import { ref, computed, watch, type Ref } from "vue";
import type { OcclusionShape, OcclusionMode } from "../utils/imageOcclusion";

let shapeIdCounter = 0;
function generateId(): string {
  return `shape-${Date.now()}-${++shapeIdCounter}`;
}

export type IoTool = "select" | "rect" | "ellipse" | "polygon" | "text";

export function useImageOcclusionEditor(initialShapes: OcclusionShape[] = []) {
  const shapes: Ref<OcclusionShape[]> = ref([...initialShapes]);
  const selectedShapeIds = ref<Set<string>>(new Set());
  const activeTool = ref<IoTool>("rect");
  const isDrawing = ref(false);
  const occlusionMode = ref<OcclusionMode>("hide-all-guess-one");

  // Undo/redo history
  const MAX_HISTORY = 50;
  let undoStack: string[] = [JSON.stringify(initialShapes)];
  let redoStack: string[] = [];
  let skipSnapshot = false;

  function pushSnapshot() {
    if (skipSnapshot) return;
    const snap = JSON.stringify(shapes.value);
    if (undoStack[undoStack.length - 1] === snap) return;
    undoStack.push(snap);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack = [];
  }

  // Watch shapes for changes and push snapshots (debounced via microtask)
  let snapshotPending = false;
  watch(() => shapes.value, () => {
    if (skipSnapshot || isDrawing.value) return;
    if (!snapshotPending) {
      snapshotPending = true;
      queueMicrotask(() => {
        snapshotPending = false;
        pushSnapshot();
      });
    }
  }, { deep: true });

  function undo() {
    if (undoStack.length <= 1) return;
    const current = undoStack.pop()!;
    redoStack.push(current);
    const prev = undoStack[undoStack.length - 1]!;
    skipSnapshot = true;
    shapes.value = JSON.parse(prev);
    selectedShapeIds.value = new Set();
    skipSnapshot = false;
  }

  function redo() {
    if (redoStack.length === 0) return;
    const next = redoStack.pop()!;
    undoStack.push(next);
    skipSnapshot = true;
    shapes.value = JSON.parse(next);
    selectedShapeIds.value = new Set();
    skipSnapshot = false;
  }

  let drawStartX = 0;
  let drawStartY = 0;
  let drawingShapeId: string | null = null;

  // Polygon drawing state
  const polygonPoints = ref<{ x: number; y: number }[]>([]);
  const isDrawingPolygon = ref(false);

  // Compat: single selected shape (first in set)
  const selectedShapeId = computed(() => {
    const ids = selectedShapeIds.value;
    if (ids.size === 0) return null;
    return ids.values().next().value ?? null;
  });

  const selectedShape = computed(
    () => shapes.value.find((s) => s.id === selectedShapeId.value) ?? null,
  );

  const multiSelected = computed(() => selectedShapeIds.value.size > 1);

  const nextOrdinal = computed(() => {
    const max = shapes.value.reduce((m, s) => Math.max(m, s.ordinal), 0);
    return max + 1;
  });

  function setTool(tool: IoTool) {
    if (isDrawingPolygon.value && tool !== "polygon") cancelPolygon();
    activeTool.value = tool;
    if (tool !== "select") selectedShapeIds.value = new Set();
  }

  function selectShape(id: string | null, additive = false) {
    if (id === null) {
      selectedShapeIds.value = new Set();
      return;
    }

    if (additive) {
      const next = new Set(selectedShapeIds.value);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      selectedShapeIds.value = next;
      return;
    }

    // Select shape + auto-select all shapes in the same group (same ordinal)
    const shape = shapes.value.find((s) => s.id === id);
    if (shape && shape.ordinal > 0) {
      const grouped = shapes.value.filter((s) => s.ordinal === shape.ordinal);
      if (grouped.length > 1) {
        selectedShapeIds.value = new Set(grouped.map((s) => s.id));
        return;
      }
    }

    selectedShapeIds.value = new Set([id]);
  }

  /** Select all shapes whose bounding box intersects the given rect */
  function selectInRect(rx: number, ry: number, rw: number, rh: number) {
    const ids = shapes.value
      .filter((s) => {
        return s.x + s.width > rx && s.x < rx + rw && s.y + s.height > ry && s.y < ry + rh;
      })
      .map((s) => s.id);
    selectedShapeIds.value = new Set(ids);
  }

  /** Default text size as a fraction of the larger image dimension. Set by init caller. */
  let defaultTextHeight = 40;

  function setImageSize(w: number, h: number) {
    defaultTextHeight = Math.round(Math.max(w, h) * 0.035);
  }

  function startDraw(x: number, y: number) {
    if (activeTool.value === "select") return;

    // Polygon: accumulate points on each click
    if (activeTool.value === "polygon") {
      polygonPoints.value = [...polygonPoints.value, { x, y }];
      isDrawingPolygon.value = true;
      return;
    }

    const id = generateId();
    const isText = activeTool.value === "text";

    if (isText) {
      // Text: place immediately with default size, no drag
      const h = defaultTextHeight;
      const w = h * 5; // rough width for "Label"
      const shape: OcclusionShape = {
        id,
        type: "text",
        ordinal: 0,
        x,
        y: y - h / 2, // center vertically on click point
        width: w,
        height: h,
        label: "Label",
      };
      shapes.value = [...shapes.value, shape];
      selectedShapeIds.value = new Set([id]);
      return;
    }

    const shape: OcclusionShape = {
      id,
      type: activeTool.value,
      ordinal: nextOrdinal.value,
      x,
      y,
      width: 0,
      height: 0,
    };

    shapes.value = [...shapes.value, shape];
    drawingShapeId = id;
    drawStartX = x;
    drawStartY = y;
    isDrawing.value = true;
    selectedShapeIds.value = new Set([id]);
  }

  function finishPolygon() {
    const pts = polygonPoints.value;
    if (pts.length < 3) {
      polygonPoints.value = [];
      isDrawingPolygon.value = false;
      return;
    }
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const maxX = Math.max(...xs), maxY = Math.max(...ys);
    const id = generateId();
    const shape: OcclusionShape = {
      id,
      type: "polygon",
      ordinal: nextOrdinal.value,
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
      points: [...pts],
    };
    shapes.value = [...shapes.value, shape];
    selectedShapeIds.value = new Set([id]);
    polygonPoints.value = [];
    isDrawingPolygon.value = false;
    pushSnapshot();
  }

  function cancelPolygon() {
    polygonPoints.value = [];
    isDrawingPolygon.value = false;
  }

  function updateDraw(x: number, y: number) {
    if (!isDrawing.value || !drawingShapeId) return;
    const minX = Math.min(drawStartX, x);
    const minY = Math.min(drawStartY, y);
    const w = Math.abs(x - drawStartX);
    const h = Math.abs(y - drawStartY);
    shapes.value = shapes.value.map((s) =>
      s.id === drawingShapeId ? { ...s, x: minX, y: minY, width: w, height: h } : s,
    );
  }

  function endDraw() {
    if (!isDrawing.value || !drawingShapeId) return;
    const shape = shapes.value.find((s) => s.id === drawingShapeId);
    if (shape && shape.width < 5 && shape.height < 5) {
      shapes.value = shapes.value.filter((s) => s.id !== drawingShapeId);
      selectedShapeIds.value = new Set();
    }
    drawingShapeId = null;
    isDrawing.value = false;
    pushSnapshot();
  }

  function moveShape(id: string, dx: number, dy: number) {
    shapes.value = shapes.value.map((s) => (s.id === id ? { ...s, x: s.x + dx, y: s.y + dy } : s));
  }

  function movePolygonVertex(id: string, pointIndex: number, x: number, y: number) {
    shapes.value = shapes.value.map((s) => {
      if (s.id !== id || s.type !== "polygon" || !s.points) return s;
      const points = s.points.map((p, i) => (i === pointIndex ? { x, y } : p));
      const xs = points.map((p) => p.x);
      const ys = points.map((p) => p.y);
      const minX = Math.min(...xs), minY = Math.min(...ys);
      const maxX = Math.max(...xs), maxY = Math.max(...ys);
      return { ...s, points, x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    });
  }

  function resizeShape(id: string, bounds: { x: number; y: number; width: number; height: number }) {
    shapes.value = shapes.value.map((s) => {
      if (s.id !== id) return s;
      // For polygons, translate points when bounding box moves
      if (s.type === "polygon" && s.points) {
        const dx = bounds.x - s.x;
        const dy = bounds.y - s.y;
        if (dx !== 0 || dy !== 0) {
          const points = s.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
          return { ...s, ...bounds, points };
        }
      }
      return { ...s, ...bounds };
    });
  }

  function deleteShape(id: string) {
    shapes.value = shapes.value.filter((s) => s.id !== id);
    if (selectedShapeId.value === id) selectedShapeIds.value = new Set();
  }

  function deleteSelectedShape() {
    if (selectedShapeIds.value.size === 0) return;
    shapes.value = shapes.value.filter((s) => !selectedShapeIds.value.has(s.id));
    selectedShapeIds.value = new Set();
  }

  /** Set the label text on a shape */
  function setLabel(id: string, label: string) {
    shapes.value = shapes.value.map((s) => {
      if (s.id !== id) return s;
      if (label) return { ...s, label };
      const { label: _omit, ...rest } = s;
      return rest;
    });
  }

  /** Set the ordinal on a shape (for grouping — same ordinal = same card) */
  function setOrdinal(id: string, ordinal: number) {
    shapes.value = shapes.value.map((s) => (s.id === id ? { ...s, ordinal } : s));
  }

  /** Group all currently selected shapes under the lowest ordinal among them */
  function groupSelected() {
    const ids = [...selectedShapeIds.value];
    if (ids.length < 2) return;
    const selected = shapes.value.filter((s) => ids.includes(s.id) && s.ordinal > 0);
    if (selected.length < 2) return;
    const targetOrdinal = Math.min(...selected.map((s) => s.ordinal));
    shapes.value = shapes.value.map((s) =>
      ids.includes(s.id) && s.ordinal > 0 ? { ...s, ordinal: targetOrdinal } : s,
    );
  }

  /** Ungroup a shape: give it a new unique ordinal */
  function ungroupShape(id: string) {
    shapes.value = shapes.value.map((s) =>
      s.id === id ? { ...s, ordinal: nextOrdinal.value } : s,
    );
  }

  function setShapes(newShapes: OcclusionShape[]) {
    shapes.value = [...newShapes];
    selectedShapeIds.value = new Set();
  }

  function setOcclusionMode(mode: OcclusionMode) {
    occlusionMode.value = mode;
  }

  return {
    shapes,
    selectedShapeId,
    selectedShapeIds,
    activeTool,
    isDrawing,
    isDrawingPolygon,
    polygonPoints,
    occlusionMode,
    selectedShape,
    multiSelected,
    nextOrdinal,
    setTool,
    selectShape,
    startDraw,
    updateDraw,
    endDraw,
    finishPolygon,
    cancelPolygon,
    moveShape,
    movePolygonVertex,
    resizeShape,
    deleteShape,
    deleteSelectedShape,
    setLabel,
    setOrdinal,
    selectInRect,
    groupSelected,
    ungroupShape,
    setImageSize,
    setShapes,
    setOcclusionMode,
    undo,
    redo,
  };
}
