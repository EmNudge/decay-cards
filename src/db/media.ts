import type { MediaRecord } from "./schema";
import { put, get, getAll, del, getAllByIndex } from "./helpers";
import { outboxDb } from "./outbox";

const STORE = "media";
const NSID = "cards.decay.flashcard.media";

/**
 * Normalize a filename to a valid AT Protocol record key.
 * 1. NFC normalize
 * 2. Encode as UTF-8 bytes
 * 3. Percent-encode non-[a-zA-Z0-9._~:_-] bytes as -XX
 * 4. If >480 chars, truncate and append SHA-256 hash suffix
 */
export function normalizeMediaKey(filename: string): string {
  const nfc = filename.normalize("NFC");
  const encoder = new TextEncoder();
  const bytes = encoder.encode(nfc);

  let result = "";
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    if (/[a-zA-Z0-9._~:_-]/.test(char)) {
      result += char;
    } else {
      result += `-${byte.toString(16).padStart(2, "0")}`;
    }
  }

  if (result.length <= 512) {
    return result;
  }

  // Truncate and append hash suffix for collision resistance
  const truncated = result.slice(0, 480);
  const hashSuffix = simpleHash(bytes);
  return `${truncated}-${hashSuffix}`;
}

/** Simple deterministic hash for truncation suffix (sync SHA-256 not available everywhere, use FNV-1a) */
function simpleHash(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = (hash * 0x01000193) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Build the lightweight metadata body that goes into the outbox.
 * Blobs upload separately via blobs.ts; the record itself holds metadata
 * + a BlobRef (added during sync.ts wiring, not at queue time).
 */
function mediaOutboxRecord(media: MediaRecord): Record<string, unknown> {
  return {
    normalizedKey: media.normalizedKey,
    filename: media.filename,
    ...(media.mimeType !== undefined && { mimeType: media.mimeType }),
    createdAt: media.createdAt,
    updatedAt: media.updatedAt,
  };
}

export const mediaDb = {
  async put(media: MediaRecord): Promise<void> {
    await put<MediaRecord>(STORE, media);
    await outboxDb.queuePut(NSID, media.normalizedKey, mediaOutboxRecord(media));
  },
  get: (normalizedKey: string) => get<MediaRecord>(STORE, normalizedKey),
  getAll: () => getAll<MediaRecord>(STORE),
  async delete(normalizedKey: string): Promise<void> {
    await del(STORE, normalizedKey);
    await outboxDb.queueDelete(NSID, normalizedKey);
  },

  /** Find by original filename */
  getByFilename: (filename: string) => getAllByIndex<MediaRecord>(STORE, "filename", filename),

  /** Get by normalized key from a display filename */
  getByDisplayName: (filename: string) => get<MediaRecord>(STORE, normalizeMediaKey(filename)),
};
