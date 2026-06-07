import type { NoteTypeRecord } from "./schema";
import { put, get, getAll, del, getAllByIndex } from "./helpers";

const STORE = "noteTypes";

export const noteTypesDb = {
  put: (noteType: NoteTypeRecord) => put<NoteTypeRecord>(STORE, noteType),
  get: (tid: string) => get<NoteTypeRecord>(STORE, tid),
  getAll: () => getAll<NoteTypeRecord>(STORE),
  delete: (tid: string) => del(STORE, tid),

  /** Find noteTypes forked from a given source URI */
  getByForkedFrom: (sourceUri: string) =>
    getAllByIndex<NoteTypeRecord>(STORE, "forkedFrom", sourceUri),
};
