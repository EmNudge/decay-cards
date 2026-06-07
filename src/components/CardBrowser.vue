<script setup lang="ts">
import { onMounted, ref, computed, onBeforeUnmount } from "vue";
import { useBrowser, rowKey, type BrowserRow } from "../composables/useBrowser";
import { useCardRenderer } from "../composables/useCardRenderer";
import { useDecks } from "../composables/useDecks";
import { stripHtml } from "../utils/stripHtml";
import { notesDb } from "../db/notes";
import NoteEditor from "./NoteEditor.vue";

const ROW_HEIGHT = 37; // px per row
const OVERSCAN = 10;

const emit = defineEmits<{
  close: [];
}>();

const {
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
} = useBrowser();

const { decks, noteTypes } = useDecks();
const { buildSrcdoc, resolveMediaInHtml } = useCardRenderer();
const previewHtml = ref("");
const previewSide = ref<"front" | "back">("front");
const showTagInput = ref(false);
const tagInput = ref("");
const showDeleteConfirm = ref(false);
const showDeckPicker = ref(false);
const editingNote = ref<BrowserRow | null>(null);

// Sort state
type SortColumn =
  | "front"
  | "deck"
  | "type"
  | "cards"
  | "template"
  | "phase"
  | "due"
  | "ivl"
  | "ease"
  | "reps"
  | "laps"
  | "tags";
const sortColumn = ref<SortColumn | null>(null);
const sortDirection = ref<"asc" | "desc">("asc");

// Context menu state
const contextMenu = ref<{ x: number; y: number; column: SortColumn; value: string } | null>(null);

function getSortValue(row: BrowserRow, col: SortColumn): string | number {
  const rs = row.cardState ?? row.states[0];
  switch (col) {
    case "front":
      return stripHtml(row.sortField).toLowerCase();
    case "deck":
      return row.deck.name.toLowerCase();
    case "type":
      return row.noteType.name.toLowerCase();
    case "cards":
      return row.cardCount;
    case "template":
      return (row.templateName ?? "").toLowerCase();
    case "phase":
      return phaseLabel(row);
    case "due":
      return rs?.due ? new Date(rs.due).getTime() : Infinity;
    case "ivl":
      return rs?.intervalDays ?? rs?.intervalMinutes ?? 0;
    case "ease":
      return rs?.easeFactor ?? 0;
    case "reps":
      return rs?.reps ?? 0;
    case "laps":
      return rs?.lapses ?? 0;
    case "tags":
      return (row.note.tags ?? []).join(", ").toLowerCase();
  }
}

function toggleSort(col: SortColumn) {
  if (sortColumn.value === col) {
    sortDirection.value = sortDirection.value === "asc" ? "desc" : "asc";
  } else {
    sortColumn.value = col;
    sortDirection.value = "asc";
  }
}

const sortedRows = computed(() => {
  if (!sortColumn.value) return filteredRows.value;
  const col = sortColumn.value;
  const dir = sortDirection.value === "asc" ? 1 : -1;
  return [...filteredRows.value].sort((a, b) => {
    const va = getSortValue(a, col);
    const vb = getSortValue(b, col);
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  });
});

function getCellValue(row: BrowserRow, col: SortColumn): string {
  const rs = row.cardState ?? row.states[0];
  switch (col) {
    case "front":
      return truncate(row.sortField, 80);
    case "deck":
      return row.deck.name;
    case "type":
      return row.noteType.name;
    case "cards":
      return String(row.cardCount);
    case "template":
      return row.templateName ?? "";
    case "phase":
      return phaseLabel(row);
    case "due":
      return formatDue(row);
    case "ivl":
      return formatInterval(row);
    case "ease":
      return rs?.easeFactor ? `${Math.round(rs.easeFactor * 100)}%` : "";
    case "reps":
      return String(rs?.reps ?? 0);
    case "laps":
      return String(rs?.lapses ?? 0);
    case "tags":
      return (row.note.tags ?? []).join(", ");
  }
}

function getFilterExpr(col: SortColumn, row: BrowserRow): string {
  switch (col) {
    case "deck":
      return `deck:"${row.deck.name}"`;
    case "type":
      return `note:"${row.noteType.name}"`;
    case "phase":
      return `is:${phaseLabel(row)}`;
    case "tags": {
      const tags = row.note.tags ?? [];
      return tags.length > 0 ? `tag:${tags[0]}` : "";
    }
    default:
      return "";
  }
}

function onContextMenu(e: MouseEvent, row: BrowserRow, col: SortColumn) {
  const filterExpr = getFilterExpr(col, row);
  if (!filterExpr) return;
  e.preventDefault();
  contextMenu.value = { x: e.clientX, y: e.clientY, column: col, value: filterExpr };
}

function applyFilter() {
  if (!contextMenu.value) return;
  const existing = searchQuery.value.trim();
  const expr = contextMenu.value.value;
  searchQuery.value = existing ? `${existing} ${expr}` : expr;
  contextMenu.value = null;
}

function closeContextMenu() {
  contextMenu.value = null;
}

// Virtual scroll state
const scrollContainer = ref<HTMLElement>();
const scrollTop = ref(0);

const visibleRows = computed(() => {
  const total = sortedRows.value.length;
  if (total === 0) return { rows: [] as BrowserRow[], startIdx: 0, topPad: 0, bottomPad: 0 };

  const viewportHeight = scrollContainer.value?.clientHeight ?? 600;
  const startIdx = Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN);
  const endIdx = Math.min(
    total,
    Math.ceil((scrollTop.value + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
  );

  return {
    rows: sortedRows.value.slice(startIdx, endIdx),
    startIdx,
    topPad: startIdx * ROW_HEIGHT,
    bottomPad: (total - endIdx) * ROW_HEIGHT,
  };
});

function onScroll(e: Event) {
  scrollTop.value = (e.target as HTMLElement).scrollTop;
}

onMounted(async () => {
  await loadAll();
  document.addEventListener("click", closeContextMenu);
});

onBeforeUnmount(() => {
  document.removeEventListener("click", closeContextMenu);
});

const selectedRow = computed(() => {
  if (selectedKeys.value.size !== 1) return null;
  const key = [...selectedKeys.value][0]!;
  return filteredRows.value.find((r) => rowKey(r) === key) ?? null;
});

async function previewRow(row: BrowserRow) {
  select(rowKey(row));
  // Build a minimal StudyCard for rendering
  const templateId = row.templateId ?? row.noteType.templates[0]?.id ?? "t0";
  const card = {
    key: `${row.note.tid}_${templateId}`,
    note: row.note,
    noteType: row.noteType,
    templateId,
    reviewState: row.states[0] ?? null,
    isNew: !row.states[0],
  };

  let html = buildSrcdoc(card as any, previewSide.value === "back");
  html = await resolveMediaInHtml(html);
  previewHtml.value = html;
}

function truncate(text: string, max: number): string {
  const clean = stripHtml(text);
  return clean.length > max ? clean.slice(0, max) + "…" : clean;
}

function phaseLabel(row: BrowserRow): string {
  const rs = row.states[0];
  if (!rs) return "new";
  if (rs.suspended) return "suspended";
  if (rs.buried) return "buried";
  return rs.phase;
}

function phaseColor(row: BrowserRow): string {
  const label = phaseLabel(row);
  switch (label) {
    case "new":
      return "var(--c-new)";
    case "learning":
    case "relearning":
      return "var(--c-learn)";
    case "review":
      return "var(--c-due)";
    case "suspended":
      return "var(--c-hard)";
    case "buried":
      return "var(--c-fg-subtle)";
    default:
      return "var(--c-fg-muted)";
  }
}

function formatDue(row: BrowserRow): string {
  const rs = row.states[0];
  if (!rs?.due) return "—";
  const due = new Date(rs.due);
  const now = Date.now();
  const diffMs = due.getTime() - now;
  const diffDays = Math.round(diffMs / 86400000);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "tomorrow";
  if (diffDays === -1) return "yesterday";
  if (diffDays < 0) return `${-diffDays}d ago`;
  if (diffDays < 30) return `in ${diffDays}d`;
  const months = Math.round(diffDays / 30);
  return `in ${months}mo`;
}

function formatInterval(row: BrowserRow): string {
  const rs = row.states[0];
  if (!rs) return "—";
  if (rs.intervalDays) {
    const d = Math.round(rs.intervalDays);
    if (d < 30) return `${d}d`;
    if (d < 365) return `${Math.round(d / 30)}mo`;
    return `${(d / 365).toFixed(1)}y`;
  }
  if (rs.intervalMinutes) return `${Math.round(rs.intervalMinutes)}m`;
  return "—";
}

async function handleAddTag() {
  if (!tagInput.value.trim()) return;
  await bulkAddTag(tagInput.value.trim());
  tagInput.value = "";
  showTagInput.value = false;
}

async function confirmDelete() {
  await deleteSelected();
  showDeleteConfirm.value = false;
}

async function bulkChangeDeck(deck: typeof decks.value[number]) {
  const deckUri = `at://self/cards.decay.flashcard.deck/${deck.tid}`;
  for (const row of selectedRows.value) {
    if (row.note.deck === deckUri) continue;
    row.note.deck = deckUri;
    row.note.updatedAt = new Date().toISOString();
    await notesDb.put(row.note);
  }
  showDeckPicker.value = false;
  await loadAll();
}

function editNote(row: BrowserRow) {
  editingNote.value = row;
}

async function handleNoteSaved() {
  editingNote.value = null;
  await loadAll();
  // Re-preview if still selected
  if (selectedRow.value) {
    await previewRow(selectedRow.value);
  }
}
</script>

<template>
  <div class="flex flex-col h-[calc(100vh-3.5rem)]">
    <!-- Toolbar -->
    <div class="flex items-center gap-2 px-4 py-2.5 border-b border-line bg-surface">
      <!-- Notes / Cards toggle -->
      <div class="flex rounded-[var(--r-sm)] border border-line overflow-hidden shrink-0">
        <button
          class="px-2.5 py-1 text-xs font-medium"
          :class="viewMode === 'notes' ? 'bg-accent text-accent-fg' : 'hover:bg-hover'"
          @click="setMode('notes')"
        >
          Notes
        </button>
        <button
          class="px-2.5 py-1 text-xs font-medium"
          :class="viewMode === 'cards' ? 'bg-accent text-accent-fg' : 'hover:bg-hover'"
          @click="setMode('cards')"
        >
          Cards
        </button>
      </div>

      <input
        v-model="searchQuery"
        type="search"
        :placeholder="
          viewMode === 'notes' ? 'Search notes  (deck:, tag:, is:, prop:)' : 'Search cards'
        "
        class="flex-1 px-3 py-1.5 text-sm"
      />

      <span class="text-sm text-fg-muted tabular-nums whitespace-nowrap">
        {{ filteredRows.length }} {{ viewMode }}
      </span>

      <button class="btn-icon" aria-label="Close" @click="emit('close')">✕</button>
    </div>

    <!-- Selection toolbar -->
    <div
      v-if="selectedKeys.size > 0"
      class="flex items-center flex-wrap gap-2 px-4 py-2 border-b border-line bg-hover text-sm"
    >
      <span class="font-medium">{{ selectedKeys.size }} selected</span>
      <button class="btn-pill" @click="showTagInput = true">+ Tag</button>
      <button class="btn-pill" @click="showDeckPicker = true">Change deck</button>
      <button class="btn-pill" @click="bulkSuspend">Toggle suspend</button>
      <button class="btn-pill" @click="bulkBury">Toggle bury</button>
      <button
        class="btn-pill"
        :style="{ background: 'var(--c-again-soft)', color: 'var(--c-again)' }"
        @click="showDeleteConfirm = true"
      >
        Delete
      </button>

      <div v-if="showTagInput" class="flex items-center gap-1">
        <input
          v-model="tagInput"
          type="text"
          placeholder="tag name"
          class="px-2 py-1 text-sm w-32"
          @keydown.enter="handleAddTag"
          @keydown.escape="showTagInput = false"
        />
        <button
          class="btn-pill"
          style="background: var(--c-accent); color: var(--c-accent-fg)"
          @click="handleAddTag"
        >
          Add
        </button>
      </div>
    </div>

    <div class="flex flex-1 overflow-hidden">
      <!-- Table -->
      <div ref="scrollContainer" class="flex-1 overflow-y-auto bg-canvas" @scroll="onScroll">
        <table class="w-full text-sm">
          <thead
            class="sticky top-0 bg-surface text-fg-subtle text-left text-[11px] uppercase tracking-wider font-semibold"
          >
            <tr class="border-b border-line">
              <th class="px-3 py-2 w-8">
                <input
                  type="checkbox"
                  :checked="selectedKeys.size === sortedRows.length && sortedRows.length > 0"
                  @change="selectedKeys.size === sortedRows.length ? clearSelection() : selectAll()"
                />
              </th>
              <th class="px-3 py-2 cursor-pointer select-none hover:text-fg" @click="toggleSort('front')">
                Front {{ sortColumn === 'front' ? (sortDirection === 'asc' ? '↑' : '↓') : '' }}
              </th>
              <th class="px-3 py-2 w-28 cursor-pointer select-none hover:text-fg" @click="toggleSort('deck')">
                Deck {{ sortColumn === 'deck' ? (sortDirection === 'asc' ? '↑' : '↓') : '' }}
              </th>
              <th class="px-3 py-2 w-24 cursor-pointer select-none hover:text-fg" @click="toggleSort('type')">
                Type {{ sortColumn === 'type' ? (sortDirection === 'asc' ? '↑' : '↓') : '' }}
              </th>
              <th v-if="viewMode === 'notes'" class="px-3 py-2 w-12 cursor-pointer select-none hover:text-fg" @click="toggleSort('cards')">
                Cards {{ sortColumn === 'cards' ? (sortDirection === 'asc' ? '↑' : '↓') : '' }}
              </th>
              <th v-else class="px-3 py-2 w-24 cursor-pointer select-none hover:text-fg" @click="toggleSort('template')">
                Template {{ sortColumn === 'template' ? (sortDirection === 'asc' ? '↑' : '↓') : '' }}
              </th>
              <th class="px-3 py-2 w-20 cursor-pointer select-none hover:text-fg" @click="toggleSort('phase')">
                Phase {{ sortColumn === 'phase' ? (sortDirection === 'asc' ? '↑' : '↓') : '' }}
              </th>
              <th class="px-3 py-2 w-20 cursor-pointer select-none hover:text-fg" @click="toggleSort('due')">
                Due {{ sortColumn === 'due' ? (sortDirection === 'asc' ? '↑' : '↓') : '' }}
              </th>
              <th class="px-3 py-2 w-16 cursor-pointer select-none hover:text-fg" @click="toggleSort('ivl')">
                Ivl {{ sortColumn === 'ivl' ? (sortDirection === 'asc' ? '↑' : '↓') : '' }}
              </th>
              <th class="px-3 py-2 w-14 cursor-pointer select-none hover:text-fg" @click="toggleSort('ease')">
                Ease {{ sortColumn === 'ease' ? (sortDirection === 'asc' ? '↑' : '↓') : '' }}
              </th>
              <th class="px-3 py-2 w-12 cursor-pointer select-none hover:text-fg" @click="toggleSort('reps')">
                Reps {{ sortColumn === 'reps' ? (sortDirection === 'asc' ? '↑' : '↓') : '' }}
              </th>
              <th class="px-3 py-2 w-12 cursor-pointer select-none hover:text-fg" @click="toggleSort('laps')">
                Laps {{ sortColumn === 'laps' ? (sortDirection === 'asc' ? '↑' : '↓') : '' }}
              </th>
              <th class="px-3 py-2 w-28 cursor-pointer select-none hover:text-fg" @click="toggleSort('tags')">
                Tags {{ sortColumn === 'tags' ? (sortDirection === 'asc' ? '↑' : '↓') : '' }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="visibleRows.topPad > 0" :style="{ height: visibleRows.topPad + 'px' }" />
            <tr
              v-for="row in visibleRows.rows"
              :key="rowKey(row)"
              :class="[
                'cursor-pointer border-b border-line',
                selectedKeys.has(rowKey(row)) ? 'bg-accent-soft' : 'hover:bg-hover',
              ]"
              @click="previewRow(row)"
              @dblclick="editNote(row)"
              @click.ctrl="select(rowKey(row), true)"
              @click.meta="select(rowKey(row), true)"
            >
              <td class="px-3 py-2">
                <input
                  type="checkbox"
                  :checked="selectedKeys.has(rowKey(row))"
                  @click.stop="select(rowKey(row), true)"
                />
              </td>
              <td class="px-3 py-2 truncate max-w-xs">{{ truncate(row.sortField, 80) }}</td>
              <td class="px-3 py-2 text-fg-muted truncate" @contextmenu="onContextMenu($event, row, 'deck')">{{ row.deck.name }}</td>
              <td class="px-3 py-2 text-fg-muted truncate" @contextmenu="onContextMenu($event, row, 'type')">{{ row.noteType.name }}</td>
              <td v-if="viewMode === 'notes'" class="px-3 py-2 text-fg-muted text-xs tabular-nums">
                {{ row.cardCount }}
              </td>
              <td v-else class="px-3 py-2 text-fg-muted truncate text-xs">
                {{ row.templateName ?? "—" }}
              </td>
              <td class="px-3 py-2" @contextmenu="onContextMenu($event, row, 'phase')">
                <span :style="{ color: phaseColor(row) }" class="text-xs font-medium">{{
                  phaseLabel(row)
                }}</span>
              </td>
              <td class="px-3 py-2 text-fg-muted text-xs tabular-nums">{{ formatDue(row) }}</td>
              <td class="px-3 py-2 text-fg-muted text-xs tabular-nums">
                {{ formatInterval(row) }}
              </td>
              <td class="px-3 py-2 text-fg-muted text-xs tabular-nums">
                {{
                  (row.cardState ?? row.states[0])?.easeFactor
                    ? `${Math.round((row.cardState ?? row.states[0])!.easeFactor! * 100)}%`
                    : "—"
                }}
              </td>
              <td class="px-3 py-2 text-fg-muted text-xs tabular-nums">
                {{ (row.cardState ?? row.states[0])?.reps ?? 0 }}
              </td>
              <td class="px-3 py-2 text-fg-muted text-xs tabular-nums">
                {{ (row.cardState ?? row.states[0])?.lapses ?? 0 }}
              </td>
              <td class="px-3 py-2 text-fg-muted truncate max-w-[100px] text-xs" @contextmenu="onContextMenu($event, row, 'tags')">
                {{ (row.note.tags ?? []).join(", ") }}
              </td>
            </tr>
            <tr
              v-if="visibleRows.bottomPad > 0"
              :style="{ height: visibleRows.bottomPad + 'px' }"
            />
          </tbody>
        </table>

        <div v-if="filteredRows.length === 0" class="text-center py-16 text-fg-muted">
          No matching notes
        </div>
      </div>

      <!-- Preview panel -->
      <div v-if="selectedRow" class="w-96 border-l border-line flex flex-col bg-surface">
        <div class="flex border-b border-line">
          <button
            class="flex-1 px-3 py-2 text-sm font-medium"
            :class="previewSide === 'front' ? '' : 'text-fg-muted hover:text-fg'"
            :style="
              previewSide === 'front'
                ? {
                    background: 'var(--c-hover)',
                    color: 'var(--c-accent)',
                    borderBottom: '2px solid var(--c-accent)',
                  }
                : {}
            "
            @click="
              previewSide = 'front';
              previewRow(selectedRow!);
            "
          >
            Front
          </button>
          <button
            class="flex-1 px-3 py-2 text-sm font-medium"
            :class="previewSide === 'back' ? '' : 'text-fg-muted hover:text-fg'"
            :style="
              previewSide === 'back'
                ? {
                    background: 'var(--c-hover)',
                    color: 'var(--c-accent)',
                    borderBottom: '2px solid var(--c-accent)',
                  }
                : {}
            "
            @click="
              previewSide = 'back';
              previewRow(selectedRow!);
            "
          >
            Back
          </button>
          <button
            class="px-3 py-2 text-sm font-medium"
            style="color: var(--c-accent)"
            @click="editNote(selectedRow!)"
          >
            Edit
          </button>
        </div>
        <iframe
          v-if="previewHtml"
          :srcdoc="previewHtml"
          sandbox="allow-same-origin allow-scripts"
          class="flex-1 border-0"
        />
      </div>
    </div>

    <NoteEditor
      v-if="editingNote"
      :note="editingNote.note"
      :decks="decks"
      :note-types="[editingNote.noteType]"
      @saved="handleNoteSaved"
      @close="editingNote = null"
    />

    <div
      v-if="showDeleteConfirm"
      class="fixed inset-0 modal-backdrop flex items-center justify-center z-50 p-4"
      @click.self="showDeleteConfirm = false"
    >
      <div class="modal-panel p-5 max-w-sm w-full">
        <h3 class="font-semibold tracking-tight mb-2">Delete notes</h3>
        <p class="text-fg-muted text-sm mb-4">
          Delete {{ selectedKeys.size }} note(s)? This cannot be undone.
        </p>
        <div class="flex gap-2 justify-end">
          <button class="btn-secondary" @click="showDeleteConfirm = false">Cancel</button>
          <button class="btn-danger" @click="confirmDelete">Delete</button>
        </div>
      </div>
    </div>

    <!-- Deck picker modal -->
    <div
      v-if="showDeckPicker"
      class="fixed inset-0 modal-backdrop flex items-center justify-center z-50 p-4"
      @click.self="showDeckPicker = false"
    >
      <div class="modal-panel p-5 max-w-sm w-full">
        <h3 class="font-semibold tracking-tight mb-2">Move to deck</h3>
        <div class="flex flex-col gap-1 max-h-64 overflow-y-auto">
          <button
            v-for="deck in decks"
            :key="deck.tid"
            class="text-left px-3 py-2 text-sm rounded-[var(--r-sm)] hover:bg-hover"
            @click="bulkChangeDeck(deck)"
          >
            {{ deck.name }}
          </button>
        </div>
        <div class="flex justify-end mt-4">
          <button class="btn-secondary" @click="showDeckPicker = false">Cancel</button>
        </div>
      </div>
    </div>

    <!-- Context menu -->
    <div
      v-if="contextMenu"
      class="fixed z-[60] bg-surface border border-line rounded-[var(--r-sm)] shadow-lg py-1 min-w-[160px]"
      :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
      @click.stop
    >
      <button
        class="w-full text-left px-3 py-1.5 text-sm hover:bg-hover"
        @click="applyFilter"
      >
        Filter: <span class="font-mono text-xs text-fg-muted">{{ contextMenu.value }}</span>
      </button>
    </div>
  </div>
</template>
