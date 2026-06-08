import type { ReviewStateRecord } from "./schema";
import { put, get, getAll, del, delMany, getAllByIndex, putMany } from "./helpers";
import { outboxDb } from "./outbox";

const STORE = "reviewState";
const NSID = "cards.decay.flashcard.reviewState";

export function reviewStateKey(noteTid: string, templateId: string): string {
  return `${noteTid}_${templateId}`;
}

export const reviewStateDb = {
  async put(rs: ReviewStateRecord): Promise<void> {
    await put<ReviewStateRecord>(STORE, rs);
    await outboxDb.queuePut(NSID, rs.key, rs);
  },
  async putMany(records: ReviewStateRecord[]): Promise<void> {
    await putMany<ReviewStateRecord>(STORE, records);
    await outboxDb.queuePutMany(
      NSID,
      records.map((r) => ({ recordKey: r.key, record: r })),
    );
  },
  get: (key: string) => get<ReviewStateRecord>(STORE, key),
  getAll: () => getAll<ReviewStateRecord>(STORE),
  async delete(key: string): Promise<void> {
    await del(STORE, key);
    await outboxDb.queueDelete(NSID, key);
  },
  async deleteMany(keys: string[]): Promise<void> {
    await delMany(STORE, keys);
    await outboxDb.queueDeleteMany(NSID, keys);
  },

  /** Get by composite key */
  getByNoteAndTemplate: (noteTid: string, templateId: string) =>
    get<ReviewStateRecord>(STORE, reviewStateKey(noteTid, templateId)),

  /** Get all review states for a note */
  getByNote: (noteUri: string) => getAllByIndex<ReviewStateRecord>(STORE, "noteUri", noteUri),

  /** Get all cards in a given phase */
  getByPhase: (phase: ReviewStateRecord["phase"]) =>
    getAllByIndex<ReviewStateRecord>(STORE, "phase", phase),
};
