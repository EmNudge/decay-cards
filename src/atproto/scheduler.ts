/**
 * Sync scheduler — orchestrates `runReadSync` + `drainOutbox` against
 * four triggers:
 *
 *   1. App open / sign-in success (immediate)
 *   2. Local writes (debounced 5s via outbox emitter)
 *   3. 5-minute interval while running
 *   4. document `visibilitychange` → visible
 *
 * One run at a time (no overlap). Reactive `syncStatus` is exposed for UI.
 * Cancellable: `stopSyncScheduler()` clears every timer and unsubscribes.
 */
import { ref, computed, readonly, shallowRef } from "vue";
import type { Agent } from "@atproto/api";
import { onOutboxChange } from "../db/outbox";
import { deadLettersDb } from "../db/deadLetters";
import { drainOutbox, runReadSync, resetDrainBackoff } from "./sync";
import { migrateToPhase2, type MigrationProgress } from "./migration";
import { runDeckCascades } from "./deckCascade";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_DEBOUNCE_MS = 5_000;

export interface SchedulerOptions {
  intervalMs?: number;
  debounceMs?: number;
  /**
   * Override the per-trigger sync runner. Defaults to `runSync(agent)`.
   * Tests pass a stub so scheduler behavior can be verified in isolation
   * from the read/write paths and IDB.
   */
  runner?: (agent: Agent) => Promise<void>;
  /** Override timers for tests. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** Override visibilitychange hookup for tests. */
  attachVisibility?: (fn: () => void) => () => void;
}

const syncing = ref(false);
const lastError = ref<string | null>(null);
const lastSyncedAt = ref<string | null>(null);
const deadLetterCount = ref(0);
const migrationProgress = ref<MigrationProgress | null>(null);

export const syncStatus = {
  syncing: readonly(syncing),
  lastError: readonly(lastError),
  lastSyncedAt: readonly(lastSyncedAt),
  deadLetterCount: readonly(deadLetterCount),
  migrationProgress: readonly(migrationProgress),
  /** Convenience: any signal that something is wrong. */
  hasError: computed(
    () => lastError.value !== null || deadLetterCount.value > 0,
  ),
};

interface ActiveScheduler {
  agent: Agent;
  intervalHandle: unknown;
  debounceHandle: unknown;
  outboxUnsub: () => void;
  visibilityUnsub: () => void;
  options: Required<Pick<SchedulerOptions, "intervalMs" | "debounceMs">> & {
    setTimeout: NonNullable<SchedulerOptions["setTimeout"]>;
    clearTimeout: NonNullable<SchedulerOptions["clearTimeout"]>;
  };
}

const active = shallowRef<ActiveScheduler | null>(null);

/**
 * Start the scheduler for a signed-in agent. Idempotent — calling twice
 * with the same agent is a no-op; calling with a different agent restarts.
 */
export function startSyncScheduler(
  agent: Agent,
  opts: SchedulerOptions = {},
): void {
  if (active.value) {
    if (active.value.agent === agent) return;
    stopSyncScheduler();
  }

  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const setT: (fn: () => void, ms: number) => unknown =
    opts.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearT: (handle: unknown) => void =
    opts.clearTimeout ?? ((h) => globalThis.clearTimeout(h as number));
  const setI: (fn: () => void, ms: number) => unknown =
    opts.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
  const clearI: (handle: unknown) => void =
    opts.clearInterval ?? ((h) => globalThis.clearInterval(h as number));
  const attachVis = opts.attachVisibility ?? defaultVisibility;
  const runOnce = opts.runner ?? runSync;

  const runner = () => void runOnce(agent);

  const intervalHandle = setI(runner, intervalMs);
  const visibilityUnsub = attachVis(runner);

  const session: ActiveScheduler = {
    agent,
    intervalHandle,
    debounceHandle: null,
    outboxUnsub: () => {},
    visibilityUnsub: () => {
      visibilityUnsub();
      clearI(intervalHandle);
    },
    options: {
      intervalMs,
      debounceMs,
      setTimeout: setT,
      clearTimeout: clearT,
    },
  };

  session.outboxUnsub = onOutboxChange(() => {
    if (session.debounceHandle !== null) clearT(session.debounceHandle);
    session.debounceHandle = setT(() => {
      session.debounceHandle = null;
      runner();
    }, debounceMs);
  });

  active.value = session;

  // Initial sync.
  runner();
}

/** Stop the scheduler. Clears every timer and unsubscribes from outbox. */
export function stopSyncScheduler(): void {
  const session = active.value;
  if (!session) return;
  active.value = null;
  if (session.debounceHandle !== null) {
    session.options.clearTimeout(session.debounceHandle);
  }
  session.outboxUnsub();
  session.visibilityUnsub();
  resetDrainBackoff();
}

export function isSchedulerRunning(): boolean {
  return active.value !== null;
}

/** Reset reactive sync status. Tests only. */
export function __resetSyncStatus(): void {
  syncing.value = false;
  lastError.value = null;
  lastSyncedAt.value = null;
  deadLetterCount.value = 0;
  migrationProgress.value = null;
}

/**
 * Run a single sync pass. Read first (cheap repo-rev check), then drain.
 * Exposed so callers can force a sync (e.g. UI "Sync Now" button).
 */
export async function runSync(agent: Agent): Promise<void> {
  if (syncing.value) return;
  syncing.value = true;
  lastError.value = null;
  try {
    // First sign-in: enqueue every Phase 1 record so the drain can ship it.
    // Idempotent — subsequent calls return done=true without re-walking.
    const migration = await migrateToPhase2((p) => {
      migrationProgress.value = p;
    });
    if (migration.total === 0 && migration.done) {
      migrationProgress.value = null;
    }
    await runReadSync(agent);
    // After every read pass, reconcile any soft-deleted decks the remote
    // surfaced. Idempotent — only does work when there's actual orphan state.
    await runDeckCascades();
    const drainResult = await drainOutbox(agent);
    if (drainResult.status === "deadLettered") {
      const dead = await deadLettersDb.getAll();
      deadLetterCount.value = dead.length;
    } else if (drainResult.status === "backoff") {
      // Non-fatal — surface a soft message so the UI can hint.
      lastError.value = `Sync backing off until ${new Date(drainResult.until).toISOString()}`;
    }
    lastSyncedAt.value = new Date().toISOString();
  } catch (e) {
    lastError.value = e instanceof Error ? e.message : String(e);
  } finally {
    syncing.value = false;
  }
}

function defaultVisibility(fn: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const handler = () => {
    if (document.visibilityState === "visible") fn();
  };
  document.addEventListener("visibilitychange", handler);
  return () => document.removeEventListener("visibilitychange", handler);
}
