import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { type Agent } from "@atproto/api";
import { deleteDb } from "../../db/schema";
import { outboxDb } from "../../db/outbox";
import { mediaDb } from "../../db/media";
import { deadLettersDb } from "../../db/deadLetters";
import { globalLimiter } from "../rateLimit";
import { drainOutbox, resetDrainBackoff, __resetDrainClock } from "../sync";

const MEDIA_NSID = "cards.decay.flashcard.media";
const isoNow = "2025-01-01T00:00:00Z";

interface AgentMocks {
  uploadBlob?: ReturnType<typeof vi.fn>;
  putRecord?: ReturnType<typeof vi.fn>;
  deleteRecord?: ReturnType<typeof vi.fn>;
  applyWrites?: ReturnType<typeof vi.fn>;
}

function mockAgent(did: string, mocks: AgentMocks = {}): Agent {
  return {
    did,
    com: {
      atproto: {
        repo: {
          uploadBlob:
            mocks.uploadBlob ??
            vi.fn().mockResolvedValue({
              headers: {},
              data: {
                blob: {
                  ref: { toString: () => "bafyblob123" },
                  mimeType: "image/png",
                  size: 100,
                },
              },
            }),
          putRecord:
            mocks.putRecord ??
            vi.fn().mockResolvedValue({
              headers: {},
              data: { uri: "at://did:test/cards.decay.flashcard.media/img.png", cid: "x" },
            }),
          deleteRecord:
            mocks.deleteRecord ??
            vi.fn().mockResolvedValue({ headers: {}, data: {} }),
          applyWrites:
            mocks.applyWrites ?? vi.fn().mockResolvedValue({ headers: {}, data: {} }),
          getRecord: vi.fn(),
          listRecords: vi.fn(),
        },
        sync: { getLatestCommit: vi.fn() },
      },
    },
  } as unknown as Agent;
}

beforeEach(async () => {
  await deleteDb();
  globalLimiter.reset();
  resetDrainBackoff();
  __resetDrainClock();
});

describe("drainOutbox — media put", () => {
  it("uploads the local Blob, then putRecord with the BlobRef embedded", async () => {
    await mediaDb.put({
      normalizedKey: "img.png",
      filename: "img.png",
      blob: new Blob(["xyz"], { type: "image/png" }),
      mimeType: "image/png",
      createdAt: isoNow,
      updatedAt: isoNow,
    });

    const uploadBlob = vi.fn().mockResolvedValue({
      headers: {},
      data: {
        blob: {
          ref: { toString: () => "bafyblob123" },
          mimeType: "image/png",
          size: 100,
        },
      },
    });
    const putRecord = vi.fn().mockResolvedValue({
      headers: {},
      data: { uri: "at://did:test/cards.decay.flashcard.media/img.png", cid: "x" },
    });
    const agent = mockAgent("did:test", { uploadBlob, putRecord });

    const result = await drainOutbox(agent);
    expect(result.status).toBe("done");
    if (result.status === "done") expect(result.ops).toBe(1);

    expect(uploadBlob).toHaveBeenCalledTimes(1);
    expect(putRecord).toHaveBeenCalledTimes(1);

    const putArgs = putRecord.mock.calls[0]![0];
    expect(putArgs).toMatchObject({
      repo: "did:test",
      collection: MEDIA_NSID,
      rkey: "img.png",
    });
    expect(putArgs.record).toMatchObject({
      filename: "img.png",
      blob: {
        $type: "blob",
        ref: { $link: "bafyblob123" },
        mimeType: "image/png",
        size: 100,
      },
    });

    expect(await outboxDb.getAll()).toEqual([]);
  });

  it("drops the outbox entry silently when the local Blob is gone (stale)", async () => {
    // No mediaDb.put — entry refers to a missing local record.
    await outboxDb.queuePut(MEDIA_NSID, "missing.png", {
      normalizedKey: "missing.png",
      filename: "missing.png",
      createdAt: isoNow,
      updatedAt: isoNow,
    });

    const uploadBlob = vi.fn();
    const putRecord = vi.fn();
    const agent = mockAgent("did:test", { uploadBlob, putRecord });

    const result = await drainOutbox(agent);
    expect(result.status).toBe("done");
    expect(uploadBlob).not.toHaveBeenCalled();
    expect(putRecord).not.toHaveBeenCalled();
    expect(await outboxDb.getAll()).toEqual([]);
  });

  it("dead-letters the media entry on a 4xx blob upload failure", async () => {
    await mediaDb.put({
      normalizedKey: "bad.png",
      filename: "bad.png",
      blob: new Blob(["xyz"], { type: "image/png" }),
      createdAt: isoNow,
      updatedAt: isoNow,
    });

    const { XRPCError } = await import("@atproto/api");
    const uploadBlob = vi
      .fn()
      .mockRejectedValue(new XRPCError(400, "InvalidRequest", "too big"));
    const agent = mockAgent("did:test", { uploadBlob });

    const result = await drainOutbox(agent);
    expect(result.status).toBe("deadLettered");

    const dead = await deadLettersDb.getAll();
    expect(dead.length).toBe(1);
    expect(dead[0]!.recordKey).toBe("bad.png");
    expect(dead[0]!.error).toMatch(/too big/);
  });

  it("non-media puts still flow through applyWrites batch", async () => {
    await outboxDb.queuePut("cards.decay.flashcard.note", "n1", { tid: "n1" });
    await mediaDb.put({
      normalizedKey: "img.png",
      filename: "img.png",
      blob: new Blob(["xyz"], { type: "image/png" }),
      createdAt: isoNow,
      updatedAt: isoNow,
    });

    const applyWrites = vi.fn().mockResolvedValue({ headers: {}, data: {} });
    const putRecord = vi.fn().mockResolvedValue({
      headers: {},
      data: { uri: "at://did:test/cards.decay.flashcard.media/img.png", cid: "x" },
    });
    const uploadBlob = vi.fn().mockResolvedValue({
      headers: {},
      data: {
        blob: {
          ref: { toString: () => "bafyblob" },
          mimeType: "image/png",
          size: 3,
        },
      },
    });
    const agent = mockAgent("did:test", { applyWrites, putRecord, uploadBlob });

    const result = await drainOutbox(agent);
    expect(result.status).toBe("done");

    // applyWrites should see ONLY the note (no media put in the batch).
    expect(applyWrites).toHaveBeenCalledTimes(1);
    const writes = applyWrites.mock.calls[0]![0].writes;
    expect(writes.length).toBe(1);
    expect(writes[0]).toMatchObject({
      collection: "cards.decay.flashcard.note",
      rkey: "n1",
    });

    // Media should have gone through uploadBlob + putRecord.
    expect(uploadBlob).toHaveBeenCalledTimes(1);
    expect(putRecord).toHaveBeenCalledTimes(1);
  });

  it("media DELETE still flows through the batch path (no blob upload)", async () => {
    // Queue a delete directly — no local mediaDb record needed.
    await outboxDb.queueDelete(MEDIA_NSID, "old.png");

    const applyWrites = vi.fn().mockResolvedValue({ headers: {}, data: {} });
    const uploadBlob = vi.fn();
    const agent = mockAgent("did:test", { applyWrites, uploadBlob });

    const result = await drainOutbox(agent);
    expect(result.status).toBe("done");
    expect(uploadBlob).not.toHaveBeenCalled();
    expect(applyWrites).toHaveBeenCalledTimes(1);
    expect(applyWrites.mock.calls[0]![0].writes[0]).toMatchObject({
      $type: "com.atproto.repo.applyWrites#delete",
      collection: MEDIA_NSID,
      rkey: "old.png",
    });
  });
});
