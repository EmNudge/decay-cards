import { Node, mergeAttributes } from "@tiptap/core";
import { VueNodeViewRenderer } from "@tiptap/vue-3";
import AudioChipView from "./AudioChipView.vue";

/**
 * Tiptap Node extension for inline audio playback.
 * Renders [sound:filename] as a clickable chip in the editor.
 */
export const AudioChip = Node.create({
  name: "audioChip",
  group: "inline",
  inline: true,
  atom: true, // non-editable, selectable as a unit

  addAttributes() {
    return {
      filename: { default: null },
      src: { default: null }, // blob URL resolved at render time
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-audio-chip]",
        getAttrs: (el) => {
          const dom = el as HTMLElement;
          return {
            filename: dom.getAttribute("data-filename"),
            src: dom.getAttribute("data-src"),
          };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-audio-chip": "",
        "data-filename": HTMLAttributes["filename"],
        "data-src": HTMLAttributes["src"],
      }),
    ];
  },

  addNodeView() {
    return VueNodeViewRenderer(AudioChipView);
  },
});
