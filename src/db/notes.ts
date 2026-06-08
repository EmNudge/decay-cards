import type { NoteRecord } from "./schema";
import { put, get, getAll, del, delMany, getAllByIndex } from "./helpers";
import { outboxDb } from "./outbox";

const STORE = "notes";
const NSID = "cards.decay.flashcard.note";

export const notesDb = {
  async put(note: NoteRecord): Promise<void> {
    await put<NoteRecord>(STORE, note);
    await outboxDb.queuePut(NSID, note.tid, note);
  },
  get: (tid: string) => get<NoteRecord>(STORE, tid),
  getAll: () => getAll<NoteRecord>(STORE),
  async delete(tid: string): Promise<void> {
    await del(STORE, tid);
    await outboxDb.queueDelete(NSID, tid);
  },
  async deleteMany(tids: string[]): Promise<void> {
    await delMany(STORE, tids);
    await outboxDb.queueDeleteMany(NSID, tids);
  },

  /** Get all notes in a deck */
  getByDeck: (deckUri: string) => getAllByIndex<NoteRecord>(STORE, "deckUri", deckUri),

  /** Get all notes using a noteType */
  getByNoteType: (noteTypeUri: string) =>
    getAllByIndex<NoteRecord>(STORE, "noteTypeUri", noteTypeUri),

  /** Find note by Anki note ID (for import dedup) */
  async getByAnkiNoteId(ankiNoteId: number): Promise<NoteRecord | undefined> {
    const results = await getAllByIndex<NoteRecord>(STORE, "ankiNoteId", ankiNoteId);
    return results[0];
  },
};
