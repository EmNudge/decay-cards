<script setup lang="ts">
import { ref } from "vue";
import { NodeViewWrapper } from "@tiptap/vue-3";
import AudioTrimmer from "./AudioTrimmer.vue";

const props = defineProps<{
  node: { attrs: { filename: string; src: string | null } };
  updateAttributes: (attrs: Record<string, unknown>) => void;
}>();

const audioRef = ref<HTMLAudioElement>();
const isPlaying = ref(false);
const showTrimmer = ref(false);

function play() {
  if (!audioRef.value || !props.node.attrs.src) return;
  if (isPlaying.value) {
    audioRef.value.pause();
    audioRef.value.currentTime = 0;
    isPlaying.value = false;
  } else {
    audioRef.value.currentTime = 0;
    audioRef.value
      .play()
      .then(() => {
        isPlaying.value = true;
      })
      .catch(() => {});
  }
}

function onEnded() {
  isPlaying.value = false;
}

function openTrimmer() {
  if (!props.node.attrs.src) return;
  showTrimmer.value = true;
}

function onTrimSaved(newSrc: string) {
  props.updateAttributes({ src: newSrc });
  showTrimmer.value = false;
}
</script>

<template>
  <NodeViewWrapper as="span" class="audio-chip-inline">
    <span
      class="audio-chip"
      :class="{ playing: isPlaying, missing: !node.attrs.src }"
      @click.stop.prevent="play"
      @dblclick.stop.prevent="openTrimmer"
    >
      <span class="audio-chip-icon">{{ isPlaying ? "⏸" : node.attrs.src ? "🔊" : "🔇" }}</span>
      <span class="audio-chip-name">{{ node.attrs.filename }}</span>
      <button
        v-if="node.attrs.src"
        class="audio-chip-edit"
        title="Trim audio"
        @click.stop.prevent="openTrimmer"
      >✂</button>
      <audio
        v-if="node.attrs.src"
        ref="audioRef"
        :src="node.attrs.src"
        preload="metadata"
        @ended="onEnded"
      />
    </span>

    <AudioTrimmer
      v-if="showTrimmer && node.attrs.src"
      :filename="node.attrs.filename"
      :src="node.attrs.src"
      @saved="onTrimSaved"
      @close="showTrimmer = false"
    />
  </NodeViewWrapper>
</template>

<style scoped>
.audio-chip-inline {
  display: inline;
}
.audio-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: var(--c-accent-soft, rgba(32 139 254 / 0.14));
  border: 1px solid var(--c-accent, #208bfe);
  border-radius: 999px;
  font-size: 12px;
  cursor: pointer;
  user-select: none;
  vertical-align: middle;
  max-width: 280px;
  transition: background 0.15s;
}
.audio-chip:hover {
  background: var(--c-accent, #208bfe);
  color: var(--c-accent-fg, #fff);
}
.audio-chip.playing {
  background: var(--c-accent, #208bfe);
  color: var(--c-accent-fg, #fff);
}
.audio-chip.missing {
  background: var(--c-again-soft, rgba(229 72 77 / 0.18));
  border-color: var(--c-again, #e5484d);
  opacity: 0.7;
  cursor: default;
}
.audio-chip-icon {
  font-size: 14px;
  line-height: 1;
  flex-shrink: 0;
}
.audio-chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, monospace;
  font-size: 11px;
}
.audio-chip-edit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  font-size: 11px;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  border-radius: 50%;
  opacity: 0;
  transition: opacity 0.15s;
}
.audio-chip:hover .audio-chip-edit {
  opacity: 1;
}
.audio-chip-edit:hover {
  background: rgba(255,255,255,0.2);
}
audio {
  display: none;
}
</style>
