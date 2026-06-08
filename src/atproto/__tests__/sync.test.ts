import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { type Agent, XRPCError } from "@atproto/api";
import { deleteDb } from "../../db/schema";
import { outboxDb } from "../../db/outbox";
import { deadLettersDb } from "../../db/deadLetters";
import { globalLimiter } from "../rateLimit";
import {
  drainOutbox,
  resetDrainBackoff,
  __setDrainClock,
  __resetDrainClock,
} from "../sync";

interface AgentMockOps {
  applyWrites?: ReturnType<typeof vi.fn>;
  putRecord?: ReturnType<typeof vi.fn>;
  deleteRecord?: ReturnType<typeof vi.fn>;
  getRecord?: ReturnType<typeof vi.fn>;
  listRecords?: ReturnType<typeof vi.fn>;
}

function mockAgent(did: string, ops: AgentMockOps): Agent {
  return {
    did,
    com: {
      atproto: {
        repo: {
          applyWrites: ops.applyWrites ?? vi.fn(),
          putRecord: ops.putRecord ?? vi.fn(),
          deleteRecord: ops.deleteRecord ?? vi.fn(),
          getRecord: ops.getRecord ?? vi.fn(),
          listRecords: ops.listRecords ?? vi.fn(),
        },
      },
    },
  } as unknown as Agent;
}

const COLLECTION = "cards.decay.flashcard.note";

beforeEach(async () => {
  await deleteDb();
  resetDrainBackoff();
  __resetDrainClock();
  globalLimiter.reset();
});

describe("drainOutbox — idle", () => {
  it("returns idle when outbox is empty", async () => {
    const agent = mockAgent("did:test", { applyWrites: vi.fn() });
    const res = await drainOutbox(agent);
    expect(res).toEqual({ status: "idle" });
  });
});

describe("drainOutbox — happy path", () => {
  it("sends a single batch and clears the outbox", async () => {
    await outboxDb.queuePut(COLLECTION, "k1", { tid: "k1", v: 1 });
    await outboxDb.queuePut(COLLECTION, "k2", { tid: "k2", v: 2 });
    await outboxDb.queueDelete(COLLECTION, "k3");

    const applyWrites = vi.fn().mockResolvedValue({ headers: {}, data: {} });
    const agent = mockAgent("did:test", { applyWrites });

    const res = await drainOutbox(agent);

    expect(res).toEqual({ status: "done", ops: 3 });
    expect(applyWrites).toHaveBeenCalledTimes(1);
    expect(applyWrites.mock.calls[0]![0]).toMatchObject({
      repo: "did:test",
      writes: [
        { $type: "com.atproto.repo.applyWrites#update", rkey: "k1" },
        { $type: "com.atproto.repo.applyWrites#update", rkey: "k2" },
        { $type: "com.atproto.repo.applyWrites#delete", rkey: "k3" },
      ],
    });

    const pending = await outboxDb.getAll();
    expect(pending).toEqual([]);
  });
});

describe("drainOutbox — atomic 4xx falls back to per-op", () => {
  it("retries each op individually and dead-letters the failing one", async () => {
    await outboxDb.queuePut(COLLECTION, "good1", { tid: "good1" });
    await outboxDb.queuePut(COLLECTION, "bad", { tid: "bad" });
    await outboxDb.queuePut(COLLECTION, "good2", { tid: "good2" });

    const applyWrites = vi
      .fn()
      .mockRejectedValue(new XRPCError(400, "InvalidRequest", "bad rec"));
    const putRecord = vi
      .fn()
      .mockImplementation(({ rkey }: { rkey: string }) => {
        if (rkey === "bad") {
          return Promise.reject(
            new XRPCError(400, "InvalidRequest", "field missing"),
          );
        }
        return Promise.resolve({
          headers: {},
          data: { uri: `at://did:test/${COLLECTION}/${rkey}`, cid: "x" },
        });
      });

    const agent = mockAgent("did:test", { applyWrites, putRecord });

    const res = await drainOutbox(agent);

    expect(res).toEqual({ status: "deadLettered", ops: 2, deadLettered: 1 });
    expect(putRecord).toHaveBeenCalledTimes(3);

    const remaining = await outboxDb.getAll();
    expect(remaining).toEqual([]);

    const dead = await deadLettersDb.getAll();
    expect(dead.length).toBe(1);
    expect(dead[0]!.recordKey).toBe("bad");
    expect(dead[0]!.error).toMatch(/field missing/);
  });
});

describe("drainOutbox — transient errors trigger backoff", () => {
  it("returns backoff and keeps entries on 5xx", async () => {
    await outboxDb.queuePut(COLLECTION, "k1", { tid: "k1" });

    let t = 1_000_000;
    __setDrainClock(() => t);

    const applyWrites = vi
      .fn()
      .mockRejectedValue(new XRPCError(503, "ServiceUnavailable", "down"));
    const agent = mockAgent("did:test", { applyWrites });

    const res = await drainOutbox(agent);
    expect(res.status).toBe("backoff");
    if (res.status === "backoff") {
      expect(res.reason).toBe("5xx");
      expect(res.until).toBe(t + 5000); // first backoff = 5s
    }

    const remaining = await outboxDb.getAll();
    expect(remaining.length).toBe(1);
  });

  it("returns backoff with reason 429 on rate-limit", async () => {
    await outboxDb.queuePut(COLLECTION, "k1", { tid: "k1" });

    const err = new XRPCError(429, "RateLimitExceeded", "slow");
    const applyWrites = vi.fn().mockRejectedValue(err);
    const agent = mockAgent("did:test", { applyWrites });

    const res = await drainOutbox(agent);
    expect(res.status).toBe("backoff");
    if (res.status === "backoff") expect(res.reason).toBe("429");
  });

  it("doubles the backoff window across consecutive failures", async () => {
    await outboxDb.queuePut(COLLECTION, "k1", { tid: "k1" });

    let t = 1_000_000;
    __setDrainClock(() => t);

    const applyWrites = vi
      .fn()
      .mockRejectedValue(new XRPCError(503, "ServiceUnavailable", "down"));
    const agent = mockAgent("did:test", { applyWrites });

    const first = await drainOutbox(agent);
    expect(first.status).toBe("backoff");
    const firstUntil = first.status === "backoff" ? first.until : 0;
    expect(firstUntil).toBe(t + 5000);

    // Advance past the retry window.
    t = firstUntil + 1;
    const second = await drainOutbox(agent);
    expect(second.status).toBe("backoff");
    if (second.status === "backoff") {
      // Second backoff should be 10s.
      expect(second.until).toBe(t + 10_000);
    }
  });

  it("short-circuits to backoff while the retry window is open", async () => {
    await outboxDb.queuePut(COLLECTION, "k1", { tid: "k1" });

    let t = 1_000_000;
    __setDrainClock(() => t);

    const applyWrites = vi
      .fn()
      .mockRejectedValue(new XRPCError(503, "ServiceUnavailable", "down"));
    const agent = mockAgent("did:test", { applyWrites });

    await drainOutbox(agent);
    expect(applyWrites).toHaveBeenCalledTimes(1);

    // Time hasn't advanced — second call short-circuits without re-attempting.
    const second = await drainOutbox(agent);
    expect(second.status).toBe("backoff");
    expect(applyWrites).toHaveBeenCalledTimes(1);
  });
});

describe("drainOutbox — coalescing", () => {
  it("coalesces put+delete into nothing", async () => {
    await outboxDb.queuePut(COLLECTION, "k1", { tid: "k1" });
    await outboxDb.queueDelete(COLLECTION, "k1");

    const applyWrites = vi.fn().mockResolvedValue({ headers: {}, data: {} });
    const agent = mockAgent("did:test", { applyWrites });

    const res = await drainOutbox(agent);
    expect(res).toEqual({ status: "idle" });
    expect(applyWrites).not.toHaveBeenCalled();
  });

  it("keeps only the latest put for the same key", async () => {
    await outboxDb.queuePut(COLLECTION, "k1", { tid: "k1", v: 1 });
    await outboxDb.queuePut(COLLECTION, "k1", { tid: "k1", v: 2 });
    await outboxDb.queuePut(COLLECTION, "k1", { tid: "k1", v: 3 });

    const applyWrites = vi.fn().mockResolvedValue({ headers: {}, data: {} });
    const agent = mockAgent("did:test", { applyWrites });

    const res = await drainOutbox(agent);
    expect(res).toEqual({ status: "done", ops: 1 });

    const writes = applyWrites.mock.calls[0]![0].writes;
    expect(writes.length).toBe(1);
    expect(writes[0].value).toEqual({ tid: "k1", v: 3 });
  });
});
