/**
 * IndexedDB schema for decay-flashcard-db.
 *
 * All PDS-mirrored stores hold the record body as-is (matching the Lexicon schema).
 * Local-only stores (dailyLimits, clozeOrdinals, undoBuffer, forkProgress) are not synced.
 */

const DB_NAME = "decay-flashcard-db";
const DB_VERSION = 1;

// --- PDS-mirrored record types ---

export interface DeckRecord {
  tid: string;
  name: string;
  description?: string;
  parentDeck?: string; // AT URI
  isFiltered?: boolean;
  filteredQuery?: string;
  filteredOrder?: string;
  filteredLimit?: number;
  filteredReschedule?: boolean;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NoteTypeField {
  id: string;
  name: string;
  description?: string;
}

export interface NoteTypeTemplate {
  id: string;
  name: string;
  qfmt: string;
  afmt: string;
}

export interface NoteTypeRecord {
  tid: string;
  name: string;
  isCloze?: boolean;
  fields: NoteTypeField[];
  templates: NoteTypeTemplate[];
  css?: string;
  forkedFrom?: string; // AT URI
  createdAt: string;
  updatedAt: string;
}

export interface NoteFieldValue {
  fieldId: string;
  value: string;
}

export interface NoteRecord {
  tid: string;
  deck: string; // AT URI
  noteType: string; // AT URI
  ankiNoteId?: number;
  forkedFrom?: string; // AT URI
  fields: NoteFieldValue[];
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MediaRecord {
  normalizedKey: string;
  filename: string;
  blob: Blob;
  mimeType?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewStateRecord {
  key: string; // {noteTid}_{templateId}
  note: string; // AT URI
  templateId: string;
  algorithm: "sm2" | "fsrs";
  phase: "new" | "learning" | "review" | "relearning";
  due?: string;
  intervalDays?: number;
  intervalMinutes?: number;
  learningStepIndex?: number;
  easeFactor?: number;
  reps: number;
  lapses: number;
  stability?: number;
  difficulty?: number;
  suspended?: boolean;
  suspendedChangedAt?: string;
  buried?: boolean;
  buriedChangedAt?: string;
  buriedDate?: string; // YYYY-MM-DD
  orphaned?: boolean;
  orphanedAt?: string;
  lastReviewed?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewLogRecord {
  tid: string;
  note: string; // AT URI
  deck: string; // AT URI
  templateId: string;
  answer: "again" | "hard" | "good" | "easy";
  phase: "new" | "learning" | "review" | "relearning";
  algorithm: "sm2" | "fsrs";
  intervalBeforeDays?: number;
  intervalBeforeMinutes?: number;
  intervalAfterDays?: number;
  intervalAfterMinutes?: number;
  easeFactorBefore?: number;
  easeFactorAfter?: number;
  stabilityBefore?: number;
  stabilityAfter?: number;
  difficultyBefore?: number;
  difficultyAfter?: number;
  phaseAfter?: "new" | "learning" | "review" | "relearning";
  repsAfter?: number;
  lapsesAfter?: number;
  learningStepIndexAfter?: number;
  timeTaken?: number;
  reviewedAt: string;
  resolvedDate: string; // YYYY-MM-DD
}

export interface CardFlagRecord {
  key: string; // {noteTid}_{templateId}
  note: string; // AT URI
  templateId: string;
  flag: "red" | "orange" | "green" | "blue" | "pink" | "turquoise" | "purple";
  createdAt: string;
  updatedAt: string;
}

export interface StudySummaryRecord {
  date: string; // YYYY-MM-DD
  reviewCount: number;
  newCount?: number;
  timeSpentMs?: number;
  againCount?: number;
  hardCount?: number;
  goodCount?: number;
  easyCount?: number;
  updatedAt: string;
}

export interface SettingsRecord {
  key: "self";
  defaultAlgorithm?: "sm2" | "fsrs";
  timezone?: string; // IANA
  dayStartHour?: number;
  updatedAt: string;
}

export interface DeckSettingsRecord {
  deckTid: string;
  deck: string; // AT URI
  algorithm?: "sm2" | "fsrs";
  newCardsPerDay?: number;
  reviewsPerDay?: number;
  learningSteps?: number[];
  relearningSteps?: number[];
  graduatingInterval?: number;
  easyInterval?: number;
  startingEase?: number;
  easyBonus?: number;
  hardMultiplier?: number;
  intervalModifier?: number;
  maximumInterval?: number;
  lapseNewInterval?: number;
  leechThreshold?: number;
  buryNewSiblings?: boolean;
  buryReviewSiblings?: boolean;
  desiredRetention?: number;
  fsrsWeights?: number[];
  fsrsVersion?: number;
  updatedAt: string;
}

export interface ShareDeckRecord {
  key: string; // deck TID
  deck: string; // AT URI
  title?: string;
  description?: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ForkDeckRecord {
  key: string; // local deck TID
  sourceDeck: string; // AT URI
  localDeck: string; // AT URI
  forkedAt: string;
  createdAt: string;
}

// --- Sync infrastructure ---

export type OutboxOp = "put" | "delete";

export interface OutboxEntry {
  id?: number; // autoIncrement
  collection: string;
  recordKey: string;
  op: OutboxOp;
  record?: unknown; // full record body for puts
  groupId?: string; // cascade group linkage
  createdAt: string;
}

export interface DeadLetterEntry {
  id?: number;
  collection: string;
  recordKey: string;
  op: OutboxOp;
  record?: unknown;
  error: string;
  createdAt: string;
}

export interface SyncStateEntry {
  collection: string;
  lastRev?: string;
  lastSyncedAt?: string;
}

// --- Local-only ---

export interface DailyLimitEntry {
  key: string; // {deckTid}_{YYYY-MM-DD}
  deckTid: string;
  date: string;
  newCount: number;
  reviewCount: number;
}

export interface ClozeOrdinalEntry {
  noteTid: string;
  ordinals: number[];
}

export interface UndoBufferEntry {
  key: "last";
  reviewState: ReviewStateRecord;
  reviewLogTid: string;
  outboxEntryId?: number;
}

export interface ForkProgressEntry {
  sourceDeckUri: string;
  localDeckTid: string;
  copiedNotes: string[]; // TIDs of notes already copied
  copiedMedia: string[]; // normalized keys already copied
  mediaRenames: Record<string, string>; // old → new filename
  failedBlobs: Array<{ filename: string; size: number; error: string }>;
  startedAt: string;
}

// --- Database open ---

let dbInstance: IDBDatabase | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;

export function getDb(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);

    request.onsuccess = () => {
      dbInstance = request.result;
      resolve(dbInstance);
    };

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion;

      if (oldVersion < 1) {
        createV1Stores(db);
      }
    };
  });

  return dbPromise;
}

function createV1Stores(db: IDBDatabase) {
  // PDS-mirrored
  const notes = db.createObjectStore("notes", { keyPath: "tid" });
  notes.createIndex("deckUri", "deck", { unique: false });
  notes.createIndex("noteTypeUri", "noteType", { unique: false });
  notes.createIndex("ankiNoteId", "ankiNoteId", { unique: false });

  db.createObjectStore("decks", { keyPath: "tid" });

  const noteTypes = db.createObjectStore("noteTypes", { keyPath: "tid" });
  noteTypes.createIndex("forkedFrom", "forkedFrom", { unique: false });

  const media = db.createObjectStore("media", { keyPath: "normalizedKey" });
  media.createIndex("filename", "filename", { unique: false });

  const reviewState = db.createObjectStore("reviewState", { keyPath: "key" });
  reviewState.createIndex("noteUri", "note", { unique: false });
  reviewState.createIndex("phase", "phase", { unique: false });
  reviewState.createIndex("due", "due", { unique: false });

  const reviewLogs = db.createObjectStore("reviewLogs", { keyPath: "tid" });
  reviewLogs.createIndex("noteUri", "note", { unique: false });
  reviewLogs.createIndex("reviewedAt", "reviewedAt", { unique: false });

  db.createObjectStore("cardFlags", { keyPath: "key" });
  db.createObjectStore("studySummary", { keyPath: "date" });
  db.createObjectStore("settings", { keyPath: "key" });
  db.createObjectStore("deckSettings", { keyPath: "deckTid" });
  db.createObjectStore("shareDeck", { keyPath: "key" });
  db.createObjectStore("forkDeck", { keyPath: "key" });

  // Sync infrastructure
  const outbox = db.createObjectStore("outbox", {
    keyPath: "id",
    autoIncrement: true,
  });
  outbox.createIndex("collection", "collection", { unique: false });
  outbox.createIndex("recordKey", "recordKey", { unique: false });
  outbox.createIndex("groupId", "groupId", { unique: false });

  const deadLetters = db.createObjectStore("deadLetters", {
    keyPath: "id",
    autoIncrement: true,
  });
  deadLetters.createIndex("collection", "collection", { unique: false });
  deadLetters.createIndex("createdAt", "createdAt", { unique: false });

  db.createObjectStore("syncState", { keyPath: "collection" });

  // Local-only
  db.createObjectStore("dailyLimits", { keyPath: "key" });
  db.createObjectStore("clozeOrdinals", { keyPath: "noteTid" });
  db.createObjectStore("undoBuffer", { keyPath: "key" });
  db.createObjectStore("forkProgress", { keyPath: "sourceDeckUri" });
}

/** Close the database (for testing) */
export function closeDb() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    dbPromise = null;
  }
}

/** Delete the database (for testing) */
export async function deleteDb() {
  closeDb();
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
