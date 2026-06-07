<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useDecks } from "../composables/useDecks";
import { exportDeckAsApkg } from "../export/apkgExport";
import { downloadBlob } from "../utils/downloadBlob";
import DeckManager from "./DeckManager.vue";

const emit = defineEmits<{
  study: [deckTid: string];
  settings: [deckTid: string];
}>();

const { decks, loadDecks, getDeckCounts } = useDecks();
const deckManager = ref<InstanceType<typeof DeckManager>>();

interface DeckNode {
  tid: string;
  name: string;
  depth: number;
  newCount: number;
  learnCount: number;
  dueCount: number;
  totalNotes: number;
  collapsed: boolean;
  hasChildren: boolean;
  parentTid: string | null;
  isFiltered: boolean;
}

const deckTree = ref<DeckNode[]>([]);
const collapsedTids = ref<Set<string>>(new Set());

onMounted(async () => {
  await loadDecks();
  await refreshTree();
});

async function refreshTree() {
  const allDecks = decks.value;

  // Build parent lookup
  const parentTids = new Set<string>();
  const parentOf = new Map<string, string>(); // tid → parentTid
  for (const d of allDecks) {
    if (d.parentDeck) {
      const pTid = d.parentDeck.split("/").pop()!;
      parentOf.set(d.tid, pTid);
      parentTids.add(pTid);
    }
  }

  // Get counts for each deck
  const countsMap = new Map<
    string,
    { newCount: number; learnCount: number; dueCount: number; totalNotes: number }
  >();
  for (const deck of allDecks) {
    countsMap.set(deck.tid, await getDeckCounts(deck.tid));
  }

  // Compute depth
  function getDepth(tid: string): number {
    let depth = 0;
    let cur = tid;
    while (parentOf.has(cur)) {
      depth++;
      cur = parentOf.get(cur)!;
    }
    return depth;
  }

  // Build full path for sorting
  function getFullPath(tid: string): string {
    const parts: string[] = [];
    let cur = tid;
    while (true) {
      const deck = allDecks.find((d) => d.tid === cur);
      if (!deck) break;
      parts.unshift(deck.name);
      if (!parentOf.has(cur)) break;
      cur = parentOf.get(cur)!;
    }
    return parts.join("::");
  }

  // Aggregate child counts into parents
  const aggCounts = new Map<
    string,
    { newCount: number; learnCount: number; dueCount: number; totalNotes: number }
  >();
  for (const deck of allDecks) {
    const own = countsMap.get(deck.tid) ?? {
      newCount: 0,
      learnCount: 0,
      dueCount: 0,
      totalNotes: 0,
    };
    aggCounts.set(deck.tid, { ...own });
  }
  // Walk children and add to parents
  for (const deck of allDecks) {
    const own = countsMap.get(deck.tid);
    if (!own) continue;
    let cur = deck.tid;
    while (parentOf.has(cur)) {
      const pTid = parentOf.get(cur)!;
      const parent = aggCounts.get(pTid);
      if (parent) {
        parent.newCount += own.newCount;
        parent.learnCount += own.learnCount;
        parent.dueCount += own.dueCount;
        parent.totalNotes += own.totalNotes;
      }
      cur = pTid;
    }
  }

  // Build sorted flat list
  const nodes: DeckNode[] = allDecks
    .map((deck) => {
      const counts = aggCounts.get(deck.tid) ?? {
        newCount: 0,
        learnCount: 0,
        dueCount: 0,
        totalNotes: 0,
      };
      return {
        tid: deck.tid,
        name: deck.name,
        depth: getDepth(deck.tid),
        ...counts,
        collapsed: collapsedTids.value.has(deck.tid),
        hasChildren: parentTids.has(deck.tid),
        parentTid: parentOf.get(deck.tid) ?? null,
        isFiltered: deck.isFiltered ?? false,
      };
    })
    .sort((a, b) => getFullPath(a.tid).localeCompare(getFullPath(b.tid)));

  deckTree.value = nodes;
}

/** Visible nodes — hide children of collapsed parents */
function visibleNodes(): DeckNode[] {
  const hidden = new Set<string>();
  // Walk the tree and mark children of collapsed nodes
  for (const node of deckTree.value) {
    if (hidden.has(node.tid)) continue;
    if (collapsedTids.value.has(node.tid)) {
      // Mark all descendants as hidden
      markDescendants(node.tid, hidden);
    }
  }
  return deckTree.value.filter((n) => !hidden.has(n.tid));
}

function markDescendants(parentTid: string, hidden: Set<string>) {
  for (const node of deckTree.value) {
    if (node.parentTid === parentTid) {
      hidden.add(node.tid);
      markDescendants(node.tid, hidden);
    }
  }
}

function toggleCollapse(tid: string) {
  const next = new Set(collapsedTids.value);
  if (next.has(tid)) {
    next.delete(tid);
  } else {
    next.add(tid);
  }
  collapsedTids.value = next;
}

const showContextMenu = ref(false);
const contextMenuDeck = ref<DeckNode | null>(null);
const contextMenuPos = ref({ x: 0, y: 0 });

function openContextMenu(event: MouseEvent, deck: DeckNode) {
  event.preventDefault();
  contextMenuDeck.value = deck;
  contextMenuPos.value = { x: event.clientX, y: event.clientY };
  showContextMenu.value = true;
}

function closeContextMenu() {
  showContextMenu.value = false;
}

function handleRename() {
  if (!contextMenuDeck.value) return;
  const deck = decks.value.find((d) => d.tid === contextMenuDeck.value!.tid);
  if (deck) deckManager.value?.startRename(deck);
  closeContextMenu();
}

function handleDelete() {
  if (!contextMenuDeck.value) return;
  const deck = decks.value.find((d) => d.tid === contextMenuDeck.value!.tid);
  if (deck) deckManager.value?.startDelete(deck);
  closeContextMenu();
}

async function handleExport() {
  if (!contextMenuDeck.value) return;
  const tid = contextMenuDeck.value.tid;
  const name = contextMenuDeck.value.name;
  closeContextMenu();
  const blob = await exportDeckAsApkg(tid);
  downloadBlob(blob, `${name}.apkg`);
}

async function handleDeckChanged() {
  await loadDecks();
  await refreshTree();
}
</script>

<template>
  <div class="max-w-2xl mx-auto px-4 py-6" @click="closeContextMenu">
    <!-- Empty state -->
    <div v-if="deckTree.length === 0" class="text-center py-24">
      <div class="text-5xl mb-4 opacity-40">◇</div>
      <p class="text-xl font-semibold mb-1">No decks yet</p>
      <p class="text-fg-muted text-sm">Import an .apkg file to get started.</p>
    </div>

    <!-- Deck card -->
    <div v-else class="card overflow-hidden">
      <!-- Column header -->
      <div
        class="flex items-center px-4 py-2.5 text-[11px] uppercase tracking-wider font-semibold text-fg-subtle border-b border-line"
      >
        <span class="flex-1">Deck</span>
        <div class="flex items-center gap-2 tabular-nums">
          <span class="w-9 text-right" title="New">New</span>
          <span class="w-9 text-right" title="Learning">Learn</span>
          <span class="w-9 text-right" title="Due">Due</span>
          <span class="w-7" />
        </div>
      </div>

      <ul class="divide-y divide-line">
        <li
          v-for="deck in visibleNodes()"
          :key="deck.tid"
          class="group flex items-center hover:bg-hover cursor-pointer"
          :style="{ paddingLeft: `${16 + deck.depth * 20}px`, paddingRight: '12px' }"
          @click="emit('study', deck.tid)"
          @contextmenu="openContextMenu($event, deck)"
        >
          <button
            v-if="deck.hasChildren"
            class="w-5 h-5 mr-1.5 text-fg-subtle hover:text-fg flex items-center justify-center text-xs shrink-0"
            @click.stop="toggleCollapse(deck.tid)"
          >
            <span
              class="inline-block transition-transform"
              :class="collapsedTids.has(deck.tid) ? '' : 'rotate-90'"
              >▸</span
            >
          </button>
          <span v-else class="w-5 mr-1.5 shrink-0" />

          <span
            class="flex-1 truncate py-3 text-[15px] font-medium"
            :class="deck.isFiltered ? 'italic text-fg-muted' : ''"
          >
            <span v-if="deck.isFiltered" class="not-italic mr-1 opacity-60">⧗</span>{{ deck.name }}
          </span>

          <div class="flex items-center gap-2 tabular-nums shrink-0">
            <span
              class="w-9 text-right text-sm font-medium"
              :style="
                deck.newCount > 0 ? { color: 'var(--c-new)' } : { color: 'var(--c-fg-faint)' }
              "
              >{{ deck.newCount }}</span
            >
            <span
              class="w-9 text-right text-sm font-medium"
              :style="
                deck.learnCount > 0 ? { color: 'var(--c-learn)' } : { color: 'var(--c-fg-faint)' }
              "
              >{{ deck.learnCount }}</span
            >
            <span
              class="w-9 text-right text-sm font-medium"
              :style="
                deck.dueCount > 0 ? { color: 'var(--c-due)' } : { color: 'var(--c-fg-faint)' }
              "
              >{{ deck.dueCount }}</span
            >
            <button
              class="w-7 h-7 flex items-center justify-center rounded-full text-fg-subtle opacity-0 group-hover:opacity-100 hover:bg-active hover:text-fg"
              @click.stop="emit('settings', deck.tid)"
              title="Settings"
              aria-label="Settings"
            >
              <span class="text-sm">⚙</span>
            </button>
          </div>
        </li>
      </ul>
    </div>

    <!-- New deck button -->
    <button
      class="mt-4 w-full px-4 py-3 border border-dashed border-line-strong rounded-lg text-fg-muted hover:text-fg hover:border-accent hover:bg-accent-soft text-sm font-medium"
      @click="deckManager?.startCreate()"
    >
      + Create deck
    </button>

    <!-- Context menu -->
    <div
      v-if="showContextMenu && contextMenuDeck"
      class="fixed modal-panel py-1 z-50 min-w-[140px]"
      :style="{ left: contextMenuPos.x + 'px', top: contextMenuPos.y + 'px' }"
    >
      <button class="w-full text-left px-3 py-1.5 hover:bg-hover text-sm" @click="handleRename">
        Rename
      </button>
      <button class="w-full text-left px-3 py-1.5 hover:bg-hover text-sm" @click="handleExport">
        Export .apkg
      </button>
      <button
        class="w-full text-left px-3 py-1.5 hover:bg-hover text-sm"
        style="color: var(--c-again)"
        @click="handleDelete"
      >
        Delete
      </button>
    </div>

    <DeckManager ref="deckManager" @done="handleDeckChanged" />
  </div>
</template>
