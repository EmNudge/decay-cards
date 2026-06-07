import type { ReviewStateRecord } from "./schema";
import { put, get, getAll, del, delMany, getAllByIndex, putMany } from "./helpers";

const STORE = "reviewState";

export function reviewStateKey(noteTid: string, templateId: string): string {
  return `${noteTid}_${templateId}`;
}

export const reviewStateDb = {
  put: (rs: ReviewStateRecord) => put<ReviewStateRecord>(STORE, rs),
  putMany: (records: ReviewStateRecord[]) => putMany<ReviewStateRecord>(STORE, records),
  get: (key: string) => get<ReviewStateRecord>(STORE, key),
  getAll: () => getAll<ReviewStateRecord>(STORE),
  delete: (key: string) => del(STORE, key),
  deleteMany: (keys: string[]) => delMany(STORE, keys),

  /** Get by composite key */
  getByNoteAndTemplate: (noteTid: string, templateId: string) =>
    get<ReviewStateRecord>(STORE, reviewStateKey(noteTid, templateId)),

  /** Get all review states for a note */
  getByNote: (noteUri: string) => getAllByIndex<ReviewStateRecord>(STORE, "noteUri", noteUri),

  /** Get all cards in a given phase */
  getByPhase: (phase: ReviewStateRecord["phase"]) =>
    getAllByIndex<ReviewStateRecord>(STORE, "phase", phase),
};
