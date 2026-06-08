import { promises as fs } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

interface Options {
  /**
   * The parent origin that the shell will accept postMessages from.
   * Substituted into `dist/render-shell.html` at build time. Empty
   * string skips substitution (the shell falls back to a same-origin
   * check, useful for dev / preview).
   */
  parentOrigin: string;
}

/**
 * Substitutes the `__ALLOWED_PARENT_ORIGINS__` marker inside the built
 * `render-shell.html` with the configured parent origin. Read via Vite's
 * `loadEnv` from `.env`, then passed in from `vite.config.ts`.
 */
export function renderShellSubstitution({ parentOrigin }: Options): Plugin {
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
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    },
  };
}
