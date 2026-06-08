/**
 * Deck soft-delete + cascade.
 *
 * Decks are never hard-deleted — instead, `deletedAt` is stamped on the
 * record and the cascade removes child records (notes, reviewState,
 * reviewLogs, cardFlags, deckSettings). The temporal guard preserves
 * notes that were created after the delete (per spec, those should be
 * moved to a default deck; for now we leave them in place with a
 * stale deck reference so the user can sort them out).
 *
 * The same cascade runs in two situations:
 *
 *  - Local UI delete: caller passes the deck record, we stamp + cascade.
 *  - Remote sync sees a newer `deletedAt`: scheduler invokes
 *    `runDeckCascades()` after read sync to bring the local state in line.
 *
 * Every child write goes through the typed db modules so the outbox
 * captures the deletions and propagates them on the next drain.
 */
import type { DeckRecord } from "../db/schema";
import { decksDb } from "../db/decks";
import { notesDb } from "../db/notes";
import { reviewStateDb } from "../db/reviewState";
import { reviewLogsDb } from "../db/reviewLogs";
import { cardFlagsDb } from "../db/cardFlags";
import { deckSettingsDb } from "../db/settings";

const NS = "cards.decay.flashcard";

/**
 * Soft-delete a deck and cascade children. Idempotent: calling on an
 * already-deleted deck just runs the cascade pass again.
 */
export async function softDeleteDeck(
  deck: DeckRecord,
  deletedAt: string = new Date().toISOString(),
): Promise<void> {
  const effectiveDeletedAt = deck.deletedAt ?? deletedAt;
  const updated: DeckRecord = {
    ...deck,
    deletedAt: effectiveDeletedAt,
    updatedAt: deletedAt,
  };
  await decksDb.put(updated);

  // Filtered decks don't own notes (they reference notes from other decks).
  if (updated.isFiltered) {
    await deckSettingsDb.delete(updated.tid);
    return;
  }

  await cascadeChildrenFor(updated);
  await deckSettingsDb.delete(updated.tid);
}

/**
 * Find every soft-deleted deck and cascade-delete any orphan children.
 * Safe to invoke after every read sync. No-op when nothing to clean up.
 */
export async function runDeckCascades(): Promise<void> {
  const all = await decksDb.getAll();
  for (const deck of all) {
    if (!deck.deletedAt) continue;
    if (deck.isFiltered) continue;
    await cascadeChildrenFor(deck);
  }
}

async function cascadeChildrenFor(deck: DeckRecord): Promise<void> {
  const deletedAtMs = Date.parse(deck.deletedAt!);
  if (!Number.isFinite(deletedAtMs)) return;

  const allNotes = await notesDb.getAll();
  const ourNotes = allNotes.filter((n) => matchesDeck(n.deck, deck.tid));

  // Temporal guard: only cascade where note.createdAt < deck.deletedAt.
  // Post-delete notes survive (and currently keep their stale deck pointer;
  // TODO: auto-move to a default deck once one exists).
  const toCascade = ourNotes.filter((n) => Date.parse(n.createdAt) < deletedAtMs);
  if (toCascade.length === 0) return;

  const noteTids = toCascade.map((n) => n.tid);

  // Collect every reviewState / reviewLog / cardFlag tied to these notes.
  const [allStates, allLogs, allFlags] = await Promise.all([
    reviewStateDb.getAll(),
    reviewLogsDb.getAll(),
    cardFlagsDb.getAll(),
  ]);

  const noteTidSet = new Set(noteTids);
  const stateKeys = allStates
    .filter((rs) => noteTidSet.has(extractTid(rs.note)))
    .map((rs) => rs.key);
  const logTids = allLogs.filter((l) => noteTidSet.has(extractTid(l.note))).map((l) => l.tid);
  const flagKeys = allFlags.filter((f) => noteTidSet.has(extractTid(f.note))).map((f) => f.key);

  if (stateKeys.length > 0) await reviewStateDb.deleteMany(stateKeys);
  for (const tid of logTids) await reviewLogsDb.delete(tid);
  if (flagKeys.length > 0) await cardFlagsDb.deleteMany(flagKeys);
  await notesDb.deleteMany(noteTids);
}

function matchesDeck(deckUri: string, deckTid: string): boolean {
  return deckUri.endsWith(`/${NS}.deck/${deckTid}`);
}

function extractTid(uri: string): string {
  const i = uri.lastIndexOf("/");
  return i >= 0 ? uri.slice(i + 1) : uri;
}
