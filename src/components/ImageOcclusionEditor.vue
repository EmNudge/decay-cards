<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { useImageOcclusionEditor, type IoTool } from "../composables/useImageOcclusionEditor";
import type { OcclusionShape, OcclusionMode } from "../utils/imageOcclusion";

const props = defineProps<{
  imageUrl: string;
  modelValue: OcclusionShape[];
  occlusionMode?: OcclusionMode;
  readonly?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [shapes: OcclusionShape[]];
  "update:occlusionMode": [mode: OcclusionMode];
}>();

const svgRef = ref<SVGSVGElement | null>(null);
const imageNaturalWidth = ref(800);
const imageNaturalHeight = ref(600);
const imageLoaded = ref(false);

const editor = useImageOcclusionEditor(props.modelValue);

if (props.occlusionMode) editor.setOcclusionMode(props.occlusionMode);
watch(
  () => props.occlusionMode,
  (val) => {
    if (val && val !== editor.occlusionMode.value) editor.setOcclusionMode(val);
  },
);
watch(
  () => editor.occlusionMode.value,
  (val) => emit("update:occlusionMode", val),
);
watch(
  () => props.modelValue,
  (val) => {
    if (JSON.stringify(val) !== JSON.stringify(editor.shapes.value)) editor.setShapes(val);
  },
);
watch(
  () => editor.shapes.value,
  (val) => emit("update:modelValue", val),
  { deep: true },
);

onMounted(() => {
  const img = new Image();
  img.onload = () => {
    imageNaturalWidth.value = img.naturalWidth;
    imageNaturalHeight.value = img.naturalHeight;
    imageLoaded.value = true;
    editor.setImageSize(img.naturalWidth, img.naturalHeight);
  };
  img.src = props.imageUrl;
});

function onKeydown(e: KeyboardEvent) {
  if (props.readonly) return;
  if (inlineEditId.value) return; // Don't handle keys while editing text
  if (editingLabel.value) return; // Don't handle keys while editing label

  // Enter finishes polygon
  if (e.key === "Enter" && editor.isDrawingPolygon.value) {
    e.preventDefault();
    editor.finishPolygon();
    return;
  }

  // Delete selected shapes
  if ((e.key === "Delete" || e.key === "Backspace") && editor.selectedShapeIds.value.size > 0) {
    e.preventDefault();
    editor.deleteSelectedShape();
    return;
  }

  // Tool shortcuts
  switch (e.key.toLowerCase()) {
    case "v":
      e.preventDefault();
      editor.setTool("select");
      break;
    case "escape":
      e.preventDefault();
      if (editor.isDrawingPolygon.value) {
        editor.cancelPolygon();
      } else {
        editor.setTool("select");
      }
      break;
    case "r":
      e.preventDefault();
      editor.setTool("rect");
      break;
    case "e":
      e.preventDefault();
      editor.setTool("ellipse");
      break;
    case "p":
      e.preventDefault();
      editor.setTool("polygon");
      break;
    case "t":
      e.preventDefault();
      editor.setTool("text");
      break;
    case "a":
      // Ctrl/Cmd+A = select all
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        const allIds = editor.shapes.value.map((s) => s.id);
        editor.selectedShapeIds.value = new Set(allIds);
      }
      break;
    case "g":
      // Ctrl/Cmd+G = group selected
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        if (e.shiftKey) {
          ungroupSelected();
        } else {
          editor.groupSelected();
        }
      }
      break;
    case "z":
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        if (e.shiftKey) {
          editor.redo();
        } else {
          editor.undo();
        }
      }
      break;
    case "y":
      // Ctrl+Y = redo (Windows convention)
      if (e.ctrlKey) {
        e.preventDefault();
        editor.redo();
      }
      break;
  }
}
onMounted(() => document.addEventListener("keydown", onKeydown));
onUnmounted(() => document.removeEventListener("keydown", onKeydown));

function toSvgPoint(e: PointerEvent): { x: number; y: number } | null {
  const svg = svgRef.value;
  if (!svg) return null;
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const inv = ctm.inverse();
  return {
    x: inv.a * e.clientX + inv.c * e.clientY + inv.e,
    y: inv.b * e.clientX + inv.d * e.clientY + inv.f,
  };
}

type HandleDir = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
type DragOrigin = { id: string; x: number; y: number; w: number; h: number };
let dragState: { startX: number; startY: number; origins: DragOrigin[] } | null = null;
let resizeHandle: { shapeId: string; dir: HandleDir; anchorX: number; anchorY: number } | null =
  null;
let hasDragged = false;

// Marquee (rubber-band) selection
const marquee = ref<{ x: number; y: number; w: number; h: number } | null>(null);
let marqueeStart: { x: number; y: number } | null = null;

// Polygon vertex dragging (for completed polygons)
let polyVertexDrag: { shapeId: string; pointIndex: number } | null = null;

/** Hit-test radius for polygon points (in SVG units) */
function polyHitRadius() {
  return HANDLE_TOUCH.value / 2;
}

/** Find if a point is near any vertex of a completed polygon shape */
function findPolyVertex(pt: {
  x: number;
  y: number;
}): { shapeId: string; pointIndex: number } | null {
  const r = polyHitRadius();
  for (const shape of editor.shapes.value) {
    if (shape.type !== "polygon" || !shape.points) continue;
    for (let i = 0; i < shape.points.length; i++) {
      const v = shape.points[i]!;
      if (Math.abs(pt.x - v.x) < r && Math.abs(pt.y - v.y) < r) {
        return { shapeId: shape.id, pointIndex: i };
      }
    }
  }
  return null;
}

/** Check if point is near any in-progress polygon vertex */
function findDrawingVertex(pt: { x: number; y: number }): number | null {
  const r = polyHitRadius();
  const pts = editor.polygonPoints.value;
  for (let i = 0; i < pts.length; i++) {
    const v = pts[i]!;
    if (Math.abs(pt.x - v.x) < r && Math.abs(pt.y - v.y) < r) {
      return i;
    }
  }
  return null;
}

function onPointerDown(e: PointerEvent) {
  if (props.readonly) return;
  if (inlineEditId.value) return; // Don't interact while editing text
  const pt = toSvgPoint(e);
  if (!pt) return;
  hasDragged = false;

  if (editor.activeTool.value === "select") {
    const target = e.target as Element;
    // Check polygon vertex handle
    const polyVtxEl = target.closest("[data-poly-vertex]");
    if (polyVtxEl && editor.selectedShape.value?.type === "polygon") {
      const idx = parseInt(polyVtxEl.getAttribute("data-poly-vertex")!, 10);
      polyVertexDrag = { shapeId: editor.selectedShape.value.id, pointIndex: idx };
      return;
    }
    const handleEl = target.closest("[data-handle]");
    if (handleEl && editor.selectedShape.value) {
      const dir = handleEl.getAttribute("data-handle") as HandleDir;
      const shape = editor.selectedShape.value;
      const anchors: Record<HandleDir, { x: number; y: number }> = {
        nw: { x: shape.x + shape.width, y: shape.y + shape.height },
        n: { x: shape.x, y: shape.y + shape.height },
        ne: { x: shape.x, y: shape.y + shape.height },
        e: { x: shape.x, y: shape.y },
        se: { x: shape.x, y: shape.y },
        s: { x: shape.x, y: shape.y },
        sw: { x: shape.x + shape.width, y: shape.y },
        w: { x: shape.x + shape.width, y: shape.y },
      };
      resizeHandle = { shapeId: shape.id, dir, anchorX: anchors[dir].x, anchorY: anchors[dir].y };
      return;
    }
    const shapeEl = target.closest("[data-shape-id]");
    if (shapeEl) {
      const id = shapeEl.getAttribute("data-shape-id")!;
      editor.selectShape(id, e.shiftKey);
      if (!e.shiftKey) {
        const origins = editor.shapes.value
          .filter((s) => editor.selectedShapeIds.value.has(s.id))
          .map((s) => ({ id: s.id, x: s.x, y: s.y, w: s.width, h: s.height }));
        dragState = { startX: pt.x, startY: pt.y, origins };
      }
    } else {
      // Start marquee selection on empty space
      if (!e.shiftKey) editor.selectShape(null);
      marqueeStart = { x: pt.x, y: pt.y };
      marquee.value = { x: pt.x, y: pt.y, w: 0, h: 0 };
    }
  } else {
    // Drawing tool active — but check if clicking on a handle or existing shape first
    const target = e.target as Element;

    const handleEl = target.closest("[data-handle]");
    if (handleEl && editor.selectedShape.value) {
      const dir = handleEl.getAttribute("data-handle") as HandleDir;
      const shape = editor.selectedShape.value;
      const anchors: Record<HandleDir, { x: number; y: number }> = {
        nw: { x: shape.x + shape.width, y: shape.y + shape.height },
        n: { x: shape.x, y: shape.y + shape.height },
        ne: { x: shape.x, y: shape.y + shape.height },
        e: { x: shape.x, y: shape.y },
        se: { x: shape.x, y: shape.y },
        s: { x: shape.x, y: shape.y },
        sw: { x: shape.x + shape.width, y: shape.y },
        w: { x: shape.x + shape.width, y: shape.y },
      };
      resizeHandle = { shapeId: shape.id, dir, anchorX: anchors[dir].x, anchorY: anchors[dir].y };
      return;
    }

    // Polygon tool: special handling for vertex interaction
    if (editor.activeTool.value === "polygon") {
      // If currently drawing a polygon, always handle as polygon point placement
      if (editor.isDrawingPolygon.value) {
        // Click first point to close
        if (editor.polygonPoints.value.length >= 3) {
          const hitIdx = findDrawingVertex(pt);
          if (hitIdx === 0) {
            editor.finishPolygon();
            return;
          }
          // Don't add duplicate point on existing vertex
          if (hitIdx !== null) return;
        } else {
          const hitIdx = findDrawingVertex(pt);
          if (hitIdx !== null) return;
        }
        editor.startDraw(pt.x, pt.y);
        return;
      }

      // Not drawing yet: check if clicking on an existing polygon vertex (for dragging)
      const existingVertex = findPolyVertex(pt);
      if (existingVertex) {
        editor.selectShape(existingVertex.shapeId);
        polyVertexDrag = existingVertex;
        return;
      }

      // Start a new polygon (regardless of whether we're over another shape)
      editor.startDraw(pt.x, pt.y);
      return;
    }

    const shapeEl = target.closest("[data-shape-id]");
    if (shapeEl) {
      // Clicked on a shape while in draw mode — select and drag it
      const id = shapeEl.getAttribute("data-shape-id")!;
      editor.selectShape(id, e.shiftKey);
      if (!e.shiftKey) {
        const origins = editor.shapes.value
          .filter((s) => editor.selectedShapeIds.value.has(s.id))
          .map((s) => ({ id: s.id, x: s.x, y: s.y, w: s.width, h: s.height }));
        dragState = { startX: pt.x, startY: pt.y, origins };
      }
    } else {
      editor.startDraw(pt.x, pt.y);
    }
  }
}

function onPointerMove(e: PointerEvent) {
  if (props.readonly) return;
  const pt = toSvgPoint(e);
  if (!pt) return;

  if (polyVertexDrag) {
    editor.movePolygonVertex(polyVertexDrag.shapeId, polyVertexDrag.pointIndex, pt.x, pt.y);
    return;
  }

  if (marqueeStart) {
    const mx = Math.min(marqueeStart.x, pt.x);
    const my = Math.min(marqueeStart.y, pt.y);
    const mw = Math.abs(pt.x - marqueeStart.x);
    const mh = Math.abs(pt.y - marqueeStart.y);
    marquee.value = { x: mx, y: my, w: mw, h: mh };
    return;
  }

  if (editor.isDrawing.value) {
    editor.updateDraw(pt.x, pt.y);
  } else if (resizeHandle) {
    const { dir, anchorX, anchorY, shapeId } = resizeHandle;
    const shape = editor.shapes.value.find((s) => s.id === shapeId);
    let newX = anchorX,
      newY = anchorY,
      newW = 10,
      newH = 10;
    if (dir.includes("w") || dir.includes("e")) {
      newX = Math.min(dir.includes("w") ? pt.x : anchorX, dir.includes("w") ? anchorX : pt.x);
      newW = Math.max(
        10,
        Math.abs((dir.includes("w") ? anchorX : pt.x) - (dir.includes("w") ? pt.x : anchorX)),
      );
    }
    if (dir.includes("n") || dir.includes("s")) {
      newY = Math.min(dir.includes("n") ? pt.y : anchorY, dir.includes("n") ? anchorY : pt.y);
      newH = Math.max(
        10,
        Math.abs((dir.includes("n") ? anchorY : pt.y) - (dir.includes("n") ? pt.y : anchorY)),
      );
    }
    if (dir === "n" || dir === "s") {
      newX = shape?.x ?? newX;
      newW = shape?.width ?? newW;
    }
    if (dir === "e" || dir === "w") {
      newY = shape?.y ?? newY;
      newH = shape?.height ?? newH;
    }
    // Text shapes: proportional resize (aspect ratio locked)
    if (shape?.type === "text" && shape.width > 0 && shape.height > 0) {
      const ratio = shape.width / shape.height;
      if (dir.includes("e") || dir.includes("w")) {
        newH = newW / ratio;
      } else if (dir.includes("n") || dir.includes("s")) {
        newW = newH * ratio;
      } else {
        // Corner handles: use the larger delta
        const scaleW = newW / shape.width;
        const scaleH = newH / shape.height;
        const scale = Math.max(scaleW, scaleH);
        newW = Math.max(10, shape.width * scale);
        newH = Math.max(10, shape.height * scale);
      }
    }
    editor.resizeShape(shapeId, { x: newX, y: newY, width: newW, height: newH });
  } else if (dragState) {
    const dx = pt.x - dragState.startX;
    const dy = pt.y - dragState.startY;
    if (!hasDragged && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
    hasDragged = true;
    for (const orig of dragState.origins) {
      editor.resizeShape(orig.id, {
        x: orig.x + dx,
        y: orig.y + dy,
        width: orig.w,
        height: orig.h,
      });
    }
  }
}

function onPointerUp() {
  if (polyVertexDrag) {
    polyVertexDrag = null;
    return;
  }
  if (marqueeStart && marquee.value) {
    const { x, y, w, h } = marquee.value;
    if (w > 5 || h > 5) {
      editor.selectInRect(x, y, w, h);
    }
    marquee.value = null;
    marqueeStart = null;
    return;
  }
  marqueeStart = null;
  marquee.value = null;
  if (editor.isDrawing.value) editor.endDraw();
  dragState = null;
  resizeHandle = null;
}

const tools: { key: IoTool; name: string; shortcut: string }[] = [
  { key: "select", name: "Select", shortcut: "V" },
  { key: "rect", name: "Rectangle", shortcut: "R" },
  { key: "ellipse", name: "Ellipse", shortcut: "E" },
  { key: "polygon", name: "Polygon", shortcut: "P" },
  { key: "text", name: "Text", shortcut: "T" },
];

const editingLabel = ref(false);
const labelInput = ref("");
const inlineEditId = ref<string | null>(null);
const inlineEditValue = ref("");
const inlineInput = ref<HTMLInputElement>();

function startEditLabel() {
  if (!editor.selectedShape.value) return;
  labelInput.value = editor.selectedShape.value.label ?? "";
  editingLabel.value = true;
}

function saveLabel() {
  if (editor.selectedShapeId.value) {
    editor.setLabel(editor.selectedShapeId.value, labelInput.value);
  }
  editingLabel.value = false;
}

function onDblClick(e: MouseEvent) {
  // Double-click finishes polygon drawing
  if (editor.isDrawingPolygon.value) {
    editor.finishPolygon();
    return;
  }

  const target = e.target as Element;
  const shapeEl = target.closest("[data-shape-id]");
  if (!shapeEl) return;
  const id = shapeEl.getAttribute("data-shape-id")!;
  const shape = editor.shapes.value.find((s) => s.id === id);
  if (!shape) return;

  // Start inline editing for any shape
  editor.selectShape(id);
  inlineEditId.value = id;
  inlineEditValue.value = shape.label ?? (shape.type === "text" ? "Text" : "");
  // Focus the input after Vue renders it
  setTimeout(() => inlineInput.value?.focus(), 50);
}

function saveInlineEdit() {
  if (inlineEditId.value) {
    editor.setLabel(inlineEditId.value, inlineEditValue.value);
  }
  inlineEditId.value = null;
}

function ungroupSelected() {
  // Ungroup each selected shape individually
  for (const id of editor.selectedShapeIds.value) {
    editor.ungroupShape(id);
  }
}

// Check if all selected shapes are already in one group (same ordinal)
const selectedIsGrouped = computed(() => {
  const ids = editor.selectedShapeIds.value;
  if (ids.size < 2) {
    // Single selection: check if it shares ordinal with others
    if (!editor.selectedShape.value) return false;
    return (
      editor.shapes.value.filter((s) => s.ordinal === editor.selectedShape.value!.ordinal).length >
      1
    );
  }
  // Multi-selection: all share the same ordinal = already grouped
  const selected = editor.shapes.value.filter((s) => ids.has(s.id));
  const ordinals = new Set(selected.map((s) => s.ordinal));
  return ordinals.size === 1;
});

// Show Group button only when multiple selected and they're NOT already all in one group
const showGroupButton = computed(() => {
  if (!editor.multiSelected.value) return false;
  return !selectedIsGrouped.value;
});

// Handle sizes scale with image dimensions so they look consistent
// regardless of viewBox resolution
const HANDLE_SCALE = computed(
  () => Math.max(imageNaturalWidth.value, imageNaturalHeight.value) / 800,
);
const HANDLE_SIZE = computed(() => Math.round(14 * HANDLE_SCALE.value));
const HANDLE_TOUCH = computed(() => Math.round(28 * HANDLE_SCALE.value));
const STROKE_WIDTH = computed(() => Math.max(2, Math.round(3 * HANDLE_SCALE.value)));
const DASH_SIZE = computed(() => Math.round(8 * HANDLE_SCALE.value));

function getHandles(shape: OcclusionShape) {
  const { x, y, width: w, height: h } = shape;
  return [
    { dir: "nw" as HandleDir, cx: x, cy: y },
    { dir: "n" as HandleDir, cx: x + w / 2, cy: y },
    { dir: "ne" as HandleDir, cx: x + w, cy: y },
    { dir: "e" as HandleDir, cx: x + w, cy: y + h / 2 },
    { dir: "se" as HandleDir, cx: x + w, cy: y + h },
    { dir: "s" as HandleDir, cx: x + w / 2, cy: y + h },
    { dir: "sw" as HandleDir, cx: x, cy: y + h },
    { dir: "w" as HandleDir, cx: x, cy: y + h / 2 },
  ];
}

const cursors: Record<HandleDir, string> = {
  nw: "nwse-resize",
  n: "ns-resize",
  ne: "nesw-resize",
  e: "ew-resize",
  se: "nwse-resize",
  s: "ns-resize",
  sw: "nesw-resize",
  w: "ew-resize",
};
</script>

<template>
  <div class="flex flex-col gap-2">
    <!-- Toolbar -->
    <div v-if="!readonly" class="flex items-center gap-1 flex-wrap">
      <button
        v-for="tool in tools"
        :key="tool.key"
        :class="[
          'btn-pill !px-2',
          editor.activeTool.value === tool.key ? 'bg-accent text-accent-fg' : '',
        ]"
        :title="`${tool.name} (${tool.shortcut})`"
        @click="editor.setTool(tool.key)"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 18 18"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <!-- Select (arrow cursor) -->
          <template v-if="tool.key === 'select'">
            <path
              d="M4 2 L4 13 L7.5 9.5 L10.5 15 L12.5 14 L9.5 8 L14 8 Z"
              fill="currentColor"
              stroke="none"
            />
          </template>
          <!-- Rectangle -->
          <template v-else-if="tool.key === 'rect'">
            <rect x="2" y="3" width="14" height="12" rx="1" />
          </template>
          <!-- Ellipse -->
          <template v-else-if="tool.key === 'ellipse'">
            <ellipse cx="9" cy="9" rx="7" ry="6" />
          </template>
          <!-- Polygon -->
          <template v-else-if="tool.key === 'polygon'">
            <polygon points="9,2 15,7 13,14 5,14 3,7" />
          </template>
          <!-- Text -->
          <template v-else-if="tool.key === 'text'">
            <path d="M4 4 H14 M9 4 V15" />
            <path d="M6 15 H12" />
          </template>
        </svg>
      </button>
      <span class="w-px h-5 bg-line mx-1" />
      <button
        :class="[
          'btn-pill',
          editor.occlusionMode.value === 'hide-all-guess-one' ? 'bg-accent text-accent-fg' : '',
        ]"
        @click="editor.setOcclusionMode('hide-all-guess-one')"
      >
        Hide All
      </button>
      <button
        :class="[
          'btn-pill',
          editor.occlusionMode.value === 'hide-one' ? 'bg-accent text-accent-fg' : '',
        ]"
        @click="editor.setOcclusionMode('hide-one')"
      >
        Hide One
      </button>
      <span class="w-px h-5 bg-line mx-1" />
      <button class="btn-pill" :disabled="!editor.selectedShapeId.value" @click="startEditLabel">
        Label
      </button>
      <button
        v-if="showGroupButton"
        class="btn-pill"
        @click="editor.groupSelected()"
        title="Group selected masks (same card)"
      >
        Group
      </button>
      <button v-if="selectedIsGrouped" class="btn-pill" @click="ungroupSelected">Ungroup</button>
      <button
        class="btn-pill"
        style="color: var(--c-again)"
        :disabled="!editor.selectedShapeId.value"
        @click="editor.deleteSelectedShape()"
      >
        Delete
      </button>
      <span class="ml-auto text-xs text-fg-muted">{{ editor.shapes.value.length }} mask(s)</span>

      <!-- Label editor inline -->
      <div v-if="editingLabel" class="flex items-center gap-1 ml-2">
        <input
          v-model="labelInput"
          type="text"
          placeholder="Label text"
          class="px-2 py-1 text-sm w-32 rounded border border-line bg-surface text-fg"
          @keydown.enter="saveLabel"
          @keydown.escape="editingLabel = false"
        />
        <button
          class="btn-pill"
          style="background: var(--c-accent); color: var(--c-accent-fg)"
          @click="saveLabel"
        >
          OK
        </button>
      </div>
    </div>

    <!-- Canvas -->
    <div class="border border-line rounded-[var(--r-md)] overflow-hidden bg-elevated">
      <svg
        v-if="imageLoaded"
        ref="svgRef"
        class="block w-full h-auto max-h-[60vh] touch-none select-none"
        :viewBox="`0 0 ${imageNaturalWidth} ${imageNaturalHeight}`"
        preserveAspectRatio="xMidYMid meet"
        @pointerdown.prevent="onPointerDown"
        @pointermove.prevent="onPointerMove"
        @pointerup.prevent="onPointerUp"
        @dblclick.prevent="onDblClick"
      >
        <image :href="imageUrl" :width="imageNaturalWidth" :height="imageNaturalHeight" />

        <template v-for="shape in editor.shapes.value" :key="shape.id">
          <rect
            v-if="shape.type === 'rect'"
            :data-shape-id="shape.id"
            :x="shape.x"
            :y="shape.y"
            :width="shape.width"
            :height="shape.height"
            fill="#ffeba2"
            fill-opacity="0.6"
            :stroke="editor.selectedShapeIds.value.has(shape.id) ? '#2196f3' : '#2d2d2d'"
            :stroke-width="
              editor.selectedShapeIds.value.has(shape.id)
                ? STROKE_WIDTH
                : Math.max(1, STROKE_WIDTH / 2)
            "
            style="cursor: pointer"
          />
          <ellipse
            v-else-if="shape.type === 'ellipse'"
            :data-shape-id="shape.id"
            :cx="shape.x + shape.width / 2"
            :cy="shape.y + shape.height / 2"
            :rx="shape.width / 2"
            :ry="shape.height / 2"
            fill="#ffeba2"
            fill-opacity="0.6"
            :stroke="editor.selectedShapeIds.value.has(shape.id) ? '#2196f3' : '#2d2d2d'"
            :stroke-width="
              editor.selectedShapeIds.value.has(shape.id)
                ? STROKE_WIDTH
                : Math.max(1, STROKE_WIDTH / 2)
            "
            style="cursor: pointer"
          />
          <polygon
            v-else-if="shape.type === 'polygon' && shape.points"
            :data-shape-id="shape.id"
            :points="shape.points.map((p) => `${p.x},${p.y}`).join(' ')"
            fill="#ffeba2"
            fill-opacity="0.6"
            :stroke="editor.selectedShapeIds.value.has(shape.id) ? '#2196f3' : '#2d2d2d'"
            :stroke-width="
              editor.selectedShapeIds.value.has(shape.id)
                ? STROKE_WIDTH
                : Math.max(1, STROKE_WIDTH / 2)
            "
            style="cursor: pointer"
          />
          <!-- Text shape: invisible bounding box for interaction + visible text -->
          <template v-if="shape.type === 'text'">
            <rect
              :data-shape-id="shape.id"
              :x="shape.x"
              :y="shape.y"
              :width="Math.max(shape.width, 40)"
              :height="Math.max(shape.height, 20)"
              fill="transparent"
              :stroke="editor.selectedShapeIds.value.has(shape.id) ? '#2196f3' : 'transparent'"
              :stroke-width="editor.selectedShapeIds.value.has(shape.id) ? STROKE_WIDTH : 0"
              :stroke-dasharray="`${DASH_SIZE} ${DASH_SIZE / 2}`"
              style="cursor: pointer"
            />
            <text
              :x="shape.x + 4"
              :y="shape.y + Math.max(shape.height, 20) * 0.7"
              :font-size="Math.max(shape.height * 0.7, 12)"
              fill="#222"
              pointer-events="none"
              font-weight="bold"
              stroke="white"
              :stroke-width="Math.max(shape.height * 0.7, 12) * 0.15"
              paint-order="stroke"
            >
              {{ shape.label ?? "Text" }}
            </text>
          </template>

          <!-- Ordinal + label on mask shapes -->
          <text
            v-if="shape.type !== 'text'"
            :x="shape.x + shape.width / 2"
            :y="shape.y + shape.height / 2"
            text-anchor="middle"
            dominant-baseline="central"
            font-size="14"
            font-weight="bold"
            fill="#333"
            pointer-events="none"
          >
            {{ shape.label ?? shape.ordinal }}
          </text>
        </template>

        <!-- Selection outlines for all selected shapes -->
        <template
          v-for="shape in editor.shapes.value.filter((s) =>
            editor.selectedShapeIds.value.has(s.id),
          )"
          :key="'sel-' + shape.id"
        >
          <rect
            v-if="!readonly"
            :x="shape.x - 2"
            :y="shape.y - 2"
            :width="shape.width + 4"
            :height="shape.height + 4"
            fill="none"
            stroke="#2196f3"
            :stroke-width="STROKE_WIDTH"
            :stroke-dasharray="`${DASH_SIZE} ${DASH_SIZE / 2}`"
            pointer-events="none"
          />
        </template>
        <!-- Resize handles only for single selection -->
        <template v-if="editor.selectedShape.value && !editor.multiSelected.value && !readonly">
          <template v-for="h in getHandles(editor.selectedShape.value)" :key="h.dir">
            <rect
              :data-handle="h.dir"
              :x="h.cx - HANDLE_TOUCH / 2"
              :y="h.cy - HANDLE_TOUCH / 2"
              :width="HANDLE_TOUCH"
              :height="HANDLE_TOUCH"
              fill="transparent"
              :style="{ cursor: cursors[h.dir] }"
            />
            <rect
              :x="h.cx - HANDLE_SIZE / 2"
              :y="h.cy - HANDLE_SIZE / 2"
              :width="HANDLE_SIZE"
              :height="HANDLE_SIZE"
              fill="white"
              stroke="#2196f3"
              :stroke-width="STROKE_WIDTH"
              :rx="STROKE_WIDTH"
              pointer-events="none"
            />
          </template>
        </template>

        <!-- Polygon vertex handles for selected polygon -->
        <template
          v-if="
            editor.selectedShape.value?.type === 'polygon' &&
            editor.selectedShape.value.points &&
            !editor.multiSelected.value &&
            !readonly
          "
        >
          <circle
            v-for="(pt, i) in editor.selectedShape.value.points"
            :key="'pv-' + i"
            :cx="pt.x"
            :cy="pt.y"
            :r="HANDLE_SIZE / 2"
            fill="white"
            stroke="#2196f3"
            :stroke-width="STROKE_WIDTH"
            style="cursor: move"
            :data-poly-vertex="i"
          />
        </template>

        <!-- In-progress polygon preview -->
        <template v-if="editor.isDrawingPolygon.value && editor.polygonPoints.value.length > 0">
          <polyline
            :points="editor.polygonPoints.value.map((p) => `${p.x},${p.y}`).join(' ')"
            fill="rgba(255,235,162,0.3)"
            stroke="#2196f3"
            :stroke-width="STROKE_WIDTH"
            :stroke-dasharray="`${DASH_SIZE} ${DASH_SIZE / 2}`"
            pointer-events="none"
          />
          <circle
            v-for="(pt, i) in editor.polygonPoints.value"
            :key="i"
            :cx="pt.x"
            :cy="pt.y"
            :r="HANDLE_SIZE / 2"
            :fill="i === 0 && editor.polygonPoints.value.length >= 3 ? '#4caf50' : 'white'"
            stroke="#2196f3"
            :stroke-width="STROKE_WIDTH / 2"
            pointer-events="none"
          />
        </template>

        <!-- Marquee selection rectangle -->
        <rect
          v-if="marquee"
          :x="marquee.x"
          :y="marquee.y"
          :width="marquee.w"
          :height="marquee.h"
          fill="rgba(33,150,243,0.1)"
          stroke="#2196f3"
          :stroke-width="STROKE_WIDTH / 2"
          :stroke-dasharray="`${DASH_SIZE / 2} ${DASH_SIZE / 4}`"
          pointer-events="none"
        />

        <!-- Inline text editor overlay -->
        <template v-if="inlineEditId">
          <!-- Click-away backdrop (covers the whole SVG) -->
          <rect
            x="0"
            y="0"
            :width="imageNaturalWidth"
            :height="imageNaturalHeight"
            fill="transparent"
            @pointerdown.stop="saveInlineEdit"
          />
          <foreignObject
            :x="editor.shapes.value.find((s) => s.id === inlineEditId)?.x ?? 0"
            :y="(editor.shapes.value.find((s) => s.id === inlineEditId)?.y ?? 0) - STROKE_WIDTH"
            :width="
              Math.max(
                (editor.shapes.value.find((s) => s.id === inlineEditId)?.width ?? 100) * 1.5,
                200 * HANDLE_SCALE,
              )
            "
            :height="
              Math.max(
                (editor.shapes.value.find((s) => s.id === inlineEditId)?.height ?? 30) +
                  STROKE_WIDTH * 4,
                40 * HANDLE_SCALE,
              )
            "
          >
            <input
              xmlns="http://www.w3.org/1999/xhtml"
              ref="inlineInput"
              :value="inlineEditValue"
              :style="{
                width: '100%',
                boxSizing: 'border-box',
                border: `${STROKE_WIDTH}px solid #2196f3`,
                borderRadius: `${STROKE_WIDTH}px`,
                background: 'rgba(0,0,0,0.75)',
                color: '#fff',
                fontSize: `${Math.max((editor.shapes.value.find((s) => s.id === inlineEditId)?.height ?? 20) * 0.6, 14)}px`,
                padding: `${STROKE_WIDTH}px ${STROKE_WIDTH * 2}px`,
                outline: 'none',
                fontWeight: 'bold',
              }"
              @input="(e: Event) => (inlineEditValue = (e.target as HTMLInputElement).value)"
              @keydown.enter="saveInlineEdit"
              @keydown.escape="inlineEditId = null"
              @pointerdown.stop
            />
          </foreignObject>
        </template>
      </svg>
    </div>
  </div>
</template>
