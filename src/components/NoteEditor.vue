<script setup lang="ts">
import { ref, watch, computed } from "vue";
import type { NoteRecord, NoteTypeRecord, DeckRecord } from "../db/schema";
import { notesDb } from "../db/notes";
import { noteTypesDb } from "../db/noteTypes";
import { generateTid } from "../scheduler/bridge";
import TiptapEditor from "./TiptapEditor.vue";
import ImageOcclusionEditor from "./ImageOcclusionEditor.vue";
import {
  IO_FIELD_NAMES,
  parseOcclusionShapesForEditor,
  serializeShapesToSvg,
  extractOcclusionMode,
  type OcclusionShape,
  type OcclusionMode,
} from "../utils/imageOcclusion";
import { mediaDb, normalizeMediaKey } from "../db/media";

const props = defineProps<{
  /** Note to edit, or null for create mode */
  note: NoteRecord | null;
  /** Deck URI for new notes */
  deckUri?: string;
  /** Available decks */
  decks: DeckRecord[];
  /** Available noteTypes */
  noteTypes: NoteTypeRecord[];
  /** Pre-select a noteType TID (for IO create flow) */
  initialNoteTypeTid?: string;
}>();

const emit = defineEmits<{
  saved: [note: NoteRecord];
  close: [];
}>();

const isCreate = computed(() => !props.note);
const selectedDeckUri = ref(props.deckUri ?? (props.decks[0] ? `at://self/cards.decay.flashcard.deck/${props.decks[0].tid}` : ""));
const selectedNoteTypeTid = ref(props.initialNoteTypeTid ?? props.noteTypes[0]?.tid ?? "");
const fields = ref<Record<string, string>>({});
const tags = ref<string[]>([]);
const newTag = ref("");

// Image Occlusion state
const ioShapes = ref<OcclusionShape[]>([]);
const ioMode = ref<OcclusionMode>("hide-all-guess-one");
const ioImageUrl = ref("");
const ioImageFile = ref<File | null>(null);
const ioImageWidth = ref(800);
const ioImageHeight = ref(600);
const ioFileInput = ref<HTMLInputElement>();

function onIOImageSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  ioImageFile.value = file;
  ioImageUrl.value = URL.createObjectURL(file);
  // Set the Image Occlusion field with an img tag
  const nt = activeNoteType.value;
  if (nt) {
    const imgField = nt.fields.find((f) => f.name === IO_FIELD_NAMES.image);
    if (imgField) {
      fields.value[imgField.id] = `<img src="${file.name}">`;
    }
  }
  // Load natural dimensions
  const img = new Image();
  img.onload = () => {
    ioImageWidth.value = img.naturalWidth;
    ioImageHeight.value = img.naturalHeight;
  };
  img.src = ioImageUrl.value;
}

const activeNoteType = computed(() =>
  props.noteTypes.find((nt) => nt.tid === selectedNoteTypeTid.value),
);

const isIO = computed(() => {
  const nt = activeNoteType.value;
  if (!nt) return false;
  return nt.fields.some((f) => f.name === IO_FIELD_NAMES.occlusions);
});

// Initialize from props
watch(
  () => props.note,
  (note) => {
    if (note) {
      // Edit mode
      const nt = props.noteTypes.find(
        (t) => `at://self/cards.decay.flashcard.noteType/${t.tid}` === note.noteType,
      );
      if (nt) {
        selectedNoteTypeTid.value = nt.tid;
        const fieldMap: Record<string, string> = {};
        for (const f of note.fields) {
          const def = nt.fields.find((fd) => fd.id === f.fieldId);
          if (def) fieldMap[def.id] = f.value;
        }
        fields.value = fieldMap;
      }
      tags.value = [...(note.tags ?? [])];

      // Load IO data if applicable
      if (isIO.value) {
        loadIOData(nt, note);
      }
    } else {
      // Create mode — initialize empty fields
      resetFields();
    }
  },
  { immediate: true },
);

async function loadIOData(nt: NoteTypeRecord, note: NoteRecord) {
  // Find occlusions field
  const occField = nt.fields.find((f) => f.name === IO_FIELD_NAMES.occlusions);
  const imgField = nt.fields.find((f) => f.name === IO_FIELD_NAMES.image);
  if (!occField || !imgField) return;

  const occValue = note.fields.find((f) => f.fieldId === occField.id)?.value ?? "";
  const imgValue = note.fields.find((f) => f.fieldId === imgField.id)?.value ?? "";

  // Parse shapes
  ioShapes.value = parseOcclusionShapesForEditor(occValue);
  ioMode.value = extractOcclusionMode(occValue);

  // Resolve image URL
  const srcMatch = imgValue.match(/src="([^"]+)"/);
  if (srcMatch) {
    const filename = srcMatch[1]!;
    const key = normalizeMediaKey(filename);
    const media = await mediaDb.get(key);
    if (media) {
      ioImageUrl.value = URL.createObjectURL(media.blob);
    }
  }
}

watch(selectedNoteTypeTid, () => {
  if (isCreate.value) resetFields();
});

function resetFields() {
  const nt = activeNoteType.value;
  if (!nt) return;
  const fieldMap: Record<string, string> = {};
  for (const f of nt.fields) {
    fieldMap[f.id] = "";
  }
  fields.value = fieldMap;
  tags.value = [];
}

function addTag() {
  const t = newTag.value.trim();
  if (t && !tags.value.includes(t)) {
    tags.value.push(t);
  }
  newTag.value = "";
}

function removeTag(idx: number) {
  tags.value.splice(idx, 1);
}

async function save() {
  const nt = activeNoteType.value;
  if (!nt) return;

  const now = new Date().toISOString();

  // If IO, serialize shapes and save image to media
  if (isIO.value && ioShapes.value.length > 0) {
    const occField = nt.fields.find((f) => f.name === IO_FIELD_NAMES.occlusions);
    if (occField) {
      fields.value[occField.id] = serializeShapesToSvg(ioShapes.value, ioImageWidth.value, ioImageHeight.value, ioMode.value);
    }

    // Save image file to media collection if it's a new file
    if (ioImageFile.value) {
      const filename = ioImageFile.value.name;
      const key = normalizeMediaKey(filename);
      const existing = await mediaDb.get(key);
      if (!existing) {
        await mediaDb.put({
          normalizedKey: key,
          filename,
          blob: ioImageFile.value,
          mimeType: ioImageFile.value.type,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }

  const noteFields = nt.fields.map((f) => ({
    fieldId: f.id,
    value: fields.value[f.id] ?? "",
  }));

  if (props.note) {
    // Edit
    const updated: NoteRecord = {
      tid: props.note.tid,
      deck: props.note.deck,
      noteType: props.note.noteType,
      ankiNoteId: props.note.ankiNoteId,
      forkedFrom: props.note.forkedFrom,
      fields: noteFields,
      tags: tags.value.length > 0 ? [...tags.value] : undefined,
      createdAt: props.note.createdAt,
      updatedAt: now,
    };
    await notesDb.put(updated);
    emit("saved", updated);
  } else {
    // Create
    const tid = generateTid();
    const note: NoteRecord = {
      tid,
      deck: selectedDeckUri.value,
      noteType: `at://self/cards.decay.flashcard.noteType/${nt.tid}`,
      fields: noteFields,
      tags: tags.value.length > 0 ? [...tags.value] : undefined,
      createdAt: now,
      updatedAt: now,
    };
    await notesDb.put(note);
    emit("saved", note);
  }
}

function fieldLabel(fieldId: string): string {
  return activeNoteType.value?.fields.find((f) => f.id === fieldId)?.name ?? fieldId;
}
</script>

<template>
  <div
    class="fixed inset-0 modal-backdrop flex items-center justify-center z-50 p-4"
    @click.self="emit('close')"
  >
    <div class="modal-panel w-full max-w-2xl max-h-[90vh] flex flex-col">
      <div class="flex justify-between items-center px-5 py-3.5 border-b border-line">
        <h2 class="font-semibold tracking-tight">{{ isCreate ? "Add note" : "Edit note" }}</h2>
        <button class="btn-icon" aria-label="Close" @click="emit('close')">✕</button>
      </div>

      <div class="flex-1 overflow-y-auto p-5 space-y-4">
        <div v-if="isCreate" class="flex gap-3">
          <div class="flex-1">
            <label class="field-label">Deck</label>
            <select v-model="selectedDeckUri" class="field-input">
              <option v-for="d in decks" :key="d.tid" :value="`at://self/cards.decay.flashcard.deck/${d.tid}`">{{ d.name }}</option>
            </select>
          </div>
          <div v-if="noteTypes.length > 1" class="flex-1">
            <label class="field-label">Note type</label>
            <select v-model="selectedNoteTypeTid" class="field-input">
              <option v-for="nt in noteTypes" :key="nt.tid" :value="nt.tid">{{ nt.name }}</option>
            </select>
          </div>
        </div>

        <!-- Image Occlusion -->
        <template v-if="isIO">
          <!-- Image picker (when no image loaded yet) -->
          <div v-if="!ioImageUrl" class="border-2 border-dashed border-line-strong rounded-[var(--r-lg)] p-10 text-center cursor-pointer hover:border-accent hover:bg-accent-soft" @click="ioFileInput?.click()">
            <div class="text-3xl mb-2 opacity-50">🖼</div>
            <p class="font-medium mb-1">Select an image</p>
            <p class="text-sm text-fg-muted">Click to choose or paste from clipboard</p>
            <input ref="ioFileInput" type="file" accept="image/*" class="hidden" @change="onIOImageSelected">
          </div>

          <!-- IO Editor (when image is loaded) -->
          <template v-if="ioImageUrl">
            <ImageOcclusionEditor
              :image-url="ioImageUrl"
              :model-value="ioShapes"
              :occlusion-mode="ioMode"
              @update:model-value="ioShapes = $event"
              @update:occlusion-mode="ioMode = $event"
            />
            <p class="text-xs text-fg-muted">Draw rectangles or ellipses to create masks. Each mask generates one card.</p>
          </template>

          <!-- Header and Back Extra fields -->
          <template v-for="(_, fieldId) in fields" :key="fieldId">
            <div v-if="fieldLabel(String(fieldId)) === 'Header' || fieldLabel(String(fieldId)) === 'Back Extra'">
              <label class="field-label">{{ fieldLabel(String(fieldId)) }}</label>
              <TiptapEditor
                :model-value="fields[fieldId] ?? ''"
                @update:model-value="(v: string) => (fields[fieldId] = v)"
              />
            </div>
          </template>
        </template>

        <!-- Regular field editors -->
        <template v-else>
          <div v-for="(_, fieldId) in fields" :key="fieldId">
            <label class="field-label">{{ fieldLabel(String(fieldId)) }}</label>
            <TiptapEditor
              :model-value="fields[fieldId] ?? ''"
              @update:model-value="(v: string) => (fields[fieldId] = v)"
            />
          </div>
        </template>

        <div>
          <label class="field-label">Tags</label>
          <div v-if="tags.length > 0" class="flex flex-wrap gap-1.5 mb-2">
            <span v-for="(tag, i) in tags" :key="tag" class="chip">
              {{ tag }}
              <button class="text-fg-subtle hover:text-fg" @click="removeTag(i)">&times;</button>
            </span>
          </div>
          <div class="flex gap-2">
            <input
              v-model="newTag"
              type="text"
              placeholder="Add tag…"
              class="field-input flex-1"
              @keydown.enter.prevent="addTag"
            />
            <button class="btn-secondary" @click="addTag">Add</button>
          </div>
        </div>
      </div>

      <div class="flex justify-end gap-2 px-5 py-3.5 border-t border-line">
        <button class="btn-secondary" @click="emit('close')">Cancel</button>
        <button class="btn-primary" @click="save">{{ isCreate ? "Add" : "Save" }}</button>
      </div>
    </div>
  </div>
</template>
