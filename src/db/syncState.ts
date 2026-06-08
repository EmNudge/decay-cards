import type { SyncStateEntry } from "./schema";
import { get, put, getAll } from "./helpers";

const STORE = "syncState";

/** Single repo-rev key shared across all collections (matches PDS commit). */
export const REPO_REV_KEY = "__repo_rev__";

export const syncStateDb = {
  async getRepoRev(): Promise<string | undefined> {
    const entry = await get<SyncStateEntry>(STORE, REPO_REV_KEY);
    return entry?.lastRev;
  },

  async setRepoRev(rev: string): Promise<void> {
    const entry: SyncStateEntry = {
      collection: REPO_REV_KEY,
      lastRev: rev,
      lastSyncedAt: new Date().toISOString(),
    };
    await put<SyncStateEntry>(STORE, entry);
  },

  async getForCollection(collection: string): Promise<SyncStateEntry | undefined> {
    return get<SyncStateEntry>(STORE, collection);
  },

  async setForCollection(
    collection: string,
    rev?: string,
  ): Promise<void> {
    const entry: SyncStateEntry = {
      collection,
      ...(rev !== undefined && { lastRev: rev }),
      lastSyncedAt: new Date().toISOString(),
    };
    await put<SyncStateEntry>(STORE, entry);
  },

  getAll: () => getAll<SyncStateEntry>(STORE),
};
