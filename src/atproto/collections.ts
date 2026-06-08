/**
 * Collection registry — maps every PDS-synced collection to its IDB store
 * and merge strategy. Apply order matters: parents come before children
 * (noteTypes → decks → notes → ...) so foreign-key references resolve
 * during a full traversal.
 */

const NS = "cards.decay.flashcard";

export type MergeStrategy =
  | "lww" // last-writer-wins by record.updatedAt
  | "append-only" // dedup by primary key, no comparison (reviewLogs)
  | "noteType-union" // per-element union merge (Step 6)
  | "reviewState" // after-state reconciliation from reviewLogs (Step 6)
  | "studySummary" // rebuilt from merged reviewLogs (Step 6)
  | "immutable"; // never updated post-create (forkDeck)

export interface CollectionDef {
  /** NSID — used as PDS collection name. */
  nsid: string;
  /** IDB store name. */
  store: string;
  /** The IDB store's primary-key field; matches PDS rkey. */
  keyField: string;
  /** How conflicts merge during the read path. */
  merge: MergeStrategy;
}

/**
 * Apply order: parents → children. The read path iterates this list in
 * order; the write path uses it to validate that we know how to encode
 * each collection.
 *
 * `reviewLogs` runs BEFORE `reviewState` and `studySummary` because both
 * derive their merged result from the union of locally + remotely seen
 * logs (after-state reconciliation / per-date rebuild).
 */
export const COLLECTIONS: readonly CollectionDef[] = [
  { nsid: `${NS}.noteType`, store: "noteTypes", keyField: "tid", merge: "noteType-union" },
  { nsid: `${NS}.deck`, store: "decks", keyField: "tid", merge: "lww" },
  { nsid: `${NS}.note`, store: "notes", keyField: "tid", merge: "lww" },
  { nsid: `${NS}.reviewLog`, store: "reviewLogs", keyField: "tid", merge: "append-only" },
  { nsid: `${NS}.reviewState`, store: "reviewState", keyField: "key", merge: "reviewState" },
  { nsid: `${NS}.cardFlag`, store: "cardFlags", keyField: "key", merge: "lww" },
  { nsid: `${NS}.media`, store: "media", keyField: "normalizedKey", merge: "lww" },
  { nsid: `${NS}.settings`, store: "settings", keyField: "key", merge: "lww" },
  { nsid: `${NS}.deckSettings`, store: "deckSettings", keyField: "deckTid", merge: "lww" },
  { nsid: `${NS}.studySummary`, store: "studySummary", keyField: "date", merge: "studySummary" },
  { nsid: `${NS}.shareDeck`, store: "shareDeck", keyField: "key", merge: "lww" },
  { nsid: `${NS}.forkDeck`, store: "forkDeck", keyField: "key", merge: "immutable" },
] as const;

export function collectionByNsid(nsid: string): CollectionDef | undefined {
  return COLLECTIONS.find((c) => c.nsid === nsid);
}
