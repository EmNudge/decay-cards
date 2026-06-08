import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { type Agent } from "@atproto/api";
import { deleteDb, getDb } from "../../db/schema";
import { outboxDb } from "../../db/outbox";
import { syncStateDb } from "../../db/syncState";
import { decksDb } from "../../db/decks";
import { notesDb } from "../../db/notes";
import { reviewLogsDb } from "../../db/reviewLogs";
import { globalLimiter } from "../rateLimit";
import { runReadSync } from "../sync";

interface AgentMockOps {
  getLatestCommit?: ReturnType<typeof vi.fn>;
  listRecords?: ReturnType<typeof vi.fn>;
}

function mockAgent(did: string, ops: AgentMockOps): Agent {
  return {
    did,
    com: {
      atproto: {
        repo: {
          listRecords:
            ops.listRecords ??
            vi.fn().mockResolvedValue({
              headers: {},
              data: { records: [], cursor: undefined },
            }),
          // unused but RecordsClient checks the surface
          putRecord: vi.fn(),
          deleteRecord: vi.fn(),
          getRecord: vi.fn(),
          applyWrites: vi.fn(),
        },
        sync: {
          getLatestCommit:
            ops.getLatestCommit ??
            vi.fn().mockResolvedValue({ headers: {}, data: { cid: "c", rev: "r1" } }),
        },
      },
    },
  } as unknown as Agent;
}

const NS = "cards.decay.flashcard";

/** Build a listRecords mock that returns the given map of records by NSID. */
function listRecordsFor(byNsid: Record<string, Array<{ rkey: string; value: unknown }>>) {
  return vi.fn().mockImplementation(({ collection }: { collection: string }) => {
    const items = byNsid[collection] ?? [];
    return Promise.resolve({
      headers: {},
      data: {
        records: items.map((r) => ({
          uri: `at://did:test/${collection}/${r.rkey}`,
          cid: "cid-" + r.rkey,
          value: r.value,
        })),
        cursor: undefined,
      },
    });
  });
}

beforeEach(async () => {
  await deleteDb();
  globalLimiter.reset();
});

describe("runReadSync — repo-rev short-circuit", () => {
  it("returns 'unchanged' when remote rev matches stored rev", async () => {
    await syncStateDb.setRepoRev("abc");
    const listRecords = listRecordsFor({});
    const getLatestCommit = vi.fn().mockResolvedValue({
      headers: {},
      data: { cid: "c", rev: "abc" },
    });
    const agent = mockAgent("did:test", { getLatestCommit, listRecords });

    const res = await runReadSync(agent);
    expect(res).toEqual({ status: "unchanged", rev: "abc" });
    expect(listRecords).not.toHaveBeenCalled();
  });

  it("does full traversal when rev differs", async () => {
    await syncStateDb.setRepoRev("old");
    const listRecords = listRecordsFor({});
    const getLatestCommit = vi.fn().mockResolvedValue({
      headers: {},
      data: { cid: "c", rev: "new" },
    });
    const agent = mockAgent("did:test", { getLatestCommit, listRecords });

    const res = await runReadSync(agent);
    expect(res.status).toBe("synced");
    if (res.status === "synced") expect(res.rev).toBe("new");
    // listRecords should have been hit once per collection in the registry.
    expect(listRecords.mock.calls.length).toBeGreaterThan(0);
  });

  it("reports first-run when there is no stored rev", async () => {
    const agent = mockAgent("did:test", { listRecords: listRecordsFor({}) });
    const res = await runReadSync(agent);
    expect(res.status).toBe("first-run");
    expect(await syncStateDb.getRepoRev()).toBe("r1");
  });
});

describe("runReadSync — LWW", () => {
  it("inserts remote-only records into local store", async () => {
    const listRecords = listRecordsFor({
      [`${NS}.deck`]: [
        {
          rkey: "deck-1",
          value: {
            tid: "deck-1",
            name: "Imported",
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          },
        },
      ],
    });
    const agent = mockAgent("did:test", { listRecords });

    const res = await runReadSync(agent);
    const deckResult =
      res.status !== "unchanged" ? res.collections.find((c) => c.nsid === `${NS}.deck`) : undefined;
    expect(deckResult?.inserted).toBe(1);

    const stored = await decksDb.get("deck-1");
    expect(stored?.name).toBe("Imported");
  });

  it("overwrites local with newer remote", async () => {
    await decksDb.put({
      tid: "d1",
      name: "Old",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });
    const listRecords = listRecordsFor({
      [`${NS}.deck`]: [
        {
          rkey: "d1",
          value: {
            tid: "d1",
            name: "New",
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-02-01T00:00:00Z",
          },
        },
      ],
    });
    const agent = mockAgent("did:test", { listRecords });
    await runReadSync(agent);

    const stored = await decksDb.get("d1");
    expect(stored?.name).toBe("New");
  });

  it("keeps local when local is newer than remote", async () => {
    await decksDb.put({
      tid: "d1",
      name: "Local edit",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-03-01T00:00:00Z",
    });
    const listRecords = listRecordsFor({
      [`${NS}.deck`]: [
        {
          rkey: "d1",
          value: {
            tid: "d1",
            name: "Stale remote",
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-02-01T00:00:00Z",
          },
        },
      ],
    });
    const agent = mockAgent("did:test", { listRecords });
    await runReadSync(agent);

    const stored = await decksDb.get("d1");
    expect(stored?.name).toBe("Local edit");
  });

  it("deletes local record when remote no longer has it", async () => {
    await decksDb.put({
      tid: "ghost",
      name: "Will be deleted",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });
    // Simulate "already-synced" — clear the outbox so the deletion-from-
    // local pass doesn't see a pending local put.
    await outboxDb.clear();

    const listRecords = listRecordsFor({}); // empty remote
    const agent = mockAgent("did:test", { listRecords });
    await runReadSync(agent);

    expect(await decksDb.get("ghost")).toBeUndefined();
  });
});

describe("runReadSync — skip-if-pending", () => {
  it("skips remote update when outbox has a newer pending put", async () => {
    await decksDb.put({
      tid: "d1",
      name: "Local edit",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-03-01T00:00:00Z",
    });
    await outboxDb.queuePut(`${NS}.deck`, "d1", {
      tid: "d1",
      name: "Local edit",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-03-01T00:00:00Z",
    });

    const listRecords = listRecordsFor({
      [`${NS}.deck`]: [
        {
          rkey: "d1",
          value: {
            tid: "d1",
            name: "Stale remote",
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-02-01T00:00:00Z",
          },
        },
      ],
    });
    const agent = mockAgent("did:test", { listRecords });
    const res = await runReadSync(agent);

    const stored = await decksDb.get("d1");
    expect(stored?.name).toBe("Local edit");

    if (res.status !== "unchanged") {
      const r = res.collections.find((c) => c.nsid === `${NS}.deck`);
      expect(r?.skippedPending).toBe(1);
    }
  });

  it("does not delete local when outbox has a pending put for the same key", async () => {
    await decksDb.put({
      tid: "new-local",
      name: "Just made it",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });
    await outboxDb.queuePut(`${NS}.deck`, "new-local", {
      tid: "new-local",
      name: "Just made it",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });

    const listRecords = listRecordsFor({}); // remote knows nothing
    const agent = mockAgent("did:test", { listRecords });
    await runReadSync(agent);

    expect(await decksDb.get("new-local")).toBeDefined();
  });
});

describe("runReadSync — append-only reviewLogs", () => {
  it("inserts new reviewLogs and dedups existing ones", async () => {
    await reviewLogsDb.put({
      tid: "log1",
      note: "at://did:test/note/n1",
      deck: "at://did:test/deck/d1",
      templateId: "t1",
      answer: "good",
      phase: "review",
      algorithm: "fsrs",
      reviewedAt: "2025-01-01T00:00:00Z",
      resolvedDate: "2025-01-01",
    });

    const listRecords = listRecordsFor({
      [`${NS}.reviewLog`]: [
        {
          rkey: "log1",
          value: {
            tid: "log1",
            note: "at://did:test/note/n1",
            deck: "at://did:test/deck/d1",
            templateId: "t1",
            answer: "good",
            phase: "review",
            algorithm: "fsrs",
            reviewedAt: "2025-01-01T00:00:00Z",
            resolvedDate: "2025-01-01",
          },
        },
        {
          rkey: "log2",
          value: {
            tid: "log2",
            note: "at://did:test/note/n1",
            deck: "at://did:test/deck/d1",
            templateId: "t1",
            answer: "easy",
            phase: "review",
            algorithm: "fsrs",
            reviewedAt: "2025-01-02T00:00:00Z",
            resolvedDate: "2025-01-02",
          },
        },
      ],
    });
    const agent = mockAgent("did:test", { listRecords });

    const res = await runReadSync(agent);
    const all = await reviewLogsDb.getAll();
    expect(all.map((l) => l.tid).sort()).toEqual(["log1", "log2"]);

    if (res.status !== "unchanged") {
      const r = res.collections.find((c) => c.nsid === `${NS}.reviewLog`);
      expect(r?.inserted).toBe(1); // log2 only
    }
  });

  it("does not delete local reviewLogs missing from remote", async () => {
    await reviewLogsDb.put({
      tid: "local-only",
      note: "at://did:test/note/n1",
      deck: "at://did:test/deck/d1",
      templateId: "t1",
      answer: "good",
      phase: "review",
      algorithm: "fsrs",
      reviewedAt: "2025-01-01T00:00:00Z",
      resolvedDate: "2025-01-01",
    });
    const agent = mockAgent("did:test", { listRecords: listRecordsFor({}) });
    await runReadSync(agent);
    expect((await reviewLogsDb.getAll()).length).toBe(1);
  });
});

describe("runReadSync — deferred strategies", () => {
  it("inserts remote-only noteType records (deferring update merge to Step 6)", async () => {
    const listRecords = listRecordsFor({
      [`${NS}.noteType`]: [
        {
          rkey: "nt1",
          value: {
            tid: "nt1",
            name: "Basic",
            fields: [{ id: "f0", name: "Front" }],
            templates: [{ id: "t0", name: "Card 1", qfmt: "{{Front}}", afmt: "" }],
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          },
        },
      ],
    });
    const agent = mockAgent("did:test", { listRecords });
    const res = await runReadSync(agent);

    // Insert succeeded.
    const db = await getDb();
    const stored = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction("noteTypes", "readonly");
      const req = tx.objectStore("noteTypes").get("nt1");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(stored).toBeDefined();
    if (res.status !== "unchanged") {
      const r = res.collections.find((c) => c.nsid === `${NS}.noteType`);
      expect(r?.inserted).toBe(1);
      expect(r?.skippedStrategy).toBe(0);
    }
  });

  it("unions noteType fields/templates when local already exists", async () => {
    const db = await getDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("noteTypes", "readwrite");
      tx.objectStore("noteTypes").put({
        tid: "nt1",
        name: "Local",
        fields: [{ id: "f0", name: "Front" }],
        templates: [{ id: "t0", name: "Card 1", qfmt: "", afmt: "" }],
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    const listRecords = listRecordsFor({
      [`${NS}.noteType`]: [
        {
          rkey: "nt1",
          value: {
            tid: "nt1",
            name: "Remote",
            fields: [{ id: "f1", name: "Back" }],
            templates: [],
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-02-01T00:00:00Z",
          },
        },
      ],
    });
    const agent = mockAgent("did:test", { listRecords });
    const res = await runReadSync(agent);

    const stored = await new Promise<any>((resolve, reject) => {
      void getDb().then((db) => {
        const tx = db.transaction("noteTypes", "readonly");
        const req = tx.objectStore("noteTypes").get("nt1");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    });
    expect(stored.name).toBe("Remote"); // record-level LWW (remote newer)
    expect(stored.fields.map((f: { id: string }) => f.id).sort()).toEqual(["f0", "f1"]);

    if (res.status !== "unchanged") {
      const r = res.collections.find((c) => c.nsid === `${NS}.noteType`);
      expect(r?.updated).toBe(1);
      expect(r?.skippedStrategy).toBe(0);
    }
  });
});

describe("runReadSync — reviewState reconciliation", () => {
  it("reconciles after-state from the union of merged reviewLogs", async () => {
    const db = await getDb();
    // Local reviewState lagging behind the latest log.
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("reviewState", "readwrite");
      tx.objectStore("reviewState").put({
        key: "n1_t1",
        note: "at://did:test/cards.decay.flashcard.note/n1",
        templateId: "t1",
        algorithm: "fsrs",
        phase: "learning",
        reps: 1,
        lapses: 0,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-10T00:00:00Z",
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    const listRecords = listRecordsFor({
      [`${NS}.reviewLog`]: [
        {
          rkey: "log-late",
          value: {
            tid: "log-late",
            note: "at://did:test/cards.decay.flashcard.note/n1",
            deck: "at://did:test/cards.decay.flashcard.deck/d1",
            templateId: "t1",
            answer: "good",
            phase: "review",
            algorithm: "fsrs",
            phaseAfter: "review",
            repsAfter: 5,
            lapsesAfter: 0,
            stabilityAfter: 9.9,
            difficultyAfter: 3.3,
            reviewedAt: "2025-02-15T00:00:00Z",
            resolvedDate: "2025-02-15",
          },
        },
      ],
      [`${NS}.reviewState`]: [
        {
          rkey: "n1_t1",
          value: {
            key: "n1_t1",
            note: "at://did:test/cards.decay.flashcard.note/n1",
            templateId: "t1",
            algorithm: "fsrs",
            phase: "review",
            reps: 3, // stale relative to the latest log
            lapses: 0,
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-02-01T00:00:00Z",
          },
        },
      ],
    });
    const agent = mockAgent("did:test", { listRecords });
    await runReadSync(agent);

    const merged = await new Promise<any>((resolve, reject) => {
      void getDb().then((db) => {
        const tx = db.transaction("reviewState", "readonly");
        const req = tx.objectStore("reviewState").get("n1_t1");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    });
    expect(merged.reps).toBe(5);
    expect(merged.stability).toBeCloseTo(9.9);
    expect(merged.difficulty).toBeCloseTo(3.3);
    expect(merged.lastReviewed).toBe("2025-02-15T00:00:00Z");
  });
});

describe("runReadSync — studySummary rebuild", () => {
  it("rebuilds the summary from synced reviewLogs for its date", async () => {
    const db = await getDb();
    // Existing stale local summary for 2025-01-01.
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("studySummary", "readwrite");
      tx.objectStore("studySummary").put({
        date: "2025-01-01",
        reviewCount: 1,
        newCount: 1,
        timeSpentMs: 1000,
        againCount: 0,
        hardCount: 0,
        goodCount: 1,
        easyCount: 0,
        updatedAt: "2025-01-02T00:00:00Z",
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    const listRecords = listRecordsFor({
      [`${NS}.reviewLog`]: [
        {
          rkey: "log1",
          value: {
            tid: "log1",
            note: "at://did:test/cards.decay.flashcard.note/n1",
            deck: "at://did:test/cards.decay.flashcard.deck/d1",
            templateId: "t1",
            answer: "easy",
            phase: "review",
            algorithm: "fsrs",
            timeTaken: 2000,
            reviewedAt: "2025-01-01T10:00:00Z",
            resolvedDate: "2025-01-01",
          },
        },
        {
          rkey: "log2",
          value: {
            tid: "log2",
            note: "at://did:test/cards.decay.flashcard.note/n2",
            deck: "at://did:test/cards.decay.flashcard.deck/d1",
            templateId: "t1",
            answer: "good",
            phase: "new",
            algorithm: "fsrs",
            timeTaken: 3000,
            reviewedAt: "2025-01-01T11:00:00Z",
            resolvedDate: "2025-01-01",
          },
        },
      ],
      [`${NS}.studySummary`]: [
        {
          rkey: "2025-01-01",
          value: {
            date: "2025-01-01",
            reviewCount: 99, // wrong on purpose to confirm rebuild
            updatedAt: "2025-01-02T00:00:00Z",
          },
        },
      ],
    });
    const agent = mockAgent("did:test", { listRecords });
    await runReadSync(agent);

    const merged = await new Promise<any>((resolve, reject) => {
      void getDb().then((db) => {
        const tx = db.transaction("studySummary", "readonly");
        const req = tx.objectStore("studySummary").get("2025-01-01");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    });
    expect(merged.reviewCount).toBe(2);
    expect(merged.newCount).toBe(1);
    expect(merged.easyCount).toBe(1);
    expect(merged.goodCount).toBe(1);
    expect(merged.timeSpentMs).toBe(5000);
  });
});

describe("runReadSync — first-run inserts notes too", () => {
  it("walks notes alongside decks", async () => {
    const listRecords = listRecordsFor({
      [`${NS}.deck`]: [
        {
          rkey: "d1",
          value: {
            tid: "d1",
            name: "D",
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          },
        },
      ],
      [`${NS}.note`]: [
        {
          rkey: "n1",
          value: {
            tid: "n1",
            deck: "at://did:test/cards.decay.flashcard.deck/d1",
            noteType: "at://did:test/cards.decay.flashcard.noteType/nt1",
            fields: [],
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          },
        },
      ],
    });
    const agent = mockAgent("did:test", { listRecords });
    await runReadSync(agent);

    expect(await decksDb.get("d1")).toBeDefined();
    expect(await notesDb.get("n1")).toBeDefined();
  });
});
