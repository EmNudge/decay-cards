/**
 * Sync engine — write path.
 *
 * `drainOutbox(agent)` coalesces pending entries, splits them into
 * applyWrites batches, and pushes them to the PDS. Errors split into:
 *  - 429: limiter pauses; we yield (caller schedules retry).
 *  - 4xx (atomic batch failure): fall back to per-op puts/deletes via
 *    RecordsClient — the typed wrappers already handle 404 idempotency.
 *    Ops that still fail get dead-lettered.
 *  - 5xx / network: apply exponential backoff state, return so caller can
 *    retry after the delay elapses.
 *
 * The drain is single-flight per call; concurrent calls are de-duped via
 * `inFlight`.
 */
import type { Agent } from "@atproto/api";
import { XRPCError } from "@atproto/api";
import { outboxDb } from "../db/outbox";
import { deadLettersDb } from "../db/deadLetters";
import { syncStateDb } from "../db/syncState";
import { mediaDb } from "../db/media";
import { getDb } from "../db/schema";
import type {
  OutboxEntry,
  NoteTypeRecord,
  ReviewLogRecord,
  ReviewStateRecord,
} from "../db/schema";
import { RecordsClient, batchWrites, type WriteOp, type ListedRecord } from "./records";
import { COLLECTIONS, type CollectionDef } from "./collections";
import {
  mergeNoteType,
  mergeReviewState,
  rebuildStudySummary,
} from "./merge";
import { uploadBlob } from "./blobs";

const MEDIA_NSID = "cards.decay.flashcard.media";

const MIN_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60 * 1000; // 5 min

export type DrainOutcome =
  | { status: "idle" } // nothing to do
  | { status: "done"; ops: number }
  | { status: "backoff"; until: number; reason: "5xx" | "network" | "429" }
  | { status: "deadLettered"; ops: number; deadLettered: number };

interface DrainState {
  /** Earliest timestamp at which a retry is allowed. */
  retryAfter: number;
  /** Current exponential backoff window. */
  currentBackoff: number;
}

const state: DrainState = {
  retryAfter: 0,
  currentBackoff: MIN_BACKOFF_MS,
};

let inFlight: Promise<DrainOutcome> | null = null;
let clockNow: () => number = () => Date.now();

/** Override the clock used for backoff decisions. Tests only. */
export function __setDrainClock(now: () => number): void {
  clockNow = now;
}

/** Restore the real clock. */
export function __resetDrainClock(): void {
  clockNow = () => Date.now();
}

/** Fully reset the drain state. Exposed for tests and post-success recovery. */
export function resetDrainBackoff(): void {
  state.retryAfter = 0;
  state.currentBackoff = MIN_BACKOFF_MS;
  inFlight = null;
}

/**
 * Run a single drain pass. Idempotent and single-flight; concurrent callers
 * receive the same in-flight promise.
 */
export function drainOutbox(agent: Agent): Promise<DrainOutcome> {
  if (inFlight) return inFlight;
  inFlight = doDrain(agent).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doDrain(agent: Agent): Promise<DrainOutcome> {
  const now = clockNow();
  if (state.retryAfter > now) {
    return { status: "backoff", until: state.retryAfter, reason: "5xx" };
  }

  const coalesced = await outboxDb.coalesce();
  if (coalesced.length === 0) return { status: "idle" };

  const client = new RecordsClient(agent);

  // Media puts can't go through applyWrites — they need a blob upload
  // first. Pull them out and ship one-by-one; everything else (including
  // media deletes) goes through the batched path.
  const mediaPuts: OutboxEntry[] = [];
  const batchable: OutboxEntry[] = [];
  for (const entry of coalesced) {
    if (entry.collection === MEDIA_NSID && entry.op === "put") {
      mediaPuts.push(entry);
    } else {
      batchable.push(entry);
    }
  }

  let opsSent = 0;
  let deadLettered = 0;

  for (const entry of mediaPuts) {
    const outcome = await shipMediaPut(agent, client, entry);
    if (outcome === "backoff") {
      return {
        status: "backoff",
        until: state.retryAfter,
        reason: "5xx",
      };
    }
    if (outcome === "deadLettered") deadLettered++;
    else if (outcome === "ok" || outcome === "stale") opsSent++;
  }

  const writes: WriteOp[] = batchable.map(toWriteOp);
  const batches = batchWrites(writes);
  let batchedOpsSent = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    const batchEntries = batchable.slice(
      batchedOpsSent,
      batchedOpsSent + batch.length,
    );

    try {
      await client.applyWrites(batch);
      await removeEntries(batchEntries);
      batchedOpsSent += batch.length;
      opsSent += batch.length;
      onSuccess();
    } catch (err) {
      const decision = classify(err);
      if (decision === "backoff") {
        applyBackoff();
        return {
          status: "backoff",
          until: state.retryAfter,
          reason: isXRPCStatus(err, 429) ? "429" : "5xx",
        };
      }
      // 4xx atomic failure: per-op fallback.
      const fallback = await perOpFallback(client, batchEntries);
      batchedOpsSent += batch.length;
      opsSent += fallback.ok;
      deadLettered += fallback.deadLettered;
    }
  }

  if (deadLettered > 0) {
    return { status: "deadLettered", ops: opsSent, deadLettered };
  }
  return { status: "done", ops: opsSent };
}

type MediaShipOutcome = "ok" | "stale" | "backoff" | "deadLettered";

/**
 * Push a single media put: upload the local Blob, attach the returned
 * BlobRef to the record body, then putRecord. Stale entries (where the
 * local Blob has since been deleted) are dropped from the outbox without
 * surfacing as errors.
 */
async function shipMediaPut(
  agent: Agent,
  client: RecordsClient,
  entry: OutboxEntry,
): Promise<MediaShipOutcome> {
  const local = await mediaDb.get(entry.recordKey);
  if (!local) {
    // Local source is gone — likely the user deleted the media before we
    // got around to syncing. Treat as a stale no-op.
    if (entry.id !== undefined) await outboxDb.remove(entry.id);
    return "stale";
  }

  try {
    const blobRef = await uploadBlob(agent, local.blob);
    const recordBody = {
      ...((entry.record ?? {}) as Record<string, unknown>),
      blob: blobRef,
    };
    await client.putRecord(entry.collection, entry.recordKey, recordBody);
    if (entry.id !== undefined) await outboxDb.remove(entry.id);
    onSuccess();
    return "ok";
  } catch (err) {
    const decision = classify(err);
    if (decision === "backoff") {
      applyBackoff();
      return "backoff";
    }
    await deadLettersDb.put({
      collection: entry.collection,
      recordKey: entry.recordKey,
      op: entry.op,
      ...(entry.record !== undefined && { record: entry.record }),
      error: errorString(err),
    });
    if (entry.id !== undefined) await outboxDb.remove(entry.id);
    return "deadLettered";
  }
}

function toWriteOp(e: OutboxEntry): WriteOp {
  if (e.op === "delete") {
    return { op: "delete", collection: e.collection, rkey: e.recordKey };
  }
  // We use `update` rather than `create` so callers don't need to track
  // whether this is the first push; on PDS, `update` works for new records
  // when `rkey` is provided. (Many PDS implementations treat update as
  // upsert; if not, we'll need to detect-and-create — but applyWrites'
  // `create` requires the record not to already exist, which is harder for
  // syncing.)
  return {
    op: "update",
    collection: e.collection,
    rkey: e.recordKey,
    value: (e.record ?? {}) as Record<string, unknown>,
  };
}

async function removeEntries(entries: OutboxEntry[]): Promise<void> {
  for (const e of entries) {
    if (e.id !== undefined) await outboxDb.remove(e.id);
  }
}

interface FallbackResult {
  ok: number;
  deadLettered: number;
}

/**
 * Per-op retry path after an atomic-batch 4xx. We don't know which op
 * tripped the validation, so we replay each individually via the typed
 * wrappers (which already handle 404 idempotency on delete). Anything that
 * still errors lands in the dead-letter store.
 */
async function perOpFallback(
  client: RecordsClient,
  entries: OutboxEntry[],
): Promise<FallbackResult> {
  let ok = 0;
  let deadLettered = 0;
  for (const e of entries) {
    try {
      if (e.op === "delete") {
        await client.deleteRecord(e.collection, e.recordKey);
      } else {
        await client.putRecord(
          e.collection,
          e.recordKey,
          (e.record ?? {}) as Record<string, unknown>,
        );
      }
      if (e.id !== undefined) await outboxDb.remove(e.id);
      ok++;
    } catch (err) {
      const decision = classify(err);
      if (decision === "backoff") {
        // Transient — keep the entry in the outbox; caller will retry.
        applyBackoff();
        continue;
      }
      await deadLettersDb.put({
        collection: e.collection,
        recordKey: e.recordKey,
        op: e.op,
        ...(e.record !== undefined && { record: e.record }),
        error: errorString(err),
      });
      if (e.id !== undefined) await outboxDb.remove(e.id);
      deadLettered++;
    }
  }
  return { ok, deadLettered };
}

type Decision = "backoff" | "deadLetter";

function classify(err: unknown): Decision {
  if (err instanceof XRPCError) {
    if (err.status === 429) return "backoff";
    if (err.status >= 500 && err.status < 600) return "backoff";
    return "deadLetter";
  }
  // Network errors (no XRPCError class) — treat as transient.
  return "backoff";
}

function isXRPCStatus(err: unknown, status: number): boolean {
  return err instanceof XRPCError && err.status === status;
}

function applyBackoff(): void {
  state.retryAfter = clockNow() + state.currentBackoff;
  state.currentBackoff = Math.min(state.currentBackoff * 2, MAX_BACKOFF_MS);
}

function onSuccess(): void {
  state.retryAfter = 0;
  state.currentBackoff = MIN_BACKOFF_MS;
}

function errorString(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

export type ReadSyncOutcome =
  | { status: "unchanged"; rev: string } // repo-rev matched, no traversal
  | { status: "synced"; rev: string; collections: CollectionReadResult[] }
  | { status: "first-run"; collections: CollectionReadResult[] }; // never seen a rev

export interface CollectionReadResult {
  nsid: string;
  remoteCount: number;
  inserted: number;
  updated: number;
  deletedLocal: number;
  skippedPending: number;
  skippedStrategy: number; // ops deferred to a Step 6 special merge
}

/**
 * Run a single read-sync pass.
 *
 * 1. Fetch `getLatestCommit.rev`. If unchanged, return early.
 * 2. Else: for every collection, paginated `listRecords`, diff vs the local
 *    store with LWW + skip-if-pending against the outbox.
 * 3. Persist the new repo-rev.
 *
 * NOTE: special merges (noteType union, reviewState after-state,
 * studySummary rebuild) land in Step 6. The Step 5 MVP applies LWW to
 * `lww` collections, dedup to `append-only`, insert-only to `immutable`,
 * and counts ops it deferred so Step 6 can wire the rest.
 */
export async function runReadSync(agent: Agent): Promise<ReadSyncOutcome> {
  const did = agent.did;
  if (!did) throw new Error("runReadSync requires an authenticated agent");

  const latest = await agent.com.atproto.sync.getLatestCommit({ did });
  const remoteRev = latest.data.rev;
  const localRev = await syncStateDb.getRepoRev();

  if (localRev && localRev === remoteRev) {
    return { status: "unchanged", rev: remoteRev };
  }

  const client = new RecordsClient(agent);
  const pending = await loadOutboxIndex();
  const ctx: MergeContext = {};

  const results: CollectionReadResult[] = [];
  for (const def of COLLECTIONS) {
    if (def.merge === "reviewState" || def.merge === "studySummary") {
      // Both strategies depend on the union of merged logs. Index lazily
      // on the first read; subsequent collections reuse the result.
      ctx.logsByNoteTemplate ??= await indexLogsByNoteTemplate();
      ctx.logsByDate ??= await indexLogsByDate();
    }
    const result = await pullCollection(client, def, pending, ctx);
    results.push(result);
  }

  await syncStateDb.setRepoRev(remoteRev);
  return localRev
    ? { status: "synced", rev: remoteRev, collections: results }
    : { status: "first-run", collections: results };
}

/** Group outbox entries by collection + recordKey for skip-if-pending lookups. */
async function loadOutboxIndex(): Promise<Map<string, Map<string, OutboxEntry>>> {
  const all = await outboxDb.getAll();
  const index = new Map<string, Map<string, OutboxEntry>>();
  for (const entry of all) {
    let perColl = index.get(entry.collection);
    if (!perColl) {
      perColl = new Map();
      index.set(entry.collection, perColl);
    }
    // If multiple unsent entries exist for the same key, the latest wins
    // (matches the coalesce semantics we'll apply at drain time).
    const existing = perColl.get(entry.recordKey);
    if (!existing || entryCreatedAt(entry) >= entryCreatedAt(existing)) {
      perColl.set(entry.recordKey, entry);
    }
  }
  return index;
}

function entryCreatedAt(e: OutboxEntry): number {
  return Date.parse(e.createdAt) || 0;
}

interface MergeContext {
  logsByNoteTemplate?: Map<string, ReviewLogRecord[]>;
  logsByDate?: Map<string, ReviewLogRecord[]>;
}

async function pullCollection(
  client: RecordsClient,
  def: CollectionDef,
  pendingIndex: Map<string, Map<string, OutboxEntry>>,
  ctx: MergeContext,
): Promise<CollectionReadResult> {
  const remote = new Map<string, ListedRecord>();
  for await (const page of client.listRecordsAll(def.nsid)) {
    for (const r of page) {
      const rkey = extractRkey(r.uri);
      remote.set(rkey, r);
    }
  }

  const pending = pendingIndex.get(def.nsid) ?? new Map<string, OutboxEntry>();
  const localRecords = await readAllFromStore<Record<string, unknown>>(def.store);
  const localByKey = new Map<string, Record<string, unknown>>();
  for (const r of localRecords) {
    const k = String(r[def.keyField]);
    localByKey.set(k, r);
  }

  const result: CollectionReadResult = {
    nsid: def.nsid,
    remoteCount: remote.size,
    inserted: 0,
    updated: 0,
    deletedLocal: 0,
    skippedPending: 0,
    skippedStrategy: 0,
  };

  // Remote → local pass.
  for (const [rkey, remoteRec] of remote) {
    const pendingEntry = pending.get(rkey);
    if (pendingEntry && pendingDominates(pendingEntry, remoteRec.value)) {
      result.skippedPending++;
      continue;
    }
    const local = localByKey.get(rkey);
    const decision = mergeDecide(def, local, remoteRec.value, ctx, rkey);
    if (decision.action === "take-remote") {
      const normalized = { ...remoteRec.value, [def.keyField]: rkey };
      await writeToStore(def.store, normalized);
      if (local) result.updated++;
      else result.inserted++;
    } else if (decision.action === "take-merged") {
      await writeToStore(def.store, decision.merged);
      // Only counts as an update if local already existed.
      if (local) result.updated++;
      else result.inserted++;
    } else if (decision.action === "defer") {
      result.skippedStrategy++;
    }
  }

  // Local → remote pass: deletions on other devices.
  for (const [rkey] of localByKey) {
    if (remote.has(rkey)) continue;
    const pendingEntry = pending.get(rkey);
    if (pendingEntry?.op === "put") {
      // We have a pending create/update for this key; don't delete locally.
      result.skippedPending++;
      continue;
    }
    if (def.merge === "append-only" || def.merge === "immutable") {
      // append-only/immutable rows are never removed by a remote sync —
      // they're additive history.
      continue;
    }
    await deleteFromStore(def.store, rkey);
    result.deletedLocal++;
  }

  return result;
}

function pendingDominates(
  entry: OutboxEntry,
  remoteValue: Record<string, unknown>,
): boolean {
  if (entry.op === "delete") return true; // we're about to push a delete
  const local = entry.record as Record<string, unknown> | undefined;
  const localUpdated = local?.["updatedAt"];
  const remoteUpdated = remoteValue["updatedAt"];
  if (typeof localUpdated !== "string" || typeof remoteUpdated !== "string") {
    // Either side is missing updatedAt — assume pending dominates so we
    // don't blow away the user's in-flight change.
    return true;
  }
  return Date.parse(localUpdated) >= Date.parse(remoteUpdated);
}

type MergeDecision =
  | { action: "take-remote" }
  | { action: "keep-local" }
  | { action: "defer" }
  | { action: "take-merged"; merged: Record<string, unknown> };

function mergeDecide(
  def: CollectionDef,
  local: Record<string, unknown> | undefined,
  remote: Record<string, unknown>,
  ctx: MergeContext,
  rkey: string,
): MergeDecision {
  switch (def.merge) {
    case "lww": {
      if (!local) return { action: "take-remote" };
      const lu = local["updatedAt"];
      const ru = remote["updatedAt"];
      if (typeof lu !== "string" || typeof ru !== "string") {
        return { action: "take-remote" };
      }
      return Date.parse(ru) >= Date.parse(lu)
        ? { action: "take-remote" }
        : { action: "keep-local" };
    }
    case "append-only":
      return local ? { action: "keep-local" } : { action: "take-remote" };
    case "immutable":
      return local ? { action: "keep-local" } : { action: "take-remote" };
    case "noteType-union": {
      if (!local) return { action: "take-remote" };
      const merged = mergeNoteType(
        local as unknown as NoteTypeRecord,
        remote as unknown as NoteTypeRecord,
      );
      return { action: "take-merged", merged: merged as unknown as Record<string, unknown> };
    }
    case "reviewState": {
      if (!local) return { action: "take-remote" };
      const logs = ctx.logsByNoteTemplate?.get(rkey) ?? [];
      const merged = mergeReviewState(
        local as unknown as ReviewStateRecord,
        remote as unknown as ReviewStateRecord,
        logs,
      );
      return { action: "take-merged", merged: merged as unknown as Record<string, unknown> };
    }
    case "studySummary": {
      const date = rkey;
      const logs = ctx.logsByDate?.get(date) ?? [];
      if (logs.length === 0) {
        // No local logs to base a rebuild on — fall back to LWW.
        if (!local) return { action: "take-remote" };
        const lu = local["updatedAt"];
        const ru = remote["updatedAt"];
        if (typeof lu !== "string" || typeof ru !== "string") {
          return { action: "take-remote" };
        }
        return Date.parse(ru) >= Date.parse(lu)
          ? { action: "take-remote" }
          : { action: "keep-local" };
      }
      const remoteUpdated =
        typeof remote["updatedAt"] === "string" ? remote["updatedAt"] : "";
      const localUpdated =
        local && typeof local["updatedAt"] === "string" ? local["updatedAt"] : "";
      const updatedAt = laterIso(remoteUpdated, localUpdated);
      const merged = rebuildStudySummary(date, logs, updatedAt);
      return { action: "take-merged", merged: merged as unknown as Record<string, unknown> };
    }
  }
}

function laterIso(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

async function indexLogsByNoteTemplate(): Promise<Map<string, ReviewLogRecord[]>> {
  const logs = await readAllFromStore<ReviewLogRecord>("reviewLogs");
  const idx = new Map<string, ReviewLogRecord[]>();
  for (const log of logs) {
    // reviewState key is `{noteTid}_{templateId}`. Notes are referenced
    // here as AT URIs; we extract the rkey to match the reviewState key.
    const noteTid = extractRkey(log.note);
    const key = `${noteTid}_${log.templateId}`;
    const arr = idx.get(key);
    if (arr) arr.push(log);
    else idx.set(key, [log]);
  }
  return idx;
}

async function indexLogsByDate(): Promise<Map<string, ReviewLogRecord[]>> {
  const logs = await readAllFromStore<ReviewLogRecord>("reviewLogs");
  const idx = new Map<string, ReviewLogRecord[]>();
  for (const log of logs) {
    const arr = idx.get(log.resolvedDate);
    if (arr) arr.push(log);
    else idx.set(log.resolvedDate, [log]);
  }
  return idx;
}

function extractRkey(uri: string): string {
  // at://did:.../collection/rkey
  const i = uri.lastIndexOf("/");
  return i >= 0 ? uri.slice(i + 1) : uri;
}

async function readAllFromStore<T>(storeName: string): Promise<T[]> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

async function writeToStore(storeName: string, record: unknown): Promise<void> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteFromStore(storeName: string, key: IDBValidKey): Promise<void> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
