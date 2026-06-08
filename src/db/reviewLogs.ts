import type { ReviewLogRecord } from "./schema";
import { put, get, getAll, del, getAllByIndex, putMany } from "./helpers";
import { outboxDb } from "./outbox";

const STORE = "reviewLogs";
const NSID = "cards.decay.flashcard.reviewLog";

export const reviewLogsDb = {
  async put(log: ReviewLogRecord): Promise<void> {
    await put<ReviewLogRecord>(STORE, log);
    await outboxDb.queuePut(NSID, log.tid, log);
  },
  async putMany(logs: ReviewLogRecord[]): Promise<void> {
    await putMany<ReviewLogRecord>(STORE, logs);
    await outboxDb.queuePutMany(
      NSID,
      logs.map((l) => ({ recordKey: l.tid, record: l })),
    );
  },
  get: (tid: string) => get<ReviewLogRecord>(STORE, tid),
  getAll: () => getAll<ReviewLogRecord>(STORE),
  async delete(tid: string): Promise<void> {
    await del(STORE, tid);
    await outboxDb.queueDelete(NSID, tid);
  },

  /** Get all logs for a note */
  getByNote: (noteUri: string) => getAllByIndex<ReviewLogRecord>(STORE, "noteUri", noteUri),

  /** Get logs for a specific date (for studySummary rebuild) */
  async getByDate(date: string): Promise<ReviewLogRecord[]> {
    const all = await getAll<ReviewLogRecord>(STORE);
    return all.filter((l) => l.resolvedDate === date);
  },

  /** Get today's logs for a deck (for daily limits rebuild) */
  async getByDeckAndDate(deckUri: string, date: string): Promise<ReviewLogRecord[]> {
    const all = await getAll<ReviewLogRecord>(STORE);
    return all.filter((l) => l.deck === deckUri && l.resolvedDate === date);
  },
};
