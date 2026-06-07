import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { getDb, deleteDb } from "../schema";
import { decksDb } from "../decks";
import { notesDb } from "../notes";
import { reviewStateDb, reviewStateKey } from "../reviewState";
import { reviewLogsDb } from "../reviewLogs";
import { outboxDb } from "../outbox";
import { settingsDb, deckSettingsDb, APP_DEFAULTS } from "../settings";

beforeEach(async () => {
  await deleteDb();
});

describe("schema", () => {
  it("opens the database and creates all stores", async () => {
    const db = await getDb();
    const storeNames = Array.from(db.objectStoreNames);
    expect(storeNames).toContain("notes");
    expect(storeNames).toContain("decks");
    expect(storeNames).toContain("noteTypes");
    expect(storeNames).toContain("media");
    expect(storeNames).toContain("reviewState");
    expect(storeNames).toContain("reviewLogs");
    expect(storeNames).toContain("cardFlags");
    expect(storeNames).toContain("studySummary");
    expect(storeNames).toContain("settings");
    expect(storeNames).toContain("deckSettings");
    expect(storeNames).toContain("outbox");
    expect(storeNames).toContain("deadLetters");
    expect(storeNames).toContain("syncState");
    expect(storeNames).toContain("dailyLimits");
    expect(storeNames).toContain("clozeOrdinals");
    expect(storeNames).toContain("undoBuffer");
    expect(storeNames).toContain("forkProgress");
    expect(storeNames).toContain("shareDeck");
    expect(storeNames).toContain("forkDeck");
  });
});

describe("decksDb", () => {
  it("puts and gets a deck", async () => {
    const deck = {
      tid: "deck1",
      name: "Japanese",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    await decksDb.put(deck);
    const result = await decksDb.get("deck1");
    expect(result).toEqual(deck);
  });

  it("getAllActive excludes deleted decks", async () => {
    await decksDb.put({
      tid: "d1",
      name: "Active",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    await decksDb.put({
      tid: "d2",
      name: "Deleted",
      deletedAt: "2026-06-01T00:00:00Z",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const active = await decksDb.getAllActive();
    expect(active).toHaveLength(1);
    expect(active[0]!.tid).toBe("d1");
  });
});

describe("notesDb", () => {
  it("dedup lookup by ankiNoteId", async () => {
    const note = {
      tid: "n1",
      deck: "at://did:plc:123/cards.decay.flashcard.deck/deck1",
      noteType: "at://did:plc:123/cards.decay.flashcard.noteType/nt1",
      ankiNoteId: 1234567890,
      fields: [{ fieldId: "f0", value: "front" }],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    await notesDb.put(note);
    const found = await notesDb.getByAnkiNoteId(1234567890);
    expect(found?.tid).toBe("n1");
    const notFound = await notesDb.getByAnkiNoteId(9999);
    expect(notFound).toBeUndefined();
  });
});

describe("reviewStateDb", () => {
  it("uses composite key", async () => {
    const rs = {
      key: reviewStateKey("n1", "card1"),
      note: "at://did:plc:123/cards.decay.flashcard.note/n1",
      templateId: "card1",
      algorithm: "fsrs" as const,
      phase: "new" as const,
      reps: 0,
      lapses: 0,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    await reviewStateDb.put(rs);
    const result = await reviewStateDb.getByNoteAndTemplate("n1", "card1");
    expect(result?.key).toBe("n1_card1");
  });
});

describe("settingsDb", () => {
  it("returns app defaults when no settings exist", async () => {
    const resolved = await settingsDb.getResolved();
    expect(resolved.defaultAlgorithm).toBe("fsrs");
    expect(resolved.dayStartHour).toBe(4);
  });

  it("overrides defaults with stored values", async () => {
    await settingsDb.put({
      key: "self",
      defaultAlgorithm: "sm2",
      dayStartHour: 6,
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const resolved = await settingsDb.getResolved();
    expect(resolved.defaultAlgorithm).toBe("sm2");
    expect(resolved.dayStartHour).toBe(6);
  });
});

describe("deckSettingsDb", () => {
  it("falls through to app defaults", async () => {
    const resolved = await deckSettingsDb.getResolved("nonexistent");
    expect(resolved.newCardsPerDay).toBe(APP_DEFAULTS.newCardsPerDay);
    expect(resolved.learningSteps).toEqual([1, 10]);
    expect(resolved.algorithm).toBe("fsrs");
  });

  it("per-deck overrides win", async () => {
    await deckSettingsDb.put({
      deckTid: "d1",
      deck: "at://did:plc:123/cards.decay.flashcard.deck/d1",
      newCardsPerDay: 50,
      algorithm: "sm2",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const resolved = await deckSettingsDb.getResolved("d1");
    expect(resolved.newCardsPerDay).toBe(50);
    expect(resolved.algorithm).toBe("sm2");
    // Non-overridden fields fall through
    expect(resolved.reviewsPerDay).toBe(APP_DEFAULTS.reviewsPerDay);
  });
});

describe("outboxDb", () => {
  it("coalesces put+delete for same key into no-op", async () => {
    await outboxDb.queuePut("notes", "n1", { tid: "n1", deck: "d1" });
    await outboxDb.queueDelete("notes", "n1");
    const coalesced = await outboxDb.coalesce();
    expect(coalesced).toHaveLength(0);
  });

  it("coalesces multiple puts for same key into last one", async () => {
    await outboxDb.queuePut("notes", "n1", { tid: "n1", value: "v1" });
    await outboxDb.queuePut("notes", "n1", { tid: "n1", value: "v2" });
    const coalesced = await outboxDb.coalesce();
    expect(coalesced).toHaveLength(1);
    expect((coalesced[0]!.record as { value: string }).value).toBe("v2");
  });

  it("coalesces delete+put for same key into put", async () => {
    await outboxDb.queueDelete("notes", "n1");
    await outboxDb.queuePut("notes", "n1", { tid: "n1", value: "new" });
    const coalesced = await outboxDb.coalesce();
    expect(coalesced).toHaveLength(1);
    expect(coalesced[0]!.op).toBe("put");
  });

  it("keeps independent entries", async () => {
    await outboxDb.queuePut("notes", "n1", { tid: "n1" });
    await outboxDb.queuePut("notes", "n2", { tid: "n2" });
    await outboxDb.queueDelete("decks", "d1");
    const coalesced = await outboxDb.coalesce();
    expect(coalesced).toHaveLength(3);
  });
});

describe("reviewLogsDb", () => {
  it("filters by resolvedDate", async () => {
    await reviewLogsDb.put({
      tid: "log1",
      note: "at://did:plc:123/cards.decay.flashcard.note/n1",
      deck: "at://did:plc:123/cards.decay.flashcard.deck/d1",
      templateId: "card1",
      answer: "good",
      phase: "review",
      algorithm: "fsrs",
      reviewedAt: "2026-06-06T10:00:00Z",
      resolvedDate: "2026-06-06",
    });
    await reviewLogsDb.put({
      tid: "log2",
      note: "at://did:plc:123/cards.decay.flashcard.note/n1",
      deck: "at://did:plc:123/cards.decay.flashcard.deck/d1",
      templateId: "card1",
      answer: "again",
      phase: "review",
      algorithm: "fsrs",
      reviewedAt: "2026-06-07T10:00:00Z",
      resolvedDate: "2026-06-07",
    });
    const june6 = await reviewLogsDb.getByDate("2026-06-06");
    expect(june6).toHaveLength(1);
    expect(june6[0]!.tid).toBe("log1");
  });
});
