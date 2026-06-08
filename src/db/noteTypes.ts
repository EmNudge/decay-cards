import type { NoteTypeRecord } from "./schema";
import { put, get, getAll, del, getAllByIndex } from "./helpers";
import { outboxDb } from "./outbox";

const STORE = "noteTypes";
const NSID = "cards.decay.flashcard.noteType";

export const noteTypesDb = {
  async put(noteType: NoteTypeRecord): Promise<void> {
    await put<NoteTypeRecord>(STORE, noteType);
    await outboxDb.queuePut(NSID, noteType.tid, noteType);
  },
  get: (tid: string) => get<NoteTypeRecord>(STORE, tid),
  getAll: () => getAll<NoteTypeRecord>(STORE),
  async delete(tid: string): Promise<void> {
    await del(STORE, tid);
    await outboxDb.queueDelete(NSID, tid);
  },

  /** Find noteTypes forked from a given source URI */
  getByForkedFrom: (sourceUri: string) =>
    getAllByIndex<NoteTypeRecord>(STORE, "forkedFrom", sourceUri),
};
