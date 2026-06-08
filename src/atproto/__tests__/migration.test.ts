import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { deleteDb } from "../../db/schema";
import { decksDb } from "../../db/decks";
import { notesDb } from "../../db/notes";
import { noteTypesDb } from "../../db/noteTypes";
import { reviewStateDb } from "../../db/reviewState";
import { reviewLogsDb } from "../../db/reviewLogs";
import { mediaDb } from "../../db/media";
import { settingsDb, deckSettingsDb } from "../../db/settings";
import { outboxDb } from "../../db/outbox";
import {
  migrateToPhase2,
  isPhase2Migrated,
  markPhase2Migrated,
  type MigrationProgress,
} from "../migration";

const NS = "cards.decay.flashcard";
const isoNow = "2025-01-01T00:00:00Z";

beforeEach(async () => {
  await deleteDb();
});

async function seedSomeData(): Promise<void> {
  // db modules also queue to outbox; clear it after seeding so the migration
  // starts from an empty outbox.
  await reviewLogsDb.putMany([
    {
      tid: "log-2025-02",
      note: "at://x/n/n1",
      deck: "at://x/d/d1",
      templateId: "t1",
      answer: "good",
      phase: "review",
      algorithm: "fsrs",
      reviewedAt: "2025-02-01T00:00:00Z",
      resolvedDate: "2025-02-01",
    },
    {
      tid: "log-2025-01",
      note: "at://x/n/n1",
      deck: "at://x/d/d1",
      templateId: "t1",
      answer: "good",
      phase: "review",
      algorithm: "fsrs",
      reviewedAt: "2025-01-01T00:00:00Z",
      resolvedDate: "2025-01-01",
    },
  ]);
  await reviewStateDb.put({
    key: "n1_t1",
    note: "at://x/n/n1",
    templateId: "t1",
    algorithm: "fsrs",
    phase: "review",
    reps: 2,
    lapses: 0,
    createdAt: isoNow,
    updatedAt: isoNow,
  });
  await notesDb.put({
    tid: "n1",
    deck: "at://x/d/d1",
    noteType: "at://x/nt/nt1",
    fields: [{ fieldId: "f0", value: "front" }],
    createdAt: isoNow,
    updatedAt: isoNow,
  });
  await noteTypesDb.put({
    tid: "nt1",
    name: "Basic",
    fields: [{ id: "f0", name: "Front" }],
    templates: [{ id: "t0", name: "Card 1", qfmt: "", afmt: "" }],
    createdAt: isoNow,
    updatedAt: isoNow,
  });
  await decksDb.put({
    tid: "d1",
    name: "D",
    createdAt: isoNow,
    updatedAt: isoNow,
  });
  await mediaDb.put({
    normalizedKey: "img.png",
    filename: "img.png",
    blob: new Blob(),
    mimeType: "image/png",
    createdAt: isoNow,
    updatedAt: isoNow,
  });
  await settingsDb.put({
    key: "self",
    defaultAlgorithm: "fsrs",
    updatedAt: isoNow,
  });
  await deckSettingsDb.put({
    deckTid: "d1",
    deck: "at://x/d/d1",
    updatedAt: isoNow,
  });
  await outboxDb.clear();
}

describe("migrateToPhase2 — first run", () => {
  it("enqueues every local record into the outbox", async () => {
    await seedSomeData();
    const progresses: MigrationProgress[] = [];
    const result = await migrateToPhase2((p) => progresses.push({ ...p }));

    expect(result.done).toBe(true);
    // 2 logs + 1 reviewState + 1 note + 1 noteType + 1 deck + 1 media + 1 settings + 1 deckSettings = 9
    expect(result.total).toBe(9);
    expect(result.queued).toBe(9);

    const outbox = await outboxDb.getAll();
    expect(outbox.length).toBe(9);

    // Each collection should be represented.
    const collections = new Set(outbox.map((e) => e.collection));
    expect(collections).toContain(`${NS}.reviewLog`);
    expect(collections).toContain(`${NS}.reviewState`);
    expect(collections).toContain(`${NS}.note`);
    expect(collections).toContain(`${NS}.noteType`);
    expect(collections).toContain(`${NS}.deck`);
    expect(collections).toContain(`${NS}.media`);
    expect(collections).toContain(`${NS}.settings`);
    expect(collections).toContain(`${NS}.deckSettings`);
  });

  it("sorts reviewLogs chronologically by TID", async () => {
    await seedSomeData();
    await migrateToPhase2();

    const logEntries = await outboxDb.getByCollection(`${NS}.reviewLog`);
    expect(logEntries.map((e) => e.recordKey)).toEqual(["log-2025-01", "log-2025-02"]);
  });

  it("marks migration as done after successful enqueue", async () => {
    await seedSomeData();
    expect(await isPhase2Migrated()).toBe(false);
    await migrateToPhase2();
    expect(await isPhase2Migrated()).toBe(true);
  });

  it("queues media metadata only, no Blob in outbox body", async () => {
    await seedSomeData();
    await migrateToPhase2();
    const mediaOutbox = await outboxDb.getByCollection(`${NS}.media`);
    expect(mediaOutbox.length).toBe(1);
    const body = mediaOutbox[0]!.record as Record<string, unknown>;
    expect(body).not.toHaveProperty("blob");
    expect(body).toMatchObject({ filename: "img.png", normalizedKey: "img.png" });
  });
});

describe("migrateToPhase2 — idempotency", () => {
  it("second call after success is a no-op", async () => {
    await seedSomeData();
    const first = await migrateToPhase2();
    expect(first.total).toBe(9);

    // Manually inject more data — this should NOT be enqueued by a re-run,
    // because the migration flag is already set.
    await notesDb.put({
      tid: "n2",
      deck: "at://x/d/d1",
      noteType: "at://x/nt/nt1",
      fields: [],
      createdAt: isoNow,
      updatedAt: isoNow,
    });
    await outboxDb.clear();

    const second = await migrateToPhase2();
    expect(second).toEqual({ total: 0, queued: 0, done: true });
    expect(await outboxDb.getAll()).toEqual([]);
  });

  it("markPhase2Migrated short-circuits future migrations (fresh-install path)", async () => {
    await markPhase2Migrated();
    await seedSomeData();
    await outboxDb.clear(); // simulate user signing in before any local writes
    const result = await migrateToPhase2();
    expect(result.total).toBe(0);
    expect((await outboxDb.getAll()).length).toBe(0);
  });

  it("empty-local migration sets the flag without queueing anything", async () => {
    const result = await migrateToPhase2();
    expect(result.total).toBe(0);
    expect(result.done).toBe(true);
    expect(await isPhase2Migrated()).toBe(true);
    expect((await outboxDb.getAll()).length).toBe(0);
  });
});

describe("migrateToPhase2 — progress reporting", () => {
  it("emits progress callbacks with growing queued counts", async () => {
    await seedSomeData();
    const progresses: MigrationProgress[] = [];
    await migrateToPhase2((p) => progresses.push({ ...p }));

    // Each non-empty collection causes one progress emission.
    // Final emission has done=true.
    expect(progresses.length).toBeGreaterThanOrEqual(1);
    expect(progresses[progresses.length - 1]).toEqual({
      total: 9,
      queued: 9,
      done: true,
    });
    // Counts are monotonically non-decreasing.
    for (let i = 1; i < progresses.length; i++) {
      expect(progresses[i]!.queued).toBeGreaterThanOrEqual(progresses[i - 1]!.queued);
    }
  });
});
