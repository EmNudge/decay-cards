<script setup lang="ts">
import { ref, watch, onBeforeUnmount, computed } from "vue";
import { useEditor, EditorContent } from "@tiptap/vue-3";
import StarterKit from "@tiptap/starter-kit";
import { ResizableImage } from "./ResizableImageExtension";
import { AudioChip } from "./AudioChipExtension";
import { mediaDb, normalizeMediaKey } from "../db/media";
import { generateTid } from "../scheduler/bridge";

const props = defineProps<{
  modelValue: string;
  fieldDescription?: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const showHtmlSource = ref(false);
const htmlSource = ref("");

// Media URL cache: filename → blob URL
const mediaUrls = ref(new Map<string, string>());

/** Next cloze number based on existing cloze deletions */
const nextClozeNumber = computed(() => {
  const matches = props.modelValue.matchAll(/\{\{c(\d+)::/g);
  let max = 0;
  for (const match of matches) {
    const num = parseInt(match[1]!, 10);
    if (num > max) max = num;
  }
  return max + 1;
});

/** Resolve a single media filename to a blob URL (cached) */
async function getMediaUrl(filename: string): Promise<string | null> {
  if (mediaUrls.value.has(filename)) return mediaUrls.value.get(filename)!;
  const key = normalizeMediaKey(filename);
  const media = await mediaDb.get(key);
  if (!media) return null;
  const url = URL.createObjectURL(media.blob);
  mediaUrls.value.set(filename, url);
  return url;
}

/**
 * Prepare HTML for Tiptap: resolve image src to blob URLs,
 * and convert [sound:file] to audioChip node HTML that Tiptap can parse.
 */
async function resolveMedia(html: string): Promise<string> {
  let result = html;

  // Resolve src="filename" → src="blob:..."
  const srcRegex = /src="([^"]+)"/g;
  const srcMatches = Array.from(result.matchAll(srcRegex));
  for (const match of srcMatches) {
    const filename = match[1]!;
    if (filename.startsWith("data:") || filename.startsWith("blob:") || filename.startsWith("http"))
      continue;
    const url = await getMediaUrl(filename);
    if (url) result = result.replaceAll(`src="${filename}"`, `src="${url}"`);
  }

  // Convert [sound:filename] → audioChip node HTML (parsed by the extension)
  const soundRegex = /\[sound:([^\]]+)\]/g;
  const soundMatches = Array.from(result.matchAll(soundRegex));
  for (const match of soundMatches) {
    const filename = match[1]!;
    const url = await getMediaUrl(filename);
    result = result.replace(
      match[0],
      `<span data-audio-chip data-filename="${filename}" data-src="${url ?? ""}"></span>`,
    );
  }

  return result;
}

/** Convert Tiptap HTML back to storage format: blob URLs → filenames, audioChip → [sound:] */
function unresolveMedia(html: string): string {
  let result = html;

  // Restore src="blob:..." → src="filename"
  for (const [name, url] of mediaUrls.value) {
    result = result.replaceAll(`src="${url}"`, `src="${name}"`);
  }

  // Restore audioChip nodes → [sound:filename]
  result = result.replace(
    /<span[^>]*data-audio-chip[^>]*data-filename="([^"]*)"[^>]*><\/span>/g,
    (_, filename: string) => `[sound:${filename}]`,
  );

  return result;
}

const editor = useEditor({
  content: "",
  extensions: [
    StarterKit,
    ResizableImage.configure({ inline: true, allowBase64: true }),
    AudioChip,
  ],
  onUpdate({ editor: e }) {
    emit("update:modelValue", unresolveMedia(e.getHTML()));
  },
});

// Initialize content with resolved media
resolveMedia(props.modelValue).then((html) => {
  editor.value?.commands.setContent(html);
});

watch(
  () => props.modelValue,
  async (val) => {
    if (!editor.value) return;
    const current = unresolveMedia(editor.value.getHTML());
    if (current !== val) {
      const resolved = await resolveMedia(val);
      editor.value.commands.setContent(resolved);
    }
  },
);

onBeforeUnmount(() => {
  if (isRecording.value) stopRecording();
  editor.value?.destroy();
  // Revoke blob URLs
  for (const url of mediaUrls.value.values()) {
    URL.revokeObjectURL(url);
  }
});

function insertCloze() {
  if (!editor.value) return;
  const { from, to } = editor.value.state.selection;
  const selectedText = editor.value.state.doc.textBetween(from, to, " ");
  const clozeNum = nextClozeNumber.value;
  const clozeText = selectedText ? `{{c${clozeNum}::${selectedText}}}` : `{{c${clozeNum}::}}`;
  editor.value.chain().focus().deleteSelection().insertContent(clozeText).run();
}

function insertLatex(type: "math" | "mathDisplay") {
  if (!editor.value) return;
  const { from, to } = editor.value.state.selection;
  const selectedText = editor.value.state.doc.textBetween(from, to, " ");
  const wrapped = type === "math" ? `[$]${selectedText}[/$]` : `[$$]${selectedText}[/$$]`;
  editor.value.chain().focus().deleteSelection().insertContent(wrapped).run();
}

function toggleHtmlSource() {
  if (!editor.value) return;
  if (showHtmlSource.value) {
    editor.value.commands.setContent(htmlSource.value);
    emit("update:modelValue", htmlSource.value);
    showHtmlSource.value = false;
  } else {
    htmlSource.value = unresolveMedia(editor.value.getHTML());
    showHtmlSource.value = true;
  }
}

function onHtmlSourceInput(e: Event) {
  const target = e.target as HTMLTextAreaElement;
  htmlSource.value = target.value;
  emit("update:modelValue", target.value);
}

// Audio recording
const isRecording = ref(false);
const recordingDuration = ref(0);
let mediaRecorder: MediaRecorder | null = null;
let recordingChunks: Blob[] = [];
let recordingTimer: ReturnType<typeof setInterval> | null = null;

async function toggleRecording() {
  if (isRecording.value) {
    stopRecording();
  } else {
    await startRecording();
  }
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordingChunks = [];
    recordingDuration.value = 0;

    mediaRecorder = new MediaRecorder(stream, {
      mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm",
    });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordingChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      if (recordingTimer) {
        clearInterval(recordingTimer);
        recordingTimer = null;
      }

      if (recordingChunks.length === 0) return;

      const blob = new Blob(recordingChunks, { type: "audio/webm" });
      const filename = `recording_${generateTid()}.webm`;
      const now = new Date().toISOString();

      await mediaDb.put({
        normalizedKey: normalizeMediaKey(filename),
        filename,
        blob,
        mimeType: "audio/webm",
        createdAt: now,
        updatedAt: now,
      });

      // Cache the blob URL
      const url = URL.createObjectURL(blob);
      mediaUrls.value.set(filename, url);

      // Insert audio chip into editor
      if (editor.value) {
        editor.value
          .chain()
          .focus()
          .insertContent(
            `<span data-audio-chip data-filename="${filename}" data-src="${url}"></span>`,
          )
          .run();
      }
    };

    mediaRecorder.start();
    isRecording.value = true;
    recordingTimer = setInterval(() => {
      recordingDuration.value++;
    }, 1000);
  } catch {
    // Permission denied or no mic
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  isRecording.value = false;
}

function formatRecordingTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
</script>

<template>
  <div v-if="editor" class="tiptap-wrapper">
    <div class="tiptap-toolbar">
      <template v-if="!showHtmlSource">
        <button
          type="button"
          :class="['tb', { active: editor.isActive('bold') }]"
          title="Bold"
          @click="editor.chain().focus().toggleBold().run()"
        >
          <strong>B</strong>
        </button>
        <button
          type="button"
          :class="['tb', { active: editor.isActive('italic') }]"
          title="Italic"
          @click="editor.chain().focus().toggleItalic().run()"
        >
          <em>I</em>
        </button>
        <button
          type="button"
          :class="['tb', { active: editor.isActive('strike') }]"
          title="Strikethrough"
          @click="editor.chain().focus().toggleStrike().run()"
        >
          <s>S</s>
        </button>
        <button
          type="button"
          :class="['tb', { active: editor.isActive('code') }]"
          title="Code"
          @click="editor.chain().focus().toggleCode().run()"
        >
          &lt;/&gt;
        </button>
        <span class="sep" />
        <button
          type="button"
          :class="['tb', { active: editor.isActive('bulletList') }]"
          title="Bullet list"
          @click="editor.chain().focus().toggleBulletList().run()"
        >
          &bull;
        </button>
        <button
          type="button"
          :class="['tb', { active: editor.isActive('orderedList') }]"
          title="Ordered list"
          @click="editor.chain().focus().toggleOrderedList().run()"
        >
          1.
        </button>
        <span class="sep" />
        <button type="button" class="tb" title="Cloze deletion" @click="insertCloze">[…]</button>
        <button type="button" class="tb" title="Inline math [$]…[/$]" @click="insertLatex('math')">
          $
        </button>
        <button
          type="button"
          class="tb"
          title="Display math [$$]…[/$$]"
          @click="insertLatex('mathDisplay')"
        >
          $$
        </button>
        <span class="sep" />
        <button type="button" class="tb" title="Undo" @click="editor.chain().focus().undo().run()">
          ↩
        </button>
        <button type="button" class="tb" title="Redo" @click="editor.chain().focus().redo().run()">
          ↪
        </button>
        <span class="sep" />
        <button
          type="button"
          :class="['tb', { active: isRecording }]"
          :style="isRecording ? { color: 'var(--c-again)' } : {}"
          :title="isRecording ? 'Stop recording' : 'Record audio'"
          @click="toggleRecording"
        >
          <template v-if="isRecording">⏹ {{ formatRecordingTime(recordingDuration) }}</template>
          <template v-else>🎙</template>
        </button>
      </template>
      <span v-if="!showHtmlSource" class="sep" />
      <button
        type="button"
        :class="['tb', { active: showHtmlSource }]"
        title="Toggle HTML source"
        @click="toggleHtmlSource"
      >
        HTML
      </button>
    </div>

    <EditorContent v-if="!showHtmlSource" :editor="editor" class="tiptap-content" />
    <textarea
      v-else
      class="html-source"
      :value="htmlSource"
      spellcheck="false"
      @input="onHtmlSourceInput"
    />
    <div v-if="fieldDescription" class="field-desc">{{ fieldDescription }}</div>
  </div>
</template>

<style scoped>
.tiptap-wrapper {
  border: 1px solid var(--c-line);
  border-radius: var(--r-md);
  overflow: hidden;
  background: var(--c-surface);
}
.tiptap-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border-bottom: 1px solid var(--c-line);
  background: var(--c-canvas);
  flex-wrap: wrap;
}
.tb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  height: 28px;
  padding: 0 4px;
  font-size: 13px;
  font-weight: 600;
  color: var(--c-fg-muted);
  background: transparent;
  border: none;
  border-radius: var(--r-sm);
  cursor: pointer;
}
.tb:hover {
  color: var(--c-fg);
  background: var(--c-hover);
}
.tb.active {
  color: var(--c-fg);
  background: var(--c-elevated);
  box-shadow: var(--shadow-sm);
}
.sep {
  width: 1px;
  height: 18px;
  margin: 0 3px;
  background: var(--c-line);
}
.tiptap-content {
  min-height: 80px;
  max-height: 300px;
  overflow-y: auto;
}
.tiptap-content :deep(.tiptap) {
  padding: 10px;
  font-size: 14px;
  color: var(--c-fg);
  outline: none;
  min-height: 80px;
}
.tiptap-content :deep(.tiptap p) {
  margin: 0 0 0.5em;
}
.tiptap-content :deep(.tiptap p:last-child) {
  margin-bottom: 0;
}
.tiptap-content :deep(.tiptap img) {
  max-width: 100%;
  height: auto;
  border-radius: var(--r-sm);
}
.tiptap-content :deep(.tiptap ul) {
  padding-left: 1.5em;
  margin: 0 0 0.5em;
  list-style: disc;
}
.tiptap-content :deep(.tiptap ol) {
  padding-left: 1.5em;
  margin: 0 0 0.5em;
  list-style: decimal;
}
.tiptap-content :deep(.tiptap li) {
  display: list-item;
}
.tiptap-content :deep(.tiptap code) {
  padding: 1px 4px;
  font-family: ui-monospace, monospace;
  font-size: 0.9em;
  background: var(--c-canvas);
  border-radius: 3px;
}
.tiptap-content :deep(.tiptap pre) {
  padding: 10px;
  font-family: ui-monospace, monospace;
  font-size: 13px;
  background: var(--c-canvas);
  border-radius: var(--r-sm);
  overflow-x: auto;
}
.tiptap-content :deep(.tiptap blockquote) {
  padding-left: 12px;
  border-left: 3px solid var(--c-line);
  color: var(--c-fg-muted);
  margin: 0 0 0.5em;
}
.html-source {
  width: 100%;
  min-height: 80px;
  max-height: 300px;
  padding: 10px;
  font-family: ui-monospace, monospace;
  font-size: 13px;
  color: var(--c-fg);
  background: var(--c-surface);
  border: none;
  outline: none;
  resize: vertical;
  box-sizing: border-box;
}
.field-desc {
  padding: 4px 10px;
  font-size: 11px;
  color: var(--c-fg-subtle);
  border-top: 1px solid var(--c-line);
  background: var(--c-canvas);
}
</style>
