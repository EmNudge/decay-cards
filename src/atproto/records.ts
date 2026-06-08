/**
 * Typed CRUD wrappers around `com.atproto.repo.*` endpoints.
 *
 * - Every call goes through the shared rate limiter, which observes
 *   `RateLimit-Remaining`/`RateLimit-Reset` after each request and backs
 *   off on 429.
 * - `listRecords` paginates automatically (100 per page) and yields the
 *   full result set; callers can pass `pageSize` to override or use
 *   `listRecordsPage` for a single page.
 * - `deleteRecord` treats 404 as success (idempotent).
 * - `applyWrites` batches; callers are responsible for staying under the
 *   200-op / 5 MB limit (see `batchWrites`).
 */
import { type Agent, XRPCError } from "@atproto/api";
import { RateLimiter, globalLimiter, type RateHeaders } from "./rateLimit";

/** Generic record body. Lexicon validation is opt-in on the server side. */
export type RecordBody = Record<string, unknown>;

export interface ListedRecord<T = RecordBody> {
  uri: string;
  cid: string;
  value: T;
}

export interface PutResult {
  uri: string;
  cid: string;
}

export interface ListPage<T = RecordBody> {
  records: ListedRecord<T>[];
  cursor?: string;
}

/** Single applyWrites op. */
export type WriteOp =
  | { op: "create"; collection: string; rkey?: string; value: RecordBody }
  | { op: "update"; collection: string; rkey: string; value: RecordBody }
  | { op: "delete"; collection: string; rkey: string };

const MAX_BATCH_OPS = 200;
const MAX_BATCH_BYTES = 5 * 1024 * 1024; // 5 MB

export class RecordsClient {
  constructor(
    private readonly agent: Agent,
    private readonly limiter: RateLimiter = globalLimiter,
  ) {}

  private get repo(): string {
    const did = this.agent.did;
    if (!did) throw new Error("RecordsClient requires an authenticated agent");
    return did;
  }

  /** Put or replace a record. */
  async putRecord<T extends RecordBody>(
    collection: string,
    rkey: string,
    record: T,
  ): Promise<PutResult> {
    return this.limiter.run(async () => {
      try {
        const res = await this.agent.com.atproto.repo.putRecord({
          repo: this.repo,
          collection,
          rkey,
          record,
        });
        observeHeaders(this.limiter, res.headers);
        return { uri: res.data.uri, cid: res.data.cid };
      } catch (err) {
        handleErrorBackoff(this.limiter, err);
        throw err;
      }
    });
  }

  /** Delete a record. Treats 404 as success (idempotent). */
  async deleteRecord(collection: string, rkey: string): Promise<void> {
    return this.limiter.run(async () => {
      try {
        const res = await this.agent.com.atproto.repo.deleteRecord({
          repo: this.repo,
          collection,
          rkey,
        });
        observeHeaders(this.limiter, res.headers);
      } catch (err) {
        if (isNotFound(err)) return;
        handleErrorBackoff(this.limiter, err);
        throw err;
      }
    });
  }

  /** Fetch a single record, or null on 404. */
  async getRecord<T extends RecordBody = RecordBody>(
    collection: string,
    rkey: string,
  ): Promise<ListedRecord<T> | null> {
    return this.limiter.run(async () => {
      try {
        const res = await this.agent.com.atproto.repo.getRecord({
          repo: this.repo,
          collection,
          rkey,
        });
        observeHeaders(this.limiter, res.headers);
        const cid = res.data.cid ?? "";
        return { uri: res.data.uri, cid, value: res.data.value as T };
      } catch (err) {
        if (isNotFound(err)) return null;
        handleErrorBackoff(this.limiter, err);
        throw err;
      }
    });
  }

  /** Fetch a single page of records. */
  async listRecordsPage<T extends RecordBody = RecordBody>(
    collection: string,
    opts: { limit?: number; cursor?: string; reverse?: boolean } = {},
  ): Promise<ListPage<T>> {
    return this.limiter.run(async () => {
      try {
        const res = await this.agent.com.atproto.repo.listRecords({
          repo: this.repo,
          collection,
          limit: opts.limit ?? 100,
          ...(opts.cursor !== undefined && { cursor: opts.cursor }),
          ...(opts.reverse !== undefined && { reverse: opts.reverse }),
        });
        observeHeaders(this.limiter, res.headers);
        const records = res.data.records.map((r) => ({
          uri: r.uri,
          cid: r.cid,
          value: r.value as T,
        }));
        return {
          records,
          ...(res.data.cursor !== undefined && { cursor: res.data.cursor }),
        };
      } catch (err) {
        handleErrorBackoff(this.limiter, err);
        throw err;
      }
    });
  }

  /**
   * Stream all records in a collection, page by page. Each yielded array is
   * one page (so callers can apply back-pressure or persist incrementally).
   */
  async *listRecordsAll<T extends RecordBody = RecordBody>(
    collection: string,
    pageSize = 100,
  ): AsyncGenerator<ListedRecord<T>[]> {
    let cursor: string | undefined;
    while (true) {
      const page = await this.listRecordsPage<T>(collection, {
        limit: pageSize,
        ...(cursor !== undefined && { cursor }),
      });
      if (page.records.length > 0) yield page.records;
      if (!page.cursor) return;
      cursor = page.cursor;
    }
  }

  /**
   * Apply a batch of writes atomically. Caller-provided `writes` must fit
   * within `MAX_BATCH_OPS` ops and `MAX_BATCH_BYTES` bytes — use
   * `batchWrites()` to split larger sets.
   */
  async applyWrites(writes: WriteOp[]): Promise<void> {
    if (writes.length === 0) return;
    if (writes.length > MAX_BATCH_OPS) {
      throw new Error(
        `applyWrites: ${writes.length} ops exceeds limit ${MAX_BATCH_OPS}`,
      );
    }
    return this.limiter.run(async () => {
      try {
        const res = await this.agent.com.atproto.repo.applyWrites({
          repo: this.repo,
          writes: writes.map(toApplyWritesOp),
        });
        observeHeaders(this.limiter, res.headers);
      } catch (err) {
        handleErrorBackoff(this.limiter, err);
        throw err;
      }
    });
  }
}

/**
 * Split a write list into batches that respect both the 200-op and 5 MB
 * limits. JSON-serializes each op once to measure size.
 */
export function batchWrites(writes: WriteOp[]): WriteOp[][] {
  const batches: WriteOp[][] = [];
  let current: WriteOp[] = [];
  let currentBytes = 0;

  for (const w of writes) {
    const wBytes = estimateOpBytes(w);
    const overOps = current.length + 1 > MAX_BATCH_OPS;
    const overBytes = currentBytes + wBytes > MAX_BATCH_BYTES;
    if (current.length > 0 && (overOps || overBytes)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(w);
    currentBytes += wBytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function estimateOpBytes(w: WriteOp): number {
  // Cheap byte estimate: JSON-serialize the op. Good enough — the server
  // limit is on serialized request size, not memory size.
  try {
    return new Blob([JSON.stringify(w)]).size;
  } catch {
    return 1024;
  }
}

function toApplyWritesOp(w: WriteOp) {
  switch (w.op) {
    case "create":
      return {
        $type: "com.atproto.repo.applyWrites#create" as const,
        collection: w.collection,
        ...(w.rkey !== undefined && { rkey: w.rkey }),
        value: w.value,
      };
    case "update":
      return {
        $type: "com.atproto.repo.applyWrites#update" as const,
        collection: w.collection,
        rkey: w.rkey,
        value: w.value,
      };
    case "delete":
      return {
        $type: "com.atproto.repo.applyWrites#delete" as const,
        collection: w.collection,
        rkey: w.rkey,
      };
  }
}

function isNotFound(err: unknown): boolean {
  if (err instanceof XRPCError && err.status === 404) return true;
  // Some servers also signal record-missing via the typed error name.
  if (err instanceof Error && /RecordNotFound|not found/i.test(err.message)) {
    return true;
  }
  return false;
}

type RawHeaders = Record<string, string | undefined>;

function observeHeaders(limiter: RateLimiter, headers: RawHeaders | undefined): void {
  if (!headers) return;
  const h: RateHeaders = {
    remaining: pickHeader(headers, "ratelimit-remaining"),
    reset: pickHeader(headers, "ratelimit-reset"),
  };
  limiter.observe(h);
}

function handleErrorBackoff(limiter: RateLimiter, err: unknown): void {
  if (err instanceof XRPCError && err.status === 429) {
    const headers = (err as unknown as { headers?: RawHeaders }).headers;
    const retryAfter = headers ? pickHeader(headers, "retry-after") : null;
    limiter.backoff(retryAfter);
  }
}

function pickHeader(headers: RawHeaders, name: string): string | null {
  const lower = name.toLowerCase();
  for (const key in headers) {
    if (key.toLowerCase() === lower) return headers[key] ?? null;
  }
  return null;
}
