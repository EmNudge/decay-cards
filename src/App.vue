<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from "vue";
import DeckList from "./components/DeckList.vue";
import StudyView from "./components/StudyView.vue";
import ImportView from "./components/ImportView.vue";
import CardBrowser from "./components/CardBrowser.vue";
import SettingsView from "./components/SettingsView.vue";
import NoteEditor from "./components/NoteEditor.vue";
import CsvImportView from "./components/CsvImportView.vue";
import DeckManager from "./components/DeckManager.vue";
import { useDecks } from "./composables/useDecks";
import { useImport } from "./composables/useImport";
import { useTheme } from "./composables/useTheme";
import { deleteDb } from "./db/schema";

type View = "decks" | "study" | "import" | "csv-import" | "browse" | "settings";
const activeView = ref<View>("decks");
const deckListKey = ref(0);
const showNoteEditor = ref(false);
const importFileInput = ref<HTMLInputElement>();
const showNewMenu = ref(false);
const deckManagerRef = ref<InstanceType<typeof DeckManager>>();

function closeNewMenu(e: MouseEvent) {
  if (!(e.target as Element).closest("[data-new-menu]")) {
    showNewMenu.value = false;
  }
}
onMounted(() => document.addEventListener("click", closeNewMenu));
onUnmounted(() => document.removeEventListener("click", closeNewMenu));

const { decks, noteTypes, loadDecks, activeDeck, activeDeckTid, activeDeckUri, selectDeck } =
  useDecks();
const { importFile } = useImport();
const { resolved, choice, cycleTheme } = useTheme();
const ioCreateMode = ref(false);

const themeIcon = computed(() => {
  if (choice.value === "system") return "◐";
  return resolved.value === "dark" ? "☾" : "☀";
});
const themeLabel = computed(() =>
  choice.value === "system"
    ? "System theme"
    : choice.value === "dark"
      ? "Dark theme"
      : "Light theme",
);

onMounted(async () => {
  await loadDecks();
});

function startStudy(deckTid: string) {
  selectDeck(deckTid);
  activeView.value = "study";
}

function openSettings(deckTid: string) {
  selectDeck(deckTid);
  activeView.value = "settings";
}

function goHome() {
  selectDeck(null);
  activeView.value = "decks";
  loadDecks();
}

function openNewDeck() {
  showNewMenu.value = false;
  deckManagerRef.value?.startCreate();
}

function openNewFilteredDeck() {
  showNewMenu.value = false;
  deckManagerRef.value?.startCreateFiltered();
}

function openAddNote() {
  showNewMenu.value = false;
  if (decks.value.length === 0) return;
  if (!activeDeckTid.value) {
    selectDeck(decks.value[0]!.tid);
  }
  ioCreateMode.value = false;
  showNoteEditor.value = true;
}

async function openAddImageOcclusion() {
  showNewMenu.value = false;
  if (decks.value.length === 0) return;
  if (!activeDeckTid.value) {
    selectDeck(decks.value[0]!.tid);
  }
  // Ensure IO noteType exists
  await ensureIONoteType();
  await loadDecks(); // refresh noteTypes
  ioCreateMode.value = true;
  showNoteEditor.value = true;
}

async function ensureIONoteType() {
  const existing = noteTypes.value.find((nt) =>
    nt.fields.some((f) => f.name === "Occlusions"),
  );
  if (existing) return;

  const { generateTid } = await import("./scheduler/bridge");
  const { noteTypesDb } = await import("./db/noteTypes");
  const now = new Date().toISOString();
  await noteTypesDb.put({
    tid: generateTid(),
    name: "Image Occlusion",
    isCloze: true,
    fields: [
      { id: "f0", name: "Image Occlusion" },
      { id: "f1", name: "Header" },
      { id: "f2", name: "Back Extra" },
      { id: "f3", name: "Occlusions" },
    ],
    templates: [
      {
        id: "io",
        name: "Image Occlusion",
        qfmt: "{{#Header}}<div class='io-header'>{{Header}}</div>{{/Header}}<div class='io-container'>{{Image Occlusion}}</div>",
        afmt: "{{#Header}}<div class='io-header'>{{Header}}</div>{{/Header}}<div class='io-container'>{{Image Occlusion}}</div>{{#Back Extra}}<hr><div class='io-back-extra'>{{Back Extra}}</div>{{/Back Extra}}",
      },
    ],
    createdAt: now,
    updatedAt: now,
  });
}

function openCsvImport() {
  showNewMenu.value = false;
  activeView.value = "csv-import";
}

async function clearData() {
  if (!confirm("Delete all decks, notes, and review history? This cannot be undone.")) return;
  await deleteDb();
  window.location.reload();
}

function handleNoteSaved() {
  showNoteEditor.value = false;
  loadDecks();
}

function triggerImport() {
  importFileInput.value?.click();
}

async function handleImportFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  activeView.value = "import";
  await importFile(file);
}
</script>

<template>
  <div class="min-h-screen bg-canvas text-fg">
    <header class="sticky top-0 z-30 backdrop-blur-md bg-canvas/85 border-b border-line">
      <div class="max-w-4xl mx-auto px-4 h-14 flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <button
            v-if="activeView !== 'decks'"
            class="btn-icon"
            aria-label="Back to decks"
            @click="goHome"
          >
            <span class="text-base">←</span>
          </button>
          <h1 class="text-[15px] font-semibold tracking-tight truncate">
            <span class="text-accent">decay</span><span class="text-fg-muted">.</span>cards
          </h1>
        </div>

        <div class="flex items-center gap-1.5">
          <div v-if="activeView === 'decks'" class="relative" data-new-menu>
            <button
              class="btn-pill"
              style="background: var(--c-accent); color: var(--c-accent-fg)"
              @click.stop="showNewMenu = !showNewMenu"
            >
              + New
            </button>
            <div v-if="showNewMenu" class="absolute right-0 top-full mt-1 w-44 bg-surface border border-line rounded-[var(--r-md)] shadow-lg py-1 z-50">
              <button class="w-full text-left px-3 py-1.5 text-sm hover:bg-elevated" @click="openNewDeck">
                New deck
              </button>
              <button class="w-full text-left px-3 py-1.5 text-sm hover:bg-elevated" @click="openNewFilteredDeck">
                Filtered deck
              </button>
              <button class="w-full text-left px-3 py-1.5 text-sm hover:bg-elevated" :disabled="decks.length === 0" @click="openAddNote">
                New note
              </button>
              <button class="w-full text-left px-3 py-1.5 text-sm hover:bg-elevated" :disabled="decks.length === 0" @click="openAddImageOcclusion">
                Image occlusion
              </button>
              <hr class="my-1 border-line" />
              <button class="w-full text-left px-3 py-1.5 text-sm hover:bg-elevated" @click="openCsvImport">
                Import CSV
              </button>
            </div>
          </div>
          <button v-if="activeView === 'decks'" class="btn-pill" @click="activeView = 'browse'">
            Browse
          </button>
          <button
            v-if="activeView === 'decks'"
            class="btn-pill"
            @click="triggerImport"
          >
            Import
          </button>
          <input
            ref="importFileInput"
            type="file"
            accept=".apkg,.colpkg"
            class="hidden"
            @change="handleImportFile"
          />

          <button class="btn-icon" :title="themeLabel" :aria-label="themeLabel" @click="cycleTheme">
            <span class="text-base leading-none">{{ themeIcon }}</span>
          </button>

          <button
            v-if="activeView === 'decks' && decks.length > 0"
            class="btn-icon"
            title="Clear all data"
            aria-label="Clear all data"
            @click="clearData"
          >
            <span class="text-sm">⌫</span>
          </button>
        </div>
      </div>
    </header>

    <main>
      <DeckList v-if="activeView === 'decks'" :key="deckListKey" @study="startStudy" @settings="openSettings" />

      <StudyView
        v-else-if="activeView === 'study' && activeDeckTid && activeDeckUri"
        :deck-tid="activeDeckTid"
        :deck-uri="activeDeckUri"
        @finish="goHome"
      />

      <ImportView v-else-if="activeView === 'import'" @done="goHome" />

      <CsvImportView v-else-if="activeView === 'csv-import'" @done="goHome" />

      <CardBrowser v-else-if="activeView === 'browse'" @close="goHome" />

      <SettingsView
        v-else-if="activeView === 'settings' && activeDeck && activeDeckTid && activeDeckUri"
        :deck-tid="activeDeckTid"
        :deck-uri="activeDeckUri"
        :deck-name="activeDeck.name"
        @close="goHome"
      />
    </main>

    <NoteEditor
      v-if="showNoteEditor"
      :note="null"
      :decks="decks"
      :deck-uri="activeDeckUri ?? undefined"
      :note-types="ioCreateMode ? noteTypes.filter(nt => nt.fields.some(f => f.name === 'Occlusions')) : noteTypes"
      :initial-note-type-tid="ioCreateMode ? noteTypes.find(nt => nt.fields.some(f => f.name === 'Occlusions'))?.tid : undefined"
      @saved="handleNoteSaved"
      @close="showNoteEditor = false"
    />

    <DeckManager ref="deckManagerRef" @done="loadDecks(); deckListKey++" />
  </div>
</template>
