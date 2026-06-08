/**
 * Phase 1 → Phase 2 migration.
 *
 * Phase 1 users have local IndexedDB data that predates the outbox
 * wiring. On the first sign-in, we walk every local store and enqueue
 * its contents to the outbox, in spec order, so the normal drain
 * pipeline can push everything to the PDS.
 *
 * The migration is one-shot — a flag in `syncState` records completion.
 * Subsequent app starts skip it. Coalescing at drain time collapses any
 * duplicate entries that may have been created if the user wrote a few
 * records between the outbox wiring and the first sync.
 *
 * No agent / no network needed: this is a pure local enqueue.
 */
import { decksDb } from "../db/decks";
import { notesDb } from "../db/notes";
import { noteTypesDb } from "../db/noteTypes";
import { reviewStateDb } from "../db/reviewState";
import { reviewLogsDb } from "../db/reviewLogs";
import { mediaDb } from "../db/media";
import { settingsDb, deckSettingsDb } from "../db/settings";
import { outboxDb } from "../db/outbox";
import { syncStateDb } from "../db/syncState";
import type { MediaRecord } from "../db/schema";

const MIGRATION_FLAG = "__phase2_migrated__";

const NS = "cards.decay.flashcard";

export interface MigrationProgress {
  total: number;
  queued: number;
  done: boolean;
}

export async function isPhase2Migrated(): Promise<boolean> {
  const entry = await syncStateDb.getForCollection(MIGRATION_FLAG);
  return entry?.lastSyncedAt !== undefined;
}

/** Mark migration as already-done — used for fresh installs that have nothing to upload. */
export async function markPhase2Migrated(): Promise<void> {
  await syncStateDb.setForCollection(MIGRATION_FLAG);
}

/**
 * Enqueue every local record into the outbox. Order matches the spec:
 * reviewLogs (chronological) → reviewState → notes → noteTypes → decks →
 * media → settings → deckSettings. Returns the final progress snapshot.
 *
 * Idempotent: once the migration flag is set, subsequent calls return
 * `{ total: 0, queued: 0, done: true }` without re-walking.
 */
export async function migrateToPhase2(
  onProgress?: (p: MigrationProgress) => void,
): Promise<MigrationProgress> {
  if (await isPhase2Migrated()) {
    return { total: 0, queued: 0, done: true };
  }

  const logs = (await reviewLogsDb.getAll()).sort((a, b) =>
    a.tid.localeCompare(b.tid),
  );
  const reviewStates = await reviewStateDb.getAll();
  const notes = await notesDb.getAll();
  const noteTypes = await noteTypesDb.getAll();
  const decks = await decksDb.getAll();
  const media = await mediaDb.getAll();
  const settings = await settingsDb.get();
  const deckSettings = await deckSettingsDb.getAll();

  const total =
    logs.length +
    reviewStates.length +
    notes.length +
    noteTypes.length +
    decks.length +
    media.length +
    (settings ? 1 : 0) +
    deckSettings.length;

  let queued = 0;
  const tickBy = (n: number) => {
    queued += n;
    onProgress?.({ total, queued, done: false });
  };

  await outboxDb.queuePutMany(
    `${NS}.reviewLog`,
    logs.map((l) => ({ recordKey: l.tid, record: l })),
  );
  tickBy(logs.length);

  await outboxDb.queuePutMany(
    `${NS}.reviewState`,
    reviewStates.map((rs) => ({ recordKey: rs.key, record: rs })),
  );
  tickBy(reviewStates.length);

  await outboxDb.queuePutMany(
    `${NS}.note`,
    notes.map((n) => ({ recordKey: n.tid, record: n })),
  );
  tickBy(notes.length);

  await outboxDb.queuePutMany(
    `${NS}.noteType`,
    noteTypes.map((nt) => ({ recordKey: nt.tid, record: nt })),
  );
  tickBy(noteTypes.length);

  await outboxDb.queuePutMany(
    `${NS}.deck`,
    decks.map((d) => ({ recordKey: d.tid, record: d })),
  );
  tickBy(decks.length);

  // Media records: queue metadata only — blob upload is a separate path
  // (see blobs.ts; final BlobRef gets attached during drain in Step 8).
  await outboxDb.queuePutMany(
    `${NS}.media`,
    media.map((m) => ({ recordKey: m.normalizedKey, record: mediaMetadata(m) })),
  );
  tickBy(media.length);

  if (settings) {
    await outboxDb.queuePut(`${NS}.settings`, "self", { ...settings, key: "self" });
    tickBy(1);
  }

  await outboxDb.queuePutMany(
    `${NS}.deckSettings`,
    deckSettings.map((ds) => ({ recordKey: ds.deckTid, record: ds })),
  );
  tickBy(deckSettings.length);

  await markPhase2Migrated();

  const finalProgress: MigrationProgress = { total, queued, done: true };
  onProgress?.(finalProgress);
  return finalProgress;
}

function mediaMetadata(m: MediaRecord): Record<string, unknown> {
  return {
    normalizedKey: m.normalizedKey,
    filename: m.filename,
    ...(m.mimeType !== undefined && { mimeType: m.mimeType }),
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}
