/**
 * Integration test that reproduces the FSRS "Invalid state:[undefined]" error.
 * The bug: bridge.ts constructs FSRS Card objects that ts-fsrs rejects.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { deleteDb } from "../db/schema";
import { decksDb } from "../db/decks";
import { notesDb } from "../db/notes";
import { noteTypesDb } from "../db/noteTypes";
import { reviewStateDb, reviewStateKey } from "../db/reviewState";
import { deckSettingsDb } from "../db/settings";
import { StudyQueue } from "../scheduler/studyQueue";
import { toOldCardState } from "../scheduler/bridge";
import { createEmptyCard, FSRS, Rating, State } from "ts-fsrs";
import type { ReviewStateRecord } from "../db/schema";
import type { Answer } from "../scheduler/types";

beforeEach(async () => {
  await deleteDb();
});

const DECK_TID = "d1";
const DECK_URI = `at://self/cards.decay.flashcard.deck/${DECK_TID}`;

describe("FSRS bridge correctness", () => {
  it("createEmptyCard produces valid state", () => {
    const card = createEmptyCard();
    expect(card.state).toBe(State.New);
    expect(card.due).toBeInstanceOf(Date);

    // Verify ts-fsrs can actually process it
    const fsrs = new FSRS({});
    const result = fsrs.repeat(card, new Date());
    expect(result[Rating.Again]).toBeDefined();
    expect(result[Rating.Good]).toBeDefined();
  });

  it("toOldCardState produces valid FSRS card for new phase", () => {
    const rs: ReviewStateRecord = {
      key: "n1_card1",
      note: "at://self/cards.decay.flashcard.note/n1",
      templateId: "card1",
      algorithm: "fsrs",
      phase: "new",
      reps: 0,
      lapses: 0,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };

    const old = toOldCardState(rs);
    const card = old.cardState as any;

    console.log(
      "Bridged FSRS card:",
      JSON.stringify(card, (_, v) => (v instanceof Date ? v.toISOString() : v), 2),
    );

    // Verify state is the enum, not undefined
    expect(card.state).toBeDefined();
    expect(card.state).toBe(State.New);
    expect(card.due).toBeInstanceOf(Date);

    // The critical test: can ts-fsrs actually process this?
    const fsrs = new FSRS({});
    expect(() => fsrs.repeat(card, new Date())).not.toThrow();

    const result = fsrs.repeat(card, new Date());
    expect(result[Rating.Again].card.state).toBeDefined();
  });

  it("toOldCardState produces valid FSRS card for review phase", () => {
    const rs: ReviewStateRecord = {
      key: "n1_card1",
      note: "at://self/cards.decay.flashcard.note/n1",
      templateId: "card1",
      algorithm: "fsrs",
      phase: "review",
      stability: 10.5,
      difficulty: 5.0, // FSRS difficulty range is ~1-10
      intervalDays: 15,
      due: new Date(Date.now() - 86400000).toISOString(), // yesterday
      reps: 5,
      lapses: 1,
      lastReviewed: new Date(Date.now() - 86400000 * 15).toISOString(),
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };

    const old = toOldCardState(rs);
    const card = old.cardState as any;

    expect(card.state).toBe(State.Review);
    expect(card.stability).toBe(10.5);
    expect(card.difficulty).toBe(5.0);

    const fsrs = new FSRS({});
    expect(() => fsrs.repeat(card, new Date())).not.toThrow();
  });

  it("toOldCardState produces valid FSRS card for learning phase", () => {
    const rs: ReviewStateRecord = {
      key: "n1_card1",
      note: "at://self/cards.decay.flashcard.note/n1",
      templateId: "card1",
      algorithm: "fsrs",
      phase: "learning",
      stability: 2.3,
      difficulty: 5.0,
      intervalMinutes: 10,
      learningStepIndex: 1,
      due: new Date(Date.now() + 600000).toISOString(),
      reps: 1,
      lapses: 0,
      lastReviewed: new Date().toISOString(),
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };

    const old = toOldCardState(rs);
    const card = old.cardState as any;

    expect(card.state).toBe(State.Learning);

    const fsrs = new FSRS({});
    expect(() => fsrs.repeat(card, new Date())).not.toThrow();
  });

  it("full study flow: import-like cards → FSRS review all 4 answers", async () => {
    // Simulate what the import does: create deck, noteType, notes
    await decksDb.put({
      tid: DECK_TID,
      name: "Civil Law",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    await noteTypesDb.put({
      tid: "nt1",
      name: "Basic",
      fields: [
        { id: "f0", name: "Front" },
        { id: "f1", name: "Back" },
      ],
      templates: [
        { id: "t0", name: "Card 1", qfmt: "{{Front}}", afmt: "{{FrontSide}}<hr>{{Back}}" },
      ],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    // Create 5 notes (like a small imported deck)
    for (let i = 0; i < 5; i++) {
      await notesDb.put({
        tid: `n${i}`,
        deck: DECK_URI,
        noteType: `at://self/cards.decay.flashcard.noteType/nt1`,
        fields: [
          { fieldId: "f0", value: `Question ${i}` },
          { fieldId: "f1", value: `Answer ${i}` },
        ],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
    }

    // Set FSRS algorithm
    await deckSettingsDb.put({
      deckTid: DECK_TID,
      deck: DECK_URI,
      algorithm: "fsrs",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    // Build study queue
    const q = new StudyQueue(DECK_TID, DECK_URI);
    await q.init();

    const due = q.getDueCards();
    expect(due.length).toBe(5);

    // Review each card with a different answer
    const answers: Answer[] = ["again", "hard", "good", "easy", "good"];
    for (let i = 0; i < Math.min(due.length, 5); i++) {
      const cards = q.getDueCards();
      if (cards.length === 0) break;

      const card = cards[0]!;
      console.log(
        `Review ${i}: answer=${answers[i]}, phase=${card.reviewState.phase}, algo=${card.reviewState.algorithm}`,
      );

      const { card: updated } = await q.processReview(card, answers[i]!, 2000);
      console.log(`  → phase=${updated.reviewState.phase}, reps=${updated.reviewState.reps}`);
    }

    // Verify all reviews logged
    const { reviewLogsDb } = await import("../db/reviewLogs");
    const logs = await reviewLogsDb.getAll();
    expect(logs.length).toBeGreaterThanOrEqual(3); // some may be buried
  });

  it("SM2 cards with deck set to FSRS use FSRS for new cards", async () => {
    // Simulate: imported deck has SM2 scheduling, but user sets FSRS
    await decksDb.put({
      tid: DECK_TID,
      name: "Test",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    await noteTypesDb.put({
      tid: "nt1",
      name: "Basic",
      fields: [
        { id: "f0", name: "Front" },
        { id: "f1", name: "Back" },
      ],
      templates: [{ id: "t0", name: "Card 1", qfmt: "{{Front}}", afmt: "{{Back}}" }],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    await notesDb.put({
      tid: "n1",
      deck: DECK_URI,
      noteType: "at://self/cards.decay.flashcard.noteType/nt1",
      fields: [
        { fieldId: "f0", value: "Q" },
        { fieldId: "f1", value: "A" },
      ],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    // Import created SM2 reviewState but deck is FSRS
    await reviewStateDb.put({
      key: reviewStateKey("n1", "t0"),
      note: "at://self/cards.decay.flashcard.note/n1",
      templateId: "t0",
      algorithm: "sm2", // imported as SM2
      phase: "new",
      reps: 0,
      lapses: 0,
      easeFactor: 2.5,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    // Deck uses FSRS
    await deckSettingsDb.put({
      deckTid: DECK_TID,
      deck: DECK_URI,
      algorithm: "fsrs",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const q = new StudyQueue(DECK_TID, DECK_URI);
    await q.init();

    const due = q.getDueCards();
    expect(due.length).toBe(1);

    // The card has algorithm:sm2 but deck is fsrs — bridge must handle this
    const card = due[0]!;
    console.log("Card state:", {
      algorithm: card.reviewState.algorithm,
      phase: card.reviewState.phase,
      deckAlgorithm: "fsrs",
    });

    // This is the exact scenario that causes the error
    // The queue uses the deck's algorithm (FSRS) but the card was stored as SM2
    const { card: updated } = await q.processReview(card, "good", 3000);
    expect(updated.reviewState.reps).toBeGreaterThanOrEqual(1);
  });
});
