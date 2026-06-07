# Phase 2: AT Protocol Integration — Implementation Plan

## Prerequisites
- Phase 1 complete (local-only app with import, study, browse, settings)
- `decay.cards` domain configured
- `decaycards.emnudge.dev` subdomain for iframe isolation

## Dependencies to Add
```
pnpm add @atproto/api @atproto/oauth-client-browser
```

---

## Step 1: Auth + Client Setup

**Files:** `src/atproto/auth.ts`, `src/atproto/client.ts`

- OAuth flow via `@atproto/oauth-client-browser`
- Token storage in **IndexedDB** (not sessionStorage — survives browser restart)
- Login UI: handle entry → OAuth redirect → callback
- Token refresh: the OAuth library handles this transparently
- Extended offline: if refresh token expires, sync pauses with non-blocking banner ("Re-authenticate to sync"), study continues offline
- `client.ts`: authenticated `Agent` instance, PDS endpoint resolution from DID

## Step 2: Lexicon Schemas

**Files:** `src/lexicons/cards/decay/flashcard/*.json`

Write JSON lexicon files for all record types:
- `deck.json`, `noteType.json`, `note.json`, `media.json`
- `reviewState.json`, `reviewLog.json`, `cardFlag.json`
- `settings.json`, `deckSettings.json`, `studySummary.json`
- `shareDeck.json`, `forkDeck.json`

These match the schemas in SPEC.md. Used for documentation and future AppView registration — the client doesn't validate against them at runtime.

## Step 3: PDS CRUD Helpers

**Files:** `src/atproto/records.ts`, `src/atproto/blobs.ts`

### records.ts
Typed CRUD wrappers for each collection:
```ts
putRecord(collection, rkey, record) → { uri, cid }
deleteRecord(collection, rkey) → void
listRecords(collection, opts?) → { records, cursor }
getRecord(collection, rkey) → record | null
```

- Handles pagination (100 records/page)
- Adaptive pacing: start at 20 pages/sec, adjust based on `RateLimit-Remaining` / `RateLimit-Reset` headers
- 429 responses: back off per `Retry-After`

### blobs.ts
- `uploadBlob(blob)` → BlobRef
- `fetchBlob(did, cid)` → Blob
- Cache API for fetched blobs (persist across sessions)
- Lazy fetch: blobs downloaded on first card render, not on sync

## Step 4: Sync Engine — Write Path

**Files:** `src/atproto/sync.ts`

### Outbox Drain
Wire the existing `db/outbox.ts` coalescing logic to actual PDS writes:

1. On sync trigger, call `outbox.coalesce()` to compact pending entries
2. Group entries into `applyWrites` batches (max 200 ops AND 5 MB serialized)
3. Send batches to PDS
4. On success: clear outbox entries
5. On 404 for deleteRecord: treat as success (idempotent delete)
6. On other 4xx: parse error response to identify failing op, dead-letter it, retry rest
7. On 5xx/network: exponential backoff (5s → 10s → 20s → ... → 5min max)

### Outbox Entry Creation
Every local write (note create/edit, review, deck delete, etc.) already goes to IndexedDB. Add outbox entry creation alongside each db write:
- `notesDb.put(note)` → also `outboxDb.queuePut("cards.decay.flashcard.note", note.tid, note)`
- `reviewStateDb.put(rs)` → also `outboxDb.queuePut("cards.decay.flashcard.reviewState", rs.key, rs)`
- Same for all other collections

### Sync Triggers
- App open
- Local write (debounced 5s)
- 5-minute polling while foregrounded
- `visibilitychange` event (return from background)

## Step 5: Sync Engine — Read Path

### Repo-Rev Short-Circuit
1. Call `com.atproto.sync.getLatestCommit` (1 API call)
2. Compare against stored `lastRev` in `syncState`
3. If unchanged → skip entire read path
4. If changed → proceed to full traversal

### Full Traversal with Diffing
For each mutable collection:
1. `listRecords` paginated (100/page) to fetch ALL remote records
2. Build key→record map
3. Within a **single IDB transaction** (spanning all stores + outbox):
   - Remote exists locally: compare `updatedAt` → if remote newer, update local; if local newer, skip (outbox will push)
   - Remote not local: insert
   - Local not remote: deleted on another device → delete locally (unless pending in outbox as a create)
   - **Skip-if-pending**: if outbox has unsent entry for this key with `updatedAt` >= remote, skip the remote value
4. Update `syncState.lastRev`

### Apply Order
noteTypes → decks → notes → reviewState → reviewLogs → cardFlags → media → settings → deckSettings → studySummary → shareDeck → forkDeck

## Step 6: Conflict Resolution

### Standard records (notes, decks, settings, deckSettings, cardFlag, media)
- LWW by `updatedAt`. Identical timestamps: PDS wins.

### noteTypes
- **Per-element union merge**: templates merged by stable `id` (union of both sides; per-template, later `updatedAt` wins). Fields merged by stable `id`. `css` and `name` use record-level LWW.
- Template/field deletion doesn't propagate across devices (union-only).

### reviewState
- **After-state reconciliation**: sort merged reviewLogs by `reviewedAt`, take latest entry's after-state (`phaseAfter`, `repsAfter`, `lapsesAfter`, `learningStepIndexAfter`, `easeFactorAfter`/`stabilityAfter`/`difficultyAfter`).
- Non-scheduling flags (`suspended`, `buried`) merged per-flag using `suspendedChangedAt` / `buriedChangedAt` (later timestamp wins for each flag independently).
- `createdAt`: use `min(local, remote)`.

### reviewLogs
- Append-only, no conflicts. Dedup by TID.

### studySummary
- Rebuilt from merged reviewLogs for the conflicting `resolvedDate`. Sync order: reviewLogs first, then studySummary.

### forkDeck
- Immutable, no conflict resolution.

### Deck deletion
- Soft-delete (set `deletedAt` on deck record, never hard-delete)
- Cascade: notes, reviewState, reviewLogs, cardFlags (temporal guard: only cascade where `note.createdAt < deck.deletedAt`)
- Post-delete notes auto-moved to default deck
- Any device seeing `deletedAt` can independently run cascade

## Step 7: Phase 1→2 Migration

On first Phase 2 sync:
1. Upload all locally-stored reviewLogs to PDS in chronological order
2. Upload all reviewState records
3. Upload all notes, noteTypes, decks, media, settings, deckSettings
4. This is a one-time bulk upload — use import rate limiting (10 putRecord/s, 2 uploadBlob/s)
5. Show progress UI: "Syncing 3,421 / 10,000 records..."

## Step 8: Media Sync

### Upload
- When a note with media is synced, upload the media record to PDS
- `uploadBlob(blob)` → get BlobRef → `putRecord` for media collection with BlobRef
- Throttle: 2 uploadBlob/s

### Download (lazy)
- On sync, media records (metadata only) are synced via full traversal
- Blob data is NOT fetched eagerly
- On card render, if media blob isn't in local Cache API: fetch from PDS, cache, serve
- Placeholder skeleton shown while loading

### Cache
- Blob data cached in Cache API (persists across sessions)
- Cache keyed by normalized media key

## Step 9: Iframe Isolation (Phase 2 Renderer)

**Infrastructure:** Static shell at `decaycards.emnudge.dev`

### Shell (`index.html`)
- Minimal HTML: receives card HTML + media ArrayBuffers via `postMessage`
- Creates local blob URLs from received ArrayBuffers
- Renders card HTML in its own origin
- Clears localStorage, sessionStorage, IndexedDB, Cache API before each render
- CSP: `default-src 'none'; img-src blob: data:; media-src blob: data:; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'none'`

### postMessage Contract
- Parent → iframe: `{ type: "render", html: string, media: { filename: string, data: ArrayBuffer }[] }`
- Iframe → parent: `{ type: "ready" }`
- Both sides validate `event.origin`
- Parent ignores all messages that fail origin check or have unexpected `type`

### Different eTLD+1
- App: `decay.cards`
- Shell: `decaycards.emnudge.dev` (eTLD+1 = `emnudge.dev`)
- Prevents `.decay.cards` domain cookies from leaking to shell

### Fallback
If subdomain unavailable, fall back to Phase 1 same-origin `sandbox="allow-same-origin allow-scripts"` with media inlined as data: URIs.

## Step 10: UI Updates

### Login View (`src/components/LoginView.vue`)
- Handle entry field
- "Sign in with AT Protocol" button
- OAuth redirect flow
- Loading state during auth
- Error handling (invalid handle, network failure)

### Sync Status
- Header badge showing sync state (synced / syncing / offline / error)
- Dead letter count badge
- Manual "Sync Now" button
- Dead letter management panel (view errors, retry, discard)

### Settings
- AT Protocol account section (handle, DID, PDS endpoint)
- Sign out button
- Sync interval configuration

---

## Testing Strategy

### Unit tests
- `atproto/records.ts`: mock PDS responses, test pagination, rate limiting
- `atproto/sync.ts`: test coalescing → drain → read path with fake-indexeddb
- Conflict resolution: test LWW, noteType union merge, reviewState after-state reconciliation

### Integration tests
- Full sync cycle: local writes → outbox → drain → read back
- Conflict scenarios: two "devices" (two IDB instances) writing to same mock PDS
- Phase 1→2 migration: populate IDB, run migration, verify PDS state

### Manual testing
- Real PDS (bsky.social or self-hosted)
- Import .apkg → sync → verify records on PDS
- Two browser tabs simulating multi-device
- Offline study → reconnect → verify sync

---

## Estimated Effort

| Step | Complexity | Notes |
|------|-----------|-------|
| 1. Auth | Medium | OAuth library does most of the work |
| 2. Lexicons | Low | JSON files, no logic |
| 3. CRUD helpers | Medium | Pagination, rate limiting |
| 4. Write path | High | Outbox drain, error handling, batching |
| 5. Read path | High | Full traversal, skip-if-pending, IDB transaction |
| 6. Conflict resolution | High | Multiple strategies per collection |
| 7. Migration | Medium | Bulk upload with progress |
| 8. Media sync | Medium | Blob upload/download, caching |
| 9. Iframe isolation | Medium | Static shell deployment, postMessage |
| 10. UI | Medium | Login, sync status, dead letters |
