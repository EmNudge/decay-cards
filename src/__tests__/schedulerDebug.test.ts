import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { deleteDb } from "../db/schema";
import { decksDb } from "../db/decks";
import { notesDb } from "../db/notes";
import { noteTypesDb } from "../db/noteTypes";
import { reviewLogsDb } from "../db/reviewLogs";
import { deckSettingsDb } from "../db/settings";
import { StudyQueue } from "../scheduler/studyQueue";

beforeEach(async () => {
  await deleteDb();
});

/**
 * Simulates the Nations of the World deck structure:
 * Each note has 8 templates (capital, flag, map, etc.)
 */
async function seedMultiTemplateDeck() {
  const DECK_TID = "europe";
  const DECK_URI = `at://self/cards.decay.flashcard.deck/${DECK_TID}`;
  const NT_TID = "nations";
  const NT_URI = `at://self/cards.decay.flashcard.noteType/${NT_TID}`;

  await decksDb.put({
    tid: DECK_TID,
    name: "Europe",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });

  // 8 templates like the Nations deck
  await noteTypesDb.put({
    tid: NT_TID,
    name: "Nations",
    fields: [
      { id: "f0", name: "Country" },
      { id: "f1", name: "Capital" },
      { id: "f2", name: "Flag" },
    ],
    templates: [
      { id: "t0", name: "Capital Q", qfmt: "Capital of {{Country}}?", afmt: "{{Capital}}" },
      {
        id: "t1",
        name: "Capital Rev",
        qfmt: "{{Capital}} is the capital of?",
        afmt: "{{Country}}",
      },
      { id: "t2", name: "Flag Q", qfmt: "Flag of {{Country}}?", afmt: "{{Flag}}" },
      { id: "t3", name: "Flag Rev", qfmt: "{{Flag}} belongs to?", afmt: "{{Country}}" },
    ],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });

  await deckSettingsDb.put({
    deckTid: DECK_TID,
    deck: DECK_URI,
    algorithm: "fsrs",
    newCardsPerDay: 20,
    buryNewSiblings: true,
    buryReviewSiblings: true,
    updatedAt: "2026-01-01T00:00:00Z",
  });

  // 5 notes = 5 × 4 = 20 cards
  const countries = ["France", "Germany", "Italy", "Spain", "UK"];
  const capitals = ["Paris", "Berlin", "Rome", "Madrid", "London"];
  for (let i = 0; i < 5; i++) {
    await notesDb.put({
      tid: `note${i}`,
      deck: DECK_URI,
      noteType: NT_URI,
      fields: [
        { fieldId: "f0", value: countries[i]! },
        { fieldId: "f1", value: capitals[i]! },
        { fieldId: "f2", value: `🇫🇷` },
      ],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
  }

  return { DECK_TID, DECK_URI };
}

describe("Multi-template scheduling", () => {
  it("new cards from same note should not appear consecutively", async () => {
    const { DECK_TID, DECK_URI } = await seedMultiTemplateDeck();
    const q = new StudyQueue(DECK_TID, DECK_URI);
    await q.init();

    const counts = q.getCounts();
    console.log("Initial counts:", counts);
    expect(counts.newCount).toBe(20); // 5 notes × 4 templates

    const due = q.getDueCards();
    console.log("Due cards:", due.length);

    // Show first few cards' note IDs
    for (let i = 0; i < Math.min(10, due.length); i++) {
      console.log(`  Card ${i}: note=${due[i]!.note.tid} template=${due[i]!.templateId}`);
    }

    // Review card 0
    const card0 = due[0]!;
    console.log(`\nReviewing: note=${card0.note.tid} template=${card0.templateId}`);
    const { card: updated } = await q.processReview(card0, "good", 3000);
    console.log(`  → phase=${updated.reviewState.phase}`);

    // Get next due cards
    const due2 = q.getDueCards();
    console.log(`\nAfter review, ${due2.length} cards due`);
    console.log("Counts:", q.getCounts());

    if (due2.length > 0) {
      const next = due2[0]!;
      console.log(`Next card: note=${next.note.tid} template=${next.templateId}`);
      // After burying, next card should be from a DIFFERENT note
      expect(next.note.tid).not.toBe(card0.note.tid);
    }

    // Review 3 more cards
    for (let i = 0; i < 3; i++) {
      const cards = q.getDueCards();
      if (cards.length === 0) break;
      const card = cards[0]!;
      console.log(`Review ${i + 2}: note=${card.note.tid} template=${card.templateId}`);
      await q.processReview(card, "good", 2000);
    }

    const logs = await reviewLogsDb.getAll();
    console.log(`\nTotal reviews: ${logs.length}`);
    console.log("Counts:", q.getCounts());

    // Should have reviewed 4 different notes (due to sibling burying)
    const reviewedNotes = new Set(logs.map((l) => l.note));
    console.log("Unique notes reviewed:", reviewedNotes.size);
    expect(reviewedNotes.size).toBe(4); // each from a different note
  });

  it("deck list counts match study queue counts", async () => {
    const { DECK_TID, DECK_URI } = await seedMultiTemplateDeck();

    // getDeckCounts (used by deck list) should agree with StudyQueue.getCounts()
    const { useDecks } = await import("../composables/useDecks");
    const { getDeckCounts } = useDecks();
    const deckCounts = await getDeckCounts(DECK_TID);

    const q = new StudyQueue(DECK_TID, DECK_URI);
    await q.init();
    const queueCounts = q.getCounts();

    console.log("Deck list counts:", deckCounts);
    console.log("Queue counts:", queueCounts);

    // Both should report 20 new cards (5 notes × 4 templates)
    expect(deckCounts.newCount).toBe(20);
    expect(queueCounts.newCount).toBe(20);
    expect(deckCounts.newCount).toBe(queueCounts.newCount);
  });

  it("daily new count tracks correctly", async () => {
    const { DECK_TID, DECK_URI } = await seedMultiTemplateDeck();
    const q = new StudyQueue(DECK_TID, DECK_URI);
    await q.init();

    // Review 3 cards
    for (let i = 0; i < 3; i++) {
      const cards = q.getDueCards();
      if (cards.length === 0) break;
      await q.processReview(cards[0]!, "good", 2000);
    }

    const progress = q.getProgress();
    console.log("Progress:", progress);
    expect(progress.newStudied).toBe(3);

    // Verify via review logs
    const logs = await reviewLogsDb.getAll();
    expect(logs.length).toBe(3);
    expect(logs.every((l) => l.phase === "new")).toBe(true);
  });
});
