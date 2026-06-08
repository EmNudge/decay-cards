<script setup lang="ts">
import { ref, computed, watch, shallowRef } from "vue";
import { toRaw } from "vue";
import { decksDb } from "../db/decks";
import { notesDb } from "../db/notes";
import { noteTypesDb } from "../db/noteTypes";
import { reviewStateDb } from "../db/reviewState";
import { reviewLogsDb } from "../db/reviewLogs";
import { deckSettingsDb } from "../db/settings";
import { softDeleteDeck } from "../atproto/deckCascade";
import { generateTid } from "../scheduler/bridge";
import { parseSearch, matchExpr, type SearchableCard } from "../search/engine";
import { stripHtml } from "../utils/stripHtml";
import type { DeckRecord, NoteRecord, NoteTypeRecord, ReviewStateRecord } from "../db/schema";

const emit = defineEmits<{
  done: [];
}>();

const mode = ref<"create" | "createFiltered" | "rename" | "delete" | null>(null);
const deckName = ref("");
const filteredQuery = ref("");
const filteredLimit = ref(100);
const filteredOrder = ref("random");
const filteredReschedule = ref(true);
const targetDeck = ref<DeckRecord | null>(null);
const error = ref("");
const isDeleting = ref(false);

function startCreate() {
  mode.value = "create";
  deckName.value = "";
  error.value = "";
}

function startCreateFiltered() {
  mode.value = "createFiltered";
  deckName.value = "";
  filteredQuery.value = "";
  filteredLimit.value = 100;
  filteredOrder.value = "random";
  filteredReschedule.value = true;
  error.value = "";
}

function startRename(deck: DeckRecord) {
  mode.value = "rename";
  targetDeck.value = deck;
  deckName.value = deck.name;
  error.value = "";
}

function startDelete(deck: DeckRecord) {
  mode.value = "delete";
  targetDeck.value = deck;
  error.value = "";
}

async function createDeck() {
  const name = deckName.value.trim();
  if (!name) {
    error.value = "Name is required";
    return;
  }

  const deck: DeckRecord = {
    tid: generateTid(),
    name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await decksDb.put(deck);
  mode.value = null;
  emit("done");
}

// Filtered deck preview
interface PreviewRow {
  front: string;
  deck: string;
  phase: string;
}
const previewRows = shallowRef<PreviewRow[]>([]);
const previewTotal = ref(0);
let previewTimer: ReturnType<typeof setTimeout> | null = null;

watch(filteredQuery, () => {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, 300);
});

async function runPreview() {
  const query = filteredQuery.value.trim();
  if (!query) {
    previewRows.value = [];
    previewTotal.value = 0;
    return;
  }

  let expr;
  try {
    expr = parseSearch(query);
  } catch {
    previewRows.value = [];
    previewTotal.value = 0;
    return;
  }
  if (!expr) { previewRows.value = []; previewTotal.value = 0; return; }

  const allNotes = await notesDb.getAll();
  const allDecks = await decksDb.getAllActive();
  const allNoteTypes = await noteTypesDb.getAll();
  const allStates = await reviewStateDb.getAll();

  const deckMap = new Map(allDecks.map((d) => [`at://self/cards.decay.flashcard.deck/${d.tid}`, d.name]));
  const ntMap = new Map(allNoteTypes.map((nt) => [`at://self/cards.decay.flashcard.noteType/${nt.tid}`, nt]));
  const statesByNote = new Map<string, ReviewStateRecord[]>();
  for (const rs of allStates) {
    const noteTid = rs.key.split("_")[0]!;
    const arr = statesByNote.get(noteTid) ?? [];
    arr.push(rs);
    statesByNote.set(noteTid, arr);
  }

  const matched: PreviewRow[] = [];

  for (const note of allNotes) {
    const noteType = ntMap.get(note.noteType);
    if (!noteType) continue;
    const deckName = deckMap.get(note.deck) ?? "";
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

    if (matchExpr(searchable, expr, 0)) {
      const front = stripHtml(note.fields[0]?.value ?? "");
      matched.push({ front: front.slice(0, 60), deck: deckName, phase: queueName });
    }
  }

  previewTotal.value = matched.length;
  previewRows.value = matched.slice(0, 20);
}

async function createFilteredDeck() {
  const name = deckName.value.trim();
  if (!name) {
    error.value = "Name is required";
    return;
  }
  if (!filteredQuery.value.trim()) {
    error.value = "Search query is required";
    return;
  }

  const deck: DeckRecord = {
    tid: generateTid(),
    name,
    isFiltered: true,
    filteredQuery: filteredQuery.value.trim(),
    filteredOrder: filteredOrder.value,
    filteredLimit: filteredLimit.value,
    filteredReschedule: filteredReschedule.value,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await decksDb.put(deck);
  mode.value = null;
  emit("done");
}

async function renameDeck() {
  if (!targetDeck.value) return;
  const name = deckName.value.trim();
  if (!name) {
    error.value = "Name is required";
    return;
  }

  const raw = toRaw(targetDeck.value);
  const updated: DeckRecord = {
    ...raw,
    name,
    updatedAt: new Date().toISOString(),
  };
  await decksDb.put(updated);
  mode.value = null;
  emit("done");
}

const isFilteredTarget = computed(() => targetDeck.value?.isFiltered ?? false);

async function deleteDeck() {
  if (!targetDeck.value) return;
  isDeleting.value = true;

  const raw = toRaw(targetDeck.value);
  await softDeleteDeck(raw);

  isDeleting.value = false;
  mode.value = null;
  emit("done");
}

function cancel() {
  mode.value = null;
  error.value = "";
}

defineExpose({ startCreate, startCreateFiltered, startRename, startDelete });
</script>

<template>
  <!-- Create / Rename modal -->
  <div
    v-if="mode === 'create' || mode === 'rename'"
    class="fixed inset-0 modal-backdrop flex items-center justify-center z-50 p-4"
    @click.self="cancel"
  >
    <div class="modal-panel p-5 w-full max-w-sm">
      <h3 class="font-semibold tracking-tight mb-4">
        {{ mode === "create" ? "Create deck" : "Rename deck" }}
      </h3>

      <label class="field-label">Name</label>
      <input
        v-model="deckName"
        type="text"
        placeholder="Deck name"
        class="field-input mb-2"
        @keydown.enter="mode === 'create' ? createDeck() : renameDeck()"
      />
      <p v-if="error" class="text-sm mb-2" :style="{ color: 'var(--c-again)' }">{{ error }}</p>

      <div class="flex gap-2 justify-end mt-4">
        <button class="btn-secondary" @click="cancel">Cancel</button>
        <button class="btn-primary" @click="mode === 'create' ? createDeck() : renameDeck()">
          {{ mode === "create" ? "Create" : "Rename" }}
        </button>
      </div>
    </div>
  </div>

  <!-- Create filtered deck modal -->
  <div
    v-if="mode === 'createFiltered'"
    class="fixed inset-0 modal-backdrop flex items-center justify-center z-50 p-4"
    @click.self="cancel"
  >
    <div class="modal-panel p-5 w-full max-w-2xl max-h-[85vh] flex flex-col">
      <h3 class="font-semibold tracking-tight mb-4">Create filtered deck</h3>

      <label class="field-label">Name</label>
      <input
        v-model="deckName"
        type="text"
        placeholder="Filtered deck name"
        class="field-input mb-3"
      />

      <label class="field-label">Search query</label>
      <input
        v-model="filteredQuery"
        type="text"
        placeholder="e.g. deck:Japanese is:due prop:ivl>10"
        class="field-input mb-2"
      />

      <!-- Preview -->
      <div v-if="filteredQuery.trim()" class="mb-3 border border-line rounded-[var(--r-sm)] overflow-hidden">
        <div class="px-3 py-1.5 bg-canvas text-xs text-fg-muted border-b border-line flex justify-between">
          <span>{{ previewTotal }} matching card{{ previewTotal === 1 ? '' : 's' }}</span>
          <span v-if="previewTotal > 20" class="text-fg-subtle">showing first 20</span>
        </div>
        <div v-if="previewRows.length > 0" class="max-h-40 overflow-y-auto">
          <table class="w-full text-xs">
            <tbody>
              <tr v-for="(row, i) in previewRows" :key="i" class="border-b border-line last:border-0">
                <td class="px-2 py-1 truncate max-w-[200px]">{{ row.front || '—' }}</td>
                <td class="px-2 py-1 text-fg-muted truncate max-w-[100px]">{{ row.deck }}</td>
                <td class="px-2 py-1 text-fg-muted">{{ row.phase }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="px-3 py-3 text-center text-xs text-fg-muted">No matches</div>
      </div>

      <div class="flex gap-3 mb-3">
        <div class="flex-1">
          <label class="field-label">Limit</label>
          <input
            v-model.number="filteredLimit"
            type="number"
            min="1"
            max="9999"
            class="field-input"
          />
        </div>
        <div class="flex-1">
          <label class="field-label">Order</label>
          <select v-model="filteredOrder" class="field-input">
            <option value="random">Random</option>
            <option value="due">Due date</option>
            <option value="added">Date added</option>
            <option value="ivl-asc">Interval (ascending)</option>
            <option value="ivl-desc">Interval (descending)</option>
            <option value="ease-asc">Ease (ascending)</option>
            <option value="lapses-desc">Most lapses</option>
          </select>
        </div>
      </div>

      <label class="flex items-center gap-2 text-sm mb-1 cursor-pointer">
        <input v-model="filteredReschedule" type="checkbox" />
        Reschedule cards based on answers
      </label>
      <p class="text-xs text-fg-muted mb-3">
        When off, reviews won't change intervals or due dates of the original cards.
      </p>

      <p v-if="error" class="text-sm mb-2" :style="{ color: 'var(--c-again)' }">{{ error }}</p>

      <div class="flex gap-2 justify-end mt-4">
        <button class="btn-secondary" @click="cancel">Cancel</button>
        <button class="btn-primary" @click="createFilteredDeck">Create</button>
      </div>
    </div>
  </div>

  <!-- Delete confirmation -->
  <div
    v-if="mode === 'delete'"
    class="fixed inset-0 modal-backdrop flex items-center justify-center z-50 p-4"
    @click.self="cancel"
  >
    <div class="modal-panel p-5 w-full max-w-sm">
      <h3 class="font-semibold tracking-tight mb-2">{{ isFilteredTarget ? 'Delete filtered deck' : 'Delete deck' }}</h3>
      <p class="text-fg-muted text-sm mb-4">
        <template v-if="isFilteredTarget">
          Delete the filtered deck "<span class="text-fg font-medium">{{ targetDeck?.name }}</span>"? The original cards will not be affected.
        </template>
        <template v-else>
          Delete "<span class="text-fg font-medium">{{ targetDeck?.name }}</span>" and all its notes? This cannot be undone.
        </template>
      </p>

      <div v-if="isDeleting" class="text-center py-2 text-fg-muted text-sm">Deleting…</div>

      <div v-else class="flex gap-2 justify-end">
        <button class="btn-secondary" @click="cancel">Cancel</button>
        <button class="btn-danger" @click="deleteDeck">Delete</button>
      </div>
    </div>
  </div>
</template>
