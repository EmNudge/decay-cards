import type { SettingsRecord, DeckSettingsRecord } from "./schema";
import { put, get, getAll, del } from "./helpers";

const SETTINGS = "settings";
const DECK_SETTINGS = "deckSettings";

/** Hardcoded application defaults */
export const APP_DEFAULTS = {
  defaultAlgorithm: "fsrs" as const,
  dayStartHour: 4,
  newCardsPerDay: 20,
  reviewsPerDay: 200,
  learningSteps: [1, 10],
  relearningSteps: [10],
  graduatingInterval: 1,
  easyInterval: 4,
  startingEase: 2.5,
  easyBonus: 1.3,
  hardMultiplier: 1.2,
  intervalModifier: 1.0,
  maximumInterval: 36500,
  lapseNewInterval: 0.0,
  leechThreshold: 8,
  buryNewSiblings: true,
  buryReviewSiblings: true,
  desiredRetention: 0.9,
  fsrsVersion: 5,
};

export const settingsDb = {
  async get(): Promise<SettingsRecord | undefined> {
    return get<SettingsRecord>(SETTINGS, "self");
  },

  async put(settings: SettingsRecord): Promise<void> {
    return put<SettingsRecord>(SETTINGS, { ...settings, key: "self" });
  },

  /** Get a resolved setting value with fallback to app default */
  async getResolved() {
    const s = await get<SettingsRecord>(SETTINGS, "self");
    return {
      defaultAlgorithm: s?.defaultAlgorithm ?? APP_DEFAULTS.defaultAlgorithm,
      dayStartHour: s?.dayStartHour ?? APP_DEFAULTS.dayStartHour,
      timezone: s?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      updatedAt: s?.updatedAt ?? new Date().toISOString(),
    };
  },
};

export const deckSettingsDb = {
  put: (ds: DeckSettingsRecord) => put<DeckSettingsRecord>(DECK_SETTINGS, ds),
  get: (deckTid: string) => get<DeckSettingsRecord>(DECK_SETTINGS, deckTid),
  getAll: () => getAll<DeckSettingsRecord>(DECK_SETTINGS),
  delete: (deckTid: string) => del(DECK_SETTINGS, deckTid),

  /** Get resolved settings for a deck, falling through to app defaults */
  async getResolved(deckTid: string) {
    const ds = await get<DeckSettingsRecord>(DECK_SETTINGS, deckTid);
    const global = await settingsDb.getResolved();
    return {
      algorithm: ds?.algorithm ?? global.defaultAlgorithm,
      newCardsPerDay: ds?.newCardsPerDay ?? APP_DEFAULTS.newCardsPerDay,
      reviewsPerDay: ds?.reviewsPerDay ?? APP_DEFAULTS.reviewsPerDay,
      learningSteps: ds?.learningSteps ?? APP_DEFAULTS.learningSteps,
      relearningSteps: ds?.relearningSteps ?? APP_DEFAULTS.relearningSteps,
      graduatingInterval: ds?.graduatingInterval ?? APP_DEFAULTS.graduatingInterval,
      easyInterval: ds?.easyInterval ?? APP_DEFAULTS.easyInterval,
      startingEase: ds?.startingEase ?? APP_DEFAULTS.startingEase,
      easyBonus: ds?.easyBonus ?? APP_DEFAULTS.easyBonus,
      hardMultiplier: ds?.hardMultiplier ?? APP_DEFAULTS.hardMultiplier,
      intervalModifier: ds?.intervalModifier ?? APP_DEFAULTS.intervalModifier,
      maximumInterval: ds?.maximumInterval ?? APP_DEFAULTS.maximumInterval,
      lapseNewInterval: ds?.lapseNewInterval ?? APP_DEFAULTS.lapseNewInterval,
      leechThreshold: ds?.leechThreshold ?? APP_DEFAULTS.leechThreshold,
      buryNewSiblings: ds?.buryNewSiblings ?? APP_DEFAULTS.buryNewSiblings,
      buryReviewSiblings: ds?.buryReviewSiblings ?? APP_DEFAULTS.buryReviewSiblings,
      desiredRetention: ds?.desiredRetention ?? APP_DEFAULTS.desiredRetention,
      fsrsWeights: ds?.fsrsWeights,
      fsrsVersion: ds?.fsrsVersion ?? APP_DEFAULTS.fsrsVersion,
      dayStartHour: global.dayStartHour,
      timezone: global.timezone,
    };
  },
};
