/**
 * New study queue built on the db/ storage layer.
 *
 * Replaces the old queue.ts which was coupled to the legacy ReviewDB.
 * Uses bridge.ts to convert between flat ReviewStateRecords and the
 * algorithm implementations' internal card state format.
 */

import type { ReviewStateRecord, NoteRecord, NoteTypeRecord, DeckRecord } from "../db/schema";
import { notesDb } from "../db/notes";
import { noteTypesDb } from "../db/noteTypes";
import { reviewStateDb, reviewStateKey } from "../db/reviewState";
import { reviewLogsDb } from "../db/reviewLogs";
import { deckSettingsDb } from "../db/settings";
import { parseSearch, matchExpr, type SearchableCard, type SearchExpr } from "../search/engine";
import {
  toOldCardState,
  applyResultToReviewState,
  toOldSchedulerSettings,
  createAlgorithm,

} from "./bridge";
import type { SchedulingAlgorithm } from "./algorithm";
import type { Answer } from "./types";
import { groupBy } from "../utils/groupBy";

const CLOZE_REGEX = /\{\{c(\d+)::/g;
const MAX_CLOZE_ORDINAL = 500;

/**
 * A card ready for review — combines a note reference with its review state
 * and rendering context.
 */
export interface StudyCard {
  /** ReviewState record key: {noteTid}_{templateId} */
  key: string;
  /** The note this card is derived from */
  note: NoteRecord;
  /** The noteType for rendering */
  noteType: NoteTypeRecord;
  /** Template ID (or cloze ordinal like "c1") */
  templateId: string;
  /** Current review state */
  reviewState: ReviewStateRecord;
  /** Whether this card has never been reviewed */
  isNew: boolean;
  /** Deck name for rendering {{Deck}} in templates */
  deckName: string;
}

export interface StudyQueueCounts {
  newCount: number;
  learnCount: number;
  dueCount: number;
}

export interface DailyProgress {
  newStudied: number;
  reviewsStudied: number;
  newLimit: number;
  reviewLimit: number;
}

/**
 * Manages the study queue for a single deck.
 */
export class StudyQueue {
  private deckTid: string;
  private deckUri: string;
  private deckName = "";
  private deckRecord: DeckRecord | null = null;
  private algorithm!: SchedulingAlgorithm;
  private resolvedSettings!: Awaited<ReturnType<typeof deckSettingsDb.getResolved>>;
  private isFiltered = false;
  private filteredReschedule = true;

  private cards: StudyCard[] = [];
  private dailyNewStudied = 0;
  private dailyReviewsStudied = 0;
  private filteredAnswered = new Set<string>();

  constructor(deckTid: string, deckUri: string) {
    this.deckTid = deckTid;
    this.deckUri = deckUri;
  }

  /**
   * Initialize: load settings, build the card list, rebuild daily counts.
   */
  async init(): Promise<void> {
    this.resolvedSettings = await deckSettingsDb.getResolved(this.deckTid);
    const oldSettings = toOldSchedulerSettings(this.resolvedSettings);
    this.algorithm = createAlgorithm(oldSettings);

    const deck = await (await import("../db/decks")).decksDb.get(this.deckTid);
    this.deckRecord = deck ?? null;
    this.deckName = deck?.name ?? "";
    this.isFiltered = deck?.isFiltered ?? false;
    this.filteredReschedule = deck?.filteredReschedule ?? true;

    await this.buildCards();
    await this.rebuildDailyCounts();
    await this.unburyCards();
  }

  /**
   * Build the full card list from notes in this deck (or matching query for filtered decks).
   */
  private async buildCards(): Promise<void> {
    let notes: NoteRecord[];
    let deckNameMap: Map<string, string> | null = null;

    if (this.isFiltered) {
      notes = await notesDb.getAll();
      // Build deck name lookup for search
      const { decksDb } = await import("../db/decks");
      const allDecks = await decksDb.getAllActive();
      deckNameMap = new Map(
        allDecks.map((d) => [`at://self/cards.decay.flashcard.deck/${d.tid}`, d.name]),
      );
    } else {
      notes = await notesDb.getByDeck(this.deckUri);
    }
    const noteTypeCache = new Map<string, NoteTypeRecord>();
    const cards: StudyCard[] = [];

    for (const note of notes) {
      // Load noteType (cached)
      let noteType = noteTypeCache.get(note.noteType);
      if (!noteType) {
        const nt = await noteTypesDb.get(note.noteType.split("/").pop()!);
        if (!nt) continue; // orphaned note — skip
        noteType = nt;
        noteTypeCache.set(note.noteType, nt);
      }

      // Determine which cards this note generates
      const templateIds = noteType.isCloze
        ? getCardOrdinals(note, noteType)
        : noteType.templates.map((t) => t.id);

      const cardDeckName = deckNameMap ? (deckNameMap.get(note.deck) ?? "") : this.deckName;

      for (const templateId of templateIds) {
        const key = reviewStateKey(note.tid, templateId);
        let rs = await reviewStateDb.get(key);
        const isNew = !rs;

        if (!rs) {
          // Create initial reviewState for new cards
          const now = new Date().toISOString();
          rs = {
            key,
            note: `at://self/cards.decay.flashcard.note/${note.tid}`,
            templateId,
            algorithm: this.resolvedSettings.algorithm,
            phase: "new",
            reps: 0,
            lapses: 0,
            createdAt: now,
            updatedAt: now,
          };
        }

        // Skip orphaned cloze cards
        if (rs.orphaned) continue;

        cards.push({
          key,
          note,
          noteType,
          templateId,
          reviewState: rs,
          isNew,
          deckName: cardDeckName,
        });
      }
    }

    if (this.isFiltered && this.deckRecord?.filteredQuery) {
      this.cards = this.applyFilteredQuery(cards);
    } else {
      this.cards = cards;
    }
  }

  /**
   * Apply the filtered deck's search query, ordering, and limit.
   */
  private applyFilteredQuery(cards: StudyCard[]): StudyCard[] {
    const query = this.deckRecord!.filteredQuery!;
    let expr: SearchExpr | null;
    try {
      expr = parseSearch(query);
    } catch {
      return [];
    }
    if (!expr) return [];

    // Load deck names for search
    const deckNameCache = new Map<string, string>();
    const getDeckName = (note: NoteRecord): string => {
      if (deckNameCache.has(note.deck)) return deckNameCache.get(note.deck)!;
      // We don't have async access here, so use the deckName from the card or fallback
      return "";
    };

    let matched = cards.filter((card) => {
      const fields: Record<string, string> = {};
      for (const f of card.note.fields) {
        const fieldDef = card.noteType.fields.find((fd) => fd.id === f.fieldId);
        if (fieldDef) fields[fieldDef.name] = f.value;
      }
      const rs = card.reviewState;
      const queueName = rs.suspended ? "suspended" : rs.buried ? "buried" : rs.phase;

      const searchable: SearchableCard = {
        fields,
        deck: card.deckName || getDeckName(card.note),
        tags: card.note.tags ?? [],
        templateName: card.noteType.templates.find((t) => t.id === card.templateId)?.name ?? "",
        queueName,
        flags: 0,
        rawEase: rs.easeFactor ?? null,
        rawIvl: rs.intervalDays ?? 0,
        rawDue: rs.due ? new Date(rs.due).getTime() / 1000 : 0,
        rawDueType: rs.phase === "review" ? "dayOffset" : "timestamp",
        cardCreatedMs: new Date(card.note.createdAt).getTime(),
        noteModSec: new Date(card.note.updatedAt).getTime() / 1000,
        cardModSec: new Date(rs.updatedAt).getTime() / 1000,
        reps: rs.reps,
        lapses: rs.lapses,
      };
      return matchExpr(searchable, expr, 0);
    });

    // Apply ordering
    const order = this.deckRecord!.filteredOrder ?? "random";
    switch (order) {
      case "due":
        matched.sort((a, b) => {
          const aD = a.reviewState.due ? new Date(a.reviewState.due).getTime() : Infinity;
          const bD = b.reviewState.due ? new Date(b.reviewState.due).getTime() : Infinity;
          return aD - bD;
        });
        break;
      case "added":
        matched.sort((a, b) =>
          new Date(a.note.createdAt).getTime() - new Date(b.note.createdAt).getTime(),
        );
        break;
      case "ivl-asc":
        matched.sort((a, b) => (a.reviewState.intervalDays ?? 0) - (b.reviewState.intervalDays ?? 0));
        break;
      case "ivl-desc":
        matched.sort((a, b) => (b.reviewState.intervalDays ?? 0) - (a.reviewState.intervalDays ?? 0));
        break;
      case "ease-asc":
        matched.sort((a, b) => (a.reviewState.easeFactor ?? 0) - (b.reviewState.easeFactor ?? 0));
        break;
      case "lapses-desc":
        matched.sort((a, b) => (b.reviewState.lapses) - (a.reviewState.lapses));
        break;
      case "random":
      default:
        // Fisher-Yates shuffle
        for (let i = matched.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [matched[i], matched[j]] = [matched[j]!, matched[i]!];
        }
        break;
    }

    // Apply limit
    const limit = this.deckRecord!.filteredLimit ?? 100;
    return matched.slice(0, limit);
  }

  /**
   * Rebuild daily counts from today's review logs.
   */
  private async rebuildDailyCounts(): Promise<void> {
    const today = this.getTodayString();
    const logs = await reviewLogsDb.getByDeckAndDate(this.deckUri, today);
    this.dailyNewStudied = logs.filter((l) => l.phase === "new").length;
    this.dailyReviewsStudied = logs.filter((l) => l.phase !== "new").length;
  }

  /**
   * Unbury cards from previous days.
   */
  private async unburyCards(): Promise<void> {
    const today = this.getTodayString();
    const toUnbury = this.cards.filter(
      (c) => c.reviewState.buried && c.reviewState.buriedDate && c.reviewState.buriedDate < today,
    );

    for (const card of toUnbury) {
      card.reviewState = {
        ...card.reviewState,
        buried: false,
        buriedChangedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await reviewStateDb.put(card.reviewState);
    }
  }

  /**
   * Get cards due for study, in Anki order: learning → due reviews → new.
   * Filtered decks present all matched cards regardless of due state.
   */
  getDueCards(): StudyCard[] {
    if (this.isFiltered) {
      // Filtered decks: show all non-suspended/buried cards that haven't been answered yet
      return this.cards.filter(
        (c) => !c.reviewState.suspended && !c.reviewState.buried && !this.filteredAnswered.has(c.key),
      );
    }

    const now = Date.now();
    const learnAheadMs = 20 * 60 * 1000; // 20 minutes learn-ahead window

    const active = this.cards.filter((c) => !c.reviewState.suspended && !c.reviewState.buried);

    const categorize = (card: StudyCard): string => {
      const rs = card.reviewState;
      if (rs.phase === "new") return "new";
      if (rs.phase === "learning" || rs.phase === "relearning") {
        const dueMs = rs.due ? new Date(rs.due).getTime() : 0;
        // Only show learning cards when actually due — NOT in learn-ahead window.
        // Learn-ahead is only used when the regular queue is empty (handled below).
        if (dueMs <= now) return "learning";
        return "learningWaiting";
      }
      if (rs.due && new Date(rs.due).getTime() <= now) return "dueReview";
      return "ahead";
    };

    const grouped = groupBy(active, categorize);
    const learning = grouped["learning"] ?? [];
    const dueReviews = grouped["dueReview"] ?? [];
    const newCards = grouped["new"] ?? [];
    const learningWaiting = grouped["learningWaiting"] ?? [];

    // Apply daily limits
    const newLeft = Math.max(0, this.resolvedSettings.newCardsPerDay - this.dailyNewStudied);
    const reviewLeft = Math.max(0, this.resolvedSettings.reviewsPerDay - this.dailyReviewsStudied);

    const selectedNew = newCards.slice(0, newLeft);
    const selectedReviews = dueReviews.slice(0, reviewLeft);

    // If no due cards at all, include learn-ahead cards
    if (learning.length === 0 && selectedReviews.length === 0 && selectedNew.length === 0) {
      const learnAhead = learningWaiting.filter((c) => {
        const dueMs = c.reviewState.due ? new Date(c.reviewState.due).getTime() : 0;
        return dueMs <= now + learnAheadMs;
      });
      if (learnAhead.length > 0) {
        learning.push(...learnAhead);
      }
    }

    // Sort learning by due time (soonest first)
    learning.sort((a, b) => {
      const aDue = a.reviewState.due ? new Date(a.reviewState.due).getTime() : 0;
      const bDue = b.reviewState.due ? new Date(b.reviewState.due).getTime() : 0;
      return aDue - bDue;
    });

    // Sort reviews by due date
    selectedReviews.sort((a, b) => {
      const aDue = a.reviewState.due ? new Date(a.reviewState.due).getTime() : 0;
      const bDue = b.reviewState.due ? new Date(b.reviewState.due).getTime() : 0;
      return aDue - bDue;
    });

    return [...learning, ...selectedReviews, ...selectedNew];
  }

  /**
   * Process a review answer. Returns the updated card and the review log TID (for undo).
   */
  async processReview(
    card: StudyCard,
    answer: Answer,
    timeMs: number,
  ): Promise<{ card: StudyCard; logTid: string }> {
    // Handle algorithm mismatch: if card was stored as SM2 but deck is FSRS (or vice versa),
    // convert the reviewState to match the deck's algorithm before processing.
    let rs = card.reviewState;
    if (rs.algorithm !== this.resolvedSettings.algorithm) {
      rs = convertAlgorithm(rs, this.resolvedSettings.algorithm);
    }

    const oldCardState = toOldCardState(rs);
    const result = this.algorithm.reviewCard(oldCardState.cardState, answer);
    const resolvedDate = this.getTodayString();

    const { updatedState, log } = applyResultToReviewState(
      rs,
      result,
      answer,
      timeMs,
      resolvedDate,
      this.deckUri,
    );

    // Leech detection
    if (updatedState.lapses >= this.resolvedSettings.leechThreshold && answer === "again") {
      updatedState.suspended = true;
      updatedState.suspendedChangedAt = new Date().toISOString();
    }

    // Save state + log (skip state update if filtered deck with reschedule=off)
    if (!this.isFiltered || this.filteredReschedule) {
      await reviewStateDb.put(updatedState);
    }
    await reviewLogsDb.put(log);

    // Update daily counts
    if (card.reviewState.phase === "new") {
      this.dailyNewStudied++;
    } else {
      this.dailyReviewsStudied++;
    }

    // Sibling burying
    await this.burySiblings(card, updatedState);

    // Update the card in our list
    const updated: StudyCard = { ...card, reviewState: updatedState, isNew: false };
    const idx = this.cards.findIndex((c) => c.key === card.key);
    if (idx !== -1) this.cards[idx] = updated;

    // Track answered cards in filtered decks
    if (this.isFiltered) {
      this.filteredAnswered.add(card.key);
    }

    return { card: updated, logTid: log.tid };
  }

  /**
   * Auto-bury sibling cards (other cards from the same note).
   */
  private async burySiblings(reviewed: StudyCard, _state: ReviewStateRecord): Promise<void> {
    const settings = this.resolvedSettings;
    const siblings = this.cards.filter(
      (c) => c.note.tid === reviewed.note.tid && c.key !== reviewed.key,
    );

    for (const sibling of siblings) {
      if (sibling.reviewState.suspended || sibling.reviewState.buried) continue;

      const shouldBury =
        (sibling.isNew && settings.buryNewSiblings) ||
        (!sibling.isNew && settings.buryReviewSiblings);

      if (shouldBury) {
        const now = new Date().toISOString();
        sibling.reviewState = {
          ...sibling.reviewState,
          buried: true,
          buriedChangedAt: now,
          buriedDate: this.getTodayString(),
          updatedAt: now,
        };
        await reviewStateDb.put(sibling.reviewState);
      }
    }
  }

  /**
   * Get interval previews for each answer button.
   */
  getNextIntervals(card: StudyCard): Record<Answer, string> {
    try {
      let rs = card.reviewState;
      if (rs.algorithm !== this.resolvedSettings.algorithm) {
        rs = convertAlgorithm(rs, this.resolvedSettings.algorithm);
      }
      const oldState = toOldCardState(rs);
      const intervals = this.algorithm.getNextIntervals(oldState.cardState);
      return {
        again: formatInterval(intervals.again),
        hard: formatInterval(intervals.hard),
        good: formatInterval(intervals.good),
        easy: formatInterval(intervals.easy),
      };
    } catch {
      return { again: "<1m", hard: "?", good: "?", easy: "?" };
    }
  }

  /**
   * Get queue counts for the deck header.
   */
  getCounts(): StudyQueueCounts {
    const now = Date.now();
    let newCount = 0;
    let learnCount = 0;
    let dueCount = 0;

    for (const card of this.cards) {
      if (card.reviewState.suspended || card.reviewState.buried) continue;

      const rs = card.reviewState;
      if (rs.phase === "new") {
        newCount++;
      } else if (rs.phase === "learning" || rs.phase === "relearning") {
        // Count learning cards that are actually due now
        const dueMs = rs.due ? new Date(rs.due).getTime() : 0;
        if (dueMs <= now) learnCount++;
      } else if (rs.due && new Date(rs.due).getTime() <= now) {
        dueCount++;
      }
    }

    const newLeft = Math.max(0, this.resolvedSettings.newCardsPerDay - this.dailyNewStudied);
    return {
      newCount: Math.min(newCount, newLeft),
      learnCount,
      dueCount: Math.min(
        dueCount,
        Math.max(0, this.resolvedSettings.reviewsPerDay - this.dailyReviewsStudied),
      ),
    };
  }

  /**
   * Get daily progress.
   */
  getProgress(): DailyProgress {
    return {
      newStudied: this.dailyNewStudied,
      reviewsStudied: this.dailyReviewsStudied,
      newLimit: this.resolvedSettings.newCardsPerDay,
      reviewLimit: this.resolvedSettings.reviewsPerDay,
    };
  }

  /**
   * Undo the last review. Only works if the review log hasn't synced.
   */
  async undo(undoState: ReviewStateRecord, logTid: string): Promise<void> {
    await reviewStateDb.put(undoState);
    await reviewLogsDb.delete(logTid);

    // Update in-memory list
    const idx = this.cards.findIndex((c) => c.key === undoState.key);
    if (idx !== -1) {
      this.cards[idx] = { ...this.cards[idx]!, reviewState: undoState };
    }
  }

  private getTodayString(): string {
    const tz = this.resolvedSettings.timezone;
    const hour = this.resolvedSettings.dayStartHour;
    const now = new Date();
    // Adjust for dayStartHour: if before the hour, it's "yesterday"
    const adjusted = new Date(now.getTime() - hour * 60 * 60 * 1000);
    // Format in the settings timezone
    return adjusted.toLocaleDateString("en-CA", { timeZone: tz }); // en-CA gives YYYY-MM-DD
  }
}

/**
 * Extract cloze ordinals from a note's field values.
 * Returns templateIds like "c1", "c2", etc.
 */
const IO_ORDINAL_REGEX = /data-ordinal="(\d+)"/g;

/**
 * Get card ordinals for a cloze/IO note.
 * IO notes have ordinals in SVG data-ordinal attributes.
 * Regular cloze notes have ordinals in {{cN::...}} patterns.
 */
function getCardOrdinals(note: NoteRecord, _noteType: NoteTypeRecord): string[] {
  // Check for Image Occlusion: look for data-ordinal in any field
  for (const field of note.fields) {
    if (field.value.includes("data-ordinal")) {
      return getIOOrdinals(field.value);
    }
  }
  // Fall back to standard cloze
  return getClozeOrdinals(note);
}

function getIOOrdinals(svgString: string): string[] {
  const ordinals = new Set<number>();
  IO_ORDINAL_REGEX.lastIndex = 0;
  let match;
  while ((match = IO_ORDINAL_REGEX.exec(svgString)) !== null) {
    const n = parseInt(match[1]!, 10);
    if (n >= 1 && n <= MAX_CLOZE_ORDINAL) ordinals.add(n);
  }
  return Array.from(ordinals)
    .sort((a, b) => a - b)
    .map((n) => `c${n}`);
}

function getClozeOrdinals(note: NoteRecord): string[] {
  const ordinals = new Set<number>();
  for (const field of note.fields) {
    CLOZE_REGEX.lastIndex = 0;
    let match;
    while ((match = CLOZE_REGEX.exec(field.value)) !== null) {
      const n = parseInt(match[1]!, 10);
      if (n >= 1 && n <= MAX_CLOZE_ORDINAL) {
        ordinals.add(n);
      }
    }
  }
  return Array.from(ordinals)
    .sort((a, b) => a - b)
    .map((n) => `c${n}`);
}

/**
 * Convert a reviewState from one algorithm to another (lazy conversion per spec).
 * SM-2 → FSRS: stability ≈ interval, difficulty from easeFactor
 * FSRS → SM-2: easeFactor from difficulty, interval preserved
 */
/**
 * Convert a reviewState from one algorithm to another (lazy conversion per spec).
 * For new cards: just switch the algorithm field (FSRS/SM-2 both start from defaults).
 * For reviewed cards: SM-2 → FSRS: stability ≈ interval, difficulty from easeFactor.
 */
function convertAlgorithm(rs: ReviewStateRecord, targetAlgo: "sm2" | "fsrs"): ReviewStateRecord {
  const converted: ReviewStateRecord = { ...rs, algorithm: targetAlgo };

  // New cards: both algorithms start from their own defaults, no conversion needed
  if (rs.phase === "new") {
    if (targetAlgo === "fsrs") {
      delete converted.easeFactor;
      converted.stability = 0;
      converted.difficulty = 0;
    } else {
      delete converted.stability;
      delete converted.difficulty;
      converted.easeFactor = 2.5;
    }
    return converted;
  }

  if (targetAlgo === "fsrs" && rs.algorithm === "sm2") {
    // SM-2 → FSRS: stability ≈ interval (in days), difficulty from ease
    // FSRS difficulty range is ~1-10 (NOT 0-1 as spec originally assumed)
    converted.stability = Math.max(0.1, rs.intervalDays ?? 1);
    converted.difficulty = rs.easeFactor
      ? Math.max(1, Math.min(10, (3.0 - rs.easeFactor) * 3 + 5))
      : 5.0;
    delete converted.easeFactor;
  } else if (targetAlgo === "sm2" && rs.algorithm === "fsrs") {
    converted.easeFactor =
      rs.difficulty !== undefined
        ? Math.max(1.3, Math.min(3.0, 3.0 - (rs.difficulty - 5) / 3))
        : 2.5;
    delete converted.stability;
    delete converted.difficulty;
  }

  return converted;
}

function formatInterval(due: Date): string {
  const diffMs = due.getTime() - Date.now();
  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  const months = Math.floor(days / 30);

  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 30) return `${days}d`;
  return `${months}mo`;
}
