import { describe, it, expect } from "vitest";
import {
  toOldCardState,
  applyResultToReviewState,
  toOldSchedulerSettings,
  createAlgorithm,
  generateTid,
} from "../bridge";
import type { ReviewStateRecord } from "../../db/schema";
import type { AnkiSM2CardState } from "../anki-sm2-algorithm";

const makeReviewState = (overrides: Partial<ReviewStateRecord> = {}): ReviewStateRecord => ({
  key: "n1_card1",
  note: "at://did:plc:123/cards.decay.flashcard.note/n1",
  templateId: "card1",
  algorithm: "sm2",
  phase: "new",
  reps: 0,
  lapses: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

describe("toOldCardState", () => {
  it("converts a new SM-2 card", () => {
    const rs = makeReviewState();
    const old = toOldCardState(rs);
    expect(old.cardId).toBe("n1_card1");
    expect(old.algorithm).toBe("sm2");
    const sm2 = old.cardState as AnkiSM2CardState;
    expect(sm2.phase).toBe("new");
    expect(sm2.reps).toBe(0);
  });

  it("converts a review SM-2 card with ease factor", () => {
    const rs = makeReviewState({
      phase: "review",
      easeFactor: 2.5,
      intervalDays: 10,
      due: "2026-06-15T00:00:00Z",
      reps: 5,
    });
    const old = toOldCardState(rs);
    const sm2 = old.cardState as AnkiSM2CardState;
    expect(sm2.phase).toBe("review");
    expect(sm2.ease).toBe(2.5);
    expect(sm2.interval).toBe(10);
    expect(sm2.reps).toBe(5);
  });

  it("converts suspended state to queueOverride", () => {
    const rs = makeReviewState({ suspended: true });
    const old = toOldCardState(rs);
    expect(old.queueOverride).toBe(-1);
  });

  it("converts buried state to queueOverride", () => {
    const rs = makeReviewState({ buried: true });
    const old = toOldCardState(rs);
    expect(old.queueOverride).toBe(-2);
  });

  it("converts FSRS card", () => {
    const rs = makeReviewState({
      algorithm: "fsrs",
      phase: "review",
      stability: 10.5,
      difficulty: 0.3,
      intervalDays: 15,
      due: "2026-06-20T00:00:00Z",
      reps: 8,
    });
    const old = toOldCardState(rs);
    expect(old.algorithm).toBe("fsrs");
    // FSRS Card type has stability/difficulty
    const fsrs = old.cardState as { stability: number; difficulty: number; reps: number };
    expect(fsrs.stability).toBe(10.5);
    expect(fsrs.difficulty).toBe(0.3);
    expect(fsrs.reps).toBe(8);
  });
});

describe("applyResultToReviewState", () => {
  it("produces a reviewLog with all required fields", () => {
    const rs = makeReviewState({ phase: "new" });
    const settings = toOldSchedulerSettings({
      algorithm: "sm2",
      newCardsPerDay: 20,
      reviewsPerDay: 200,
      learningSteps: [1, 10],
      relearningSteps: [10],
      graduatingInterval: 1,
      easyInterval: 4,
      startingEase: 2.5,
      easyBonus: 1.3,
      hardMultiplier: 1.2,
      intervalModifier: 1.0,
      maximumInterval: 36500,
      lapseNewInterval: 0,
      leechThreshold: 8,
      buryNewSiblings: true,
      buryReviewSiblings: true,
      desiredRetention: 0.9,
      fsrsWeights: undefined,
      fsrsVersion: 5,
      dayStartHour: 4,
      timezone: "America/New_York",
    });

    const algo = createAlgorithm(settings);
    const old = toOldCardState(rs);
    const result = algo.reviewCard(old.cardState, "good");

    const { updatedState, log } = applyResultToReviewState(
      rs,
      result,
      "good",
      5000,
      "2026-06-07",
      "at://did:plc:123/cards.decay.flashcard.deck/d1",
    );

    // Updated state has new phase
    expect(updatedState.phase).not.toBe("new");
    expect(updatedState.lastReviewed).toBeDefined();
    expect(updatedState.updatedAt).toBeDefined();

    // Log has all required fields
    expect(log.note).toBe(rs.note);
    expect(log.deck).toBe("at://did:plc:123/cards.decay.flashcard.deck/d1");
    expect(log.templateId).toBe("card1");
    expect(log.answer).toBe("good");
    expect(log.phase).toBe("new"); // phase BEFORE review
    expect(log.algorithm).toBe("sm2");
    expect(log.phaseAfter).toBeDefined();
    expect(log.repsAfter).toBeDefined();
    expect(log.lapsesAfter).toBeDefined();
    expect(log.timeTaken).toBe(5000);
    expect(log.reviewedAt).toBeDefined();
    expect(log.resolvedDate).toBe("2026-06-07");
    expect(log.tid).toMatch(/^[a-z2-7]{13}$/);
  });
});

describe("toOldSchedulerSettings", () => {
  it("maps resolved deck settings to old format", () => {
    const resolved = {
      algorithm: "fsrs" as const,
      newCardsPerDay: 30,
      reviewsPerDay: 100,
      learningSteps: [1, 10, 60],
      relearningSteps: [10],
      graduatingInterval: 1,
      easyInterval: 4,
      startingEase: 2.5,
      easyBonus: 1.3,
      hardMultiplier: 1.2,
      intervalModifier: 1.0,
      maximumInterval: 36500,
      lapseNewInterval: 0,
      leechThreshold: 8,
      buryNewSiblings: true,
      buryReviewSiblings: true,
      desiredRetention: 0.85,
      fsrsWeights: [0.1, 0.2, 0.3],
      fsrsVersion: 5,
      dayStartHour: 4,
      timezone: "UTC",
    };

    const old = toOldSchedulerSettings(resolved);
    expect(old.algorithm).toBe("fsrs");
    expect(old.dailyNewLimit).toBe(30);
    expect(old.dailyReviewLimit).toBe(100);
    expect(old.fsrsParams?.weights).toEqual([0.1, 0.2, 0.3]);
    expect(old.fsrsParams?.requestRetention).toBe(0.85);
    expect(old.sm2Params?.learningSteps).toEqual([1, 10, 60]);
  });
});

describe("generateTid", () => {
  it("produces 13-char base32 strings", () => {
    const tid = generateTid();
    expect(tid).toMatch(/^[a-z2-7]{13}$/);
    expect(tid).toHaveLength(13);
  });

  it("produces unique values", () => {
    const tids = new Set(Array.from({ length: 100 }, () => generateTid()));
    expect(tids.size).toBe(100);
  });

  it("sorts chronologically", () => {
    const t1 = generateTid();
    const t2 = generateTid();
    // Later TID should sort after earlier one
    expect(t2 > t1).toBe(true);
  });
});
