import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { deleteDb } from "../schema";
import { decksDb } from "../decks";
import { notesDb } from "../notes";
import { noteTypesDb } from "../noteTypes";
import { reviewStateDb } from "../reviewState";
import { reviewLogsDb } from "../reviewLogs";
import { mediaDb } from "../media";
import { settingsDb, deckSettingsDb } from "../settings";
import { outboxDb } from "../outbox";

const NS = "cards.decay.flashcard";
const isoNow = "2025-01-01T00:00:00Z";

beforeEach(async () => {
  await deleteDb();
});

describe("outbox wiring — every db module queues to outbox on put/delete", () => {
  it("decksDb.put / delete queue cards.decay.flashcard.deck ops", async () => {
    await decksDb.put({
      tid: "d1",
      name: "D",
      createdAt: isoNow,
      updatedAt: isoNow,
    });
    let pending = await outboxDb.getByCollection(`${NS}.deck`);
    expect(pending.length).toBe(1);
    expect(pending[0]).toMatchObject({ op: "put", recordKey: "d1" });

    await decksDb.delete("d1");
    pending = await outboxDb.getByCollection(`${NS}.deck`);
    expect(pending.length).toBe(2);
    expect(pending[1]).toMatchObject({ op: "delete", recordKey: "d1" });
  });

  it("notesDb.put queues, deleteMany batches in one tx", async () => {
    await notesDb.put({
      tid: "n1",
      deck: "at://x/d/1",
      noteType: "at://x/nt/1",
      fields: [],
      createdAt: isoNow,
      updatedAt: isoNow,
    });
    await notesDb.deleteMany(["n1", "n2"]);

    const pending = await outboxDb.getByCollection(`${NS}.note`);
    expect(pending.length).toBe(3);
    expect(pending.filter((p) => p.op === "delete").map((p) => p.recordKey).sort()).toEqual(
      ["n1", "n2"],
    );
  });

  it("noteTypesDb.put queues", async () => {
    await noteTypesDb.put({
      tid: "nt1",
      name: "Basic",
      fields: [],
      templates: [],
      createdAt: isoNow,
      updatedAt: isoNow,
    });
    const pending = await outboxDb.getByCollection(`${NS}.noteType`);
    expect(pending.length).toBe(1);
  });

  it("reviewStateDb.putMany queues one entry per record", async () => {
    await reviewStateDb.putMany([
      {
        key: "n1_t1",
        note: "at://x/n/n1",
        templateId: "t1",
        algorithm: "fsrs",
        phase: "new",
        reps: 0,
        lapses: 0,
        createdAt: isoNow,
        updatedAt: isoNow,
      },
      {
        key: "n2_t1",
        note: "at://x/n/n2",
        templateId: "t1",
        algorithm: "fsrs",
        phase: "new",
        reps: 0,
        lapses: 0,
        createdAt: isoNow,
        updatedAt: isoNow,
      },
    ]);
    const pending = await outboxDb.getByCollection(`${NS}.reviewState`);
    expect(pending.length).toBe(2);
    expect(pending.map((p) => p.recordKey).sort()).toEqual(["n1_t1", "n2_t1"]);
  });

  it("reviewLogsDb.put queues an append-only log", async () => {
    await reviewLogsDb.put({
      tid: "log1",
      note: "at://x/n/n1",
      deck: "at://x/d/d1",
      templateId: "t1",
      answer: "good",
      phase: "review",
      algorithm: "fsrs",
      reviewedAt: isoNow,
      resolvedDate: "2025-01-01",
    });
    const pending = await outboxDb.getByCollection(`${NS}.reviewLog`);
    expect(pending.length).toBe(1);
  });

  it("mediaDb.put queues metadata (blob handled separately)", async () => {
    await mediaDb.put({
      normalizedKey: "img.png",
      filename: "img.png",
      blob: new Blob(),
      mimeType: "image/png",
      createdAt: isoNow,
      updatedAt: isoNow,
    });
    const pending = await outboxDb.getByCollection(`${NS}.media`);
    expect(pending.length).toBe(1);
    // The outbox body should NOT contain the raw Blob — only metadata.
    const body = pending[0]!.record as Record<string, unknown>;
    expect(body).not.toHaveProperty("blob");
    expect(body).toMatchObject({ filename: "img.png", normalizedKey: "img.png" });
  });

  it("settingsDb.put queues with key 'self'", async () => {
    await settingsDb.put({
      key: "self",
      defaultAlgorithm: "fsrs",
      updatedAt: isoNow,
    });
    const pending = await outboxDb.getByCollection(`${NS}.settings`);
    expect(pending.length).toBe(1);
    expect(pending[0]!.recordKey).toBe("self");
  });

  it("deckSettingsDb.put queues with deckTid as rkey", async () => {
    await deckSettingsDb.put({
      deckTid: "d1",
      deck: "at://x/d/d1",
      updatedAt: isoNow,
    });
    const pending = await outboxDb.getByCollection(`${NS}.deckSettings`);
    expect(pending.length).toBe(1);
    expect(pending[0]!.recordKey).toBe("d1");
  });
});
