import { ref, shallowRef, watch, computed } from "vue";
import type { NoteRecord, NoteTypeRecord, ReviewStateRecord, DeckRecord } from "../db/schema";
import { notesDb } from "../db/notes";
import { noteTypesDb } from "../db/noteTypes";
import { reviewStateDb } from "../db/reviewState";
import { decksDb } from "../db/decks";
import { parseSearch, matchExpr, type SearchableCard, type SearchExpr } from "../search/engine";
import { omitUndefined } from "../utils/omitUndefined";

export type BrowserMode = "notes" | "cards";

export interface BrowserRow {
  note: NoteRecord;
  noteType: NoteTypeRecord;
  deck: DeckRecord;
  states: ReviewStateRecord[];
  /** Total number of cards this note generates (notes mode) */
  cardCount: number;
  /** First field value for sort/display */
  sortField: string;
  /** Template name for this specific card (cards mode only) */
  templateName?: string;
  /** Template ID for this specific card (cards mode only) */
  templateId?: string;
  /** The specific card's review state (cards mode — single state, not array) */
  cardState?: ReviewStateRecord;
}

const allNoteRows = shallowRef<BrowserRow[]>([]);
const allCardRows = shallowRef<BrowserRow[]>([]);
const viewMode = ref<BrowserMode>("notes");
const searchQuery = ref("");
const filteredRows = shallowRef<BrowserRow[]>([]);
const selectedKeys = ref<Set<string>>(new Set());

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function activeRows(): BrowserRow[] {
  return viewMode.value === "cards" ? allCardRows.value : allNoteRows.value;
}

function runFilter() {
  const query = searchQuery.value.trim();
  const source = activeRows();
  if (!query) {
    filteredRows.value = source;
    return;
  }

  let expr: SearchExpr | null;
  try {
    expr = parseSearch(query);
  } catch {
    filteredRows.value = source;
    return;
  }
  if (!expr) {
    filteredRows.value = source;
    return;
  }

  const collectionCreationTime = Date.now();
  filteredRows.value = source.filter((row) => {
    const searchable = toSearchableCard(row);
    return matchExpr(searchable, expr!, collectionCreationTime);
  });
}

export function useBrowser() {
  // Debounce search
  watch(searchQuery, () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runFilter, 200);
  });

  // Re-filter when source data or mode changes
  watch([allNoteRows, allCardRows, viewMode], () => runFilter());

  function setMode(mode: BrowserMode) {
    viewMode.value = mode;
    selectedKeys.value = new Set();
  }

  async function loadAll() {
    const notes = await notesDb.getAll();
    const decks = await decksDb.getAllActive();
    const noteTypes = await noteTypesDb.getAll();
    const allStates = await reviewStateDb.getAll();

    const deckMap = new Map(decks.map((d) => [`at://self/cards.decay.flashcard.deck/${d.tid}`, d]));
    const ntMap = new Map(
      noteTypes.map((nt) => [`at://self/cards.decay.flashcard.noteType/${nt.tid}`, nt]),
    );
    const statesByNote = new Map<string, ReviewStateRecord[]>();
    for (const rs of allStates) {
      const noteTid = rs.key.split("_")[0]!;
      const arr = statesByNote.get(noteTid) ?? [];
      arr.push(rs);
      statesByNote.set(noteTid, arr);
    }

    const noteRows: BrowserRow[] = [];
    const cardRows: BrowserRow[] = [];

    for (const note of notes) {
      const noteType = ntMap.get(note.noteType);
      const deck = deckMap.get(note.deck);
      if (!noteType || !deck) continue;

      const states = statesByNote.get(note.tid) ?? [];
      const stateMap = new Map(states.map((s) => [s.templateId, s]));
      const cardCount = noteType.isCloze ? countClozeOrdinals(note) : noteType.templates.length;
      const sortField = note.fields[0]?.value ?? "";

      // Note row (one per note)
      noteRows.push({ note, noteType, deck, states, cardCount, sortField });

      // Card rows (one per template)
      const templateIds = noteType.isCloze
        ? getClozeTemplateIds(note)
        : noteType.templates.map((t) => ({ id: t.id, name: t.name }));

      for (const tmpl of templateIds) {
        const rs = stateMap.get(tmpl.id);
        cardRows.push(
          omitUndefined({
            note,
            noteType,
            deck,
            states: rs ? [rs] : [],
            cardCount: 1,
            sortField,
            templateName: tmpl.name,
            templateId: tmpl.id,
            cardState: rs,
          }),
        );
      }
    }

    allNoteRows.value = noteRows;
    allCardRows.value = cardRows;
  }

  function select(key: string, multi = false) {
    if (multi) {
      const next = new Set(selectedKeys.value);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      selectedKeys.value = next;
    } else {
      selectedKeys.value = new Set([key]);
    }
  }

  function selectAll() {
    selectedKeys.value = new Set(filteredRows.value.map((r) => rowKey(r)));
  }

  function clearSelection() {
    selectedKeys.value = new Set();
  }

  const selectedRows = computed(() =>
    filteredRows.value.filter((r) => selectedKeys.value.has(rowKey(r))),
  );

  async function bulkAddTag(tag: string) {
    for (const row of selectedRows.value) {
      const note = row.note;
      const tags = new Set(note.tags ?? []);
      if (tags.has(tag)) continue;
      tags.add(tag);
      note.tags = [...tags];
      note.updatedAt = new Date().toISOString();
      await notesDb.put(note);
    }
    await loadAll();
  }

  async function bulkRemoveTag(tag: string) {
    for (const row of selectedRows.value) {
      const note = row.note;
      if (!note.tags?.includes(tag)) continue;
      note.tags = note.tags.filter((t) => t !== tag);
      note.updatedAt = new Date().toISOString();
      await notesDb.put(note);
    }
    await loadAll();
  }

  async function bulkSuspend() {
    const now = new Date().toISOString();
    for (const row of selectedRows.value) {
      for (const rs of row.states) {
        rs.suspended = !rs.suspended;
        rs.suspendedChangedAt = now;
        rs.updatedAt = now;
        await reviewStateDb.put(rs);
      }
    }
    await loadAll();
  }

  async function bulkBury() {
    const now = new Date().toISOString();
    const today = new Date().toISOString().slice(0, 10);
    for (const row of selectedRows.value) {
      for (const rs of row.states) {
        rs.buried = !rs.buried;
        rs.buriedChangedAt = now;
        if (rs.buried) {
          rs.buriedDate = today;
        } else {
          delete rs.buriedDate;
        }
        rs.updatedAt = now;
        await reviewStateDb.put(rs);
      }
    }
    await loadAll();
  }

  async function deleteSelected() {
    for (const row of selectedRows.value) {
      await notesDb.delete(row.note.tid);
      for (const rs of row.states) {
        await reviewStateDb.delete(rs.key);
      }
    }
    clearSelection();
    await loadAll();
  }

  return {
    filteredRows,
    viewMode,
    searchQuery,
    selectedKeys,
    selectedRows,
    loadAll,
    setMode,
    select,
    selectAll,
    clearSelection,
    bulkAddTag,
    bulkRemoveTag,
    bulkSuspend,
    bulkBury,
    deleteSelected,
  };
}

function toSearchableCard(row: BrowserRow): SearchableCard {
  const fields: Record<string, string> = {};
  for (const f of row.note.fields) {
    const fieldDef = row.noteType.fields.find((fd) => fd.id === f.fieldId);
    if (fieldDef) fields[fieldDef.name] = f.value;
  }

  const rs = row.states[0];
  const queueName = rs ? (rs.suspended ? "suspended" : rs.buried ? "buried" : rs.phase) : "new";

  return {
    fields,
    deck: row.deck.name,
    tags: row.note.tags ?? [],
    templateName: row.noteType.templates[0]?.name ?? "",
    queueName,
    flags: 0,
    rawEase: rs?.easeFactor ?? null,
    rawIvl: rs?.intervalDays ?? 0,
    rawDue: rs?.due ? new Date(rs.due).getTime() / 1000 : 0,
    rawDueType: rs?.phase === "review" ? "dayOffset" : "timestamp",
    cardCreatedMs: new Date(row.note.createdAt).getTime(),
    noteModSec: new Date(row.note.updatedAt).getTime() / 1000,
    cardModSec: rs ? new Date(rs.updatedAt).getTime() / 1000 : 0,
    reps: rs?.reps ?? 0,
    lapses: rs?.lapses ?? 0,
  };
}

const CLOZE_REGEX = /\{\{c(\d+)::/g;
const IO_ORDINAL_REGEX = /data-ordinal="(\d+)"/g;
function countClozeOrdinals(note: NoteRecord): number {
  return getClozeTemplateIds(note).length;
}
function getClozeTemplateIds(note: NoteRecord): { id: string; name: string }[] {
  const ordinals = new Set<number>();
  for (const field of note.fields) {
    CLOZE_REGEX.lastIndex = 0;
    let match;
    while ((match = CLOZE_REGEX.exec(field.value)) !== null) {
      ordinals.add(parseInt(match[1]!, 10));
    }
    // Also check for IO data-ordinal attributes
    IO_ORDINAL_REGEX.lastIndex = 0;
    while ((match = IO_ORDINAL_REGEX.exec(field.value)) !== null) {
      ordinals.add(parseInt(match[1]!, 10));
    }
  }
  return Array.from(ordinals)
    .sort((a, b) => a - b)
    .map((n) => ({
      id: `c${n}`,
      name: `Cloze ${n}`,
    }));
}

/** Unique key for a browser row — note TID in notes mode, note_template in cards mode */
export function rowKey(row: BrowserRow): string {
  return row.templateId ? `${row.note.tid}_${row.templateId}` : row.note.tid;
}
