import type { NoteRecord } from "./schema";
import { put, get, getAll, del, delMany, getAllByIndex } from "./helpers";

const STORE = "notes";

export const notesDb = {
  put: (note: NoteRecord) => put<NoteRecord>(STORE, note),
  get: (tid: string) => get<NoteRecord>(STORE, tid),
  getAll: () => getAll<NoteRecord>(STORE),
  delete: (tid: string) => del(STORE, tid),
  deleteMany: (tids: string[]) => delMany(STORE, tids),

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
