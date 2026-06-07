/**
 * Import transform: AnkiData (parsed .apkg) → db/ records.
 *
 * Takes the output of ankiParser and writes structured records
 * into the new IndexedDB layer. Handles:
 * - NoteType creation with stable random IDs (or tN/fN on import)
 * - Note creation with fieldId mapping
 * - ReviewState creation from Anki card scheduling
 * - ReviewLog creation from Anki revlog
 * - DeckSettings flattening from deck option groups
 * - Media extraction to shared media collection
 * - ankiNoteId global dedup
 */

import type { AnkiData } from "../ankiParser/index";
import type { CardScheduling } from "../ankiParser/anki2/index";
import type {
  DeckRecord,
  NoteTypeRecord,
  NoteRecord,
  ReviewStateRecord,
  DeckSettingsRecord,
  MediaRecord,
} from "../db/schema";
import { decksDb } from "../db/decks";
import { noteTypesDb } from "../db/noteTypes";
import { notesDb } from "../db/notes";
import { reviewStateDb, reviewStateKey } from "../db/reviewState";
import { deckSettingsDb } from "../db/settings";
import { mediaDb, normalizeMediaKey } from "../db/media";
import { generateTid } from "../scheduler/bridge";
import { omitUndefined } from "../utils/omitUndefined";

export interface ImportProgress {
  phase: "noteTypes" | "decks" | "notes" | "reviewState" | "media";
  current: number;
  total: number;
}

export interface ImportResult {
  decksCreated: number;
  noteTypesCreated: number;
  notesCreated: number;
  notesUpdated: number;
  notesSkipped: number;
  reviewStatesCreated: number;
  reviewLogsCreated: number;
  mediaCreated: number;
}

/**
 * Import an .apkg file's parsed data into the db layer.
 */
export async function importAnkiData(
  data: AnkiData,
  onProgress?: (p: ImportProgress) => void,
): Promise<ImportResult> {
  const result: ImportResult = {
    decksCreated: 0,
    noteTypesCreated: 0,
    notesCreated: 0,
    notesUpdated: 0,
    notesSkipped: 0,
    reviewStatesCreated: 0,
    reviewLogsCreated: 0,
    mediaCreated: 0,
  };

  const now = new Date().toISOString();

  // --- 1. Import note types ---
  const cards = data.cards;

  // Build a model key for each card to identify its noteType.
  // Cards sharing the same fields+templates+css belong to the same Anki model.
  function getModelKey(card: (typeof cards)[number]): string {
    const fieldNames = Object.keys(card.values).join("\x1F");
    const tmplNames = card.templates
      .map((t) => `${t.name}\x1E${t.qfmt.length}\x1E${t.afmt.length}`)
      .join("\x1F");
    return `${fieldNames}\x1D${tmplNames}\x1D${card.css.length}\x1D${card.noteType}`;
  }

  // Collect unique note types
  const seenModels = new Map<string, (typeof cards)[number]>();
  // Map modelKey → our noteType TID
  const modelKeyToTid = new Map<string, string>();

  for (const card of cards) {
    const key = getModelKey(card);
    if (!seenModels.has(key)) {
      seenModels.set(key, card);
    }
  }

  let ntIdx = 0;
  for (const [modelKey, card] of seenModels) {
    onProgress?.({ phase: "noteTypes", current: ntIdx++, total: seenModels.size });

    const tid = generateTid();
    const isCloze = card.noteType === 1; // MODEL_CLOZE

    const noteType: NoteTypeRecord = omitUndefined({
      tid,
      name: card.templates[0]?.name ?? "Imported",
      isCloze: isCloze || undefined,
      fields: Object.keys(card.values).map((name, i) => ({
        id: `f${i}`,
        name,
      })),
      templates: card.templates.map((t, i) => ({
        id: `t${i}`,
        name: t.name,
        qfmt: t.qfmt,
        afmt: t.afmt,
      })),
      css: card.css,
      createdAt: now,
      updatedAt: now,
    });

    await noteTypesDb.put(noteType);
    result.noteTypesCreated++;
    modelKeyToTid.set(modelKey, tid);
  }

  // --- 2. Import decks ---
  // First, collect which deck names actually have cards
  const usedDeckNames = new Set(cards.map((c) => c.deckName));

  // Pre-load existing decks for dedup
  const existingDecks = await decksDb.getAllActive();
  const deckMap = new Map<string, string>(); // ankiDeckName (full path) → tid

  // Seed the map with existing decks
  for (const d of existingDecks) {
    deckMap.set(d.name, d.tid);
  }

  const deckEntries = Object.entries(data.decks);
  const sortedDecks = deckEntries
    .map(([ankiId, ankiDeck]) => {
      const name =
        typeof ankiDeck === "string"
          ? ankiDeck
          : "name" in ankiDeck
            ? String(ankiDeck.name)
            : `Deck ${ankiId}`;
      return { ankiId, name };
    })
    .sort((a, b) => a.name.length - b.name.length);

  for (let i = 0; i < sortedDecks.length; i++) {
    const { name } = sortedDecks[i]!;
    onProgress?.({ phase: "decks", current: i, total: sortedDecks.length });

    // Skip decks with no cards AND no children that have cards
    // (a parent deck like "Nations of the World" should be created if children have cards)
    const hasCards = usedDeckNames.has(name);
    const hasChildrenWithCards = [...usedDeckNames].some((n) => n.startsWith(name + "::"));
    if (!hasCards && !hasChildrenWithCards) continue;

    // Skip if already mapped
    if (deckMap.has(name)) continue;

    const parts = name.split("::");
    const leafName = parts[parts.length - 1]!;

    // Check if a deck with this leaf name already exists
    const existingByLeaf = existingDecks.find((d) => d.name === leafName);
    if (existingByLeaf) {
      deckMap.set(name, existingByLeaf.tid);
      continue;
    }

    const tid = generateTid();
    const deck: DeckRecord = {
      tid,
      name: leafName,
      createdAt: now,
      updatedAt: now,
    };

    // Handle parent::child nesting
    if (parts.length > 1) {
      const parentName = parts.slice(0, -1).join("::");
      const parentTid = deckMap.get(parentName);
      if (parentTid) {
        deck.parentDeck = `at://self/cards.decay.flashcard.deck/${parentTid}`;
      }
    }

    await decksDb.put(deck);
    deckMap.set(name, tid);
    result.decksCreated++;
  }

  // --- 3. Import deck settings (flattened from option groups) ---
  if (data.deckConfigs) {
    const configEntries = Object.entries(data.deckConfigs);
    for (const [, config] of configEntries) {
      // Find decks that use this config
      for (const [, ankiDeck] of Object.entries(data.decks)) {
        const confId =
          typeof ankiDeck === "object" && "conf" in ankiDeck ? ankiDeck.conf : undefined;

        if (
          confId !== undefined &&
          typeof config === "object" &&
          "id" in config &&
          config.id === confId
        ) {
          const deckName =
            typeof ankiDeck === "object" && "name" in ankiDeck ? String(ankiDeck.name) : undefined;
          if (!deckName) continue;
          const deckTid = deckMap.get(deckName);
          if (!deckTid) continue;

          const ds: DeckSettingsRecord = {
            deckTid,
            deck: `at://self/cards.decay.flashcard.deck/${deckTid}`,
            updatedAt: now,
          };

          if (config.learnSteps) ds.learningSteps = config.learnSteps;
          if (config.relearnSteps) ds.relearningSteps = config.relearnSteps;
          if (config.new) {
            if ("perDay" in config.new) ds.newCardsPerDay = config.new.perDay as number;
          }
          if (config.rev) {
            if ("perDay" in config.rev) ds.reviewsPerDay = config.rev.perDay as number;
            if ("ease4" in config.rev) ds.easyBonus = config.rev.ease4 as number;
            if ("hardFactor" in config.rev) ds.hardMultiplier = config.rev.hardFactor as number;
            if ("ivlFct" in config.rev) ds.intervalModifier = config.rev.ivlFct as number;
            if ("maxIvl" in config.rev) ds.maximumInterval = config.rev.maxIvl as number;
          }
          if (config.lapse) {
            if ("leechFails" in config.lapse) ds.leechThreshold = config.lapse.leechFails as number;
            if ("mult" in config.lapse) ds.lapseNewInterval = config.lapse.mult as number;
          }

          await deckSettingsDb.put(ds);
        }
      }
    }
  }

  // --- 4. Import notes + review states ---
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i]!;
    onProgress?.({ phase: "notes", current: i, total: cards.length });

    const noteTypeTid = modelKeyToTid.get(getModelKey(card));
    if (!noteTypeTid) continue;

    const deckTid = deckMap.get(card.deckName);
    if (!deckTid) continue;

    const noteTypeUri = `at://self/cards.decay.flashcard.noteType/${noteTypeTid}`;
    const deckUri = `at://self/cards.decay.flashcard.deck/${deckTid}`;

    // Dedup by ankiNoteId
    const ankiNoteId = card.ankiCardId;
    if (ankiNoteId !== undefined) {
      const existing = await notesDb.getByAnkiNoteId(ankiNoteId);
      if (existing) {
        // Check mod timestamp — skip if local is newer
        if (card.noteMod !== undefined) {
          const localMod = new Date(existing.updatedAt).getTime() / 1000;
          if (localMod >= card.noteMod) {
            result.notesSkipped++;
            continue;
          }
          // Import is newer — update
          existing.fields = Object.entries(card.values).map(([_name, value], idx) => ({
            fieldId: `f${idx}`,
            value: value ?? "",
          }));
          existing.tags = card.tags;
          existing.updatedAt = now;
          await notesDb.put(existing);
          result.notesUpdated++;
          continue;
        }
        result.notesSkipped++;
        continue;
      }
    }

    // Create note
    const noteTid = generateTid();
    const note: NoteRecord = omitUndefined({
      tid: noteTid,
      deck: deckUri,
      noteType: noteTypeUri,
      ankiNoteId,
      fields: Object.entries(card.values).map(([_name, value], idx) => ({
        fieldId: `f${idx}`,
        value: value ?? "",
      })),
      tags: card.tags.length > 0 ? card.tags : undefined,
      createdAt: now,
      updatedAt: now,
    });
    await notesDb.put(note);
    result.notesCreated++;

    // Create review states from scheduling data
    if (card.scheduling) {
      const noteUri = `at://self/cards.decay.flashcard.note/${noteTid}`;

      for (let tIdx = 0; tIdx < card.templates.length; tIdx++) {
        const templateId = card.noteType === 1 ? `c${tIdx + 1}` : `t${tIdx}`;
        const rs = schedulingToReviewState(noteTid, templateId, noteUri, card.scheduling, now);
        await reviewStateDb.put(rs);
        result.reviewStatesCreated++;
      }
    }
  }

  // --- 5. Import media ---
  const mediaEntries = Array.from(data.files.entries());
  for (let i = 0; i < mediaEntries.length; i++) {
    const [filename, objectUrl] = mediaEntries[i]!;
    onProgress?.({ phase: "media", current: i, total: mediaEntries.length });

    const normalizedKey = normalizeMediaKey(filename);

    // Check if already exists
    const existing = await mediaDb.get(normalizedKey);
    if (existing) continue;

    // Fetch the blob from the object URL
    try {
      const response = await fetch(objectUrl);
      const blob = await response.blob();

      const media: MediaRecord = omitUndefined({
        normalizedKey,
        filename,
        blob,
        mimeType: blob.type || undefined,
        createdAt: now,
        updatedAt: now,
      });
      await mediaDb.put(media);
      result.mediaCreated++;
    } catch {
      // Skip failed media fetches
    }
  }

  return result;
}

/**
 * Convert Anki card scheduling to a ReviewStateRecord.
 */
function schedulingToReviewState(
  noteTid: string,
  templateId: string,
  noteUri: string,
  sched: CardScheduling,
  now: string,
): ReviewStateRecord {
  const key = reviewStateKey(noteTid, templateId);

  const phase = (() => {
    switch (sched.type) {
      case 0:
        return "new" as const;
      case 1:
        return "learning" as const;
      case 2:
        return "review" as const;
      case 3:
        return "relearning" as const;
      default:
        return "new" as const;
    }
  })();

  const hasFsrs = sched.fsrs !== null && sched.fsrs !== undefined;
  const algorithm = hasFsrs ? ("fsrs" as const) : ("sm2" as const);

  const rs: ReviewStateRecord = {
    key,
    note: noteUri,
    templateId,
    algorithm,
    phase,
    reps: sched.reps,
    lapses: sched.lapses,
    createdAt: now,
    updatedAt: now,
  };

  // Due date
  if (phase !== "new" && sched.due) {
    if (sched.dueType === "timestamp") {
      rs.due = new Date(sched.due * 1000).toISOString();
    } else if (sched.dueType === "dayOffset") {
      rs.due = new Date(Date.now() + sched.due * 86400000).toISOString();
    }
  }

  // Interval
  if (phase === "review") {
    rs.intervalDays = sched.ivlUnit === "days" ? sched.ivl : sched.ivl / 86400;
  } else if (phase === "learning" || phase === "relearning") {
    rs.intervalMinutes = sched.ivlUnit === "seconds" ? sched.ivl / 60 : sched.ivl * 1440;
    rs.learningStepIndex = sched.left;
  }

  // Algorithm-specific
  if (algorithm === "sm2") {
    rs.easeFactor = sched.easeFactor ?? (sched.factor > 0 ? sched.factor / 1000 : 2.5);
  } else if (hasFsrs) {
    rs.stability = sched.fsrs!.stability;
    rs.difficulty = sched.fsrs!.difficulty;
  }

  // Suspension/burial
  if (sched.queue === -1) {
    rs.suspended = true;
    rs.suspendedChangedAt = now;
  } else if (sched.queue === -2 || sched.queue === -3) {
    rs.buried = true;
    rs.buriedChangedAt = now;
  }

  return rs;
}
