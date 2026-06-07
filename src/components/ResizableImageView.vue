<script setup lang="ts">
import { ref, computed } from "vue";
import { NodeViewWrapper } from "@tiptap/vue-3";

const props = defineProps<{
  node: { attrs: { src: string; alt?: string; title?: string; width?: number | string } };
  updateAttributes: (attrs: Record<string, unknown>) => void;
  selected: boolean;
}>();

const isResizing = ref(false);
const startX = ref(0);
const startWidth = ref(0);

const currentWidth = computed(() => {
  const w = props.node.attrs.width;
  if (typeof w === "number") return w;
  if (typeof w === "string" && w.endsWith("px")) return parseInt(w, 10);
  return undefined;
});

function onMouseDown(e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
  isResizing.value = true;
  startX.value = e.clientX;
  startWidth.value =
    currentWidth.value ??
    (e.target as HTMLElement).closest(".resizable-image")?.querySelector("img")?.offsetWidth ??
    200;
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
}

function onMouseMove(e: MouseEvent) {
  if (!isResizing.value) return;
  const diff = e.clientX - startX.value;
  const newWidth = Math.max(50, startWidth.value + diff);
  props.updateAttributes({ width: newWidth });
}

function onMouseUp() {
  isResizing.value = false;
  document.removeEventListener("mousemove", onMouseMove);
  document.removeEventListener("mouseup", onMouseUp);
}
</script>

<template>
  <NodeViewWrapper as="span" class="resizable-image" :class="{ selected, resizing: isResizing }">
    <img
      :src="node.attrs.src"
      :alt="node.attrs.alt ?? ''"
      :title="node.attrs.title ?? undefined"
      :style="currentWidth ? { width: currentWidth + 'px' } : {}"
      draggable="false"
    />
    <span v-if="selected" class="resize-handle resize-handle-right" @mousedown="onMouseDown" />
  </NodeViewWrapper>
</template>

<style scoped>
.resizable-image {
  display: inline-block;
  position: relative;
  line-height: 0;
  max-width: 100%;
}
.resizable-image img {
  max-width: 100%;
  height: auto;
  border-radius: var(--r-sm, 6px);
  display: block;
}
.resizable-image.selected img {
  outline: 2px solid var(--c-accent, #208bfe);
  outline-offset: 2px;
}
.resize-handle {
  position: absolute;
  width: 8px;
  height: 8px;
  background: var(--c-accent, #208bfe);
  border: 1.5px solid var(--c-accent-fg, #fff);
  border-radius: 2px;
  cursor: ew-resize;
  z-index: 1;
}
.resize-handle-right {
  right: -4px;
  top: 50%;
  transform: translateY(-50%);
}
.resizing {
  cursor: ew-resize;
}
</style>
