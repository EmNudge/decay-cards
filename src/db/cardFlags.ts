import type { CardFlagRecord } from "./schema";
import { put, get, getAll, del, delMany } from "./helpers";
import { outboxDb } from "./outbox";

const STORE = "cardFlags";
const NSID = "cards.decay.flashcard.cardFlag";

export const cardFlagsDb = {
  async put(flag: CardFlagRecord): Promise<void> {
    await put<CardFlagRecord>(STORE, flag);
    await outboxDb.queuePut(NSID, flag.key, flag);
  },
  get: (key: string) => get<CardFlagRecord>(STORE, key),
  getAll: () => getAll<CardFlagRecord>(STORE),
  async delete(key: string): Promise<void> {
    await del(STORE, key);
    await outboxDb.queueDelete(NSID, key);
  },
  async deleteMany(keys: string[]): Promise<void> {
    await delMany(STORE, keys);
    await outboxDb.queueDeleteMany(NSID, keys);
  },
};
