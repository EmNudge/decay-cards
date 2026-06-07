# Image Occlusion — Feature Spec

## Overview

Image Occlusion (IO) lets users place mask shapes over an image, generating one flashcard per shape. During review, masks hide parts of the image — the user guesses what's underneath. This is the second most popular Anki feature after basic flashcards, used heavily for anatomy, maps, diagrams, and labeled photographs.

## How It Works in Anki

### Note Structure

IO uses a special note type with these fields:

| Field | Content |
|-------|---------|
| `Image Occlusion` | `<img>` tag referencing the base image |
| `Occlusions` | SVG markup with shape elements, each tagged with `data-ordinal` |
| `Header` | Optional text shown above the image (both sides) |
| `Back Extra` | Optional text shown below the image (answer side only) |

### SVG Format

The `Occlusions` field contains an SVG like:
```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" data-mode="hide-all-guess-one">
  <rect data-ordinal="1" x="100" y="150" width="80" height="40" fill="#ffeba2" fill-opacity="1" stroke="#2d2d2d" stroke-width="1"/>
  <ellipse data-ordinal="2" cx="400" cy="300" rx="50" ry="30" fill="#ffeba2" fill-opacity="1" stroke="#2d2d2d" stroke-width="1"/>
</svg>
```

Each shape has a `data-ordinal` (1-based). One card is generated per unique ordinal — identical to how cloze ordinals work.

### Study Modes

- **Hide All, Guess One** (default): All shapes are masked. The active shape is highlighted with a different color. On reveal, the active shape shows a dashed outline.
- **Hide One, Guess One**: Only the active shape is masked. All others are visible. Useful for maps where context matters.

### Card Generation

Each `data-ordinal` produces one card. Shapes sharing the same ordinal are grouped (revealed together). This maps directly to our existing cloze model: `data-ordinal="1"` → `templateId: "c1"`.

---

## Data Model (fits existing schema)

IO notes use the existing `NoteRecord` and `NoteTypeRecord` schemas with no changes needed:

### NoteType

```ts
{
  tid: "...",
  name: "Image Occlusion",
  isCloze: true, // IO cards work like cloze — one card per ordinal
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
      qfmt: "{{#Header}}<div class='io-header'>{{Header}}</div>{{/Header}}<div class='io-container'>{{Image Occlusion}}{{Occlusions}}</div>",
      afmt: "{{#Header}}<div class='io-header'>{{Header}}</div>{{/Header}}<div class='io-container'>{{Image Occlusion}}{{Occlusions}}</div>{{#Back Extra}}<hr><div class='io-back-extra'>{{Back Extra}}</div>{{/Back Extra}}",
    },
  ],
}
```

### Note

```ts
{
  tid: "...",
  deck: "at://...",
  noteType: "at://...",
  fields: [
    { fieldId: "f0", value: '<img src="anatomy.png">' },
    { fieldId: "f1", value: "Label the parts of the heart" },
    { fieldId: "f2", value: "Source: Gray's Anatomy" },
    { fieldId: "f3", value: '<svg xmlns="..." viewBox="0 0 800 600" data-mode="hide-all-guess-one">...</svg>' },
  ],
}
```

### ReviewState

Same as cloze: `templateId: "c1"`, `templateId: "c2"`, etc. Card generation scans the `Occlusions` field for unique `data-ordinal` values instead of `{{cN::...}}` patterns.

### Card Rendering

The existing `renderImageOcclusion()` in `utils/imageOcclusion.ts` handles review rendering. It:
1. Parses shapes from the SVG
2. Applies CSS classes based on mode and active ordinal
3. Overlays the SVG on top of the image

**No changes needed to the rendering pipeline** — it already works.

---

## What Needs to Be Built

### 1. IO Note Type Auto-Creation

On first use (or on import of an IO deck), create the "Image Occlusion" noteType if it doesn't exist.

**Files**: `src/import/apkgImport.ts` (detect `originalStockKind === 6`), `src/composables/useDecks.ts`

### 2. Image Occlusion Editor Component

A canvas/SVG editor for drawing masks on images.

**Files**: `src/components/ImageOcclusionEditor.vue`, `src/composables/useImageOcclusionEditor.ts`

**Already ported from anki-pwa**: `src/utils/imageOcclusion.ts` (parsing, serialization, rendering), `src/composables/useImageOcclusionEditor.ts` (from anki-pwa — 145 lines, handles draw state)

#### Editor Features

**Tools**:
- **Select** (pointer): Click to select a shape, drag to move it
- **Rectangle**: Click-drag to draw a rectangle mask
- **Ellipse**: Click-drag to draw an ellipse mask

**Shape interactions**:
- Click to select (shows resize handles)
- Drag to move
- Resize handles on corners/edges
- Delete key removes selected shape
- Each shape auto-assigned next ordinal (1, 2, 3...)

**Toolbar**:
- Tool selector: Select / Rectangle / Ellipse
- Mode toggle: Hide All, Guess One / Hide One, Guess One
- Undo / Redo
- Delete selected
- Zoom controls (fit / actual size)

**Canvas**:
- Base image displayed at native resolution, scaled to fit container
- SVG overlay for shapes (drawn in image coordinate space)
- Mouse/touch events mapped from screen → image coordinates via viewBox transform

### 3. IO Note Editor Integration

When creating/editing an IO note, the NoteEditor shows:
- Image picker (select file or paste from clipboard)
- The ImageOcclusionEditor over the image
- Header field (text input)
- Back Extra field (text input)
- Tags

**Files**: Update `src/components/NoteEditor.vue` to detect IO noteType and switch to IO editing mode.

### 4. Card Generation for IO

The study queue already handles cloze-style card generation. For IO notes, the ordinals come from `data-ordinal` attributes in the SVG instead of `{{cN::...}}` patterns in field text.

**Modify**: `src/scheduler/studyQueue.ts` `getClozeOrdinals()` → also check for IO notes and parse ordinals from SVG.

Or simpler: since `isCloze: true` is set on the IO noteType, and the Occlusions field contains `{{c1::...}}`-style markers that the import creates... actually no, the SVG doesn't use cloze syntax. The ordinals are in `data-ordinal` attributes.

**Fix**: Add an `isImageOcclusion` check alongside `isCloze` in `studyQueue.ts` `buildCards()`:

```ts
function getCardOrdinals(note: NoteRecord, noteType: NoteTypeRecord): string[] {
  if (noteType.isCloze) {
    // Check if this is an IO note (has Occlusions field with SVG)
    const occlusionsField = note.fields.find(f => {
      const fieldDef = noteType.fields.find(fd => fd.id === f.fieldId);
      return fieldDef?.name === "Occlusions";
    });
    if (occlusionsField?.value?.includes("data-ordinal")) {
      return getIOOrdinals(occlusionsField.value);
    }
    return getClozeOrdinals(note);
  }
  return noteType.templates.map(t => t.id);
}

function getIOOrdinals(svgString: string): string[] {
  const ordinals = new Set<number>();
  const regex = /data-ordinal="(\d+)"/g;
  let match;
  while ((match = regex.exec(svgString)) !== null) {
    ordinals.add(parseInt(match[1]!, 10));
  }
  return Array.from(ordinals).sort((a, b) => a - b).map(n => `c${n}`);
}
```

### 5. IO Card Rendering in Study View

The existing `renderImageOcclusion()` needs to be called from `useCardRenderer.ts` when an IO card is detected.

**Modify**: `src/composables/useCardRenderer.ts` `renderCard()`:

```ts
function renderCard(card: StudyCard, isAnswer: boolean): string {
  const noteType = card.noteType;

  // Check if this is an Image Occlusion note
  const isIO = noteType.fields.some(f => f.name === "Occlusions") && noteType.isCloze;
  if (isIO) {
    return renderImageOcclusion({
      values: buildVariablesMap(card),
      cardOrd: parseInt(card.templateId.replace("c", ""), 10) - 1,
      isAnswer,
    });
  }

  // Normal card rendering...
}
```

### 6. Import Compatibility

Anki .apkg files with IO notes have `originalStockKind === 6`. The import should:
1. Detect IO cards and create the correct noteType
2. Preserve the SVG occlusions field
3. Map the image to the media collection

**Files**: `src/import/apkgImport.ts`

---

## Implementation Plan

### Phase A: Rendering (minimal — can ship fast)
1. Detect IO notes in `useCardRenderer.ts` and call `renderImageOcclusion()`
2. Ensure imported IO decks render correctly during study
3. **No editor needed** — users import IO decks from Anki, review works

### Phase B: Editor (full feature)
1. Copy `ImageOcclusionEditor.vue` and `useImageOcclusionEditor.ts` from anki-pwa
2. Adapt to use the new media resolution (blob URLs from IDB)
3. Integrate into NoteEditor with IO mode detection
4. Wire up "New Image Occlusion Note" flow:
   - User selects image
   - Opens IO editor overlay
   - Draws masks
   - Fills in Header / Back Extra
   - Saves → creates note with image in media collection + SVG in Occlusions field

### Phase C: Polish
1. Polygon tool (freeform shapes for irregular regions)
2. Text labels on masks (shown on reveal)
3. Shape grouping (multiple shapes share one ordinal)
4. Duplicate shape / copy-paste
5. Alignment helpers (snap to grid, align selected shapes)
6. Touch support (mobile drawing)
7. Zoom/pan on large images

---

## What Already Exists (Ported)

| File | Status | Lines |
|------|--------|-------|
| `src/utils/imageOcclusion.ts` | Ported, working | 283 |
| `src/composables/useCardRenderer.ts` | Has IO styles in BASE_STYLES | — |
| CSS classes (`.io-container`, `.io-mask`, `.io-overlay`, etc.) | In card srcdoc styles | — |

The rendering pipeline is complete. The editor (~800 lines across 2 components + 1 composable in anki-pwa) needs to be ported and adapted.

---

## Schema Impact

**None.** IO uses the existing:
- `NoteTypeRecord` with `isCloze: true`
- `NoteRecord` with standard fields
- `MediaRecord` for the base image
- `ReviewStateRecord` with `templateId: "c1"`, `"c2"`, etc.
- Card rendering via `renderImageOcclusion()` which is already ported

The only code changes are:
1. IO detection in the card renderer (5 lines)
2. IO ordinal extraction in the study queue (10 lines)
3. Porting the editor component (~800 lines from anki-pwa)
