import type { DeckRecord } from "./schema";
import { put, get, getAll, del, delMany } from "./helpers";
import { outboxDb } from "./outbox";

const STORE = "decks";
const NSID = "cards.decay.flashcard.deck";

export const decksDb = {
  async put(deck: DeckRecord): Promise<void> {
    await put<DeckRecord>(STORE, deck);
    await outboxDb.queuePut(NSID, deck.tid, deck);
  },
  get: (tid: string) => get<DeckRecord>(STORE, tid),
  getAll: () => getAll<DeckRecord>(STORE),
  async delete(tid: string): Promise<void> {
    await del(STORE, tid);
    await outboxDb.queueDelete(NSID, tid);
  },
  async deleteMany(tids: string[]): Promise<void> {
    await delMany(STORE, tids);
    await outboxDb.queueDeleteMany(NSID, tids);
  },

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
