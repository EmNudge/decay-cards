/**
 * Integration test: full study flow from import to review.
 * Exercises the entire pipeline: import → db → studyQueue → algorithm → reviewLog.
 * Catches issues like the FSRS State enum mismatch that unit tests missed.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { deleteDb } from "../db/schema";
import { decksDb } from "../db/decks";
import { notesDb } from "../db/notes";
import { noteTypesDb } from "../db/noteTypes";
import { reviewStateDb } from "../db/reviewState";
import { reviewLogsDb } from "../db/reviewLogs";
import { deckSettingsDb } from "../db/settings";
import { StudyQueue } from "../scheduler/studyQueue";
import { omitUndefined } from "../utils/omitUndefined";
import type { Answer } from "../scheduler/types";
import { importAnkiData } from "../import/apkgImport";
import type { AnkiData } from "../ankiParser/index";

const DECK_TID = "testdeck";
const DECK_URI = `at://self/cards.decay.flashcard.deck/${DECK_TID}`;
const NT_TID = "nt1";
const NT_URI = `at://self/cards.decay.flashcard.noteType/${NT_TID}`;

beforeEach(async () => {
  await deleteDb();
});

async function seedDeck(
  opts: {
    algorithm?: "sm2" | "fsrs";
    noteCount?: number;
    isCloze?: boolean;
  } = {},
) {
  const { algorithm = "fsrs", noteCount = 3, isCloze = false } = opts;

  await decksDb.put({
    tid: DECK_TID,
    name: "Test",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });

  await noteTypesDb.put(
    omitUndefined({
      tid: NT_TID,
      name: isCloze ? "Cloze" : "Basic",
      isCloze: isCloze || undefined,
      fields: [{ id: "f0", name: "Front" }, ...(!isCloze ? [{ id: "f1", name: "Back" }] : [])],
      templates: isCloze
        ? [{ id: "cloze1", name: "Cloze", qfmt: "{{cloze:Front}}", afmt: "{{cloze:Front}}" }]
        : [{ id: "card1", name: "Card 1", qfmt: "{{Front}}", afmt: "{{Back}}" }],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }),
  );

  await deckSettingsDb.put({
    deckTid: DECK_TID,
    deck: DECK_URI,
    algorithm,
    updatedAt: "2026-01-01T00:00:00Z",
  });

  for (let i = 0; i < noteCount; i++) {
    const value = isCloze ? `{{c1::Answer${i}}} is the {{c2::answer${i}}}` : `Front ${i}`;

    await notesDb.put({
      tid: `note${i}`,
      deck: DECK_URI,
      noteType: NT_URI,
      fields: isCloze
        ? [{ fieldId: "f0", value }]
        : [
            { fieldId: "f0", value },
            { fieldId: "f1", value: `Back ${i}` },
          ],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
  }
}

describe("Full study flow", () => {
  const ANSWERS: Answer[] = ["again", "hard", "good", "easy"];

  for (const algo of ["sm2", "fsrs"] as const) {
    describe(`${algo.toUpperCase()} algorithm`, () => {
      for (const answer of ANSWERS) {
        it(`reviews a new card with "${answer}"`, async () => {
          await seedDeck({ algorithm: algo, noteCount: 1 });
          const q = new StudyQueue(DECK_TID, DECK_URI);
          await q.init();

          const due = q.getDueCards();
          expect(due.length).toBeGreaterThan(0);

          const card = due[0]!;
          expect(card.reviewState.phase).toBe("new");

          const { card: updated, logTid } = await q.processReview(card, answer, 3000);

          expect(updated.reviewState.lastReviewed).toBeDefined();
          expect(updated.reviewState.updatedAt).toBeDefined();
          expect(logTid).toBeTruthy();

          // Verify log was saved
          const logs = await reviewLogsDb.getAll();
          expect(logs).toHaveLength(1);
          expect(logs[0]!.answer).toBe(answer);
          expect(logs[0]!.algorithm).toBe(algo);
          expect(logs[0]!.phaseAfter).toBeDefined();
          expect(logs[0]!.repsAfter).toBeDefined();

          // Verify reviewState was saved
          const states = await reviewStateDb.getAll();
          expect(states.length).toBeGreaterThan(0);
          const saved = states.find((s) => s.key === card.key);
          expect(saved).toBeDefined();
          expect(saved!.reps).toBeGreaterThanOrEqual(1);
        });
      }

      it("completes a full session (multiple cards, multiple reviews)", async () => {
        await seedDeck({ algorithm: algo, noteCount: 3 });
        const q = new StudyQueue(DECK_TID, DECK_URI);
        await q.init();

        let due = q.getDueCards();
        expect(due.length).toBe(3);

        // Review all available cards
        let reviewCount = 0;
        while (due.length > 0 && reviewCount < 10) {
          await q.processReview(due[0]!, "good", 2000);
          due = q.getDueCards();
          reviewCount++;
        }

        // All cards should have been processed at least once
        const logs = await reviewLogsDb.getAll();
        expect(logs.length).toBeGreaterThanOrEqual(3);
      });

      it("reviews a card twice (learning → review cycle)", async () => {
        await seedDeck({ algorithm: algo, noteCount: 1 });
        const q = new StudyQueue(DECK_TID, DECK_URI);
        await q.init();

        // First review
        let due = q.getDueCards();
        const { card: after1 } = await q.processReview(due[0]!, "good", 2000);

        // If card entered learning, it should be due again soon
        if (after1.reviewState.phase === "learning" || after1.reviewState.phase === "relearning") {
          // Manually set due to now so we can review again
          after1.reviewState.due = new Date().toISOString();
          await reviewStateDb.put(after1.reviewState);

          // Rebuild queue
          const q2 = new StudyQueue(DECK_TID, DECK_URI);
          await q2.init();
          due = q2.getDueCards();

          if (due.length > 0) {
            const { card: after2 } = await q2.processReview(due[0]!, "good", 1500);
            expect(after2.reviewState.reps).toBeGreaterThan(after1.reviewState.reps);
          }
        }

        const logs = await reviewLogsDb.getAll();
        expect(logs.length).toBeGreaterThanOrEqual(1);
      });
    });
  }

  describe("Cloze cards", () => {
    it("generates cards from cloze ordinals and reviews them", async () => {
      await seedDeck({ algorithm: "fsrs", noteCount: 1, isCloze: true });
      const q = new StudyQueue(DECK_TID, DECK_URI);
      await q.init();

      // Should have 2 cards (c1 and c2)
      const counts = q.getCounts();
      expect(counts.newCount).toBe(2);

      const due = q.getDueCards();
      expect(due.length).toBe(2);

      // Review both
      await q.processReview(due[0]!, "good", 2000);
      // After sibling burying, only 0 or 1 cards should be due
      const due2 = q.getDueCards();
      expect(due2.length).toBeLessThanOrEqual(1);
    });
  });

  describe("Interval previews", () => {
    it("returns valid intervals for all answer types", async () => {
      for (const algo of ["sm2", "fsrs"] as const) {
        await deleteDb();
        await seedDeck({ algorithm: algo, noteCount: 1 });
        const q = new StudyQueue(DECK_TID, DECK_URI);
        await q.init();

        const due = q.getDueCards();
        const intervals = q.getNextIntervals(due[0]!);

        for (const answer of ANSWERS) {
          expect(intervals[answer]).toBeTruthy();
          expect(intervals[answer]).not.toBe("?");
        }
      }
    });
  });

  describe("Undo", () => {
    it("restores previous state on undo", async () => {
      await seedDeck({ algorithm: "fsrs", noteCount: 1 });
      const q = new StudyQueue(DECK_TID, DECK_URI);
      await q.init();

      const due = q.getDueCards();
      const card = due[0]!;
      const originalPhase = card.reviewState.phase;

      const { logTid } = await q.processReview(card, "good", 2000);

      // Verify state changed
      const stateAfter = await reviewStateDb.get(card.key);
      expect(stateAfter!.reps).toBeGreaterThan(0);

      // Undo
      await q.undo(card.reviewState, logTid);

      // Verify state restored
      const stateAfterUndo = await reviewStateDb.get(card.key);
      expect(stateAfterUndo!.phase).toBe(originalPhase);
      expect(stateAfterUndo!.reps).toBe(0);

      // Verify log deleted
      const logs = await reviewLogsDb.getAll();
      expect(logs).toHaveLength(0);
    });
  });

  describe("Import → study flow", () => {
    it("imports an apkg-style dataset and studies it", async () => {
      const data: AnkiData = {
        files: new Map(),
        cards: [
          {
            ankiCardId: 1001,
            values: { Front: "Capital of Japan", Back: "Tokyo" },
            tags: ["geography"],
            templates: [{ name: "Card 1", qfmt: "{{Front}}", afmt: "{{Back}}", ord: 0 }],
            css: ".card { font-size: 20px; }",
            deckName: "Geography",
            guid: "geo1",
            scheduling: null,
            noteType: 0,
            latexSvg: false,
            latexPre: "",
            latexPost: "",
            req: null,
            fieldDescriptions: {},
            noteData: null,
            csum: null,
            sfld: null,
          },
          {
            ankiCardId: 1002,
            values: { Front: "Capital of France", Back: "Paris" },
            tags: ["geography"],
            templates: [{ name: "Card 1", qfmt: "{{Front}}", afmt: "{{Back}}", ord: 0 }],
            css: ".card { font-size: 20px; }",
            deckName: "Geography",
            guid: "geo2",
            scheduling: null,
            noteType: 0,
            latexSvg: false,
            latexPre: "",
            latexPost: "",
            req: null,
            fieldDescriptions: {},
            noteData: null,
            csum: null,
            sfld: null,
          },
        ],
        deckName: "Geography",
        decks: { "1": { id: 1, name: "Geography" } },
        notesTypes: [],
        collectionCreationTime: 1700000000,
        deckConfigs: {},
        colConf: null,
      };

      const result = await importAnkiData(data);
      expect(result.notesCreated).toBe(2);
      expect(result.decksCreated).toBe(1);

      // Find the created deck
      const decks = await decksDb.getAll();
      const deck = decks[0]!;
      const deckUri = `at://self/cards.decay.flashcard.deck/${deck.tid}`;

      // Set FSRS algorithm
      await deckSettingsDb.put({
        deckTid: deck.tid,
        deck: deckUri,
        algorithm: "fsrs",
        updatedAt: new Date().toISOString(),
      });

      // Study
      const q = new StudyQueue(deck.tid, deckUri);
      await q.init();

      const due = q.getDueCards();
      expect(due.length).toBe(2);

      // Review both cards with every answer type
      for (const answer of ["again", "good"] as Answer[]) {
        const card = q.getDueCards()[0];
        if (!card) break;
        const { card: updated } = await q.processReview(card, answer, 2000);
        expect(updated.reviewState.lastReviewed).toBeDefined();
      }

      const logs = await reviewLogsDb.getAll();
      expect(logs.length).toBeGreaterThanOrEqual(2);
    });
  });
});
