import type { ReviewLogRecord } from "./schema";
import { put, get, getAll, del, getAllByIndex, putMany } from "./helpers";

const STORE = "reviewLogs";

export const reviewLogsDb = {
  put: (log: ReviewLogRecord) => put<ReviewLogRecord>(STORE, log),
  putMany: (logs: ReviewLogRecord[]) => putMany<ReviewLogRecord>(STORE, logs),
  get: (tid: string) => get<ReviewLogRecord>(STORE, tid),
  getAll: () => getAll<ReviewLogRecord>(STORE),
  delete: (tid: string) => del(STORE, tid),

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
