/**
 * Image Occlusion utilities for rendering and editing.
 *
 * IO notes have originalStockKind === 6 and contain:
 *   - "Image Occlusion" field: <img> tag referencing the base image
 *   - "Occlusions" field: SVG markup with shapes having data-ordinal attributes
 *   - "Header" field: optional text above the image
 *   - "Back Extra" field: optional text below the image on the answer side
 */

import { omitUndefined } from "./omitUndefined";

const ORIGINAL_STOCK_KIND_IMAGE_OCCLUSION = 6;

export const IO_FIELD_NAMES = {
  image: "Image Occlusion",
  header: "Header",
  backExtra: "Back Extra",
  occlusions: "Occlusions",
} as const;

// --- Types ---

export type OcclusionMode = "hide-one" | "hide-all-guess-one";

export type OcclusionShape = {
  id: string;
  type: "rect" | "ellipse" | "text" | "polygon";
  ordinal: number; // 1-based, maps to cloze number. Shapes sharing an ordinal are grouped.
  x: number;
  y: number;
  width: number;
  height: number;
  /** Text label displayed on the mask (visible during review as a hint or annotation) */
  label?: string;
  /** Polygon vertices (absolute coordinates) */
  points?: { x: number; y: number }[];
};

type CardLike = {
  values: Record<string, string | null>;
  originalStockKind?: number;
};

// --- Detection ---

export function isImageOcclusionCard(card: CardLike): boolean {
  return card.originalStockKind === ORIGINAL_STOCK_KIND_IMAGE_OCCLUSION;
}

// --- Field helpers ---

function getField(values: Record<string, string | null>, name: string): string {
  if (values[name] != null) return values[name]!;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(values)) {
    if (key.toLowerCase() === lower && value != null) return value;
  }
  return "";
}

/**
 * Extract the image filename from the Image Occlusion field HTML.
 */
export function getImageFilename(imageFieldHtml: string): string | null {
  const match = imageFieldHtml.match(/src="([^"]+)"/);
  return match ? match[1]! : null;
}

// --- Shape parsing (for rendering) ---

export function parseOcclusionShapes(svgString: string): { ordinal: number; svgElement: string }[] {
  if (!svgString.trim()) return [];

  const shapes: { ordinal: number; svgElement: string }[] = [];
  const shapeRegex = /<(rect|ellipse|circle|polygon|path)\b([^>]*?)\/?>(?:<\/\1>)?/gi;

  let match;
  while ((match = shapeRegex.exec(svgString)) !== null) {
    const fullElement = match[0];
    const attrs = match[2] ?? "";
    const ordinalMatch = attrs.match(/data-ordinal="(\d+)"/);
    if (!ordinalMatch) continue;
    const ordinal = parseInt(ordinalMatch[1]!, 10);
    shapes.push({ ordinal, svgElement: fullElement });
  }

  return shapes;
}

// --- Shape parsing (for editor) ---

let shapeIdCounter = 0;

function generateShapeId(): string {
  return `shape-${Date.now()}-${++shapeIdCounter}`;
}

/**
 * Parse SVG occlusion data into editable OcclusionShape objects.
 */
export function parseOcclusionShapesForEditor(svgString: string): OcclusionShape[] {
  if (!svgString.trim()) return [];

  const shapes: OcclusionShape[] = [];
  const shapeRegex = /<(rect|ellipse|circle|polygon|path)\b([^>]*?)\/?>(?:<\/\1>)?/gi;

  let match;
  while ((match = shapeRegex.exec(svgString)) !== null) {
    const tag = match[1]!.toLowerCase();
    const attrs = match[2] ?? "";

    const ordinalMatch = attrs.match(/data-ordinal="(\d+)"/);
    if (!ordinalMatch) continue;
    const ordinal = parseInt(ordinalMatch[1]!, 10);

    const label = parseStringAttr(attrs, "data-label");

    if (tag === "rect") {
      const x = parseAttr(attrs, "x");
      const y = parseAttr(attrs, "y");
      const w = parseAttr(attrs, "width");
      const h = parseAttr(attrs, "height");
      shapes.push(
        omitUndefined({
          id: generateShapeId(),
          type: "rect" as const,
          ordinal,
          x,
          y,
          width: w,
          height: h,
          label,
        }),
      );
    } else if (tag === "ellipse") {
      const cx = parseAttr(attrs, "cx");
      const cy = parseAttr(attrs, "cy");
      const rx = parseAttr(attrs, "rx");
      const ry = parseAttr(attrs, "ry");
      shapes.push(
        omitUndefined({
          id: generateShapeId(),
          type: "ellipse" as const,
          ordinal,
          x: cx - rx,
          y: cy - ry,
          width: rx * 2,
          height: ry * 2,
          label,
        }),
      );
    } else if (tag === "circle") {
      const cx = parseAttr(attrs, "cx");
      const cy = parseAttr(attrs, "cy");
      const r = parseAttr(attrs, "r");
      shapes.push(
        omitUndefined({
          id: generateShapeId(),
          type: "ellipse" as const,
          ordinal,
          x: cx - r,
          y: cy - r,
          width: r * 2,
          height: r * 2,
          label,
        }),
      );
    } else if (tag === "polygon") {
      const pointsStr = parseStringAttr(attrs, "points") ?? "";
      const points = pointsStr
        .split(/\s+/)
        .filter(Boolean)
        .map((p) => {
          const [px, py] = p.split(",");
          return { x: parseFloat(px ?? "0"), y: parseFloat(py ?? "0") };
        });
      if (points.length >= 3) {
        const xs = points.map((p) => p.x);
        const ys = points.map((p) => p.y);
        const minX = Math.min(...xs),
          minY = Math.min(...ys);
        const maxX = Math.max(...xs),
          maxY = Math.max(...ys);
        shapes.push(
          omitUndefined({
            id: generateShapeId(),
            type: "polygon" as const,
            ordinal,
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY,
            label,
            points,
          }),
        );
      }
    }
  }

  return shapes;
}

function parseAttr(attrs: string, name: string): number {
  const match = attrs.match(new RegExp(`${name}="([^"]+)"`));
  return match ? parseFloat(match[1]!) : 0;
}

function parseStringAttr(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`${name}="([^"]+)"`));
  return match ? match[1] : undefined;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Shape serialization ---

/**
 * Serialize OcclusionShape array to SVG string matching Anki desktop format.
 */
export function serializeShapesToSvg(
  shapes: OcclusionShape[],
  imageWidth: number,
  imageHeight: number,
  mode: OcclusionMode = "hide-all-guess-one",
): string {
  const elements: string[] = [];
  for (const shape of shapes) {
    if (shape.type === "text") {
      // Text annotations — not masked, just labels on the image
      elements.push(
        `<text data-ordinal="${shape.ordinal}" x="${shape.x}" y="${shape.y + shape.height}" font-size="${shape.height}" fill="#333"${shape.label ? ` data-label="${escapeAttr(shape.label)}"` : ""}>${escapeXml(shape.label ?? "")}</text>`,
      );
    } else if (shape.type === "polygon" && shape.points) {
      const pts = shape.points.map((p) => `${p.x},${p.y}`).join(" ");
      elements.push(
        `<polygon data-ordinal="${shape.ordinal}" points="${pts}" fill="#ffeba2" fill-opacity="1" stroke="#2d2d2d" stroke-width="1"${shape.label ? ` data-label="${escapeAttr(shape.label)}"` : ""}/>`,
      );
    } else if (shape.type === "ellipse") {
      const cx = shape.x + shape.width / 2;
      const cy = shape.y + shape.height / 2;
      const rx = shape.width / 2;
      const ry = shape.height / 2;
      elements.push(
        `<ellipse data-ordinal="${shape.ordinal}" cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#ffeba2" fill-opacity="1" stroke="#2d2d2d" stroke-width="1"${shape.label ? ` data-label="${escapeAttr(shape.label)}"` : ""}/>`,
      );
    } else {
      elements.push(
        `<rect data-ordinal="${shape.ordinal}" x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" fill="#ffeba2" fill-opacity="1" stroke="#2d2d2d" stroke-width="1"${shape.label ? ` data-label="${escapeAttr(shape.label)}"` : ""}/>`,
      );
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${imageWidth} ${imageHeight}" data-mode="${mode}">\n  ${elements.join("\n  ")}\n</svg>`;
}

// --- SVG metadata extraction ---

function extractViewBox(svgString: string): string | null {
  const match = svgString.match(/viewBox="([^"]+)"/);
  return match ? match[1]! : null;
}

/**
 * Extract the occlusion mode from the SVG root element.
 * Defaults to "hide-all-guess-one" (Anki desktop default).
 */
export function extractOcclusionMode(svgString: string): OcclusionMode {
  const match = svgString.match(/data-mode="([^"]+)"/);
  if (match && (match[1] === "hide-one" || match[1] === "hide-all-guess-one")) {
    return match[1];
  }
  return "hide-all-guess-one";
}

// --- Rendering ---

/**
 * Render an image occlusion card to HTML for review.
 */
export function renderImageOcclusion({
  values,
  cardOrd,
  isAnswer,
}: {
  values: Record<string, string | null>;
  cardOrd: number;
  isAnswer: boolean;
}): string {
  const imageHtml = getField(values, IO_FIELD_NAMES.image);
  const header = getField(values, IO_FIELD_NAMES.header);
  const backExtra = getField(values, IO_FIELD_NAMES.backExtra);
  const occlusionsSvg = getField(values, IO_FIELD_NAMES.occlusions);

  const activeOrdinal = cardOrd + 1;
  const shapes = parseOcclusionShapes(occlusionsSvg);
  const viewBox = extractViewBox(occlusionsSvg);
  const mode = extractOcclusionMode(occlusionsSvg);

  const svgShapes = shapes
    .map(({ ordinal, svgElement }) => {
      const isActive = ordinal === activeOrdinal;

      if (mode === "hide-one") {
        // Hide one: only the active shape is shown as a mask; others are invisible
        if (!isActive) return null;
        if (isAnswer) {
          return svgElement
            .replace(/class="[^"]*"/, "")
            .replace(/<(rect|ellipse|circle|polygon|path)\b/, `<$1 class="io-mask-reveal"`);
        }
        return svgElement
          .replace(/class="[^"]*"/, "")
          .replace(/<(rect|ellipse|circle|polygon|path)\b/, `<$1 class="io-mask io-mask-active"`);
      }

      // hide-all-guess-one (default): all shapes masked, active highlighted
      if (isAnswer) {
        if (isActive) {
          return svgElement
            .replace(/class="[^"]*"/, "")
            .replace(/<(rect|ellipse|circle|polygon|path)\b/, `<$1 class="io-mask-reveal"`);
        }
        return svgElement
          .replace(/class="[^"]*"/, "")
          .replace(/<(rect|ellipse|circle|polygon|path)\b/, `<$1 class="io-mask"`);
      } else {
        const cssClass = isActive ? "io-mask io-mask-active" : "io-mask";
        return svgElement
          .replace(/class="[^"]*"/, "")
          .replace(/<(rect|ellipse|circle|polygon|path)\b/, `<$1 class="${cssClass}"`);
      }
    })
    .filter((s): s is string => s !== null)
    .join("\n    ");

  const viewBoxAttr = viewBox ? `viewBox="${viewBox}"` : "";
  const svgOverlay = `<svg class="io-overlay" ${viewBoxAttr} xmlns="http://www.w3.org/2000/svg">
    ${svgShapes}
  </svg>`;

  const parts: string[] = [];

  if (header) {
    parts.push(`<div class="io-header">${header}</div>`);
  }

  parts.push(`<div class="io-container">
  ${imageHtml}
  ${svgOverlay}
</div>`);

  if (isAnswer && backExtra) {
    parts.push(`<hr id="answer">
<div class="io-back-extra">${backExtra}</div>`);
  }

  return parts.join("\n");
}
