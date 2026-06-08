import type { DeadLetterEntry, OutboxOp } from "./schema";
import { put, getAll, del, clear } from "./helpers";

const STORE = "deadLetters";

export const deadLettersDb = {
  /** Move a failed outbox op into the dead-letter store. */
  async put(args: {
    collection: string;
    recordKey: string;
    op: OutboxOp;
    record?: unknown;
    error: string;
  }): Promise<void> {
    const entry: DeadLetterEntry = {
      collection: args.collection,
      recordKey: args.recordKey,
      op: args.op,
      ...(args.record !== undefined && { record: args.record }),
      error: args.error,
      createdAt: new Date().toISOString(),
    };
    await put<DeadLetterEntry>(STORE, entry);
  },

  getAll: () => getAll<DeadLetterEntry>(STORE),
  remove: (id: number) => del(STORE, id),
  clear: () => clear(STORE),
};
