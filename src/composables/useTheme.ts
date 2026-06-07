import { ref, watchEffect } from "vue";

export type ThemeChoice = "light" | "dark" | "system";
type Resolved = "light" | "dark";

const STORAGE_KEY = "decay.theme";

function readStored(): ThemeChoice {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}

function systemPref(): Resolved {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function apply(resolved: Resolved) {
  document.documentElement.classList.toggle("dark", resolved === "dark");
  // Broadcast to card iframes
  const iframes = document.querySelectorAll("iframe");
  for (const iframe of iframes) {
    iframe.contentWindow?.postMessage({ type: "theme-change", theme: resolved }, "*");
  }
}

const choice = ref<ThemeChoice>("system");
const resolved = ref<Resolved>("light");
let initialized = false;

function resolve(c: ThemeChoice): Resolved {
  return c === "system" ? systemPref() : c;
}

/**
 * Initialise immediately on import (synchronously, before mount) so the page
 * never flashes the wrong theme. Safe to call multiple times.
 */
export function initTheme() {
  if (initialized) return;
  initialized = true;
  choice.value = readStored();
  resolved.value = resolve(choice.value);
  apply(resolved.value);

  // React to OS changes while on "system"
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  mql.addEventListener("change", () => {
    if (choice.value === "system") {
      resolved.value = systemPref();
      apply(resolved.value);
    }
  });

  watchEffect(() => {
    resolved.value = resolve(choice.value);
    apply(resolved.value);
  });
}

export function useTheme() {
  function setTheme(next: ThemeChoice) {
    choice.value = next;
    localStorage.setItem(STORAGE_KEY, next);
  }

  /** Cycle: light → dark → system → light */
  function cycleTheme() {
    setTheme(choice.value === "light" ? "dark" : choice.value === "dark" ? "system" : "light");
  }

  /** Two-state toggle: explicit light ↔ dark */
  function toggleTheme() {
    setTheme(resolved.value === "dark" ? "light" : "dark");
  }

  return { choice, resolved, setTheme, cycleTheme, toggleTheme };
}
