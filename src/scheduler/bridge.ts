/**
 * Bridge between the new db/schema.ts ReviewStateRecord (flat, spec-compliant)
 * and the old scheduler types (CardReviewState with nested cardState blob).
 *
 * This lets the existing algorithm implementations (anki-sm2-algorithm, fsrs-algorithm)
 * work with the new storage layer without rewriting them.
 *
 * Once the old queue.ts is fully replaced, this bridge can be removed and the
 * algorithms can be adapted to work with ReviewStateRecord directly.
 */

import type { ReviewStateRecord, ReviewLogRecord } from "../db/schema";
import type { CardReviewState, Answer, SchedulerSettings, SM2Params } from "./types";
import type { AnkiSM2CardState } from "./anki-sm2-algorithm";
import type { SchedulingResult, CardState } from "./algorithm";
import { type Card, State, createEmptyCard } from "ts-fsrs";
import { AnkiSM2Algorithm } from "./anki-sm2-algorithm";
import { FSRSAlgorithm } from "./fsrs-algorithm";
import { omitUndefined } from "../utils/omitUndefined";

/**
 * Convert a flat ReviewStateRecord to the old CardReviewState format
 * so existing algorithm code can process it.
 */
export function toOldCardState(rs: ReviewStateRecord): CardReviewState {
  let cardState: CardState;

  if (rs.algorithm === "sm2") {
    const sm2State: AnkiSM2CardState = {
      phase: rs.phase,
      step: rs.learningStepIndex ?? 0,
      ease: rs.easeFactor ?? 2.5,
      interval: rs.intervalDays ?? (rs.intervalMinutes ? rs.intervalMinutes / 1440 : 0),
      due: rs.due ? new Date(rs.due).getTime() : 0,
      lapses: rs.lapses,
      reps: rs.reps,
    };
    cardState = sm2State;
  } else {
    // FSRS - construct a proper ts-fsrs Card
    // Start from createEmptyCard() to get correct defaults, then override
    const base = createEmptyCard();
    const fsrsCard: Card = omitUndefined({
      ...base,
      due: rs.due ? new Date(rs.due) : new Date(),
      stability: rs.stability ?? 0,
      difficulty: rs.difficulty ?? 0,
      elapsed_days: 0,
      scheduled_days: rs.intervalDays ?? 0,
      learning_steps: rs.learningStepIndex ?? 0,
      reps: rs.reps,
      lapses: rs.lapses,
      state: phaseToFSRSState(rs.phase),
      last_review: rs.lastReviewed ? new Date(rs.lastReviewed) : undefined,
    });
    cardState = fsrsCard;
  }

  return omitUndefined({
    cardId: rs.key,
    deckId: "", // derived from note.deck at usage site
    algorithm: rs.algorithm,
    cardState,
    createdAt: new Date(rs.createdAt).getTime(),
    lastReviewed: rs.lastReviewed ? new Date(rs.lastReviewed).getTime() : null,
    queueOverride: rs.suspended ? -1 : rs.buried ? -2 : undefined,
  });
}

/**
 * Convert old SchedulingResult back to flat ReviewStateRecord fields.
 */
export function applyResultToReviewState(
  rs: ReviewStateRecord,
  result: SchedulingResult,
  answer: Answer,
  timeMs: number,
  resolvedDate: string,
  deckUri: string,
): { updatedState: ReviewStateRecord; log: ReviewLogRecord } {
  const now = new Date().toISOString();
  const beforeState = { ...rs };

  let updatedState: ReviewStateRecord;

  if (rs.algorithm === "sm2") {
    const sm2 = result.cardState as AnkiSM2CardState;
    const isReview = sm2.phase === "review";
    updatedState = omitUndefined({
      ...rs,
      phase: sm2.phase,
      due: new Date(sm2.due).toISOString(),
      intervalDays: isReview ? sm2.interval : undefined,
      intervalMinutes: !isReview ? sm2.interval * 1440 : undefined,
      learningStepIndex:
        sm2.phase === "learning" || sm2.phase === "relearning" ? sm2.step : undefined,
      easeFactor: sm2.ease,
      reps: sm2.reps,
      lapses: sm2.lapses,
      lastReviewed: now,
      updatedAt: now,
    });
  } else {
    const fsrs = result.cardState as Card;
    const fsrsPhase = fsrsStateToPhase(fsrs.state);
    const isLearning = fsrsPhase === "learning" || fsrsPhase === "relearning";
    updatedState = omitUndefined({
      ...rs,
      phase: fsrsPhase,
      due: fsrs.due instanceof Date ? fsrs.due.toISOString() : String(fsrs.due),
      intervalDays: !isLearning && fsrs.scheduled_days > 0 ? fsrs.scheduled_days : undefined,
      intervalMinutes: isLearning ? fsrs.scheduled_days * 1440 : undefined,
      learningStepIndex: isLearning ? fsrs.learning_steps : undefined,
      stability: fsrs.stability,
      difficulty: fsrs.difficulty,
      reps: fsrs.reps,
      lapses: fsrs.lapses,
      lastReviewed: now,
      updatedAt: now,
    });
  }

  const log: ReviewLogRecord = omitUndefined({
    tid: generateTid(),
    note: rs.note,
    deck: deckUri,
    templateId: rs.templateId,
    answer,
    phase: rs.phase,
    algorithm: rs.algorithm,
    intervalBeforeDays: beforeState.intervalDays,
    intervalBeforeMinutes: beforeState.intervalMinutes,
    intervalAfterDays: updatedState.intervalDays,
    intervalAfterMinutes: updatedState.intervalMinutes,
    easeFactorBefore: rs.algorithm === "sm2" ? beforeState.easeFactor : undefined,
    easeFactorAfter: rs.algorithm === "sm2" ? updatedState.easeFactor : undefined,
    stabilityBefore: rs.algorithm === "fsrs" ? beforeState.stability : undefined,
    stabilityAfter: rs.algorithm === "fsrs" ? updatedState.stability : undefined,
    difficultyBefore: rs.algorithm === "fsrs" ? beforeState.difficulty : undefined,
    difficultyAfter: rs.algorithm === "fsrs" ? updatedState.difficulty : undefined,
    phaseAfter: updatedState.phase,
    repsAfter: updatedState.reps,
    lapsesAfter: updatedState.lapses,
    learningStepIndexAfter: updatedState.learningStepIndex,
    timeTaken: timeMs,
    reviewedAt: now,
    resolvedDate,
  });

  return { updatedState, log };
}

/**
 * Build a SchedulerSettings (old format) from resolved deck settings.
 */
export function toOldSchedulerSettings(
  resolved: Awaited<ReturnType<typeof import("../db/settings").deckSettingsDb.getResolved>>,
): SchedulerSettings {
  const sm2Params: Partial<SM2Params> = {
    learningSteps: resolved.learningSteps,
    relearningSteps: resolved.relearningSteps,
    graduatingInterval: resolved.graduatingInterval,
    easyInterval: resolved.easyInterval,
    startingEase: resolved.startingEase,
    easyBonus: resolved.easyBonus,
    hardMultiplier: resolved.hardMultiplier,
    intervalModifier: resolved.intervalModifier,
    lapseNewInterval: resolved.lapseNewInterval,
    maximumInterval: resolved.maximumInterval,
    leechThreshold: resolved.leechThreshold,
    buryNew: resolved.buryNewSiblings,
    buryReviews: resolved.buryReviewSiblings,
  };

  return {
    enabled: true,
    algorithm: resolved.algorithm,
    dailyNewLimit: resolved.newCardsPerDay,
    dailyReviewLimit: resolved.reviewsPerDay,
    showAheadOfSchedule: false,
    learnAheadMins: 20,
    rolloverHour: resolved.dayStartHour,
    sm2Params,
    fsrsParams: omitUndefined({
      weights: resolved.fsrsWeights,
      requestRetention: resolved.desiredRetention,
      maximumInterval: resolved.maximumInterval,
    }),
  };
}

/**
 * Create the appropriate algorithm instance from settings.
 */
export function createAlgorithm(settings: SchedulerSettings) {
  if (settings.algorithm === "fsrs") {
    return new FSRSAlgorithm(settings.fsrsParams);
  }
  return new AnkiSM2Algorithm(settings.sm2Params);
}

// --- Helpers ---

function phaseToFSRSState(phase: ReviewStateRecord["phase"]): State {
  switch (phase) {
    case "new":
      return State.New;
    case "learning":
      return State.Learning;
    case "review":
      return State.Review;
    case "relearning":
      return State.Relearning;
  }
}

function fsrsStateToPhase(state: State | number): ReviewStateRecord["phase"] {
  switch (state) {
    case State.New:
      return "new";
    case State.Learning:
      return "learning";
    case State.Review:
      return "review";
    case State.Relearning:
      return "relearning";
    default:
      return "new";
  }
}

/**
 * Generate a TID (timestamp-based ID compatible with AT Protocol).
 * TIDs are base32-sortable, 13 chars. Uses microsecond timestamp
 * with a monotonic counter to ensure uniqueness within the same ms.
 */
let lastTidMs = 0;
let tidCounter = 0;

export function generateTid(): string {
  const nowMs = Date.now();
  if (nowMs === lastTidMs) {
    tidCounter++;
  } else {
    lastTidMs = nowMs;
    tidCounter = 0;
  }
  // Microsecond-precision: ms * 1000 + counter (wraps at 1000)
  const microTs = BigInt(nowMs) * 1000n + BigInt(tidCounter % 1000);
  // Add 10 bits of randomness in the low bits for cross-device uniqueness
  const withRandom = (microTs << 10n) | BigInt(Math.floor(Math.random() * 1024));
  return encodeTid(withRandom);
}

const TID_CHARS = "234567abcdefghijklmnopqrstuvwxyz";

function encodeTid(value: bigint): string {
  let result = "";
  let remaining = value;
  for (let i = 0; i < 13; i++) {
    result = TID_CHARS[Number(remaining & 31n)] + result;
    remaining >>= 5n;
  }
  return result;
}
