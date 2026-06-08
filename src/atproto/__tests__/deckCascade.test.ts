import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { deleteDb } from "../../db/schema";
import { decksDb } from "../../db/decks";
import { notesDb } from "../../db/notes";
import { reviewStateDb } from "../../db/reviewState";
import { reviewLogsDb } from "../../db/reviewLogs";
import { cardFlagsDb } from "../../db/cardFlags";
import { deckSettingsDb } from "../../db/settings";
import { outboxDb } from "../../db/outbox";
import { softDeleteDeck, runDeckCascades } from "../deckCascade";

const NS = "cards.decay.flashcard";

const T_PRE = "2025-01-01T00:00:00Z";
const T_DELETE = "2025-02-01T00:00:00Z";
const T_POST = "2025-03-01T00:00:00Z";

async function seed(): Promise<void> {
  await decksDb.put({
    tid: "d1",
    name: "D1",
    createdAt: T_PRE,
    updatedAt: T_PRE,
  });
  // Pre-delete note: eligible to cascade.
  await notesDb.put({
    tid: "n-pre",
    deck: `at://self/${NS}.deck/d1`,
    noteType: `at://x/nt/nt1`,
    fields: [],
    createdAt: T_PRE,
    updatedAt: T_PRE,
  });
  // Post-delete note: protected by the temporal guard.
  await notesDb.put({
    tid: "n-post",
    deck: `at://self/${NS}.deck/d1`,
    noteType: `at://x/nt/nt1`,
    fields: [],
    createdAt: T_POST,
    updatedAt: T_POST,
  });
  await reviewStateDb.put({
    key: "n-pre_t1",
    note: `at://self/${NS}.note/n-pre`,
    templateId: "t1",
    algorithm: "fsrs",
    phase: "review",
    reps: 1,
    lapses: 0,
    createdAt: T_PRE,
    updatedAt: T_PRE,
  });
  await reviewLogsDb.put({
    tid: "log-pre",
    note: `at://self/${NS}.note/n-pre`,
    deck: `at://self/${NS}.deck/d1`,
    templateId: "t1",
    answer: "good",
    phase: "review",
    algorithm: "fsrs",
    reviewedAt: T_PRE,
    resolvedDate: "2025-01-01",
  });
  await cardFlagsDb.put({
    key: "n-pre_t1",
    note: `at://self/${NS}.note/n-pre`,
    templateId: "t1",
    flag: "red",
    createdAt: T_PRE,
    updatedAt: T_PRE,
  });
  await deckSettingsDb.put({
    deckTid: "d1",
    deck: `at://self/${NS}.deck/d1`,
    updatedAt: T_PRE,
  });
  await outboxDb.clear();
}

beforeEach(async () => {
  await deleteDb();
});

describe("softDeleteDeck", () => {
  it("stamps deletedAt and cascades pre-delete children", async () => {
    await seed();
    const deck = (await decksDb.get("d1"))!;
    await softDeleteDeck(deck, T_DELETE);

    const updated = await decksDb.get("d1");
    expect(updated?.deletedAt).toBe(T_DELETE);

    // Pre-delete note + its state/log/flag are gone.
    expect(await notesDb.get("n-pre")).toBeUndefined();
    expect(await reviewStateDb.get("n-pre_t1")).toBeUndefined();
    expect(await reviewLogsDb.get("log-pre")).toBeUndefined();
    expect(await cardFlagsDb.get("n-pre_t1")).toBeUndefined();
    expect(await deckSettingsDb.get("d1")).toBeUndefined();
  });

  it("protects post-delete notes via the temporal guard", async () => {
    await seed();
    const deck = (await decksDb.get("d1"))!;
    await softDeleteDeck(deck, T_DELETE);

    expect(await notesDb.get("n-post")).toBeDefined();
  });

  it("queues outbox entries for every cascaded delete", async () => {
    await seed();
    const deck = (await decksDb.get("d1"))!;
    await softDeleteDeck(deck, T_DELETE);

    const allOutbox = await outboxDb.getAll();
    const byColl = new Map<string, string[]>();
    for (const e of allOutbox) {
      const arr = byColl.get(e.collection) ?? [];
      arr.push(`${e.op}:${e.recordKey}`);
      byColl.set(e.collection, arr);
    }
    // Deck record gets a put with deletedAt set.
    expect(byColl.get(`${NS}.deck`)).toEqual(["put:d1"]);
    // Children get deletes.
    expect(byColl.get(`${NS}.note`)).toEqual(["delete:n-pre"]);
    expect(byColl.get(`${NS}.reviewState`)).toEqual(["delete:n-pre_t1"]);
    expect(byColl.get(`${NS}.reviewLog`)).toEqual(["delete:log-pre"]);
    expect(byColl.get(`${NS}.cardFlag`)).toEqual(["delete:n-pre_t1"]);
    expect(byColl.get(`${NS}.deckSettings`)).toEqual(["delete:d1"]);
  });

  it("skips note cascade for filtered decks", async () => {
    await decksDb.put({
      tid: "fd",
      name: "Filtered",
      isFiltered: true,
      createdAt: T_PRE,
      updatedAt: T_PRE,
    });
    await notesDb.put({
      tid: "n1",
      deck: `at://self/${NS}.deck/fd`,
      noteType: `at://x/nt/nt1`,
      fields: [],
      createdAt: T_PRE,
      updatedAt: T_PRE,
    });
    await outboxDb.clear();

    const deck = (await decksDb.get("fd"))!;
    await softDeleteDeck(deck, T_DELETE);

    // Filtered deck note survives because the deck doesn't own it.
    expect(await notesDb.get("n1")).toBeDefined();
    expect((await decksDb.get("fd"))?.deletedAt).toBe(T_DELETE);
  });

  it("is idempotent on a re-run", async () => {
    await seed();
    const deck = (await decksDb.get("d1"))!;
    await softDeleteDeck(deck, T_DELETE);
    await softDeleteDeck(deck, T_DELETE); // second pass

    expect(await notesDb.get("n-pre")).toBeUndefined();
    expect((await decksDb.get("d1"))?.deletedAt).toBe(T_DELETE);
  });
});

describe("runDeckCascades", () => {
  it("applies cascades for every soft-deleted deck", async () => {
    await seed();
    // Mutate the deck to "remote received a deletedAt" path.
    const deck = (await decksDb.get("d1"))!;
    await decksDb.put({ ...deck, deletedAt: T_DELETE, updatedAt: T_DELETE });
    expect(await notesDb.get("n-pre")).toBeDefined(); // still present

    await runDeckCascades();
    expect(await notesDb.get("n-pre")).toBeUndefined();
    expect(await notesDb.get("n-post")).toBeDefined(); // temporal guard
  });

  it("does nothing for active decks", async () => {
    await seed();
    await runDeckCascades();
    expect(await notesDb.get("n-pre")).toBeDefined();
    expect(await notesDb.get("n-post")).toBeDefined();
  });
});
