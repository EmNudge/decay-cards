<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import { mediaDb, normalizeMediaKey } from "../db/media";

const props = defineProps<{
  filename: string;
  src: string;
}>();

const emit = defineEmits<{
  saved: [newSrc: string];
  close: [];
}>();

const canvasRef = ref<HTMLCanvasElement>();
const containerRef = ref<HTMLDivElement>();
const audioCtx = ref<AudioContext>();
const audioBuffer = ref<AudioBuffer | null>(null);
const duration = ref(0);

// Trim handles (0-1 normalized) — define what to keep on save
const trimStart = ref(0);
const trimEnd = ref(1);

// Cut selection (0-1 normalized) — a separate region to cut out
const selStart = ref<number | null>(null);
const selEnd = ref<number | null>(null);
const hasSelection = computed(() => selStart.value !== null && selEnd.value !== null && selStart.value !== selEnd.value);

// Playback
const isPlaying = ref(false);
const playbackPos = ref(0);
let sourceNode: AudioBufferSourceNode | null = null;
let animFrame: number | null = null;
let playStartTime = 0;
let playStartOffset = 0;

// Dragging state
const dragging = ref<"trimStart" | "trimEnd" | "sel" | null>(null);
const cursorStyle = ref("crosshair");

// Undo stack
const undoStack = ref<AudioBuffer[]>([]);
const canUndo = computed(() => undoStack.value.length > 0);

// Save state
const isSaving = ref(false);

onMounted(async () => {
  audioCtx.value = new AudioContext();
  const response = await fetch(props.src);
  const arrayBuffer = await response.arrayBuffer();
  audioBuffer.value = await audioCtx.value.decodeAudioData(arrayBuffer);
  duration.value = audioBuffer.value.duration;
  drawWaveform();
});

onBeforeUnmount(() => {
  stopPlayback();
  if (animFrame) cancelAnimationFrame(animFrame);
  audioCtx.value?.close();
});

watch([trimStart, trimEnd, selStart, selEnd], () => {
  drawWaveform();
});

function drawWaveform() {
  const canvas = canvasRef.value;
  const buffer = audioBuffer.value;
  if (!canvas || !buffer) return;

  const ctx = canvas.getContext("2d")!;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const width = rect.width;
  const height = rect.height;
  const styles = getComputedStyle(document.documentElement);

  ctx.clearRect(0, 0, width, height);

  // Draw dimmed regions (outside trim bounds)
  const tStartX = trimStart.value * width;
  const tEndX = trimEnd.value * width;

  ctx.fillStyle = styles.getPropertyValue("--c-active").trim() || "rgba(0,0,0,0.3)";
  ctx.fillRect(0, 0, tStartX, height);
  ctx.fillRect(tEndX, 0, width - tEndX, height);

  // Draw cut selection highlight (red-ish)
  if (selStart.value !== null && selEnd.value !== null) {
    const sLeft = Math.min(selStart.value, selEnd.value) * width;
    const sRight = Math.max(selStart.value, selEnd.value) * width;
    ctx.fillStyle = styles.getPropertyValue("--c-again-soft").trim() || "rgba(229,72,77,0.2)";
    ctx.fillRect(sLeft, 0, sRight - sLeft, height);
  }

  // Draw waveform
  const data = buffer.getChannelData(0);
  const step = Math.ceil(data.length / width);
  const mid = height / 2;

  ctx.beginPath();
  ctx.strokeStyle = styles.getPropertyValue("--c-accent").trim() || "#208bfe";
  ctx.lineWidth = 1;

  for (let i = 0; i < width; i++) {
    const start = i * step;
    let min = 1, max = -1;
    for (let j = 0; j < step && start + j < data.length; j++) {
      const val = data[start + j]!;
      if (val < min) min = val;
      if (val > max) max = val;
    }
    const y1 = mid + min * mid * 0.9;
    const y2 = mid + max * mid * 0.9;
    ctx.moveTo(i, y1);
    ctx.lineTo(i, y2);
  }
  ctx.stroke();

  // Draw trim handles
  const accentColor = styles.getPropertyValue("--c-accent").trim() || "#208bfe";
  ctx.fillStyle = accentColor;
  // Start handle
  ctx.fillRect(tStartX, 0, 3, height);
  // End handle
  ctx.fillRect(tEndX - 3, 0, 3, height);

  // Draw cut selection handles (red)
  if (selStart.value !== null && selEnd.value !== null) {
    const againColor = styles.getPropertyValue("--c-again").trim() || "#e5484d";
    ctx.fillStyle = againColor;
    const sLeftX = Math.min(selStart.value, selEnd.value) * width;
    const sRightX = Math.max(selStart.value, selEnd.value) * width;
    ctx.fillRect(sLeftX, 0, 2, height);
    ctx.fillRect(sRightX - 2, 0, 2, height);
  }

  // Draw playhead
  if (isPlaying.value || playbackPos.value > 0) {
    const phX = playbackPos.value * width;
    ctx.fillStyle = styles.getPropertyValue("--c-fg").trim() || "#fff";
    ctx.fillRect(phX - 1, 0, 2, height);
  }
}

function getHandleAt(x: number): "trimStart" | "trimEnd" | null {
  const threshold = 0.025;
  const startDist = Math.abs(x - trimStart.value);
  const endDist = Math.abs(x - trimEnd.value);
  if (startDist < threshold && startDist <= endDist) return "trimStart";
  if (endDist < threshold) return "trimEnd";
  return null;
}

function onPointerDown(e: PointerEvent) {
  const rect = canvasRef.value!.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const handle = getHandleAt(x);

  if (handle) {
    // Dragging a trim handle
    dragging.value = handle;
    cursorStyle.value = "ew-resize";
  } else {
    // Click-drag to create a cut selection
    selStart.value = x;
    selEnd.value = x;
    dragging.value = "sel";
    cursorStyle.value = "crosshair";
  }
  containerRef.value!.setPointerCapture(e.pointerId);
}

function onPointerMove(e: PointerEvent) {
  const rect = canvasRef.value!.getBoundingClientRect();
  const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

  if (!dragging.value) {
    const handle = getHandleAt(x);
    cursorStyle.value = handle ? "ew-resize" : "crosshair";
    return;
  }

  if (dragging.value === "trimStart") {
    trimStart.value = Math.min(x, trimEnd.value - 0.01);
  } else if (dragging.value === "trimEnd") {
    trimEnd.value = Math.max(x, trimStart.value + 0.01);
  } else if (dragging.value === "sel") {
    selEnd.value = x;
  }
}

function onPointerUp(e: PointerEvent) {
  dragging.value = null;
  const rect = canvasRef.value!.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const handle = getHandleAt(x);
  cursorStyle.value = handle ? "ew-resize" : "crosshair";

  // Clear selection if it's too tiny (accidental click)
  if (selStart.value !== null && selEnd.value !== null) {
    if (Math.abs(selEnd.value - selStart.value) < 0.005) {
      selStart.value = null;
      selEnd.value = null;
      drawWaveform();
    }
  }
}

function togglePlayback() {
  if (isPlaying.value) {
    stopPlayback();
  } else {
    startPlayback();
  }
}

function startPlayback() {
  if (!audioCtx.value || !audioBuffer.value) return;

  const ctx = audioCtx.value;
  if (ctx.state === "suspended") ctx.resume();

  const startSec = trimStart.value * duration.value;
  const endSec = trimEnd.value * duration.value;
  const playDuration = endSec - startSec;

  sourceNode = ctx.createBufferSource();
  sourceNode.buffer = audioBuffer.value;
  sourceNode.connect(ctx.destination);
  sourceNode.onended = () => {
    isPlaying.value = false;
    playbackPos.value = trimEnd.value;
    if (animFrame) cancelAnimationFrame(animFrame);
    drawWaveform();
  };

  const offset = playbackPos.value >= trimStart.value && playbackPos.value < trimEnd.value
    ? playbackPos.value * duration.value
    : startSec;

  const remainingDuration = endSec - offset;
  sourceNode.start(0, offset, remainingDuration);
  playStartTime = ctx.currentTime;
  playStartOffset = offset;
  isPlaying.value = true;
  animatePlayhead();
}

function stopPlayback() {
  if (sourceNode) {
    sourceNode.onended = null;
    sourceNode.stop();
    sourceNode = null;
  }
  isPlaying.value = false;
  if (animFrame) {
    cancelAnimationFrame(animFrame);
    animFrame = null;
  }
  drawWaveform();
}

function animatePlayhead() {
  if (!isPlaying.value || !audioCtx.value) return;
  const elapsed = audioCtx.value.currentTime - playStartTime;
  const currentSec = playStartOffset + elapsed;
  playbackPos.value = currentSec / duration.value;
  drawWaveform();
  animFrame = requestAnimationFrame(animatePlayhead);
}

const trimmedDuration = computed(() => {
  const secs = (trimEnd.value - trimStart.value) * duration.value;
  return formatTime(secs);
});

const totalDuration = computed(() => formatTime(duration.value));

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 10);
  return `${m}:${s.toString().padStart(2, "0")}.${ms}`;
}

/** Cut out the red selection region and join the remaining parts */
function cutSelection() {
  if (!audioBuffer.value || selStart.value === null || selEnd.value === null) return;
  const buffer = audioBuffer.value;
  const cutFrom = Math.min(selStart.value, selEnd.value);
  const cutTo = Math.max(selStart.value, selEnd.value);
  const startSample = Math.floor(cutFrom * buffer.length);
  const endSample = Math.floor(cutTo * buffer.length);

  if (endSample - startSample < 1) return;

  // Save current buffer for undo
  undoStack.value = [...undoStack.value, buffer];

  const beforeLength = startSample;
  const afterLength = buffer.length - endSample;
  const newLength = beforeLength + afterLength;

  if (newLength === 0) return;

  const newBuffer = new AudioBuffer({
    numberOfChannels: buffer.numberOfChannels,
    length: newLength,
    sampleRate: buffer.sampleRate,
  });

  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const oldData = buffer.getChannelData(ch);
    const newData = newBuffer.getChannelData(ch);
    // Copy before cut
    newData.set(oldData.subarray(0, startSample), 0);
    // Copy after cut
    newData.set(oldData.subarray(endSample), beforeLength);
  }

  stopPlayback();
  audioBuffer.value = newBuffer;
  duration.value = newBuffer.duration;
  selStart.value = null;
  selEnd.value = null;
  trimStart.value = 0;
  trimEnd.value = 1;
  playbackPos.value = 0;
  drawWaveform();
}

function undo() {
  if (undoStack.value.length === 0) return;
  const prev = undoStack.value[undoStack.value.length - 1]!;
  undoStack.value = undoStack.value.slice(0, -1);

  stopPlayback();
  audioBuffer.value = prev;
  duration.value = prev.duration;
  trimStart.value = 0;
  trimEnd.value = 1;
  selStart.value = null;
  selEnd.value = null;
  playbackPos.value = 0;
  drawWaveform();
}

function clearSelection() {
  selStart.value = null;
  selEnd.value = null;
  drawWaveform();
}

async function save() {
  if (!audioBuffer.value || !audioCtx.value || isSaving.value) return;
  isSaving.value = true;
  try {
    await doSave();
  } finally {
    isSaving.value = false;
  }
}

async function doSave() {
  if (!audioBuffer.value || !audioCtx.value) return;

  const buffer = audioBuffer.value;
  const sampleRate = buffer.sampleRate;
  const channels = buffer.numberOfChannels;
  const startSample = Math.floor(trimStart.value * buffer.length);
  const endSample = Math.floor(trimEnd.value * buffer.length);
  const trimmedLength = endSample - startSample;

  // Create offline context to render the selected region
  const offlineCtx = new OfflineAudioContext(channels, trimmedLength, sampleRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(offlineCtx.destination);
  source.start(0, trimStart.value * buffer.duration, (trimEnd.value - trimStart.value) * buffer.duration);

  const rendered = await offlineCtx.startRendering();

  // Encode as Opus/WebM (much smaller than WAV)
  const encodedBlob = await encodeAsWebm(rendered);
  const now = new Date().toISOString();

  // Overwrite the existing media entry with the same filename so references stay valid
  const key = normalizeMediaKey(props.filename);

  await mediaDb.put({
    normalizedKey: key,
    filename: props.filename,
    blob: encodedBlob,
    mimeType: encodedBlob.type,
    createdAt: now,
    updatedAt: now,
  });

  const newSrc = URL.createObjectURL(encodedBlob);
  emit("saved", newSrc);
}

/**
 * Encode an AudioBuffer as Opus/WebM using MediaRecorder.
 * Falls back to WAV if WebM is not supported.
 */
function encodeAsWebm(buffer: AudioBuffer): Promise<Blob> {
  return new Promise((resolve) => {
    const ctx = new AudioContext({ sampleRate: buffer.sampleRate });
    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const dest = ctx.createMediaStreamDestination();
    source.connect(dest);

    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";

    const recorder = new MediaRecorder(dest.stream, { mimeType });
    const chunks: Blob[] = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = () => {
      ctx.close();
      resolve(new Blob(chunks, { type: mimeType }));
    };

    recorder.start();
    source.start();
    source.onended = () => {
      // Small delay to ensure all data is flushed
      setTimeout(() => recorder.stop(), 50);
    };
  });
}
</script>

<template>
  <div
    class="fixed inset-0 modal-backdrop flex items-center justify-center z-50 p-4"
    @click.self="emit('close')"
  >
    <div class="modal-panel w-full max-w-lg">
      <div class="flex justify-between items-center px-5 py-3.5 border-b border-line">
        <h2 class="font-semibold tracking-tight">Trim audio</h2>
        <button class="btn-icon" aria-label="Close" @click="emit('close')">✕</button>
      </div>

      <div class="p-5 space-y-4">
        <!-- Waveform -->
        <div
          ref="containerRef"
          class="relative select-none"
          :style="{ cursor: cursorStyle, '-webkit-user-drag': 'none', 'touch-action': 'none' }"
          @pointerdown.prevent="onPointerDown"
          @pointermove.prevent="onPointerMove"
          @pointerup.prevent="onPointerUp"
          @dragstart.prevent
        >
          <canvas
            ref="canvasRef"
            class="w-full h-24 rounded-[var(--r-sm)] bg-canvas border border-line"
            style="touch-action: none; -webkit-user-drag: none;"
            draggable="false"
          />
        </div>

        <!-- Info -->
        <div class="flex items-center justify-between text-xs text-fg-muted">
          <span>Selection: {{ trimmedDuration }}</span>
          <span>Total: {{ totalDuration }}</span>
        </div>

        <!-- Controls -->
        <div class="flex items-center gap-2 flex-wrap">
          <button class="btn-secondary" @click="togglePlayback">
            {{ isPlaying ? "⏸ Pause" : "▶ Play" }}
          </button>
          <button
            class="btn-secondary text-xs"
            :disabled="!hasSelection"
            :style="hasSelection ? { borderColor: 'var(--c-again)', color: 'var(--c-again)' } : {}"
            title="Delete the red selection"
            @click="cutSelection"
          >
            ✂ Cut
          </button>
          <button
            class="btn-secondary text-xs"
            :disabled="!canUndo"
            title="Undo last cut"
            @click="undo"
          >
            ↩ Undo
          </button>
          <button
            v-if="hasSelection"
            class="btn-secondary text-xs"
            @click="clearSelection"
          >
            Clear selection
          </button>

          <div class="flex-1" />

          <span class="text-xs text-fg-muted font-mono">
            Save: {{ formatTime(trimStart * duration) }} – {{ formatTime(trimEnd * duration) }}
          </span>
        </div>

        <p class="text-xs text-fg-muted">
          Drag <span style="color: var(--c-accent)">blue handles</span> to set trim bounds for save.
          Click-drag the waveform to make a <span style="color: var(--c-again)">red selection</span> to cut.
        </p>
      </div>

      <div class="flex justify-end gap-2 px-5 py-3.5 border-t border-line">
        <button class="btn-secondary" :disabled="isSaving" @click="emit('close')">Cancel</button>
        <button class="btn-primary" :disabled="isSaving" @click="save">
          <span v-if="isSaving" class="inline-flex items-center gap-1.5">
            <span class="saving-spinner" /> Saving…
          </span>
          <span v-else>Save trimmed</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.saving-spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
