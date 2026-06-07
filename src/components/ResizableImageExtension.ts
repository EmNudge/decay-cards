import Image from "@tiptap/extension-image";
import { VueNodeViewRenderer } from "@tiptap/vue-3";
import ResizableImageView from "./ResizableImageView.vue";

export const ResizableImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => el.getAttribute("width") || el.style.width || null,
        renderHTML: (attrs) => {
          if (!attrs["width"]) return {};
          const w = typeof attrs["width"] === "number" ? `${attrs["width"]}px` : attrs["width"];
          return { width: attrs["width"], style: `width: ${w}` };
        },
      },
    };
  },

  addNodeView() {
    return VueNodeViewRenderer(ResizableImageView);
  },
});
