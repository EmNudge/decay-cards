/**
 * Pure merger functions for non-LWW collections (Step 6).
 *
 * Kept separate from sync.ts so they're trivially testable without IDB or
 * an Agent. Each function returns a fully-formed merged record — the
 * caller is responsible for persisting it.
 *
 * Conventions:
 * - `local` / `remote` are the raw record bodies (matching the IDB schema
 *   for that collection).
 * - When local is undefined, callers should just use `remote` directly;
 *   these mergers assume both sides exist.
 * - All timestamps are ISO-8601 strings; we compare via `Date.parse`.
 */
import type {
  NoteTypeRecord,
  NoteTypeField,
  NoteTypeTemplate,
  ReviewStateRecord,
  ReviewLogRecord,
  StudySummaryRecord,
} from "../db/schema";

// ---------------------------------------------------------------------------
// noteType — per-element union merge
// ---------------------------------------------------------------------------

/**
 * Merge two noteType records:
 * - Fields and templates are unioned by stable `id`. On id collision, the
 *   element from whichever record has the newer record-level `updatedAt`
 *   wins. (The schema doesn't carry per-element timestamps; the record's
 *   own `updatedAt` is the closest signal we have.)
 * - Scalar fields (`name`, `css`, `isCloze`) use record-level LWW.
 * - `createdAt` collapses to `min(local, remote)`.
 * - `tid` is invariant (caller passes consistent records).
 *
 * Deletion of a field/template does not propagate across devices: as long
 * as either side still has the element, it survives.
 */
export function mergeNoteType(
  local: NoteTypeRecord,
  remote: NoteTypeRecord,
): NoteTypeRecord {
  const remoteNewer = isNewer(remote.updatedAt, local.updatedAt);
  const dominant = remoteNewer ? remote : local;

  const fields = unionById(local.fields, remote.fields, remoteNewer);
  const templates = unionById(local.templates, remote.templates, remoteNewer);

  const merged: NoteTypeRecord = {
    tid: local.tid,
    name: dominant.name,
    fields,
    templates,
    createdAt: minIso(local.createdAt, remote.createdAt),
    updatedAt: maxIso(local.updatedAt, remote.updatedAt),
  };
  if (dominant.css !== undefined) merged.css = dominant.css;
  if (dominant.isCloze !== undefined) merged.isCloze = dominant.isCloze;
  if (dominant.forkedFrom !== undefined) merged.forkedFrom = dominant.forkedFrom;
  return merged;
}

function unionById<T extends NoteTypeField | NoteTypeTemplate>(
  local: T[],
  remote: T[],
  remoteWinsOnConflict: boolean,
): T[] {
  const merged = new Map<string, T>();
  for (const item of local) merged.set(item.id, item);
  for (const item of remote) {
    if (!merged.has(item.id) || remoteWinsOnConflict) merged.set(item.id, item);
  }
  return Array.from(merged.values());
}

// ---------------------------------------------------------------------------
// reviewState — after-state reconciliation
// ---------------------------------------------------------------------------

/**
 * Reconcile a reviewState record from the union of reviewLogs for that
 * (note, templateId). Scheduling fields come from the latest log's
 * after-state; `suspended`/`buried` flags merge per-flag using their own
 * timestamps; `createdAt` collapses to `min(local, remote)`.
 *
 * If there are no logs and local/remote both exist, we fall back to LWW
 * for the whole record (treating it as a still-new card).
 */
export function mergeReviewState(
  local: ReviewStateRecord,
  remote: ReviewStateRecord,
  logsForKey: ReviewLogRecord[],
): ReviewStateRecord {
  // After-state from the latest log; if no logs, take whichever side is newer.
  const latestLog = pickLatestLog(logsForKey);

  const base: ReviewStateRecord = latestLog
    ? applyAfterState(local, remote, latestLog)
    : pickByUpdatedAt(local, remote);

  // Per-flag LWW for non-scheduling flags.
  const suspendedMerge = pickFlagLww(
    local.suspended,
    local.suspendedChangedAt,
    remote.suspended,
    remote.suspendedChangedAt,
  );
  const buriedMerge = pickFlagLww(
    local.buried,
    local.buriedChangedAt,
    remote.buried,
    remote.buriedChangedAt,
  );

  const merged: ReviewStateRecord = {
    ...base,
    key: local.key,
    note: local.note,
    templateId: local.templateId,
    createdAt: minIso(local.createdAt, remote.createdAt),
    updatedAt: maxIso(local.updatedAt, remote.updatedAt),
  };
  assignFlag(merged, "suspended", "suspendedChangedAt", suspendedMerge);
  assignFlag(merged, "buried", "buriedChangedAt", buriedMerge);
  return merged;
}

function assignFlag(
  target: ReviewStateRecord,
  flagKey: "suspended" | "buried",
  tsKey: "suspendedChangedAt" | "buriedChangedAt",
  merge: { flag?: boolean; changedAt?: string },
): void {
  if (merge.flag !== undefined) target[flagKey] = merge.flag;
  else delete target[flagKey];
  if (merge.changedAt !== undefined) target[tsKey] = merge.changedAt;
  else delete target[tsKey];
}

function applyAfterState(
  local: ReviewStateRecord,
  remote: ReviewStateRecord,
  log: ReviewLogRecord,
): ReviewStateRecord {
  // Start from whichever record is newer so non-after-state fields survive.
  const base = pickByUpdatedAt(local, remote);
  const out: ReviewStateRecord = { ...base };
  if (log.phaseAfter !== undefined) out.phase = log.phaseAfter;
  if (log.repsAfter !== undefined) out.reps = log.repsAfter;
  if (log.lapsesAfter !== undefined) out.lapses = log.lapsesAfter;
  if (log.learningStepIndexAfter !== undefined) {
    out.learningStepIndex = log.learningStepIndexAfter;
  }
  if (log.easeFactorAfter !== undefined) out.easeFactor = log.easeFactorAfter;
  if (log.stabilityAfter !== undefined) out.stability = log.stabilityAfter;
  if (log.difficultyAfter !== undefined) out.difficulty = log.difficultyAfter;
  if (log.intervalAfterDays !== undefined) out.intervalDays = log.intervalAfterDays;
  if (log.intervalAfterMinutes !== undefined) {
    out.intervalMinutes = log.intervalAfterMinutes;
  }
  out.lastReviewed = log.reviewedAt;
  return out;
}

function pickLatestLog(logs: ReviewLogRecord[]): ReviewLogRecord | undefined {
  if (logs.length === 0) return undefined;
  let latest = logs[0]!;
  for (let i = 1; i < logs.length; i++) {
    const candidate = logs[i]!;
    if (Date.parse(candidate.reviewedAt) > Date.parse(latest.reviewedAt)) {
      latest = candidate;
    }
  }
  return latest;
}

function pickByUpdatedAt<T extends { updatedAt: string }>(local: T, remote: T): T {
  return isNewer(remote.updatedAt, local.updatedAt) ? remote : local;
}

function pickFlagLww(
  localFlag: boolean | undefined,
  localChangedAt: string | undefined,
  remoteFlag: boolean | undefined,
  remoteChangedAt: string | undefined,
): { flag?: boolean; changedAt?: string } {
  if (localChangedAt === undefined && remoteChangedAt === undefined) {
    return localFlag !== undefined ? { flag: localFlag } : {};
  }
  if (localChangedAt === undefined) {
    return {
      ...(remoteFlag !== undefined && { flag: remoteFlag }),
      changedAt: remoteChangedAt!,
    };
  }
  if (remoteChangedAt === undefined) {
    return {
      ...(localFlag !== undefined && { flag: localFlag }),
      changedAt: localChangedAt,
    };
  }
  const remoteWins = Date.parse(remoteChangedAt) >= Date.parse(localChangedAt);
  const flag = remoteWins ? remoteFlag : localFlag;
  const changedAt = remoteWins ? remoteChangedAt : localChangedAt;
  return {
    ...(flag !== undefined && { flag }),
    changedAt,
  };
}

// ---------------------------------------------------------------------------
// studySummary — rebuild from logs
// ---------------------------------------------------------------------------

/**
 * Rebuild the studySummary for `date` from the union of reviewLogs for
 * that date. Used both on conflict (local + remote disagree) and on
 * remote-only inserts when fresh log data is available locally. Returns
 * the new record body to write — caller passes the existing record's
 * `updatedAt` to bump (or uses the current ISO time).
 */
export function rebuildStudySummary(
  date: string,
  logs: ReviewLogRecord[],
  updatedAt: string,
): StudySummaryRecord {
  let reviewCount = 0;
  let newCount = 0;
  let timeSpentMs = 0;
  let againCount = 0;
  let hardCount = 0;
  let goodCount = 0;
  let easyCount = 0;
  for (const log of logs) {
    reviewCount++;
    if (log.phase === "new") newCount++;
    if (log.timeTaken !== undefined) timeSpentMs += log.timeTaken;
    switch (log.answer) {
      case "again":
        againCount++;
        break;
      case "hard":
        hardCount++;
        break;
      case "good":
        goodCount++;
        break;
      case "easy":
        easyCount++;
        break;
    }
  }
  return {
    date,
    reviewCount,
    newCount,
    timeSpentMs,
    againCount,
    hardCount,
    goodCount,
    easyCount,
    updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isNewer(a: string, b: string): boolean {
  return Date.parse(a) > Date.parse(b);
}

function minIso(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function maxIso(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}
