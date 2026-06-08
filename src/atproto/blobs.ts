/**
 * Blob upload and lazy-fetch with Cache API persistence.
 *
 * - Upload: throttled at 2/sec via a dedicated rate limiter (independent
 *   from the records limiter — blob uploads are heavier and the PDS treats
 *   them under a separate quota).
 * - Fetch: cached in the Cache API across sessions, keyed by `(did, cid)`.
 * - Mime type is hinted to `uploadBlob` so the PDS rejects mismatches early.
 */
import type { Agent } from "@atproto/api";
import { RateLimiter } from "./rateLimit";

export interface BlobRefValue {
  $type: "blob";
  ref: { $link: string };
  mimeType: string;
  size: number;
}

const CACHE_NAME = "decay-blobs-v1";
// 2 uploads/sec → 500ms interval.
const uploadLimiter = new RateLimiter();
// Tune the upload limiter to 2/sec by observing a synthetic header set
// to its baseline. We do this once at module init.
uploadLimiter.observe({ remaining: 2, reset: nowSecs() + 1 });

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

function blobCacheUrl(did: string, cid: string): string {
  return `https://blob-cache.local/${encodeURIComponent(did)}/${encodeURIComponent(cid)}`;
}

async function openCache(): Promise<Cache | null> {
  if (typeof caches === "undefined") return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

export async function uploadBlob(
  agent: Agent,
  blob: Blob,
): Promise<BlobRefValue> {
  return uploadLimiter.run(async () => {
    const res = await agent.com.atproto.repo.uploadBlob(blob, {
      encoding: blob.type || "application/octet-stream",
    });
    const ref = res.data.blob;
    // The SDK returns a BlobRef instance; serialize to the IPLD-style shape
    // we store in records.
    return {
      $type: "blob",
      ref: { $link: typeof ref.ref === "string" ? ref.ref : ref.ref.toString() },
      mimeType: ref.mimeType,
      size: ref.size,
    };
  });
}

/**
 * Fetch a blob from the user's PDS, returning a Blob. Cached in the Cache
 * API across sessions; cache key is `(did, cid)`. Returns `null` if the
 * blob is missing.
 */
export async function fetchBlob(
  agent: Agent,
  did: string,
  cid: string,
  mimeType?: string,
): Promise<Blob | null> {
  const cache = await openCache();
  const cacheKey = blobCacheUrl(did, cid);

  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return await hit.blob();
  }

  try {
    const res = await agent.com.atproto.sync.getBlob({ did, cid });
    const data = res.data;
    const blob = new Blob([data as BlobPart], {
      type: mimeType || "application/octet-stream",
    });
    if (cache) {
      const resp = new Response(blob, {
        headers: { "Content-Type": blob.type },
      });
      await cache.put(cacheKey, resp);
    }
    return blob;
  } catch (err) {
    if (isBlobMissing(err)) return null;
    throw err;
  }
}

/**
 * Drop a blob from the local cache. Use when the source record is deleted.
 */
export async function evictBlobFromCache(did: string, cid: string): Promise<void> {
  const cache = await openCache();
  if (!cache) return;
  await cache.delete(blobCacheUrl(did, cid));
}

function isBlobMissing(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (/BlobNotFound|not found/i.test(err.message)) return true;
  const status = (err as { status?: number }).status;
  return status === 404;
}
