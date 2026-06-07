import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { deleteDb } from "../../db/schema";
import { decksDb } from "../../db/decks";
import { notesDb } from "../../db/notes";
import { noteTypesDb } from "../../db/noteTypes";
import { reviewStateDb } from "../../db/reviewState";
import { reviewLogsDb } from "../../db/reviewLogs";
import { deckSettingsDb } from "../../db/settings";
import { StudyQueue } from "../studyQueue";

const DECK_TID = "testdeck1";
const DECK_URI = `at://did:plc:test/cards.decay.flashcard.deck/${DECK_TID}`;
const NT_TID = "notetype1";
const NT_URI = `at://did:plc:test/cards.decay.flashcard.noteType/${NT_TID}`;

async function seedBasicDeck(noteCount: number) {
  await decksDb.put({
    tid: DECK_TID,
    name: "Test Deck",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });

  await noteTypesDb.put({
    tid: NT_TID,
    name: "Basic",
    fields: [
      { id: "f0", name: "Front" },
      { id: "f1", name: "Back" },
    ],
    templates: [{ id: "card1", name: "Card 1", qfmt: "{{Front}}", afmt: "{{Back}}" }],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });

  for (let i = 0; i < noteCount; i++) {
    await notesDb.put({
      tid: `note${i}`,
      deck: DECK_URI,
      noteType: NT_URI,
      fields: [
        { fieldId: "f0", value: `Front ${i}` },
        { fieldId: "f1", value: `Back ${i}` },
      ],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
  }
}

async function seedClozeDeck() {
  await decksDb.put({
    tid: DECK_TID,
    name: "Cloze Deck",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });

  await noteTypesDb.put({
    tid: NT_TID,
    name: "Cloze",
    isCloze: true,
    fields: [{ id: "f0", name: "Text" }],
    templates: [{ id: "cloze1", name: "Cloze", qfmt: "{{cloze:Text}}", afmt: "{{cloze:Text}}" }],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });

  await notesDb.put({
    tid: "cnote1",
    deck: DECK_URI,
    noteType: NT_URI,
    fields: [{ fieldId: "f0", value: "{{c1::Tokyo}} is the capital of {{c2::Japan}}" }],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });
}

beforeEach(async () => {
  await deleteDb();
});

describe("StudyQueue", () => {
  describe("init + buildCards", () => {
    it("builds cards from basic notes", async () => {
      await seedBasicDeck(5);
      const q = new StudyQueue(DECK_TID, DECK_URI);
      await q.init();

      const counts = q.getCounts();
      expect(counts.newCount).toBe(5);
      expect(counts.learnCount).toBe(0);
      expect(counts.dueCount).toBe(0);
    });

    it("builds cloze cards from ordinals", async () => {
      await seedClozeDeck();
      const q = new StudyQueue(DECK_TID, DECK_URI);
      await q.init();

      const counts = q.getCounts();
      // c1 and c2 = 2 cards
      expect(counts.newCount).toBe(2);
    });

    it("respects daily new card limit", async () => {
      await seedBasicDeck(30);
      await deckSettingsDb.put({
        deckTid: DECK_TID,
        deck: DECK_URI,
        newCardsPerDay: 10,
        updatedAt: "2026-01-01T00:00:00Z",
      });

      const q = new StudyQueue(DECK_TID, DECK_URI);
      await q.init();

      const due = q.getDueCards();
      expect(due.length).toBe(10); // limited to 10
      expect(q.getCounts().newCount).toBe(10);
    });
  });

  describe("processReview", () => {
    it("reviews a new card and transitions to learning", async () => {
      await seedBasicDeck(1);
      const q = new StudyQueue(DECK_TID, DECK_URI);
      await q.init();

      const due = q.getDueCards();
      expect(due).toHaveLength(1);

      const card = due[0]!;
      expect(card.isNew).toBe(true);
      expect(card.reviewState.phase).toBe("new");

      const { card: updated, logTid } = await q.processReview(card, "good", 3000);
      expect(updated.reviewState.phase).not.toBe("new");
      expect(updated.isNew).toBe(false);
      expect(updated.reviewState.lastReviewed).toBeDefined();
      expect(logTid).toMatch(/^[a-z2-7]+$/);

      // Review log should be saved
      const logs = await reviewLogsDb.getByNote(card.reviewState.note);
      expect(logs).toHaveLength(1);
      expect(logs[0]!.answer).toBe("good");
      expect(logs[0]!.phase).toBe("new");
      expect(logs[0]!.phaseAfter).toBeDefined();
      expect(logs[0]!.deck).toBe(DECK_URI);
      expect(logs[0]!.resolvedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("tracks daily progress", async () => {
      await seedBasicDeck(3);
      const q = new StudyQueue(DECK_TID, DECK_URI);
      await q.init();

      const cards = q.getDueCards();
      await q.processReview(cards[0]!, "good", 2000);
      await q.processReview(cards[1]!, "easy", 1500);

      const progress = q.getProgress();
      expect(progress.newStudied).toBe(2);
      expect(progress.reviewsStudied).toBe(0);
    });

    it("leech detection suspends card", async () => {
      await seedBasicDeck(1);
      await deckSettingsDb.put({
        deckTid: DECK_TID,
        deck: DECK_URI,
        leechThreshold: 3,
        updatedAt: "2026-01-01T00:00:00Z",
      });

      const q = new StudyQueue(DECK_TID, DECK_URI);
      await q.init();

      // Simulate a card with 3 lapses about to get another
      const due = q.getDueCards();
      const card = due[0]!;
      // Manually set lapses to threshold
      card.reviewState.lapses = 3;
      card.reviewState.phase = "review";
      card.reviewState.intervalDays = 10;
      card.reviewState.due = new Date(Date.now() - 86400000).toISOString();
      card.reviewState.easeFactor = 2.5;
      card.reviewState.reps = 5;
      await reviewStateDb.put(card.reviewState);

      const { card: updated } = await q.processReview(card, "again", 5000);
      expect(updated.reviewState.suspended).toBe(true);
    });
  });

  describe("sibling burying", () => {
    it("buries siblings from the same note", async () => {
      // Create a note with 2 templates (2 cards)
      await decksDb.put({
        tid: DECK_TID,
        name: "Test",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });

      await noteTypesDb.put({
        tid: NT_TID,
        name: "Basic + Reversed",
        fields: [
          { id: "f0", name: "Front" },
          { id: "f1", name: "Back" },
        ],
        templates: [
          { id: "card1", name: "Forward", qfmt: "{{Front}}", afmt: "{{Back}}" },
          { id: "card2", name: "Reverse", qfmt: "{{Back}}", afmt: "{{Front}}" },
        ],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });

      await notesDb.put({
        tid: "note0",
        deck: DECK_URI,
        noteType: NT_URI,
        fields: [
          { fieldId: "f0", value: "Hello" },
          { fieldId: "f1", value: "World" },
        ],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });

      const q = new StudyQueue(DECK_TID, DECK_URI);
      await q.init();

      // Should have 2 cards
      expect(q.getCounts().newCount).toBe(2);

      // Review the first card
      const due = q.getDueCards();
      expect(due.length).toBe(2);
      await q.processReview(due[0]!, "good", 2000);

      // The sibling should now be buried
      const counts = q.getCounts();
      expect(counts.newCount).toBe(0); // 1 reviewed, 1 buried
    });
  });

  describe("getNextIntervals", () => {
    it("returns interval strings for each answer", async () => {
      await seedBasicDeck(1);
      const q = new StudyQueue(DECK_TID, DECK_URI);
      await q.init();

      const due = q.getDueCards();
      const intervals = q.getNextIntervals(due[0]!);

      expect(intervals.again).toBeDefined();
      expect(intervals.hard).toBeDefined();
      expect(intervals.good).toBeDefined();
      expect(intervals.easy).toBeDefined();

      // All should be non-empty strings
      for (const val of Object.values(intervals)) {
        expect(val.length).toBeGreaterThan(0);
      }
    });
  });
});
