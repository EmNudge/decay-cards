import { describe, it, expect } from "vitest";
import type {
  NoteTypeRecord,
  ReviewLogRecord,
  ReviewStateRecord,
} from "../../db/schema";
import {
  mergeNoteType,
  mergeReviewState,
  rebuildStudySummary,
} from "../merge";

const t0 = "2025-01-01T00:00:00Z";
const t1 = "2025-02-01T00:00:00Z";
const t2 = "2025-03-01T00:00:00Z";

function baseNoteType(over: Partial<NoteTypeRecord> = {}): NoteTypeRecord {
  return {
    tid: "nt1",
    name: "Basic",
    fields: [{ id: "f0", name: "Front" }],
    templates: [{ id: "tmpl0", name: "Card 1", qfmt: "{{Front}}", afmt: "" }],
    createdAt: t0,
    updatedAt: t0,
    ...over,
  };
}

describe("mergeNoteType", () => {
  it("unions templates and fields by id when neither side conflicts", () => {
    const local = baseNoteType({
      fields: [
        { id: "f0", name: "Front" },
        { id: "f1", name: "Back" },
      ],
      templates: [
        { id: "tmpl0", name: "Card 1", qfmt: "L", afmt: "L" },
      ],
    });
    const remote = baseNoteType({
      fields: [
        { id: "f0", name: "Front" },
        { id: "f2", name: "Hint" },
      ],
      templates: [
        { id: "tmpl1", name: "Card 2", qfmt: "R", afmt: "R" },
      ],
      updatedAt: t1,
    });
    const merged = mergeNoteType(local, remote);
    expect(merged.fields.map((f) => f.id).sort()).toEqual(["f0", "f1", "f2"]);
    expect(merged.templates.map((t) => t.id).sort()).toEqual(["tmpl0", "tmpl1"]);
  });

  it("uses record-level LWW to break ties on conflicting ids", () => {
    const local = baseNoteType({
      templates: [{ id: "tmpl0", name: "Local label", qfmt: "L", afmt: "L" }],
      updatedAt: t0,
    });
    const remote = baseNoteType({
      templates: [{ id: "tmpl0", name: "Remote label", qfmt: "R", afmt: "R" }],
      updatedAt: t2,
    });
    const merged = mergeNoteType(local, remote);
    const tmpl = merged.templates.find((t) => t.id === "tmpl0")!;
    expect(tmpl.name).toBe("Remote label");
  });

  it("survives one-sided deletions (union-only)", () => {
    const local = baseNoteType({
      templates: [
        { id: "tmpl0", name: "L1", qfmt: "", afmt: "" },
        { id: "tmpl1", name: "L2", qfmt: "", afmt: "" },
      ],
      updatedAt: t1,
    });
    const remote = baseNoteType({
      templates: [{ id: "tmpl0", name: "R1", qfmt: "", afmt: "" }],
      updatedAt: t2,
    });
    const merged = mergeNoteType(local, remote);
    // Remote dropped tmpl1; we keep it (deletions don't propagate).
    expect(merged.templates.map((t) => t.id).sort()).toEqual(["tmpl0", "tmpl1"]);
  });

  it("LWW for scalar fields, min for createdAt, max for updatedAt", () => {
    const local = baseNoteType({
      name: "Old name",
      css: ".local{}",
      createdAt: t0,
      updatedAt: t0,
    });
    const remote = baseNoteType({
      name: "New name",
      css: ".remote{}",
      createdAt: t1,
      updatedAt: t2,
    });
    const merged = mergeNoteType(local, remote);
    expect(merged.name).toBe("New name");
    expect(merged.css).toBe(".remote{}");
    expect(merged.createdAt).toBe(t0);
    expect(merged.updatedAt).toBe(t2);
  });
});

function baseReviewState(over: Partial<ReviewStateRecord> = {}): ReviewStateRecord {
  return {
    key: "n1_t1",
    note: "at://did:test/cards.decay.flashcard.note/n1",
    templateId: "t1",
    algorithm: "fsrs",
    phase: "new",
    reps: 0,
    lapses: 0,
    createdAt: t0,
    updatedAt: t0,
    ...over,
  };
}

function baseLog(over: Partial<ReviewLogRecord> = {}): ReviewLogRecord {
  return {
    tid: "log",
    note: "at://did:test/cards.decay.flashcard.note/n1",
    deck: "at://did:test/cards.decay.flashcard.deck/d1",
    templateId: "t1",
    answer: "good",
    phase: "review",
    algorithm: "fsrs",
    reviewedAt: t0,
    resolvedDate: "2025-01-01",
    ...over,
  };
}

describe("mergeReviewState", () => {
  it("takes after-state from the latest log", () => {
    const local = baseReviewState({ reps: 0, phase: "new" });
    const remote = baseReviewState({ reps: 2, phase: "review", updatedAt: t1 });
    const logs = [
      baseLog({
        tid: "l1",
        reviewedAt: t0,
        phaseAfter: "learning",
        repsAfter: 1,
        lapsesAfter: 0,
      }),
      baseLog({
        tid: "l2",
        reviewedAt: t2, // latest
        phaseAfter: "review",
        repsAfter: 5,
        lapsesAfter: 1,
        stabilityAfter: 12.3,
        difficultyAfter: 4.5,
      }),
    ];
    const merged = mergeReviewState(local, remote, logs);
    expect(merged.phase).toBe("review");
    expect(merged.reps).toBe(5);
    expect(merged.lapses).toBe(1);
    expect(merged.stability).toBe(12.3);
    expect(merged.difficulty).toBe(4.5);
    expect(merged.lastReviewed).toBe(t2);
  });

  it("merges suspended flag with per-flag LWW", () => {
    const local = baseReviewState({
      suspended: true,
      suspendedChangedAt: t1,
    });
    const remote = baseReviewState({
      suspended: false,
      suspendedChangedAt: t2, // later — wins
    });
    const merged = mergeReviewState(local, remote, []);
    expect(merged.suspended).toBe(false);
    expect(merged.suspendedChangedAt).toBe(t2);
  });

  it("merges buried flag independently from suspended", () => {
    const local = baseReviewState({
      suspended: true,
      suspendedChangedAt: t2, // local wins
      buried: false,
      buriedChangedAt: t0,
    });
    const remote = baseReviewState({
      suspended: false,
      suspendedChangedAt: t1,
      buried: true,
      buriedChangedAt: t1, // remote wins
    });
    const merged = mergeReviewState(local, remote, []);
    expect(merged.suspended).toBe(true);
    expect(merged.buried).toBe(true);
  });

  it("uses min(createdAt) and max(updatedAt)", () => {
    const local = baseReviewState({ createdAt: t1, updatedAt: t1 });
    const remote = baseReviewState({ createdAt: t0, updatedAt: t2 });
    const merged = mergeReviewState(local, remote, []);
    expect(merged.createdAt).toBe(t0);
    expect(merged.updatedAt).toBe(t2);
  });

  it("falls back to LWW when there are no logs", () => {
    const local = baseReviewState({ reps: 1, updatedAt: t0 });
    const remote = baseReviewState({ reps: 5, updatedAt: t2 });
    const merged = mergeReviewState(local, remote, []);
    expect(merged.reps).toBe(5);
  });
});

describe("rebuildStudySummary", () => {
  it("aggregates counts from logs", () => {
    const logs: ReviewLogRecord[] = [
      baseLog({ tid: "1", answer: "good", phase: "new", timeTaken: 2000 }),
      baseLog({ tid: "2", answer: "good", phase: "review", timeTaken: 1500 }),
      baseLog({ tid: "3", answer: "easy", phase: "review", timeTaken: 1000 }),
      baseLog({ tid: "4", answer: "hard", phase: "review", timeTaken: 4000 }),
      baseLog({ tid: "5", answer: "again", phase: "relearning", timeTaken: 3000 }),
    ];
    const summary = rebuildStudySummary("2025-01-01", logs, t1);
    expect(summary).toMatchObject({
      date: "2025-01-01",
      reviewCount: 5,
      newCount: 1,
      againCount: 1,
      hardCount: 1,
      goodCount: 2,
      easyCount: 1,
      timeSpentMs: 11500,
      updatedAt: t1,
    });
  });

  it("returns zeros when no logs", () => {
    const summary = rebuildStudySummary("2025-01-01", [], t1);
    expect(summary.reviewCount).toBe(0);
    expect(summary.timeSpentMs).toBe(0);
  });
});
