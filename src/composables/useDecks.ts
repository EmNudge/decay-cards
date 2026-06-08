import { ref, computed, shallowRef } from "vue";
import type { DeckRecord, NoteTypeRecord, NoteRecord, ReviewStateRecord } from "../db/schema";
import { decksDb } from "../db/decks";
import { notesDb } from "../db/notes";
import { noteTypesDb } from "../db/noteTypes";
import { reviewStateDb } from "../db/reviewState";
import { parseSearch, matchExpr, type SearchableCard } from "../search/engine";

const CLOZE_REGEX = /\{\{c(\d+)::/g;

function getClozeOrdinals(note: NoteRecord): string[] {
  const ordinals = new Set<number>();
  for (const field of note.fields) {
    CLOZE_REGEX.lastIndex = 0;
    let match;
    while ((match = CLOZE_REGEX.exec(field.value)) !== null) {
      const n = parseInt(match[1]!, 10);
      if (n >= 1 && n <= 500) ordinals.add(n);
    }
  }
  return Array.from(ordinals).map((n) => `c${n}`);
}

const decks = shallowRef<DeckRecord[]>([]);
const noteTypes = shallowRef<NoteTypeRecord[]>([]);
const activeDeckTid = ref<string | null>(null);

export function useDecks() {
  async function loadDecks() {
    decks.value = await decksDb.getAllActive();
    noteTypes.value = await noteTypesDb.getAll();
  }

  const activeDeck = computed(() => decks.value.find((d) => d.tid === activeDeckTid.value));

  const activeDeckUri = computed(() =>
    activeDeckTid.value ? `at://self/cards.decay.flashcard.deck/${activeDeckTid.value}` : null,
  );

  function selectDeck(tid: string | null) {
    activeDeckTid.value = tid;
  }

  async function getDeckCounts(deckTid: string) {
    const deck = decks.value.find((d) => d.tid === deckTid);
    if (deck?.isFiltered && deck.filteredQuery) {
      return getFilteredDeckCounts(deck);
    }

    const deckUri = `at://self/cards.decay.flashcard.deck/${deckTid}`;
    const notes = await notesDb.getByDeck(deckUri);
    const noteTids = new Set(notes.map((n) => n.tid));

    // Count cards with existing reviewState
    const allStates = await reviewStateDb.getAll();
    const deckStates = allStates.filter((rs) => {
      const noteTid = rs.key.split("_")[0]!;
      return noteTids.has(noteTid);
    });
    const stateKeys = new Set(deckStates.map((rs) => rs.key));

    // Also count cards that DON'T have a reviewState yet (new cards never reviewed).
    // These are derived from notes × noteType templates.
    const allNoteTypes = await noteTypesDb.getAll();
    const ntMap = new Map(allNoteTypes.map((nt) => [nt.tid, nt]));

    let newWithoutState = 0;
    for (const note of notes) {
      const ntTid = note.noteType.split("/").pop()!;
      const nt = ntMap.get(ntTid);
      if (!nt) continue;
      const templateIds = nt.isCloze ? getClozeOrdinals(note) : nt.templates.map((t) => t.id);
      for (const tid of templateIds) {
        const key = `${note.tid}_${tid}`;
        if (!stateKeys.has(key)) newWithoutState++;
      }
    }

    const now = Date.now();
    let newCount = 0;
    let learnCount = 0;
    let dueCount = 0;

    for (const rs of deckStates) {
      if (rs.suspended || rs.buried || rs.orphaned) continue;
      if (rs.phase === "new") newCount++;
      else if (rs.phase === "learning" || rs.phase === "relearning") learnCount++;
      else if (rs.due && new Date(rs.due).getTime() <= now) dueCount++;
    }

    newCount += newWithoutState;
    return { newCount, learnCount, dueCount, totalNotes: notes.length };
  }

  async function getFilteredDeckCounts(deck: DeckRecord) {
    const query = deck.filteredQuery!;
    let expr;
    try {
      expr = parseSearch(query);
    } catch {
      return { newCount: 0, learnCount: 0, dueCount: 0, totalNotes: 0 };
    }
    if (!expr) return { newCount: 0, learnCount: 0, dueCount: 0, totalNotes: 0 };

    const allNotes = await notesDb.getAll();
    const allDecks = await decksDb.getAllActive();
    const allNoteTypes = await noteTypesDb.getAll();
    const allStates = await reviewStateDb.getAll();

    const deckNameMap = new Map(
      allDecks.map((d) => [`at://self/cards.decay.flashcard.deck/${d.tid}`, d.name]),
    );
    const ntMap = new Map(
      allNoteTypes.map((nt) => [`at://self/cards.decay.flashcard.noteType/${nt.tid}`, nt]),
    );
    const statesByNote = new Map<string, ReviewStateRecord[]>();
    for (const rs of allStates) {
      const noteTid = rs.key.split("_")[0]!;
      const arr = statesByNote.get(noteTid) ?? [];
      arr.push(rs);
      statesByNote.set(noteTid, arr);
    }

    let newCount = 0;
    let learnCount = 0;
    let dueCount = 0;
    let total = 0;
    const now = Date.now();
    const limit = deck.filteredLimit ?? 100;

    for (const note of allNotes) {
      if (total >= limit) break;
      const noteType = ntMap.get(note.noteType);
      if (!noteType) continue;
      const deckName = deckNameMap.get(note.deck) ?? "";
      const states = statesByNote.get(note.tid) ?? [];
      const rs = states[0];
      const queueName = rs ? (rs.suspended ? "suspended" : rs.buried ? "buried" : rs.phase) : "new";

      const fields: Record<string, string> = {};
      for (const f of note.fields) {
        const fieldDef = noteType.fields.find((fd) => fd.id === f.fieldId);
        if (fieldDef) fields[fieldDef.name] = f.value;
      }

      const searchable: SearchableCard = {
        fields,
        deck: deckName,
        tags: note.tags ?? [],
        templateName: noteType.templates[0]?.name ?? "",
        queueName,
        flags: 0,
        rawEase: rs?.easeFactor ?? null,
        rawIvl: rs?.intervalDays ?? 0,
        rawDue: rs?.due ? new Date(rs.due).getTime() / 1000 : 0,
        rawDueType: rs?.phase === "review" ? "dayOffset" : "timestamp",
        cardCreatedMs: new Date(note.createdAt).getTime(),
        noteModSec: new Date(note.updatedAt).getTime() / 1000,
        cardModSec: rs ? new Date(rs.updatedAt).getTime() / 1000 : 0,
        reps: rs?.reps ?? 0,
        lapses: rs?.lapses ?? 0,
      };

      if (!matchExpr(searchable, expr, 0)) continue;

      total++;
      if (!rs || rs.phase === "new") newCount++;
      else if (rs.phase === "learning" || rs.phase === "relearning") learnCount++;
      else if (rs.due && new Date(rs.due).getTime() <= now) dueCount++;
    }

    return { newCount, learnCount, dueCount, totalNotes: total };
  }

  return {
    decks,
    noteTypes,
    activeDeck,
    activeDeckTid,
    activeDeckUri,
    loadDecks,
    selectDeck,
    getDeckCounts,
  };
}
