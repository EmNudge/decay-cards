import { promises as fs } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

/**
 * Substitutes the __ALLOWED_PARENT_ORIGINS__ marker inside
 * `public/render-shell.html` with the configured parent origin at
 * production-build time. In dev (no override), the shell falls through
 * to its same-origin check.
 *
 * Set VITE_RENDER_SHELL_PARENT_ORIGIN to the app's origin
 * (e.g. "https://decay.cards") so the shell rejects postMessages from
 * anywhere else.
 */
export function renderShellSubstitution(): Plugin {
  const parentOrigin = process.env["VITE_RENDER_SHELL_PARENT_ORIGIN"] ?? "";

  return {
    name: "render-shell-substitution",
    apply: "build",
    async closeBundle() {
      if (!parentOrigin) return;
      const out = path.resolve("dist", "render-shell.html");
      try {
        const original = await fs.readFile(out, "utf8");
        const replaced = original.replace(
          /"__ALLOWED_PARENT_ORIGINS__"/g,
          JSON.stringify(parentOrigin),
        );
        await fs.writeFile(out, replaced);
      } catch (err) {
        // Non-fatal: if dist/render-shell.html isn't present (e.g. when
        // building a non-app target) we just skip.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    },
  };
}
