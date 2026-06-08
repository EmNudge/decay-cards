import { describe, it, expect, vi } from "vitest";
import { type Agent, XRPCError } from "@atproto/api";
import { RecordsClient, batchWrites, type WriteOp } from "../records";
import { RateLimiter, type RateLimitClock } from "../rateLimit";

const instantClock: RateLimitClock = {
  now: () => 0,
  sleep: () => Promise.resolve(),
};

function newLimiter(): RateLimiter {
  return new RateLimiter(instantClock);
}

interface MockOps {
  putRecord?: ReturnType<typeof vi.fn>;
  deleteRecord?: ReturnType<typeof vi.fn>;
  getRecord?: ReturnType<typeof vi.fn>;
  listRecords?: ReturnType<typeof vi.fn>;
  applyWrites?: ReturnType<typeof vi.fn>;
}

function mockAgent(did: string, ops: MockOps): Agent {
  return {
    did,
    com: {
      atproto: {
        repo: {
          putRecord: ops.putRecord ?? vi.fn(),
          deleteRecord: ops.deleteRecord ?? vi.fn(),
          getRecord: ops.getRecord ?? vi.fn(),
          listRecords: ops.listRecords ?? vi.fn(),
          applyWrites: ops.applyWrites ?? vi.fn(),
        },
      },
    },
  } as unknown as Agent;
}

describe("RecordsClient.putRecord", () => {
  it("calls agent.putRecord with repo did + returns uri/cid", async () => {
    const putRecord = vi.fn().mockResolvedValue({
      headers: {},
      data: { uri: "at://did:abc/c.col/key", cid: "bafy123" },
    });
    const agent = mockAgent("did:abc", { putRecord });
    const client = new RecordsClient(agent, newLimiter());

    const res = await client.putRecord("c.col", "key", { v: 1 });

    expect(res).toEqual({ uri: "at://did:abc/c.col/key", cid: "bafy123" });
    expect(putRecord).toHaveBeenCalledWith({
      repo: "did:abc",
      collection: "c.col",
      rkey: "key",
      record: { v: 1 },
    });
  });

  it("throws if agent has no DID", async () => {
    const agent = mockAgent("", { putRecord: vi.fn() });
    const client = new RecordsClient(agent, newLimiter());
    await expect(client.putRecord("c.col", "k", {})).rejects.toThrow(
      /authenticated agent/,
    );
  });
});

describe("RecordsClient.deleteRecord", () => {
  it("treats 404 as success (idempotent)", async () => {
    const err = new XRPCError(404, "RecordNotFound", "Not found");
    const deleteRecord = vi.fn().mockRejectedValue(err);
    const agent = mockAgent("did:abc", { deleteRecord });
    const client = new RecordsClient(agent, newLimiter());

    await expect(
      client.deleteRecord("c.col", "missing"),
    ).resolves.toBeUndefined();
    expect(deleteRecord).toHaveBeenCalled();
  });

  it("re-throws non-404 errors", async () => {
    const err = new XRPCError(500, "InternalServerError", "boom");
    const deleteRecord = vi.fn().mockRejectedValue(err);
    const agent = mockAgent("did:abc", { deleteRecord });
    const client = new RecordsClient(agent, newLimiter());

    await expect(client.deleteRecord("c.col", "k")).rejects.toBe(err);
  });
});

describe("RecordsClient.getRecord", () => {
  it("returns null on 404", async () => {
    const err = new XRPCError(404, "RecordNotFound", "missing");
    const getRecord = vi.fn().mockRejectedValue(err);
    const agent = mockAgent("did:abc", { getRecord });
    const client = new RecordsClient(agent, newLimiter());

    const res = await client.getRecord("c.col", "k");
    expect(res).toBeNull();
  });

  it("returns the record body on success", async () => {
    const getRecord = vi.fn().mockResolvedValue({
      headers: {},
      data: { uri: "at://did:abc/c.col/k", cid: "bafy1", value: { foo: "bar" } },
    });
    const agent = mockAgent("did:abc", { getRecord });
    const client = new RecordsClient(agent, newLimiter());

    const res = await client.getRecord("c.col", "k");
    expect(res).toEqual({
      uri: "at://did:abc/c.col/k",
      cid: "bafy1",
      value: { foo: "bar" },
    });
  });
});

describe("RecordsClient.listRecordsAll (pagination)", () => {
  it("follows cursors across pages and yields each page", async () => {
    const pages = [
      {
        headers: {},
        data: {
          records: [
            { uri: "at://x/c/1", cid: "c1", value: { n: 1 } },
            { uri: "at://x/c/2", cid: "c2", value: { n: 2 } },
          ],
          cursor: "after-2",
        },
      },
      {
        headers: {},
        data: {
          records: [{ uri: "at://x/c/3", cid: "c3", value: { n: 3 } }],
          cursor: undefined,
        },
      },
    ];
    const listRecords = vi.fn();
    listRecords.mockResolvedValueOnce(pages[0]);
    listRecords.mockResolvedValueOnce(pages[1]);
    const agent = mockAgent("did:x", { listRecords });
    const client = new RecordsClient(agent, newLimiter());

    const collected: unknown[] = [];
    for await (const page of client.listRecordsAll("c.col", 100)) {
      collected.push(...page.map((r) => r.value));
    }

    expect(collected).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(listRecords).toHaveBeenCalledTimes(2);
    expect(listRecords.mock.calls[0]![0]).not.toHaveProperty("cursor");
    expect(listRecords.mock.calls[1]![0]).toMatchObject({ cursor: "after-2" });
  });

  it("stops without re-querying when first page has no cursor", async () => {
    const listRecords = vi.fn().mockResolvedValue({
      headers: {},
      data: { records: [], cursor: undefined },
    });
    const agent = mockAgent("did:x", { listRecords });
    const client = new RecordsClient(agent, newLimiter());

    const pages: unknown[] = [];
    for await (const p of client.listRecordsAll("c.col")) {
      pages.push(p);
    }

    expect(pages).toEqual([]);
    expect(listRecords).toHaveBeenCalledTimes(1);
  });
});

describe("RecordsClient.applyWrites", () => {
  it("translates ops to lexicon-typed shape", async () => {
    const applyWrites = vi.fn().mockResolvedValue({ headers: {}, data: {} });
    const agent = mockAgent("did:x", { applyWrites });
    const client = new RecordsClient(agent, newLimiter());

    await client.applyWrites([
      { op: "create", collection: "c.col", rkey: "k1", value: { a: 1 } },
      { op: "update", collection: "c.col", rkey: "k2", value: { a: 2 } },
      { op: "delete", collection: "c.col", rkey: "k3" },
    ]);

    expect(applyWrites).toHaveBeenCalledWith({
      repo: "did:x",
      writes: [
        {
          $type: "com.atproto.repo.applyWrites#create",
          collection: "c.col",
          rkey: "k1",
          value: { a: 1 },
        },
        {
          $type: "com.atproto.repo.applyWrites#update",
          collection: "c.col",
          rkey: "k2",
          value: { a: 2 },
        },
        {
          $type: "com.atproto.repo.applyWrites#delete",
          collection: "c.col",
          rkey: "k3",
        },
      ],
    });
  });

  it("no-ops on empty writes", async () => {
    const applyWrites = vi.fn();
    const agent = mockAgent("did:x", { applyWrites });
    const client = new RecordsClient(agent, newLimiter());
    await client.applyWrites([]);
    expect(applyWrites).not.toHaveBeenCalled();
  });

  it("rejects oversized single batches", async () => {
    const agent = mockAgent("did:x", { applyWrites: vi.fn() });
    const client = new RecordsClient(agent, newLimiter());

    const writes: WriteOp[] = Array.from({ length: 201 }, (_, i) => ({
      op: "delete",
      collection: "c.col",
      rkey: `k${i}`,
    }));
    await expect(client.applyWrites(writes)).rejects.toThrow(/exceeds limit/);
  });
});

describe("batchWrites", () => {
  it("splits at 200 ops", () => {
    const writes: WriteOp[] = Array.from({ length: 450 }, (_, i) => ({
      op: "delete",
      collection: "c.col",
      rkey: `k${i}`,
    }));
    const batches = batchWrites(writes);
    expect(batches.map((b) => b.length)).toEqual([200, 200, 50]);
  });

  it("splits at 5 MB", () => {
    const big = "x".repeat(1_000_000); // 1 MB string
    const writes: WriteOp[] = Array.from({ length: 10 }, (_, i) => ({
      op: "create",
      collection: "c.col",
      rkey: `k${i}`,
      value: { blob: big },
    }));
    const batches = batchWrites(writes);
    // Each op is ~1 MB; expect ~5 per batch.
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) {
      expect(b.length).toBeLessThanOrEqual(5);
    }
  });

  it("preserves order across batches", () => {
    const writes: WriteOp[] = Array.from({ length: 250 }, (_, i) => ({
      op: "delete",
      collection: "c.col",
      rkey: `k${i}`,
    }));
    const batches = batchWrites(writes);
    const flat = batches.flat();
    expect(flat.map((w) => w.op === "delete" && w.rkey)).toEqual(
      writes.map((w) => w.op === "delete" && w.rkey),
    );
  });
});

describe("RecordsClient backoff on 429", () => {
  it("calls limiter.backoff with Retry-After when 429 is thrown", async () => {
    const limiter = newLimiter();
    const backoffSpy = vi.spyOn(limiter, "backoff");
    const err = new XRPCError(429, "RateLimitExceeded", "slow down");
    (err as unknown as { headers: Record<string, string> }).headers = {
      "retry-after": "7",
    };
    const putRecord = vi.fn().mockRejectedValue(err);
    const agent = mockAgent("did:x", { putRecord });
    const client = new RecordsClient(agent, limiter);

    await expect(client.putRecord("c.col", "k", {})).rejects.toBe(err);
    expect(backoffSpy).toHaveBeenCalledWith("7");
  });
});
