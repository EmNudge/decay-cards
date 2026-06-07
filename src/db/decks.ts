import type { DeckRecord } from "./schema";
import { put, get, getAll, del, delMany } from "./helpers";

const STORE = "decks";

export const decksDb = {
  put: (deck: DeckRecord) => put<DeckRecord>(STORE, deck),
  get: (tid: string) => get<DeckRecord>(STORE, tid),
  getAll: () => getAll<DeckRecord>(STORE),
  delete: (tid: string) => del(STORE, tid),
  deleteMany: (tids: string[]) => delMany(STORE, tids),

  /** Get all non-deleted decks */
  async getAllActive(): Promise<DeckRecord[]> {
    const all = await getAll<DeckRecord>(STORE);
    return all.filter((d) => !d.deletedAt);
  },

  /** Get child decks of a parent */
  async getChildren(parentUri: string): Promise<DeckRecord[]> {
    const all = await getAll<DeckRecord>(STORE);
    return all.filter((d) => d.parentDeck === parentUri && !d.deletedAt);
  },
};
