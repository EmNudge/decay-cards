#!/usr/bin/env node
/**
 * Splits the Vite output in `dist/` into two deployable directories:
 *
 *   deploy/<app-host>/    — the SPA, everything except the shell
 *   deploy/<shell-host>/  — render-shell.html, renamed to index.html
 *
 * The host names are derived from `.env` via Vite's loadEnv:
 *   - <app-host>   = hostname of VITE_RENDER_SHELL_PARENT_ORIGIN
 *   - <shell-host> = hostname of VITE_RENDER_SHELL_URL
 *
 * Each directory mirrors what the web server should serve at its vhost
 * root. Wired into `pnpm build` via the package.json script chain. Rsync
 * each directory to its corresponding vhost on the VPS to deploy.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadEnv } from "vite";

const ROOT = process.cwd();
const DIST = path.join(ROOT, "dist");
const DEPLOY = path.join(ROOT, "deploy");
const SHELL_SOURCE = "render-shell.html";

function hostnameOf(url, varName) {
  if (!url) {
    console.error(
      `${varName} is not set. Add it to .env (or .env.local) before building.`,
    );
    process.exit(1);
  }
  try {
    return new URL(url).hostname;
  } catch {
    console.error(`${varName} is not a valid URL: ${url}`);
    process.exit(1);
  }
}

async function copyDir(src, dst, exclude) {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (exclude.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, dstPath, exclude);
    } else {
      await fs.copyFile(srcPath, dstPath);
    }
  }
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(DIST))) {
    console.error("dist/ not found — run `vite build` first.");
    process.exit(1);
  }
  if (!(await exists(path.join(DIST, SHELL_SOURCE)))) {
    console.error(`dist/${SHELL_SOURCE} not found — was public/ copied?`);
    process.exit(1);
  }

  // Read the same env Vite saw during build (.env + .env.local + mode files).
  const mode = process.env.NODE_ENV ?? "production";
  const env = loadEnv(mode, ROOT, "VITE_");
  const appHost = hostnameOf(
    env.VITE_RENDER_SHELL_PARENT_ORIGIN,
    "VITE_RENDER_SHELL_PARENT_ORIGIN",
  );
  const shellHost = hostnameOf(env.VITE_RENDER_SHELL_URL, "VITE_RENDER_SHELL_URL");
  if (appHost === shellHost) {
    console.error(
      `App and shell must live on different eTLD+1s, got the same host: ${appHost}`,
    );
    process.exit(1);
  }

  const appDir = path.join(DEPLOY, appHost);
  const shellDir = path.join(DEPLOY, shellHost);

  // Wipe + recreate deploy/ so stale files from prior builds don't linger.
  await fs.rm(DEPLOY, { recursive: true, force: true });

  // App vhost: everything except the shell HTML.
  await copyDir(DIST, appDir, new Set([SHELL_SOURCE]));

  // Shell vhost: just the shell, served as index.html so the bare origin
  // works (the iframe URL is the bare hostname, no path).
  await fs.mkdir(shellDir, { recursive: true });
  await fs.copyFile(
    path.join(DIST, SHELL_SOURCE),
    path.join(shellDir, "index.html"),
  );

  console.log("deploy artifacts:");
  console.log(`  ${path.relative(ROOT, appDir)}/`);
  console.log(`  ${path.relative(ROOT, shellDir)}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
