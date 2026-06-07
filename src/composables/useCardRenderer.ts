import katexCss from "katex/dist/katex.min.css?raw";
import { getRenderedCardString } from "../utils/render";
import { renderImageOcclusion } from "../utils/imageOcclusion";
import type { StudyCard } from "../scheduler/studyQueue";
import { mediaDb, normalizeMediaKey } from "../db/media";
import { omitUndefined } from "../utils/omitUndefined";
import { useTheme } from "./useTheme";

/** Cache of media filename → object URL */
const mediaUrlCache = new Map<string, string>();

const BASE_STYLES = `
*, *::before, *::after { box-sizing: border-box; }
:root {
  --card-bg: #f7f9fb;
  --card-fg: #0b1019;
  --card-line: #e3e8ed;
  --card-muted: #56657a;
  --card-code-bg: #eef2f6;
  --card-accent: #1083fe;
  --card-input-bg: #ffffff;
  --card-input-border: #ccd4dc;
}
:root.dark {
  --card-bg: #0e141b;
  --card-fg: #f1f3f5;
  --card-line: #262f3a;
  --card-muted: #97a3b3;
  --card-code-bg: #1d2530;
  --card-accent: #208bfe;
  --card-input-bg: #1d2530;
  --card-input-border: #3a4452;
}
body {
  margin: 0;
  padding: 0;
  font-family: system-ui, -apple-system, sans-serif;
  background: var(--card-bg);
  color: var(--card-fg);
}
.card {
  font-size: 20px;
  text-align: center;
  padding: 20px;
  line-height: 1.5;
  word-wrap: break-word;
}
img { max-width: 100%; height: auto; display: block; margin: 0 auto; }
hr { margin: 1rem 0; border: none; border-top: 1px solid var(--card-line); }
table { border-collapse: collapse; margin: 0.5rem auto; }
td, th { border: 1px solid var(--card-line); padding: 0.4rem 0.8rem; }
a { color: var(--card-accent); }
pre, code { font-family: ui-monospace, monospace; font-size: 0.9em; }
code { background: var(--card-code-bg); padding: 0.15em 0.3em; border-radius: 3px; }
pre { background: var(--card-code-bg); padding: 0.75rem; border-radius: 6px; overflow-x: auto; text-align: left; }
pre code { background: none; padding: 0; }
ul, ol { text-align: left; }
blockquote { border-left: 3px solid var(--card-line); margin: 0.5rem 0; padding: 0.5rem 1rem; color: var(--card-muted); }
.cloze { font-weight: 700; color: var(--card-accent); }
.hint { color: var(--card-muted); cursor: pointer; border-bottom: 1px dashed var(--card-muted); }
audio { display: none; }
.audio-container {
  display: inline-flex;
  align-items: center;
}
.audio-container button {
  background: none;
  border: none;
  cursor: pointer;
  padding: 0.25rem;
  color: inherit;
  font-size: 1.2em;
}
.typeans-input {
  display: block; width: 100%; max-width: 400px; margin: 0.75rem auto;
  padding: 0.5rem 0.75rem; font-size: 1rem; font-family: inherit;
  border: 2px solid var(--card-input-border); border-radius: 6px; text-align: center;
  background: var(--card-input-bg); color: var(--card-fg); outline: none;
}
.typeans-input:focus { border-color: var(--card-accent); }
#typeans { display: block; text-align: center; margin: 0.5rem auto; font-family: monospace; }
.typeGood { color: #4ade80; }
.typeBad { color: #f87171; }
.typeMissed { color: var(--card-muted); text-decoration: line-through; }
.io-container { position: relative; display: inline-block; max-width: 100%; }
.io-container img { display: block; max-width: 100%; height: auto; }
.io-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; }
.io-mask { fill: #ffeba2; stroke: none; opacity: 0.95; }
.io-mask-active { fill: #ff8c00; }
.io-mask-reveal { fill: transparent; stroke: #4caf50; stroke-width: 2; stroke-dasharray: 6 3; }
`;

const CARD_SCRIPT = `
<script>
window.addEventListener("message", function(e) {
  if (e.data && e.data.type === "theme-change") {
    document.documentElement.classList.toggle("dark", e.data.theme === "dark");
  }
});
document.addEventListener("click", function(e) {
  var btn = e.target.closest(".audio-container button");
  if (!btn) return;
  var audio = btn.closest(".audio-container").querySelector("audio");
  if (audio) { audio.currentTime = 0; audio.play(); }
});
</script>
`;

export function useCardRenderer() {
  /**
   * Render a card's HTML for display.
   * Passes all parameters to the shared render.ts (ported from anki-pwa).
   */
  function renderCard(card: StudyCard, isAnswer: boolean): string {
    const noteType = card.noteType;
    const templateId = card.templateId;

    // Build variables map: fieldDisplayName → value
    const variables: Record<string, string> = {};
    for (const field of card.note.fields) {
      const fieldDef = noteType.fields.find((f) => f.id === field.fieldId);
      if (fieldDef) {
        variables[fieldDef.name] = field.value;
      }
    }

    // Image Occlusion: detect by presence of Occlusions field with SVG data
    const hasOcclusions =
      noteType.fields.some((f) => f.name === "Occlusions") &&
      Object.values(variables).some((v) => v.includes("data-ordinal"));
    if (hasOcclusions) {
      const clozeOrd = parseInt(templateId.replace("c", ""), 10) - 1;
      return renderImageOcclusion({
        values: variables,
        cardOrd: clozeOrd,
        isAnswer,
      });
    }

    // Find the template
    let qfmt: string;
    let afmt: string;

    if (noteType.isCloze) {
      const tmpl = noteType.templates[0];
      qfmt = tmpl?.qfmt ?? "";
      afmt = tmpl?.afmt ?? "";
    } else {
      const tmpl = noteType.templates.find((t) => t.id === templateId);
      qfmt = tmpl?.qfmt ?? "";
      afmt = tmpl?.afmt ?? "";
    }

    // Cloze ordinal (c1 → 0, c2 → 1)
    const clozeOrd = noteType.isCloze ? parseInt(templateId.replace("c", ""), 10) - 1 : 0;

    return getRenderedCardString(
      omitUndefined({
        templateString: isAnswer ? afmt : qfmt,
        variables,
        mediaFiles: new Map<string, string>(),
        cardOrd: clozeOrd,
        isAnswer,
        frontTemplate: isAnswer ? qfmt : undefined,
        tags: card.note.tags,
        deckName: card.deckName,
        cardName: noteType.templates.find((t) => t.id === templateId)?.name,
        noteTypeName: noteType.name,
        isCloze: noteType.isCloze ?? false,
        cardFlag: 0, // TODO: load from cardFlag record
        cardId: 0,
      }),
    );
  }

  /**
   * Build the full srcdoc HTML for an iframe.
   */
  function buildSrcdoc(card: StudyCard, isAnswer: boolean): string {
    const html = renderCard(card, isAnswer);
    const css = card.noteType.css ?? "";
    const { resolved } = useTheme();
    const themeClass = resolved.value === "dark" ? "dark" : "";

    return `<!DOCTYPE html>
<html class="${themeClass}">
<head>
<meta charset="utf-8">
<style>${BASE_STYLES}</style>
<style>${katexCss}</style>
${css ? `<style>${css}</style>` : ""}
${CARD_SCRIPT}
</head>
<body class="card">
${html}
</body>
</html>`;
  }

  /**
   * Resolve a media filename to an object URL.
   */
  async function resolveMediaUrl(filename: string): Promise<string | null> {
    if (mediaUrlCache.has(filename)) {
      return mediaUrlCache.get(filename)!;
    }

    const key = normalizeMediaKey(filename);
    const media = await mediaDb.get(key);
    if (!media) return null;

    const url = URL.createObjectURL(media.blob);
    mediaUrlCache.set(filename, url);
    return url;
  }

  /**
   * Replace media references in HTML with blob URLs.
   */
  async function resolveMediaInHtml(html: string): Promise<string> {
    // Find all src="..." references
    const srcRegex = /src="([^"]+)"/g;
    const matches = [...html.matchAll(srcRegex)];

    let result = html;
    for (const match of matches) {
      const filename = match[1]!;
      if (
        filename.startsWith("data:") ||
        filename.startsWith("blob:") ||
        filename.startsWith("http")
      )
        continue;

      const url = await resolveMediaUrl(filename);
      if (url) {
        result = result.replaceAll(`src="${filename}"`, `src="${url}"`);
      }
    }

    return result;
  }

  /** Clean up cached object URLs */
  function clearMediaCache() {
    for (const url of mediaUrlCache.values()) {
      URL.revokeObjectURL(url);
    }
    mediaUrlCache.clear();
  }

  /**
   * Broadcast a theme change to all card iframes on the page.
   */
  function broadcastTheme(theme: "light" | "dark") {
    const iframes = document.querySelectorAll("iframe");
    for (const iframe of iframes) {
      iframe.contentWindow?.postMessage({ type: "theme-change", theme }, "*");
    }
  }

  return {
    renderCard,
    buildSrcdoc,
    resolveMediaUrl,
    resolveMediaInHtml,
    clearMediaCache,
    broadcastTheme,
  };
}
