import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { type Agent } from "@atproto/api";
import { deleteDb } from "../../db/schema";
import { outboxDb } from "../../db/outbox";
import { decksDb } from "../../db/decks";
import {
  startSyncScheduler,
  stopSyncScheduler,
  isSchedulerRunning,
  __resetSyncStatus,
} from "../scheduler";

/** A bare Agent shape; the scheduler only ever passes it to the runner. */
function makeAgent(did: string): Agent {
  return { did } as unknown as Agent;
}

class FakeTimers {
  private nextHandle = 1;
  timeouts = new Map<number, { fn: () => void; ms: number }>();
  intervals = new Map<number, { fn: () => void; ms: number }>();

  setTimeout = (fn: () => void, ms: number): number => {
    const h = this.nextHandle++;
    this.timeouts.set(h, { fn, ms });
    return h;
  };
  clearTimeout = (h: unknown): void => {
    this.timeouts.delete(h as number);
  };
  setInterval = (fn: () => void, ms: number): number => {
    const h = this.nextHandle++;
    this.intervals.set(h, { fn, ms });
    return h;
  };
  clearInterval = (h: unknown): void => {
    this.intervals.delete(h as number);
  };

  /** Run all currently-pending timeouts in insertion order. */
  flushTimeouts(): void {
    const handles = [...this.timeouts.keys()];
    for (const h of handles) {
      const entry = this.timeouts.get(h);
      if (!entry) continue;
      this.timeouts.delete(h);
      entry.fn();
    }
  }

  fireInterval(handle: number): void {
    this.intervals.get(handle)?.fn();
  }
}

beforeEach(async () => {
  stopSyncScheduler();
  __resetSyncStatus();
  await deleteDb();
});

afterEach(() => {
  stopSyncScheduler();
});

describe("syncScheduler — lifecycle", () => {
  it("fires the runner once on start", async () => {
    const timers = new FakeTimers();
    const runner = vi.fn().mockResolvedValue(undefined);
    startSyncScheduler(makeAgent("did:test"), {
      runner,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      attachVisibility: () => () => {},
    });
    expect(isSchedulerRunning()).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]![0]).toEqual({ did: "did:test" });
  });

  it("starting again with the same agent is a no-op", () => {
    const timers = new FakeTimers();
    const runner = vi.fn().mockResolvedValue(undefined);
    const agent = makeAgent("did:test");
    const opts = {
      runner,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      attachVisibility: () => () => {},
    };
    startSyncScheduler(agent, opts);
    startSyncScheduler(agent, opts);
    expect(timers.intervals.size).toBe(1);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("stop clears interval, debounce, outbox sub, and visibility hook", async () => {
    const timers = new FakeTimers();
    const visUnsub = vi.fn();
    const runner = vi.fn().mockResolvedValue(undefined);
    startSyncScheduler(makeAgent("did:test"), {
      runner,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      attachVisibility: () => visUnsub,
    });
    expect(timers.intervals.size).toBe(1);

    // Queue a debounce timer via an outbox write.
    await decksDb.put({
      tid: "d1",
      name: "D",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });
    expect(timers.timeouts.size).toBe(1);

    stopSyncScheduler();
    expect(timers.intervals.size).toBe(0);
    expect(timers.timeouts.size).toBe(0);
    expect(visUnsub).toHaveBeenCalledTimes(1);
    expect(isSchedulerRunning()).toBe(false);
  });
});

describe("syncScheduler — outbox debounce", () => {
  it("schedules a debounced run on outbox write, then fires on flush", async () => {
    const timers = new FakeTimers();
    const runner = vi.fn().mockResolvedValue(undefined);
    startSyncScheduler(makeAgent("did:test"), {
      runner,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      attachVisibility: () => () => {},
    });
    expect(runner).toHaveBeenCalledTimes(1);

    await decksDb.put({
      tid: "d1",
      name: "D",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });
    expect(timers.timeouts.size).toBe(1);
    expect(runner).toHaveBeenCalledTimes(1); // not yet — still debouncing

    timers.flushTimeouts();
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("coalesces multiple writes into a single debounced run", async () => {
    const timers = new FakeTimers();
    const runner = vi.fn().mockResolvedValue(undefined);
    startSyncScheduler(makeAgent("did:test"), {
      runner,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      attachVisibility: () => () => {},
    });
    const initial = runner.mock.calls.length;

    await outboxDb.queuePut("cards.decay.flashcard.note", "n1", { tid: "n1" });
    await outboxDb.queuePut("cards.decay.flashcard.note", "n2", { tid: "n2" });
    await outboxDb.queuePut("cards.decay.flashcard.note", "n3", { tid: "n3" });
    expect(timers.timeouts.size).toBe(1);

    timers.flushTimeouts();
    expect(runner).toHaveBeenCalledTimes(initial + 1);
  });
});

describe("syncScheduler — interval + visibility triggers", () => {
  it("fires on interval tick", () => {
    const timers = new FakeTimers();
    const runner = vi.fn().mockResolvedValue(undefined);
    startSyncScheduler(makeAgent("did:test"), {
      runner,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      attachVisibility: () => () => {},
    });
    const initial = runner.mock.calls.length;
    const handle = [...timers.intervals.keys()][0]!;
    timers.fireInterval(handle);
    expect(runner).toHaveBeenCalledTimes(initial + 1);
  });

  it("fires on visibility-visible callback", () => {
    const timers = new FakeTimers();
    let attached: (() => void) | null = null;
    const runner = vi.fn().mockResolvedValue(undefined);
    startSyncScheduler(makeAgent("did:test"), {
      runner,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      attachVisibility: (fn) => {
        attached = fn;
        return () => {};
      },
    });
    const initial = runner.mock.calls.length;
    attached!();
    expect(runner).toHaveBeenCalledTimes(initial + 1);
  });
});
