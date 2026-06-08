import type { OutboxEntry } from "./schema";
import { put, getAll, del, clear, getAllByIndex } from "./helpers";
import { getDb } from "./schema";

const OUTBOX = "outbox";

type OutboxListener = () => void;
const listeners = new Set<OutboxListener>();

/** Subscribe to outbox writes (puts, deletes, bulk variants). Returns unsub. */
export function onOutboxChange(fn: OutboxListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notifyOutboxChange(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch (e) {
      console.error("[outbox] listener threw:", e);
    }
  }
}

export const outboxDb = {
  /** Queue a put operation */
  async queuePut(collection: string, recordKey: string, record: unknown, groupId?: string) {
    const entry: OutboxEntry = {
      collection,
      recordKey,
      op: "put",
      record,
      createdAt: new Date().toISOString(),
      ...(groupId !== undefined && { groupId }),
    };
    await put<OutboxEntry>(OUTBOX, entry);
    notifyOutboxChange();
  },

  /** Queue multiple put operations in a single transaction. */
  async queuePutMany(
    collection: string,
    records: Array<{ recordKey: string; record: unknown }>,
    groupId?: string,
  ): Promise<void> {
    if (records.length === 0) return;
    const now = new Date().toISOString();
    const db = await getDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(OUTBOX, "readwrite");
      const store = tx.objectStore(OUTBOX);
      for (const { recordKey, record } of records) {
        const entry: OutboxEntry = {
          collection,
          recordKey,
          op: "put",
          record,
          createdAt: now,
          ...(groupId !== undefined && { groupId }),
        };
        store.put(entry);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    notifyOutboxChange();
  },

  /** Queue a delete operation */
  async queueDelete(collection: string, recordKey: string, groupId?: string) {
    const entry: OutboxEntry = {
      collection,
      recordKey,
      op: "delete",
      createdAt: new Date().toISOString(),
      ...(groupId !== undefined && { groupId }),
    };
    await put<OutboxEntry>(OUTBOX, entry);
    notifyOutboxChange();
  },

  /** Queue multiple delete operations in a single transaction. */
  async queueDeleteMany(collection: string, recordKeys: string[], groupId?: string): Promise<void> {
    if (recordKeys.length === 0) return;
    const now = new Date().toISOString();
    const db = await getDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(OUTBOX, "readwrite");
      const store = tx.objectStore(OUTBOX);
      for (const recordKey of recordKeys) {
        const entry: OutboxEntry = {
          collection,
          recordKey,
          op: "delete",
          createdAt: now,
          ...(groupId !== undefined && { groupId }),
        };
        store.put(entry);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    notifyOutboxChange();
  },

  /** Get all pending entries */
  getAll: () => getAll<OutboxEntry>(OUTBOX),

  /** Get entries by collection */
  getByCollection: (collection: string) =>
    getAllByIndex<OutboxEntry>(OUTBOX, "collection", collection),

  /** Remove a completed entry */
  remove: (id: number) => del(OUTBOX, id),

  /** Clear entire outbox */
  clear: () => clear(OUTBOX),

  /**
   * Coalesce the outbox before draining.
   * - Multiple puts for same key → keep latest
   * - Put + delete for same key (put unsent) → remove both
   * - Delete + put for same key → keep put
   * - FK-aware: when a put is cancelled, cancel dependent puts
   */
  async coalesce(): Promise<OutboxEntry[]> {
    const all = await getAll<OutboxEntry>(OUTBOX);
    if (all.length === 0) return [];

    // Group by collection+recordKey
    const byKey = new Map<string, OutboxEntry[]>();
    for (const entry of all) {
      const k = `${entry.collection}:${entry.recordKey}`;
      const group = byKey.get(k);
      if (group) {
        group.push(entry);
      } else {
        byKey.set(k, [entry]);
      }
    }

    const keep = new Map<number, OutboxEntry>();
    const cancelledUris = new Set<string>();

    for (const [, entries] of byKey) {
      if (entries.length === 1) {
        const e = entries[0]!;
        keep.set(e.id!, e);
        continue;
      }

      // Multiple entries for same key — coalesce
      const last = entries[entries.length - 1]!;
      const first = entries[0]!;

      if (first.op === "put" && last.op === "delete") {
        // Put then delete → no-op (both cancelled)
        // Track the cancelled URI for FK cleanup
        if (first.record && typeof first.record === "object" && "tid" in first.record) {
          cancelledUris.add(first.recordKey);
        }
        continue;
      }

      // All other cases: keep only the last entry
      keep.set(last.id!, last);
    }

    // FK-aware: remove puts that reference cancelled records
    if (cancelledUris.size > 0) {
      const FK_FIELDS = ["deck", "noteType", "note"] as const;
      for (const [id, entry] of keep) {
        if (entry.op !== "put" || !entry.record || typeof entry.record !== "object") continue;
        const rec = entry.record as Record<string, unknown>;
        for (const fk of FK_FIELDS) {
          const val = rec[fk];
          if (typeof val === "string" && cancelledUris.has(val)) {
            keep.delete(id);
            break;
          }
        }
      }
    }

    // Rewrite the outbox
    const db = await getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(OUTBOX, "readwrite");
      const store = tx.objectStore(OUTBOX);
      store.clear();
      const result: OutboxEntry[] = [];
      for (const entry of keep.values()) {
        store.put(entry);
        result.push(entry);
      }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
    });
  },
};
