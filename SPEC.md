# Anki on AT Protocol — Specification

## Overview

A spaced-repetition flashcard application where decks, notes, review state, and study progress are stored as AT Protocol records in the user's Personal Data Server (PDS). This enables:

- **Data ownership**: Users own their flashcard data via their PDS
- **Portability**: Switch clients without losing data
- **Social features**: Share decks publicly, fork others' decks, see study streaks
- **Interoperability**: Any atproto client can read/write flashcard data
- **Offline-first**: Local-first with atproto as the sync layer

### Privacy Notice

**All flashcard data stored on AT Protocol is public.** AT Protocol repos are readable by anyone. This means notes, decks, review history, study patterns, and media are all visible. This is appropriate for general-purpose study material (language learning, geography, programming) but problematic for sensitive content (medical study, proprietary work material, personal information). Users with privacy-sensitive decks should be aware of this limitation. Encrypted record values could enable private decks in the future but are out of scope for this spec and would require protocol-level support.

## Lexicon Namespace

All lexicons use the namespace `cards.decay.flashcard.*`.

> **Why `cards.decay`?** AT Protocol lexicon namespaces must be a reversed domain you control. `decay.cards` is the project's domain. Using `com.anki.*` would violate atproto conventions since we don't own `anki.com`.

---

## Terminology

- **Note**: A set of field values (e.g., front text + back text). One note can produce multiple reviewable cards.
- **Card**: A specific (note, template) pair that the user actually reviews. Cards are not stored as records — they are derived at runtime from a note's noteType templates. For **Cloze** note types, cards are derived from `{{c1::...}}` markers in field values rather than from explicit template entries (see [Cloze Note Types](#cloze-note-types)).
- **Note Type**: Defines the fields and templates for a category of notes (e.g., "Basic", "Cloze").
- **Deck**: A collection of notes.

---

## Architectural Decisions

### Event Sourcing vs CRUD for Scheduling State

Spaced repetition scheduling is inherently event-sourced: the correct state of a card is the result of applying all reviews in sequence. However, atproto records are mutable CRUD entities, not event logs. This spec bridges the gap:

- **reviewLog** is the append-only event log (ground truth)
- **reviewState** is a materialized checkpoint derived from reviewLogs

In Phase 1 (single device), reviewState is written directly on each review — fast and simple. In Phase 2 (multi-device), reviewState becomes a **reconcilable cache**: on sync conflict, the client sorts the merged reviewLogs by `reviewedAt` and takes the **latest entry's after-state** as the authoritative scheduling state. This is functionally LWW-by-reviewedAt across log entries, but with two advantages over Phase 1 record-level LWW: (1) both reviews are preserved in the log for accurate stats, and (2) convergence is deterministic by `reviewedAt` timestamp rather than by `updatedAt` which can be affected by non-review edits. **Limitation**: if two devices review the same card offline, the earlier review's scheduling effect is discarded — only the later review determines the card's next due date. This is an inherent tradeoff of after-state chaining; true algorithmic replay would require snapshotting deckSettings history per-review, which is disproportionate complexity.

The replay algorithm:
1. Collect all reviewLog entries for the card, sorted by `reviewedAt`
2. Initialize scheduling state from the **first log entry's after-state** (`easeFactorAfter`/`stabilityAfter`/`difficultyAfter` + `intervalAfterDays`/`intervalAfterMinutes`).
3. For each subsequent log entry, take the entry's **after-state** as the new scheduling state. Replay does NOT recompute scheduling from the algorithm — it chains recorded after-states. Each device computed the correct after-state at review time with its then-current deckSettings; replay trusts those recorded values. If adjacent entries have different `algorithm` values (user toggled settings), no conversion is needed because each entry's after-state is already in the correct algorithm's format.
4. The resulting state is the correct reviewState
5. **Preserve non-scheduling flags per-flag**: `suspended` and `buried` are NOT part of the replay — they are user-intent flags. After replay, each flag is merged independently: `suspended` + `suspendedChangedAt` from whichever side has the later `suspendedChangedAt`; `buried` + `buriedChangedAt` from whichever side has the later `buriedChangedAt`. This correctly handles all cases: A buries + B suspends → both flags survive; A buries + B unburies → the later action wins with full context (both the boolean and the timestamp travel together).

This is bounded in cost — a single card rarely has >1000 lifetime reviews, and replay only runs on conflict (not on every sync).

### Client-Enforced Invariants

AT Protocol has no server-side validation beyond Lexicon schemas. Many data integrity rules (template ID uniqueness, field name uniqueness, deck cycle prevention, noteType locality) cannot be enforced at the schema level. These are specified as **client validation contracts**:

- Clients MUST validate before writing. Violations are bugs, not expected states.
- On read, clients SHOULD be defensive (first-match-wins, ignore cycles, skip orphans).
- A third-party client that violates these contracts produces data that our client handles gracefully but may display differently.

This is inherent to atproto's architecture, not a spec shortcoming. A Lexicon validation layer can only enforce types, not relational constraints.

### LWW and Clock Dependence

Last-write-wins by `updatedAt` is used for non-scheduling mutable records (notes, decks, settings). This is fragile with clock skew but acceptable because:
- These records have low contention (rarely edited on two devices simultaneously)
- atproto does not expose causal ordering to clients (repo commits have order, but there's no cross-device vector clock)
- The 30-second clock skew tolerance + user warning is proportionate to the risk

For reviewState specifically, LWW is a Phase 1 shortcut. Phase 2 replaces it with log-replay reconciliation (see above).

---

## Data Model (Lexicon Schemas)

### `cards.decay.flashcard.deck`

A collection of related notes. One record per deck.

```json
{
  "lexicon": 1,
  "id": "cards.decay.flashcard.deck",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["name", "createdAt", "updatedAt"],
        "properties": {
          "name": { "type": "string", "minLength": 1, "maxLength": 256 },
          "description": { "type": "string", "maxLength": 2048 },
          "parentDeck": { "type": "string", "format": "at-uri", "description": "AT URI of parent deck for nested decks (Parent::Child)" },
          "isFiltered": { "type": "boolean", "description": "If true, this is a filtered/custom study deck. Cards are temporarily borrowed from other decks via a search query. Filtered decks do not own their notes — they reference cards from source decks." },
          "filteredQuery": { "type": "string", "maxLength": 4096, "description": "Search query defining which cards to include (e.g., 'deck:Japanese is:due prop:ivl<30'). Only set when isFiltered is true." },
          "filteredOrder": { "type": "string", "enum": ["random", "due", "intervalAsc", "intervalDesc", "easeAsc", "easeDesc", "lapsesDesc", "added"], "description": "Sort order for filtered deck cards. Only set when isFiltered is true." },
          "filteredLimit": { "type": "integer", "minimum": 1, "description": "Max cards to include. Only set when isFiltered is true." },
          "filteredReschedule": { "type": "boolean", "description": "If true, reviews in this filtered deck update the card's real scheduling state. If false, reviews are 'cram' mode — the card returns to its source deck unchanged. Only set when isFiltered is true." },
          "deletedAt": { "type": "string", "format": "datetime", "description": "Set when deck is deleted. Deck record stays as tombstone for cross-device cascade." },
          "createdAt": { "type": "string", "format": "datetime" },
          "updatedAt": { "type": "string", "format": "datetime" }
        }
      }
    }
  }
}
```

> **Deck tree constraints**: `parentDeck` creates a tree structure with no schema-level depth limit or cycle prevention. Clients must validate before writing: (1) maximum nesting depth of 8 levels, (2) no circular references (a deck cannot be its own ancestor). A client that reads a cycle should treat it as a flat deck (ignore `parentDeck`).

### `cards.decay.flashcard.noteType`

Defines field definitions and rendering templates for a category of notes.

Each template has a stable `id` field (a short alphanumeric string assigned at creation time) in addition to its `name`. The `id` is used as the template identifier in reviewState and reviewLog records, making them resilient to template reordering, renaming, or deletion.

```json
{
  "lexicon": 1,
  "id": "cards.decay.flashcard.noteType",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["name", "fields", "templates", "createdAt", "updatedAt"],
        "properties": {
          "name": { "type": "string", "minLength": 1, "maxLength": 256 },
          "isCloze": { "type": "boolean", "description": "If true, cards are generated from {{c1::...}} markers rather than from explicit templates. The templates array should contain exactly one entry used as the rendering shell. Omitted = false (non-cloze)." },
          "fields": {
            "type": "array",
            "minLength": 1,
            "maxLength": 64,
            "items": {
              "type": "object",
              "required": ["id", "name"],
              "properties": {
                "id": { "type": "string", "minLength": 1, "maxLength": 32, "description": "Stable field identifier. Assigned once, never changes. Generated as 8-char random base32 to avoid collision across devices. On import, use 'f0', 'f1', etc." },
                "name": { "type": "string", "minLength": 1, "maxLength": 256, "description": "Display name. Can be renamed freely. Mustache templates use this name ({{FieldName}}). Must be unique within the noteType — clients must validate." },
                "description": { "type": "string", "maxLength": 1024 }
              }
            }
          },
          "templates": {
            "type": "array",
            "minLength": 1,
            "maxLength": 64,
            "items": {
              "type": "object",
              "required": ["id", "name", "qfmt", "afmt"],
              "properties": {
                "id": { "type": "string", "minLength": 1, "maxLength": 32, "description": "Stable identifier. Must match [a-zA-Z0-9]+ but must NOT match ^c\\d+$ (reserved for cloze ordinals). Generated as 8-char random base32 (e.g., 'a7x2m9kf'). On import, use 't0', 't1', etc." },
                "name": { "type": "string", "minLength": 1, "maxLength": 256, "description": "Human-readable display name. Can be renamed freely without affecting review history." },
                "qfmt": { "type": "string", "maxLength": 65536, "description": "Question format (HTML with {{field}} mustache placeholders)" },
                "afmt": { "type": "string", "maxLength": 65536, "description": "Answer format (HTML with {{field}} mustache placeholders)" }
              }
            }
          },
          "css": { "type": "string", "maxLength": 65536, "description": "CSS for rendering cards of this note type. This is the sole CSS source for card rendering." },
          "forkedFrom": { "type": "string", "format": "at-uri", "description": "AT URI of the source noteType this was forked from. Used for noteType dedup across devices when forking multiple decks from the same source." },
          "createdAt": { "type": "string", "format": "datetime" },
          "updatedAt": { "type": "string", "format": "datetime" }
        }
      }
    }
  }
}
```

> **Stable template IDs vs positional indices**: Using a stable `id` string (e.g., `"card1"`, `"reversed"`, or a short random string like `"a7x2"`) avoids data corruption when templates are reordered or deleted. The ID is assigned once when a template is created and never changes.
>
> **Template ID uniqueness**: Template `id` uniqueness within a noteType isn't enforceable in Lexicon. Clients must validate uniqueness before writing. On read, first-match wins. Two templates with the same `id` would silently merge review history — data corruption that clients must prevent.
>
> **Field display name uniqueness**: Field `name` (display name) must also be unique within a noteType. Mustache templates use `{{DisplayName}}` — if two fields share a display name, resolution is ambiguous. Clients must validate display name uniqueness before writing. On read, first-match wins.

### `cards.decay.flashcard.media`

Shared media blob storage. Media files are stored in a dedicated collection rather than embedded per-note. Multiple notes can reference the same media record by filename, avoiding duplicate blob uploads.

```json
{
  "lexicon": 1,
  "id": "cards.decay.flashcard.media",
  "defs": {
    "main": {
      "type": "record",
      "key": "any",
      "description": "Record key is the normalized filename (see key normalization below). One record per unique media file.",
      "record": {
        "type": "object",
        "required": ["filename", "blob", "createdAt", "updatedAt"],
        "properties": {
          "filename": { "type": "string", "minLength": 1, "maxLength": 256, "description": "Original display filename (may contain unicode, spaces, etc.)" },
          "blob": { "type": "blob", "accept": ["image/*", "audio/*", "video/*"], "maxSize": 52428800 },
          "mimeType": { "type": "string", "maxLength": 128 },
          "createdAt": { "type": "string", "format": "datetime" },
          "updatedAt": { "type": "string", "format": "datetime" }
        }
      }
    }
  }
}
```

> **Why separate media collection?** Anki .apkg files use a global media folder — the same `image.png` may be referenced by hundreds of notes. Embedding blob refs in each note record would duplicate the same blob hundreds of times, causing massive storage bloat. By storing media in a shared collection keyed by filename, each unique file is uploaded once. Notes reference media by filename in their HTML (e.g., `<img src="image.png">`), and the renderer resolves filenames against this collection.
>
> **Record key normalization**: AT Protocol record keys allow `[a-zA-Z0-9._:~-]` and must be ≤512 chars. Anki filenames can contain unicode, spaces, and special characters. The key normalization algorithm:
> 1. Normalize the filename to Unicode NFC form (macOS uses NFD; without NFC normalization, the same visual filename produces different keys)
> 2. Encode the NFC filename as UTF-8 bytes
> 3. For each byte that is not `[a-zA-Z0-9._~:_-]` (includes underscore `_` and colon `:` — both valid in atproto record keys), replace with `-XX` where XX is the hex value
> 4. If the result exceeds 480 chars, truncate to 480 and append `-` + first 31 chars of SHA-256 hex digest of the full NFC filename bytes. This is deterministic (no read-race for collision detection) and stays within 512 chars.
>
> The `filename` field in the record body stores the original display name. The renderer maps `<img src="画像 (1).png">` → normalize each byte → key `-e7-94-bb-e5-83-8f-20-281-29.png` → fetches the media record → serves the blob.
>
> **updatedAt for replacements**: Media records are mutable — re-importing an .apkg may replace `image.png` with a different file (same filename, new content). `updatedAt` enables conflict resolution during sync (same LWW semantics as other mutable records).
>
> **Filename collision**: Media filenames are globally unique within a user's repo. If two imported decks have different files with the same name, the import renames the second file (e.g., `image.png` → `image_1.png`) and rewrites references in note field values using **DOM parsing** (same approach as media GC — parse to document fragment, walk `src`/`href`/`srcset`/`style` attributes, rewrite matching filenames). Filenames must not contain path separators (`/`, `\`) or be empty — these are stripped/rejected on import.
>
> **URL resolution in card HTML**: The renderer recognizes the following `<img src>` / `[sound:]` patterns as media references:
> - Bare filenames: `src="photo.png"` → normalized to media record key
> - `[sound:audio.mp3]` → Anki audio syntax, resolved to media record
> - Anything else (`http:`, `https:`, `data:`, `//`, `../`) is **blocked** for imported/forked content (rewritten to empty) and left as-is for user-authored content.
>
> **Rendering**: The client intercepts resource URLs in card HTML, normalizes the filename to a record key, fetches the media record's blob, and serves it as an object URL. This resolution happens at render time after sanitization.

### `cards.decay.flashcard.note`

A single note — a set of field values associated with a note type and deck.

```json
{
  "lexicon": 1,
  "id": "cards.decay.flashcard.note",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["deck", "noteType", "fields", "createdAt", "updatedAt"],
        "properties": {
          "deck": { "type": "string", "format": "at-uri", "description": "AT URI of the deck" },
          "noteType": { "type": "string", "format": "at-uri", "description": "AT URI of the note type (must be in this user's own repo)" },
          "ankiNoteId": { "type": "integer", "description": "Original Anki note ID from .apkg import. Globally unique within a user's repo — dedup checks all notes regardless of deck." },
          "forkedFrom": { "type": "string", "format": "at-uri", "description": "AT URI of the source note this was forked from. Set on fork, unused in MVP. Enables Phase 3+ upstream update detection per-note." },
          "fields": {
            "type": "array",
            "minLength": 1,
            "maxLength": 64,
            "description": "Field values keyed by field name. Duplicate names are invalid — clients must validate uniqueness. If a duplicate is encountered on read, first-match wins.",
            "items": {
              "type": "object",
              "required": ["fieldId", "value"],
              "properties": {
                "fieldId": { "type": "string", "minLength": 1, "maxLength": 32, "description": "Must match a field id in the referenced noteType. Using the stable id (not display name) ensures resilience to field renames." },
                "value": { "type": "string", "maxLength": 65536, "description": "Per-field max 64KB. The real constraint is the ~1MB total record size limit — clients must validate total serialized record size before writing. Most fields are <1KB in practice, but some Anki fields legitimately reach 10-30KB (long cloze definitions, HTML-heavy language cards, copy-pasted source code). On import, fields exceeding 64KB are truncated with a user warning." }
              }
            }
          },
          "tags": {
            "type": "array",
            "maxLength": 256,
            "items": { "type": "string", "maxLength": 128 }
          },
          "createdAt": { "type": "string", "format": "datetime" },
          "updatedAt": { "type": "string", "format": "datetime" }
        }
      }
    }
  }
}
```

> **No embedded media**: Media blobs are stored in the separate `cards.decay.flashcard.media` collection, not in notes. Notes reference media by filename in their HTML field values. This avoids per-note blob duplication and keeps note records lightweight.
>
> **Field ID vs display name**: Note fields are keyed by `fieldId` (the field's stable `id`). Mustache templates use `{{DisplayName}}` — the renderer maps display names to field IDs via the noteType. If a field is renamed, existing notes render correctly because `fieldId` is unchanged.
>
> **Field id uniqueness**: Field `id` must be unique within a noteType. Clients must validate before writing.
>
> **Field added to noteType**: Existing notes without the new field → treated as empty string at render time. Notes are NOT retroactively updated.
>
> **Field removed from noteType**: Existing notes retain the orphaned `fieldId` entry in their `fields` array. It is preserved on read/write but ignored at render time. This allows restoration if the field is re-added.
>
> **Duplicate field names**: Clients must validate field name uniqueness before writing. On read, first-match wins.
>
> **noteType must be local**: The `noteType` AT URI must point to a record in the same user's repo. When forking a deck from another user, the noteType is deep-copied (see [Deck Forking](#deck-forking-deep-copy)).
>
> **ankiNoteId concurrent import**: If two devices import the same .apkg simultaneously (before either syncs), both create notes with the same `ankiNoteId` but different TIDs. The client surfaces these in a "Potential Duplicates" UI (similar to Anki's "Find Duplicates" feature). The user can manually merge: pick a survivor, and the client deletes the other note along with its reviewState records. ReviewLog entries referencing the deleted note are **not** mutated (this would violate the append-only contract) — they become orphaned but are harmless for stats (slightly over-counted reviews for one card). Automatic merging is not attempted because it would require mutating reviewLogs or introducing a note-alias indirection layer, both of which add significant complexity for a rare edge case.
>
> **ankiNoteId cross-profile collisions**: `ankiNoteId` uniqueness is only guaranteed within a single Anki profile. If a user imports .apkg files from two different Anki profiles, note IDs may collide legitimately (different notes, same ID). The client cannot distinguish this from a genuine duplicate. In practice this is rare — most users have one Anki profile. If it occurs, the import treats the collision as an update (LWW by mod timestamp), which may overwrite an unrelated note. Users importing from multiple profiles should use separate decks and verify imports manually.

### `cards.decay.flashcard.reviewState`

Scheduling checkpoint for a reviewable card. Each (note + template) pair has exactly one reviewState record. This record is a **materialized cache** derived from the card's reviewLog history — on multi-device sync conflict, it is recomputed by replaying the merged reviewLogs (see [Architectural Decisions](#event-sourcing-vs-crud-for-scheduling-state)).

The `algorithm` field acts as a discriminator: when `algorithm` is `"sm2"`, the `easeFactor` field is present and `stability`/`difficulty` are omitted. When `algorithm` is `"fsrs"`, `stability` and `difficulty` are present and `easeFactor` is omitted.

```json
{
  "lexicon": 1,
  "id": "cards.decay.flashcard.reviewState",
  "defs": {
    "main": {
      "type": "record",
      "key": "any",
      "description": "Record key is {noteTid}_{templateId} (e.g., '3jqfcqzm322as_card1'). For cloze notes, templateId is the cloze ordinal prefixed with 'c' (e.g., '3jqfcqzm322as_c1' for {{c1::...}}).",
      "record": {
        "type": "object",
        "required": ["note", "templateId", "algorithm", "phase", "createdAt", "updatedAt"],
        "properties": {
          "note": { "type": "string", "format": "at-uri" },
          "templateId": { "type": "string", "minLength": 1, "maxLength": 32 },
          "algorithm": { "type": "string", "enum": ["sm2", "fsrs"] },
          "phase": { "type": "string", "enum": ["new", "learning", "review", "relearning"] },
          "due": { "type": "string", "format": "datetime" },
          "intervalDays": { "type": "number", "description": "Review-phase interval in days. Set when phase is 'review'." },
          "intervalMinutes": { "type": "number", "description": "Learning/relearning-phase interval in minutes. Set when phase is 'learning' or 'relearning'." },
          "learningStepIndex": { "type": "integer", "minimum": 0, "description": "Current position in the learningSteps (or relearningSteps) array. 0 = first step. Required when phase is 'learning' or 'relearning'. On 'Good' answer, advances to next step. When index reaches array length, card graduates." },
          "easeFactor": { "type": "number", "description": "SM-2 ease factor (1.3-3.0+). Present when algorithm is 'sm2'." },
          "reps": { "type": "integer", "minimum": 0 },
          "lapses": { "type": "integer", "minimum": 0 },
          "stability": { "type": "number", "description": "FSRS stability parameter. Present when algorithm is 'fsrs'." },
          "difficulty": { "type": "number", "description": "FSRS difficulty parameter (0.0-1.0). Present when algorithm is 'fsrs'." },
          "suspended": { "type": "boolean" },
          "suspendedChangedAt": { "type": "string", "format": "datetime", "description": "When suspended was last changed (to true OR false). Used for per-flag merge: later suspendedChangedAt wins, taking both the boolean and the timestamp." },
          "buried": { "type": "boolean" },
          "buriedChangedAt": { "type": "string", "format": "datetime", "description": "When buried was last changed (to true OR false). Used for per-flag merge." },
          "buriedDate": { "type": "string", "minLength": 10, "maxLength": 10, "description": "YYYY-MM-DD when buried (per settings.timezone + dayStartHour). Used for day-boundary unbury. Not set when buried=false." },
          "orphaned": { "type": "boolean", "description": "Set when the corresponding cloze marker is removed. Card excluded from queue but scheduling state preserved. Cleared if marker is restored." },
          "orphanedAt": { "type": "string", "format": "datetime", "description": "When orphaned was set. Used for 30-day GC." },
          "lastReviewed": { "type": "string", "format": "datetime" },
          "createdAt": { "type": "string", "format": "datetime" },
          "updatedAt": { "type": "string", "format": "datetime" }
        }
      }
    }
  }
}
```

> **Deterministic keys**: The record key is `{noteTid}_{templateId}` (e.g., `3jqfcqzm322as_card1`). This ensures exactly one reviewState per reviewable card and allows idempotent `putRecord` calls.
>
> **createdAt semantics**: Set once when the reviewState is first created. Represents "when this card was first introduced." Card maturity is derived from `createdAt` + current interval. On LWW merge (Phase 1), use `min(local.createdAt, remote.createdAt)` to preserve the earliest introduction time even if the other side's record wins overall.
>
> **learningStepIndex**: Critical for step progression. The step sequence is defined in `deckSettings.learningSteps` (or `relearningSteps` for relearning). If deckSettings changes while a card is in learning and `learningStepIndex` exceeds the new array length, the client **clamps to the last valid index** (newLength - 1). This is minimally disruptive: the card is one "Good" away from graduation, matching the intent of a shortened step sequence. All deckSettings values are read at review time from current settings.
>
> **Conditional requirement**: `learningStepIndex` is semantically required when phase is `"learning"` or `"relearning"`, but Lexicon cannot express conditional requirements. A client that writes a learning-phase card without `learningStepIndex` is buggy. Other clients should treat missing `learningStepIndex` as 0 (first step) to be resilient.
>
> **Burying is persistent**: Unlike desktop Anki where burying is ephemeral, `buried: true` persists to PDS. When burying, set `buried: true`, `buriedChangedAt` to current timestamp, and `buriedDate` to the current YYYY-MM-DD (computed using `settings.timezone` + `dayStartHour`, NOT device-local timezone). When unburying, set `buried: false` and `buriedChangedAt` to current timestamp. On app open, unburies all cards where `buried: true` and `buriedDate` < today (per `settings.timezone` + `dayStartHour`). Using `buriedDate` from settings rather than device-local timezone prevents cross-timezone races where device B prematurely unburies a card buried by device A in a different timezone.
>
> **`due` is semantically required for non-new phases**: `due` is not in the `required` array (new cards have no due date — they're ordered by `createdAt`). For `learning`, `review`, and `relearning` phases, `due` must be set. Clients must set `due` when transitioning a card out of "new" phase. On read, a non-new card without `due` is treated as due immediately (defensive fallback).
>
> **Leech handling**: When a card's `lapses` reaches `leechThreshold` (from deckSettings), the client auto-suspends the card (`suspended: true`) and shows a notification ("Card suspended as leech"). This matches Anki's default behavior. The user can unsuspend manually from the card browser.

### `cards.decay.flashcard.reviewLog`

Log entry for each review action. **Append-only for live cards** — entries are never modified after creation, and deletion is only permitted as part of a deck cascade (when the entire card and its note are being deleted) or via pre-sync undo. Once on PDS, a reviewLog entry is not individually mutable or deletable. This invariant is load-bearing: Phase 2 log-replay reconciliation relies on a complete, immutable log history for any card that still exists.

```json
{
  "lexicon": 1,
  "id": "cards.decay.flashcard.reviewLog",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["note", "templateId", "answer", "phase", "algorithm", "reviewedAt"],
        "properties": {
          "note": { "type": "string", "format": "at-uri" },
          "deck": { "type": "string", "format": "at-uri", "description": "Deck the note belonged to at review time. Stamped for permanent limit attribution — moving a note between decks doesn't retroactively reassign past reviews." },
          "templateId": { "type": "string", "minLength": 1, "maxLength": 32 },
          "answer": { "type": "string", "enum": ["again", "hard", "good", "easy"] },
          "phase": { "type": "string", "enum": ["new", "learning", "review", "relearning"], "description": "'new' = first-ever review of a new card. Determines interval unit: 'review' = days, others = minutes." },
          "algorithm": { "type": "string", "enum": ["sm2", "fsrs"] },
          "intervalBeforeDays": { "type": "number", "description": "Previous interval in days. Set when phase (before review) was 'review'." },
          "intervalBeforeMinutes": { "type": "number", "description": "Previous interval in minutes. Set when phase (before review) was 'new', 'learning', or 'relearning'." },
          "intervalAfterDays": { "type": "number", "description": "New interval in days. Set when card graduates to or remains in review phase." },
          "intervalAfterMinutes": { "type": "number", "description": "New interval in minutes. Set when card stays in or enters learning/relearning phase." },
          "easeFactorBefore": { "type": "number", "description": "SM-2 only." },
          "easeFactorAfter": { "type": "number", "description": "SM-2 only." },
          "stabilityBefore": { "type": "number", "description": "FSRS only." },
          "stabilityAfter": { "type": "number", "description": "FSRS only." },
          "difficultyBefore": { "type": "number", "description": "FSRS only." },
          "difficultyAfter": { "type": "number", "description": "FSRS only." },
          "phaseAfter": { "type": "string", "enum": ["new", "learning", "review", "relearning"], "description": "Card phase after this review." },
          "repsAfter": { "type": "integer", "minimum": 0 },
          "lapsesAfter": { "type": "integer", "minimum": 0 },
          "learningStepIndexAfter": { "type": "integer", "minimum": 0, "description": "Set when phaseAfter is learning/relearning." },
          "timeTaken": { "type": "integer", "description": "Milliseconds spent reviewing" },
          "reviewedAt": { "type": "string", "format": "datetime" },
          "resolvedDate": { "type": "string", "minLength": 10, "maxLength": 10, "description": "YYYY-MM-DD date this review is attributed to, computed at review time using settings.timezone + dayStartHour (NOT device-local timezone). All devices using the same settings produce the same date for the same UTC instant, making studySummary rebuilds deterministic." }
        }
      }
    }
  }
}
```

> **Graduation records have both units**: When a card graduates (learning → review), `intervalBeforeMinutes` is set (the learning step) and `intervalAfterDays` is set (the graduating interval). Both fields present on the same record is valid and expected — the phase transition changes the unit.
>
> **reviewedAt is authoritative for timestamps**: The TID key encodes a creation timestamp used only for sync ordering (cursor-based incremental fetch). `reviewedAt` is the authoritative timestamp for stats, studySummary attribution, and display. In normal operation they match, but if there's clock drift or TID generation anomalies, `reviewedAt` takes precedence for all non-sync purposes.

### `cards.decay.flashcard.cardFlag`

User-assigned visual flags, separated from reviewState to avoid `updatedAt` churn on scheduling records.

```json
{
  "lexicon": 1,
  "id": "cards.decay.flashcard.cardFlag",
  "defs": {
    "main": {
      "type": "record",
      "key": "any",
      "description": "Record key matches the reviewState key ({noteTid}_{templateId}). Only exists for flagged cards.",
      "record": {
        "type": "object",
        "required": ["note", "templateId", "flag", "createdAt", "updatedAt"],
        "properties": {
          "note": { "type": "string", "format": "at-uri" },
          "templateId": { "type": "string", "minLength": 1, "maxLength": 32 },
          "flag": { "type": "string", "enum": ["red", "orange", "green", "blue", "pink", "turquoise", "purple"] },
          "createdAt": { "type": "string", "format": "datetime" },
          "updatedAt": { "type": "string", "format": "datetime" }
        }
      }
    }
  }
}
```

### `cards.decay.flashcard.settings`

Per-user global settings. Single record (self key).

```json
{
  "lexicon": 1,
  "id": "cards.decay.flashcard.settings",
  "defs": {
    "main": {
      "type": "record",
      "key": "literal:self",
      "record": {
        "type": "object",
        "required": ["updatedAt"],
        "properties": {
          "defaultAlgorithm": { "type": "string", "enum": ["sm2", "fsrs"] },
          "timezone": { "type": "string", "description": "IANA timezone identifier (e.g., 'America/New_York'). Clients must reject non-IANA values on write. Used for resolvedDate, buriedDate, and studySummary date computation." },
          "dayStartHour": { "type": "integer", "minimum": 0, "maximum": 23 },
          "updatedAt": { "type": "string", "format": "datetime" }
        }
      }
    }
  }
}
```

> Hardcoded defaults when omitted: `defaultAlgorithm` → `"fsrs"`, `dayStartHour` → `4`, `timezone` → system timezone. **Algorithm resolution chain**: `deckSettings.algorithm` → `settings.defaultAlgorithm` → `"fsrs"`. If the `settings` record doesn't exist (new account), hardcoded defaults apply directly. Timezone defaults to system timezone (the client uses `Intl.DateTimeFormat().resolvedOptions().timeZone` if not explicitly set). The resolved timezone affects studySummary date attribution and day-boundary calculations.

### `cards.decay.flashcard.deckSettings`

Per-deck scheduler overrides. Omitted fields fall through to hardcoded app defaults.

```json
{
  "lexicon": 1,
  "id": "cards.decay.flashcard.deckSettings",
  "defs": {
    "main": {
      "type": "record",
      "key": "any",
      "description": "Record key matches the deck's TID.",
      "record": {
        "type": "object",
        "required": ["deck", "updatedAt"],
        "properties": {
          "deck": { "type": "string", "format": "at-uri" },
          "algorithm": { "type": "string", "enum": ["sm2", "fsrs"] },
          "newCardsPerDay": { "type": "integer", "minimum": 0, "description": "App default: 20" },
          "reviewsPerDay": { "type": "integer", "minimum": 0, "description": "App default: 200" },
          "learningSteps": { "type": "array", "maxLength": 32, "items": { "type": "number", "minimum": 0.01 }, "description": "In minutes. App default: [1, 10]" },
          "relearningSteps": { "type": "array", "maxLength": 32, "items": { "type": "number", "minimum": 0.01 }, "description": "In minutes. App default: [10]" },
          "graduatingInterval": { "type": "number", "minimum": 0.01, "description": "In days. App default: 1" },
          "easyInterval": { "type": "number", "minimum": 0.01, "description": "In days. App default: 4" },
          "startingEase": { "type": "number", "minimum": 1.3, "description": "App default: 2.5" },
          "easyBonus": { "type": "number", "minimum": 1.0, "description": "App default: 1.3" },
          "hardMultiplier": { "type": "number", "minimum": 0.5, "description": "App default: 1.2" },
          "intervalModifier": { "type": "number", "minimum": 0.01, "description": "App default: 1.0" },
          "maximumInterval": { "type": "integer", "minimum": 1, "description": "In days. App default: 36500" },
          "lapseNewInterval": { "type": "number", "minimum": 0.0, "description": "App default: 0.0" },
          "leechThreshold": { "type": "integer", "minimum": 1, "description": "App default: 8" },
          "buryNewSiblings": { "type": "boolean", "description": "Auto-bury other new cards from the same note when one is reviewed. App default: true" },
          "buryReviewSiblings": { "type": "boolean", "description": "Auto-bury other review cards from the same note when one is reviewed. App default: true" },
          "desiredRetention": { "type": "number", "minimum": 0.5, "maximum": 0.99, "description": "FSRS target retention. App default: 0.9" },
          "fsrsWeights": { "type": "array", "maxLength": 128, "items": { "type": "number" }, "description": "FSRS model weights. Ceiling set high (128) to avoid Lexicon-level migration when FSRS versions add parameters." },
          "fsrsVersion": { "type": "integer", "minimum": 4, "description": "FSRS algorithm version (4, 5, etc.). Determines how fsrsWeights are interpreted. App default: 5" },
          "updatedAt": { "type": "string", "format": "datetime" }
        }
      }
    }
  }
}
```

> **fsrsVersion**: FSRS has gone through multiple versions with different parameter counts (v4: 17 weights, v5: 19 weights). `fsrsVersion` disambiguates which version the `fsrsWeights` array corresponds to. If omitted, the client uses the current default (v5). When FSRS is updated, old weights are re-optimized or the client falls back to default weights for the new version.

### `cards.decay.flashcard.studySummary`

Per-day study summary. Rebuilt from reviewLogs and synced for cross-device streak visibility.

```json
{
  "lexicon": 1,
  "id": "cards.decay.flashcard.studySummary",
  "defs": {
    "main": {
      "type": "record",
      "key": "any",
      "description": "Record key is the date string (YYYY-MM-DD, exactly 10 chars). One record per study day.",
      "record": {
        "type": "object",
        "required": ["date", "reviewCount", "updatedAt"],
        "properties": {
          "date": { "type": "string", "minLength": 10, "maxLength": 10, "description": "YYYY-MM-DD per settings.timezone and dayStartHour. Same as the record key." },
          "reviewCount": { "type": "integer", "minimum": 0 },
          "newCount": { "type": "integer", "minimum": 0, "description": "New cards studied" },
          "timeSpentMs": { "type": "integer", "minimum": 0, "description": "Total review time in milliseconds" },
          "againCount": { "type": "integer", "minimum": 0 },
          "hardCount": { "type": "integer", "minimum": 0 },
          "goodCount": { "type": "integer", "minimum": 0 },
          "easyCount": { "type": "integer", "minimum": 0 },
          "updatedAt": { "type": "string", "format": "datetime" }
        }
      }
    }
  }
}
```

> **Derived from reviewLogs (ground truth)**: studySummary is a materialized cache. On app open, the client rebuilds today's summary by grouping reviewLogs by `resolvedDate`. On sync conflict, the client rebuilds the summary from locally-available reviewLogs for that `resolvedDate`. **Known limitation**: if two devices have incomplete views of each other's logs (mid-sync), rebuild can produce transiently incorrect counts that flap until all logs converge. This is bounded — once all reviewLogs sync (full traversal), summaries stabilize. Streak calculations should tolerate ±1 day of flapping. Sync order: reviewLogs sync first, then studySummary rebuild.
>
> **Study streaks**: Computed by checking consecutive dates with `reviewCount > 0`. Available immediately on device switch without scanning all logs.
>
> **Why sync at all if derived?** Rebuilding from all reviewLogs for every historical date would be expensive. Syncing summaries gives O(1) access to historical stats. Only the current day (and conflicting dates) are ever rebuilt from logs.
>
> **Timezone/dayStartHour changes**: The `date` key is computed at review time using the then-current timezone and dayStartHour. If these settings change, future reviews attribute to dates computed with the new settings. Historical summaries are not recomputed — they reflect the timezone that was active when the reviews occurred. This can cause a one-day discontinuity in streak calculations after a timezone change, which is acceptable.

---

## Record Key Conventions

Records use two key types:

| Key type | Usage | Why |
|----------|-------|-----|
| `key: "tid"` | deck, noteType, note, reviewLog | Record identity is self-contained. TID is generated at creation time. |
| `key: "any"` | reviewState, deckSettings, shareDeck, forkDeck, cardFlag, studySummary, media | Record key is semantically derived (e.g., `{noteTid}_{templateId}` for reviewState, deck TID for deckSettings/shareDeck, normalized filename for media, date string for studySummary, local deck TID for forkDeck). This enables idempotent upserts and enforces 1:1 relationships. |

> **AT URIs are DID-based**: All AT URIs use the user's DID (e.g., `at://did:plc:abc123/cards.decay.flashcard.deck/3jqf...`), not handle-based URIs. DIDs are permanent — they survive PDS migration and handle changes. Cross-repo references (e.g., `forkDeck.sourceDeck`) remain resolvable as long as the source user's DID exists in the network.

---

## Cloze Note Types

Cloze is Anki's second most popular note type. The number of reviewable cards is determined by `{{c1::...}}`, `{{c2::...}}` markers in field values, not by explicit template entries.

### How cloze maps to this data model

1. **noteType**: `isCloze: true`, exactly one template entry (the rendering shell with `{{cloze:FieldName}}`).
2. **Note**: Field values contain `{{c1::answer::hint}}` markers.
3. **reviewState**: `templateId` is the cloze ordinal prefixed with `c` (`"c1"` for `{{c1::...}}`, `"c2"` for `{{c2::...}}`). Key: `{noteTid}_c1`. The `c` prefix prevents collision with non-cloze template IDs — without it, switching a noteType to `isCloze: true` could collide with existing template IDs like `"1"`, `"2"`.
4. **Card generation**: Client scans fields for `{{cN::...}}` patterns, generates one card per unique ordinal.
5. **Adding/removing markers**: New ordinals get reviewState on first review. When a cloze marker is removed (note edited), the reviewState is marked `orphaned: true` — **all scheduling state is left intact** (phase, interval, easeFactor, stability, reps, lapses). The card is excluded from the review queue while orphaned. If the marker is restored (e.g., user fixes a typo), `orphaned` is cleared and the card resumes with its full scheduling history. After 30 days in orphaned state (checked during periodic GC), the reviewState is permanently deleted.

> **Non-contiguous ordinals**: Gaps are allowed (c1 + c3, no c2). Clients must not assume contiguous ordinals.
>
> **Max cloze ordinal**: Clients cap at ordinal 500 (matching Anki's limit). `{{c501::...}}` and higher are ignored during card generation.
>
> **Queue building**: Cloze ordinal discovery requires regex-scanning field values. The client caches active ordinals per note in IndexedDB, invalidated on `updatedAt` change.

---

## Moving Notes Between Decks

Updating `note.deck` moves a note to a different deck. Implications:

- **reviewState records are unaffected**: They reference the note, not the deck. The card's scheduling state is preserved.
- **Algorithm mismatch**: If the source deck uses SM-2 and the target deck uses FSRS, existing reviewState records retain their SM-2 fields. The client does **not** auto-convert on move. On the next review, the card is reviewed under the new deck's algorithm — see [Algorithm Switching](#algorithm-switching) for the conversion that happens at that point.
- **Daily limits**: The card counts toward the target deck's limits going forward.

---

## Algorithm Switching

When a deck's algorithm changes (e.g., from SM-2 to FSRS via deckSettings), existing reviewState records have fields for the old algorithm. Conversion strategy:

### SM-2 → FSRS

On the **next review** of each card (not eagerly on all cards):
1. Initialize FSRS `stability` from the card's current `intervalDays` (stability ≈ interval for mature cards)
2. Initialize FSRS `difficulty` from `easeFactor`: `difficulty = (3.0 - easeFactor) / 1.7` (clamped to 0.0-1.0)
3. Clear `easeFactor` from the record
4. Set `algorithm: "fsrs"`

### FSRS → SM-2

On the **next review** of each card:
1. Initialize `easeFactor` from FSRS `difficulty`: `easeFactor = 3.0 - (difficulty * 1.7)` (clamped to 1.3-3.0)
2. `intervalDays` is kept as-is (FSRS and SM-2 intervals are comparable)
3. Clear `stability` and `difficulty` from the record
4. Set `algorithm: "sm2"`

### Queue building with algorithm mismatch

The scheduler must detect algorithm mismatch during queue building (not just at review time) because it needs to show interval previews on answer buttons. The logic:

1. For each reviewState, compare `reviewState.algorithm` against the deck's effective algorithm (from deckSettings or global default)
2. If they differ, the card is marked as "pending conversion" in the queue
3. For interval preview display: use the target algorithm's formulas with the converted parameters (computed speculatively for display only)
4. On actual review: perform the conversion, compute the new interval, and write both the converted state and new scheduling in a single update

### Why lazy conversion?

Eager conversion of thousands of cards would flood the outbox and cause a massive sync burst. Lazy conversion spreads the load — each card is converted on its next natural review.

Cards in "new" phase don't need conversion — they haven't been reviewed yet and will use the new algorithm from their first review.

---

## Referential Integrity & Cascading Deletes

AT Protocol records have no foreign key constraints. The client manages integrity.

### Deck deletion

Cascades to:
1. All **notes** in the deck
2. All **reviewState** records for those notes
3. All **reviewLog** records for those notes
4. All **cardFlag** records for those notes
5. The deck's **deckSettings** record
6. The deck's **shareDeck** record
7. Any **forkDeck** records referencing the deck as `localDeck`
8. Child **decks** (recursive)

**Soft-delete, then cascade**: The deck record itself is **not** hard-deleted. Instead, a `deletedAt` timestamp field is set on it. The deck disappears from the UI immediately, and the cascade (deleting child records) is queued in the outbox as a "cascade group" with a shared group ID. The outbox drain processes them via `applyWrites` batches (up to 200 ops AND 5 MB per call). If the drain is interrupted, remaining cascade entries persist for the next cycle.

**Cross-device cascade**: Any device that syncs and sees a deck with `deletedAt` set can independently compute and execute the cascade — list all notes with `deck` pointing to this deck URI, then delete their reviewStates, reviewLogs, and cardFlags. ReviewLogs are append-only for **live cards** (where replay might run), but deletable as part of a deck cascade — the append-only invariant exists to prevent scheduling corruption, not to preserve history for deleted content.

**Temporal guard**: The cascade only deletes notes where `note.createdAt < deck.deletedAt`. Notes created after the deck was marked deleted (e.g., by an offline device that hadn't synced yet) are auto-moved to the user's **default deck** (the first deck by creation date, or a newly-created "Default" deck if none exists) rather than deleted. Using the default deck avoids the race where multiple devices each create independent "Recovered" decks.

The deck record (with `deletedAt`) stays permanently as a tombstone (~200 bytes each). It is never hard-deleted — the cost is negligible (even 1000 deleted decks = ~200KB) and removing it would strand long-offline devices that need the temporal guard.

This eliminates the separate `deletedDeck` tombstone record and solves the "originating device disappears" problem — any device can finish the cascade because the deck record (with `deletedAt`) remains readable.

**Orphan reconciliation**: During sync, if a local record references a note that doesn't exist remotely, check whether the note's deck has `deletedAt` set. If yes, delete the orphan locally and queue a PDS delete. If the deck is also gone (shouldn't happen — deck stays until cascade completes), delete the orphan locally only.

### NoteType deletion

**Cannot be deleted while notes reference it.** Client prevents this. Orphaned noteTypes can be deleted freely.

### Orphaned records

Orphaned reviewState/reviewLog/cardFlag records (referencing nonexistent notes) are ignored by the scheduler and cleaned up during full reconciliation.

---

## Social Features

### `cards.decay.flashcard.shareDeck`

Makes a deck publicly discoverable. This is a **discoverability signal**, not an access control mechanism — AT Protocol repos are public by default, so anyone who knows the DID and collection can `listRecords` on a user's notes regardless of whether a `shareDeck` record exists. **All flashcard data is inherently public on atproto.** Users who need truly private decks would require a different architecture (e.g., encrypted record values), which is out of scope. The shareDeck record signals intentional sharing: clients use it to populate discovery UI, and the absence of a shareDeck record tells other clients "this user hasn't opted into sharing this deck."

```json
{
  "lexicon": 1,
  "id": "cards.decay.flashcard.shareDeck",
  "defs": {
    "main": {
      "type": "record",
      "key": "any",
      "description": "Record key matches the deck's TID.",
      "record": {
        "type": "object",
        "required": ["deck", "createdAt", "updatedAt"],
        "properties": {
          "deck": { "type": "string", "format": "at-uri" },
          "title": { "type": "string", "maxLength": 256, "description": "Public-facing title. Falls back to deck.name if omitted." },
          "description": { "type": "string", "maxLength": 2048, "description": "Public-facing description. Independent of deck.description (which is private)." },
          "tags": { "type": "array", "maxLength": 32, "items": { "type": "string", "maxLength": 128 } },
          "createdAt": { "type": "string", "format": "datetime" },
          "updatedAt": { "type": "string", "format": "datetime" }
        }
      }
    }
  }
}
```

### `cards.decay.flashcard.forkDeck`

Immutable record created when forking another user's deck. Never updated. Deleted when the local deck copy (`localDeck`) is deleted — cascading from deck deletion. Source-deck disappearance does NOT delete the forkDeck (it's provenance metadata for the local copy).

```json
{
  "lexicon": 1,
  "id": "cards.decay.flashcard.forkDeck",
  "defs": {
    "main": {
      "type": "record",
      "key": "any",
      "description": "Record key matches local deck copy's TID. Immutable.",
      "record": {
        "type": "object",
        "required": ["sourceDeck", "localDeck", "forkedAt", "createdAt"],
        "properties": {
          "sourceDeck": { "type": "string", "format": "at-uri" },
          "localDeck": { "type": "string", "format": "at-uri" },
          "forkedAt": { "type": "string", "format": "datetime" },
          "createdAt": { "type": "string", "format": "datetime" }
        }
      }
    }
  }
}
```

### Deck Forking (Deep Copy)

When a user forks another user's shared deck, the client performs a **deep copy** into the local repo:

1. **Copy noteTypes**: For each noteType referenced by the source deck's notes, query local noteTypes for matching `forkedFrom` URI. If multiple matches (from prior forks), pick the one with the latest `createdAt`. Compare its content (fields, templates, css) against the source — if unchanged, reuse it. If diverged (user edited it), create a new local noteType with fresh content from source and new `forkedFrom`. If no match, create new local noteType with `forkedFrom` set to source URI.

2. **Copy media first**: Scan all source note field values for media references. For each filename, check if it exists in the local media collection:
   - If it exists with the same content (compare via `BlobRef.ref.$link` CIDs from record bodies — no blob download required): reuse it.
   - If it exists with different content: rename the incoming file (e.g., `image.png` → `image_fork1.png`) and track the rename mapping.
   - If it doesn't exist: fetch the blob from the source PDS and upload to the local PDS. If `uploadBlob` fails (e.g., local PDS has a smaller size limit than source), log the failure in the `forkProgress` entry and continue — the note is still copied. The UI shows failed media files with sizes and offers a **retry** button for individual blobs (useful if the failure was transient). Failed blobs are tracked in `forkProgress` until retried or dismissed.

3. **Copy notes**: For each note in the source deck, create a local note record with:
   - `deck` pointing to the new local deck
   - `noteType` rewritten to point to the local noteType copy (from step 1)
   - Field values with media filenames rewritten per the rename mapping (from step 2)
   - No `ankiNoteId` (this is a fork, not an Anki import)

4. **Create deck + forkDeck records**: Create the local deck and the forkDeck record linking it to the source.

5. **No reviewState copied**: Forked notes start fresh (all cards in "new" phase).

#### Fork resumability

Forking a large deck (5K+ notes, 2K+ media) is a long-running operation. If interrupted (tab closed, network failure), partial state must be recoverable:

- The client creates a `forkProgress` entry in local IndexedDB tracking: source deck URI, local deck TID, which notes/media have been copied, rename mappings.
- On app open, if a `forkProgress` entry exists, the fork resumes from where it left off.
- **Source deletion mid-fork**: If a note or blob returns 404 during fork, it is flagged as skipped in `forkProgress` and the fork continues. The UI shows which items were unavailable. The fork does not stall on missing source data.
- Once complete, the `forkProgress` entry is deleted (or retained if there are failed blobs pending retry).
- The local deck is marked as "importing" in the UI until the fork completes. Notes already copied are reviewable immediately.

> **NoteType ownership**: Notes must always reference a noteType in the same user's repo. This ensures cards are always renderable regardless of the source user's PDS availability. If the source user modifies their noteType or deletes their account, forked decks continue to work.
>
> **NoteType dedup across devices**: The noteType schema includes an optional `forkedFrom` field (AT URI of the source noteType). When forking, this is set on the copied noteType. Any device can find the local copy of a source noteType by querying for `forkedFrom` matches, eliminating the need for a local-only mapping that would be lost on device switch.
>
> **Source no longer shared**: If the source user deletes their `shareDeck` record (makes it private), the local fork and `forkDeck` record are unaffected — all content was deep-copied. The client hides "check for upstream updates" UI if it can't read the source deck's notes (403/404). The `forkDeck` record remains as provenance metadata.
>
> **Fork reads all source notes**: To find notes in the source deck, the client must `listRecords` on the source user's note collection and filter by `deck` URI client-side (since `listRecords` doesn't filter by field value). For a source user with 50K notes across 20 decks, this downloads all 50K note records to find the target subset. This is a known inefficiency — an AppView query endpoint (e.g., `cards.decay.flashcard.getDeckNotes`) would eliminate it. For the MVP, this is acceptable since forking is an infrequent operation and the data is relatively small (50K × 500B = 25MB).

### Shared Deck Discovery (MVP)

Limited to direct handle entry and link sharing. No global search without an AppView.

### Upstream Update Pull — Out of Scope for MVP

One-time forking only. Upstream sync specced separately in Phase 3+.

---

## Content Security

### Sanitization Policy

1. **All content** (own and forked): Rendered in `sandbox=""` iframe (no JS). The sanitizer uses **DOMPurify** (or equivalent) configured with an **allowlist**: only `<div>`, `<span>`, `<p>`, `<br>`, `<b>`, `<i>`, `<u>`, `<strong>`, `<em>`, `<sub>`, `<sup>`, `<ul>`, `<ol>`, `<li>`, `<table>`, `<tr>`, `<td>`, `<th>`, `<thead>`, `<tbody>`, `<img>`, `<audio>`, `<source>`, `<a>`, `<h1>`-`<h6>`, `<pre>`, `<code>`, `<blockquote>`, `<hr>`, `<ruby>`, `<rt>`, `<rp>`, `<details>`, `<summary>`, `<style>` tags survive. Attributes: `class`, `style`, `src`, `href`, `alt`, `colspan`, `rowspan`, `id`. All else stripped.
2. **All content uniformly**: The base sanitizer applies to all rendered content regardless of origin. CSS `url()`, `@import`, and `expression()` are stripped from **all** content (own, imported, and forked) — not just forked. This prevents IP-leaking network requests from CSS even in `sandbox=""` iframes, which block scripts but not resource fetches. `<a href>` is restricted to `https:` scheme only; `javascript:`, `data:`, `vbscript:` URIs are stripped. All links get `rel="noopener noreferrer" target="_blank"`. Forked content additionally gets CSS scoping (no `position: fixed`, no `z-index` escaping).
3. **Rendering pipeline**: Mustache expansion (single-pass, no re-evaluation) → cloze expansion → sanitization → iframe render. The supported mustache syntax is: `{{FieldName}}` (insert field value), `{{#FieldName}}...{{/FieldName}}` (section: render if field non-empty), `{{^FieldName}}...{{/FieldName}}` (inverted: render if field empty), `{{cloze:FieldName}}` (cloze rendering), `{{type:FieldName}}` (rendered as static answer display), `{{hint:FieldName}}` (rendered as a click-to-reveal block), `{{FrontSide}}` (on answer template: inserts the question side HTML). **Empty-card suppression**: if all `{{FieldName}}` placeholders on the question template resolve to empty (after conditional evaluation), no card is generated for that template/note pair. The sanitizer runs **after** both mustache and cloze expansion, catching malicious content in field values regardless of how it's surfaced (including cloze hints like `{{c1::answer::<img src=x onerror=...>}}`).
4. **CSS complexity**: The sanitizer limits CSS rule count (max 5000 rules) and strips animation/transition properties from forked content to prevent denial-of-rendering attacks.
5. **Iframe isolation**: Cards are rendered in an iframe on a **separate origin** to prevent card content from accessing the app's cookies, localStorage, or IndexedDB. Implementation phasing:
   - **Phase 1** (local-only): `srcdoc` iframe on the same origin with `sandbox=""`. Note: .apkg imports contain untrusted third-party HTML/CSS — imported content gets the same full sanitization pipeline (CSS scoping, URL blocking, animation stripping) as forked content. The trust boundary is the file, not the authoring mode.
   - **Phase 2+** (forked content from other users): A dedicated subdomain (e.g., `decaycards.emnudge.dev`) serves a minimal static HTML shell. The parent passes card HTML and media data (as ArrayBuffers via `postMessage`), and the shell creates local blob URLs within its own origin for media rendering. This is necessary because `sandbox=""` (opaque origin) cannot load blob URLs created by the parent — same-origin policy blocks them. The subdomain provides a real, distinct origin: the iframe can create and load its own blob URLs while being fully cross-origin to the app. The shell clears `localStorage`, `sessionStorage`, all IndexedDB databases, and Cache API entries before each card render. The shell serves with CSP: `default-src 'none'; img-src blob: data:; media-src blob: data:; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'none'`. Inline scripts are allowed (for card JS) but `connect-src 'none'` blocks fetch/XHR from card scripts — no data exfiltration via network. The parent→iframe postMessage contract: parent sends `{type: "render", html: string, media: ArrayBuffer[]}` and validates `event.origin === "https://decaycards.emnudge.dev"` on all incoming messages. The iframe sends only `{type: "ready"}` and validates `event.origin` matches the parent app domain. The parent **ignores all messages** that fail origin checks or have an unexpected `type`. `sandbox="allow-scripts allow-same-origin"` is required (scripts needed for postMessage handling + blob URL creation), but the subdomain's origin has no access to the app's data. **The shell must be on a different eTLD+1 than the app** (`decay.cards` vs `emnudge.dev`) to prevent `.decay.cards` domain-scoped cookies from being readable by the shell. A subdomain like `render.decay.cards` would NOT work because cookies set on `.decay.cards` are inherited by all subdomains. The shell has no auth endpoints, no analytics, no server-side state. If the subdomain is unavailable, fall back to Phase 1 same-origin `sandbox=""` with media inlined as data: URIs (degraded but functional).

> **JavaScript in cards**: In Phase 2+, card JS is permitted within the `decaycards.emnudge.dev` iframe — the separate-origin isolation means card scripts cannot access the app's cookies, storage, or data. The shell clears all persistent state between renders, preventing cross-card data leakage. This enables desktop-Anki-compatible features: `{{type:Field}}` (interactive type-in-the-answer), custom JS in card templates (coding exercises, drag-and-drop), and audio playback triggers. The shell's CSP (`script-src 'self' 'unsafe-inline'`) allows inline scripts within card HTML but blocks external script loading. In Phase 1 (same-origin `sandbox=""`), JS is blocked — `{{type:Field}}` falls back to a static `<div>` showing the answer. KaTeX renders to static HTML/MathML in all phases.
>
> **Parent app CSP**: The main app serves with: `script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; frame-src https://decaycards.emnudge.dev; connect-src https://*.bsky.network https://*.host.bsky.network; img-src 'self' blob: data:; default-src 'none'`. This ensures that even if card content escapes the iframe via a browser bug, the parent has defense-in-depth.
>
> **Media loading**: On first app open before media sync completes, notes may reference media files not yet in local IndexedDB. The renderer shows a placeholder skeleton for unresolved media and retries resolution after sync. Media records are synced as part of the full-traversal sync; large collections (2K files) add ~200 additional `listRecords` pages but blobs are fetched lazily (only when a card is rendered, not eagerly on sync). Blob data is cached in a local Cache API store after first fetch.
>
> **Media MIME type safety**: The `mimeType` field on media records is user-controlled and untrusted. The client **never** uses the stored `mimeType` to set Content-Type headers. Instead, it sniffs the actual blob content (magic bytes) to determine the real type. All media is served exclusively via `<img>` tags (which block script execution for SVGs and HTML). Media URLs are never opened in new tabs, used in `<object>`/`<embed>`, or served with user-controlled Content-Type headers.
>
> **SVG safety**: SVGs have a large attack surface: `<image>`, `<use>`, `<feImage>`, `<foreignObject>`, CSS `background-image`, `@font-face`, and `<style>` blocks can all load external resources or embed HTML. For imported and forked content, SVGs are **rasterized to PNG on import** using an offscreen canvas. This eliminates the entire SVG attack surface at the cost of losing SVG scalability. User-authored SVGs (created natively in the app) are served as-is since the user controls the content.

---

## Sync Strategy

### Authentication & Offline Token Management

The client authenticates via `@atproto/oauth-client-browser`. OAuth tokens (access + refresh) are stored in **IndexedDB** by the OAuth library (not sessionStorage — sessionStorage clears on tab close, which would force re-auth on every browser restart for a daily-use study app).

- **Token refresh**: The access token typically expires after minutes to hours. The OAuth client library handles refresh transparently using the refresh token before each PDS request.
- **Extended offline**: If the user studies offline for days, both tokens may expire. The refresh token has a longer lifetime (days to weeks, PDS-dependent). On reconnection:
  1. The outbox drain attempts a PDS write → receives 401
  2. The OAuth client attempts token refresh → if the refresh token is still valid, a new access token is obtained transparently
  3. If the refresh token has also expired, the sync engine pauses and prompts the user to re-authenticate (the outbox is preserved — no data is lost)
- **Graceful degradation**: All study functionality works offline without a valid token. The outbox accumulates writes. Only the sync engine requires authentication. The UI shows a non-blocking banner ("Re-authenticate to sync") rather than blocking the study flow.

### Write Path (Local → PDS)

1. Change applied to IndexedDB immediately
2. Queued in outbox with monotonic sequence number
3. Background worker drains outbox using `com.atproto.repo.applyWrites` (batches of up to 200 operations AND 5 MB total serialized size — both limits enforced by the client)
4. On success, outbox entries cleared

> **applyWrites failure handling**: `applyWrites` is atomic — the entire batch succeeds or fails. If a batch fails, the client first parses the PDS error response (which typically identifies the offending operation index). If parseable, dead-letter only the problematic entry and retry the rest. If the error is opaque, fall back to single-operation retries to isolate the failure. For cascading deletes, batch failure is unlikely (deletes are idempotent — 404 = success).

#### Outbox coalescing

Before drain, the outbox is compacted per record key. Coalescing only considers entries that have **not yet been sent** (i.e., entries still pending in the outbox, not entries that were sent and are awaiting confirmation):
- Multiple `put` entries for the same key → keep only the latest
- A `put` followed by a `delete` for the same key, where the `put` has not been sent → both removed (net no-op — the record was never persisted to PDS)
- A `put` followed by a `delete` for the same key, where the `put` has already been sent (success confirmed) → keep only the `delete` (must delete the record that's now on PDS)
- A `delete` followed by a `put` for the same key (re-creation) → keep only the `put` (net effect: record exists with new content)
- A `delete` for a key with no prior `put` in the outbox → keep (it deletes a PDS-sourced record)
- **Cascade + re-import race**: If a cascade group has pending deletes and a new `put` arrives for any key in that group (e.g., user re-imports a deck that's mid-delete), the `put` takes precedence — the pending delete for that key is purged. Remaining cascade deletes for other keys proceed normally.
- **FK-aware coalescing**: When a `put` is cancelled (via put+delete no-op), the outbox scans remaining pending entries for records that reference the cancelled record via known FK fields: `note.deck`, `note.noteType`, `reviewState.note`, `reviewLog.note`, `cardFlag.note`. Those dependent entries are also cancelled. This prevents orphaned puts from uploading records with dangling references.
- **Cascade purges outbox**: When a deck cascade is queued, any pending outbox entries (puts) for notes/reviewState/reviewLogs/cardFlags referencing notes in that deck are also purged. This prevents offline-queued reviewLogs from being uploaded for cascade-deleted notes, which would create orphaned records on PDS.

#### Error handling

- **Transient** (network, 5xx, 429): Retry with exponential backoff (5s → 5min). Respect `Retry-After`.
- **404 on deleteRecord**: Treated as **success** (idempotent delete — record already gone, likely from another device's cascade). Outbox entry cleared normally.
- **Other permanent failures** (4xx except 429/404): Move to dead letter queue. User actions: view error details, edit and resubmit, or discard.
- **Sync triggers**: App open, local write (debounced 5s), 5-minute polling while foregrounded, app resume (`visibilitychange` event).

> **PWA background limitations**: Browsers throttle `setInterval` in background tabs (typically to 1 call/minute or less). The 5-minute polling interval is a *foregrounded* target. While backgrounded, actual sync frequency may be lower. The `visibilitychange` event on return-to-foreground is the reliable catch-up mechanism. Service worker `periodic-background-sync` is an option but has limited browser support and requires user permission. The "stale data window" claim (≤5 minutes) applies only to foregrounded devices.

### Read Path — Full Traversal with Diffing

**Repo-rev short-circuit, then full traversal:**

1. **Repo-rev check**: Call `com.atproto.sync.getLatestCommit` to check the global repo `rev`. If unchanged since last sync, skip everything — nothing in any collection has changed. This costs 1 API call and eliminates most sync cycles for single-device flashcard-only users. For active Bluesky users, rev advances frequently (every like/post), so this filter passes through often — but it still costs only 1 call to check.

2. **Full traversal when rev has advanced**: Every mutable collection undergoes a full `listRecords` traversal (paginated, 100/page), comparing remote key-set against local IndexedDB. This handles creates, updates, deletions, and backdated entries in one pass. No per-collection short-circuit is attempted because:
   - Newest-TID peek is unsound for `any`-keyed collections (sort by key, not recency) and misses backdated TIDs from offline devices
   - `listRecords` has no `count` endpoint for record-count comparison

Full traversal is the correct approach at current scale. For users with >50K total records, Phase 4 CAR-based sync (which supports incremental MST diffing) replaces full traversal.

#### Sync apply atomicity

After fetching the full remote state, changes are applied to IndexedDB within a **single IndexedDB transaction** spanning all affected stores **including the outbox store**. The transaction scope must explicitly enumerate every store. Apply order: noteTypes → decks → notes → reviewState → other collections.

**Skip-if-pending**: Within this same transaction, for each record key, the client checks if an unsent outbox entry exists for that key whose `updatedAt` >= the remote record's `updatedAt`. If so, the remote value is skipped — the local pending write takes precedence. If the outbox entry's `updatedAt` < remote `updatedAt`, the remote value is applied and the outbox entry is discarded (it's stale). Because the check and write happen in the same transaction, there is no TOCTOU race.

#### Partial sync resumability

If a sync fails mid-*traversal* (fetching pages from PDS), progress is lost and the traversal restarts on next cycle. This is acceptable because:
- Traversal is read-only (no local state modified until all pages fetched)
- Local IndexedDB continues serving reads during sync
- The 5-15 second traversal time makes partial failure rare

For Phase 4 (>50K records), the CAR-based sync approach would support resumability via checkpoint CIDs.

#### Performance

~10K records = 5-15 seconds background sync. Doesn't block UI. The client uses **adaptive pacing** for `listRecords` calls: starts at 20 pages/second and adjusts based on `RateLimit-Remaining` / `RateLimit-Reset` headers from the PDS. On 429 responses, backs off per `Retry-After`. This prevents both over-throttling (wasting time) and under-throttling (tripping PDS burst limits).

### Conflict Resolution

- **Mutable records** (notes, decks, settings, deckSettings, cardFlag, media): Last-write-wins by `updatedAt`. Identical timestamps: PDS wins.
- **noteTypes**: **Per-element union merge**, not record-level LWW. Templates and fields are merged by stable `id`: present on both sides → per-element LWW by the record's `updatedAt`; present on one side only → include it (addition wins). `css` and `name` use record-level LWW. **Template/field deletion does not propagate across devices** — deleting a template on device A while device B still has it will re-introduce it on next sync. To permanently delete a template, all devices must be online. This is an acceptable limitation: template deletion is rare, and the union-merge prevents the more common and more damaging scenario of losing independently-added templates.
- **reviewState**: **Log-replay reconciliation** (Phase 2+). On conflict, the client collects all reviewLog entries for the card, replays them through the scheduling algorithm, and writes the computed state. This makes reviewLogs the source of truth for scheduling, not LWW timestamps. In Phase 1 (single-device), LWW by `updatedAt` is used as a simpler shortcut.
- **reviewLogs**: Append-only, no conflicts. Dedup by TID.
- **forkDeck**: Immutable. No conflict resolution needed.
- **studySummary**: Rebuilt from merged reviewLogs for the conflicting date (not LWW — see studySummary section). The rebuilt value is written back to PDS.

#### Sync serialization

The outbox drain (write path) and full-traversal read sync must not run concurrently. If a read sync fetches PDS state while outbox entries are in-flight, it may see stale records that are about to be overwritten, temporarily regressing local IndexedDB. The sync engine serializes: outbox drain runs first (pushing local changes), then read sync runs (pulling remote state). This ensures the read sync sees a PDS that includes the latest local writes.

#### Clock skew

Known limitation of timestamp-based LWW. Client warns if local clock appears >30s in the future. Rare in practice with NTP.

### Multi-Device

- `putRecord` without CID preconditions: no CAS failures
- Stale data window (≤5min for foregrounded devices) is a known limitation
- Review logs capture all reviews from all devices regardless of state conflicts
- **ReviewState conflicts (Phase 1)**: LWW — one device's scheduling update may be lost. Review logs capture both reviews (stats accurate). Conflict is logged as a warning.
- **ReviewState conflicts (Phase 2+)**: Log-replay reconciliation — on conflict, the client replays the card's merged reviewLog to compute the correct scheduling state. Both devices' reviews are incorporated. This eliminates silent scheduling data loss.

### Daily Study Limits

Per-deck "new cards seen today" and "reviews done today" counters are tracked in the **local-only** `dailyLimits` IndexedDB store (not synced). They are:
- Reset at `dayStartHour` boundary each day
- Rebuilt from today's reviewLogs on app open using each log's `deck` field (stamped at review time — not the note's current deck). This correctly attributes reviews to the deck they were studied in, even after note moves.
- **Known multi-device over-issue**: Each device enforces limits independently. Two devices studying offline both see a full budget. A user with phone + laptop can study 2× the configured new-cards limit on offline days. This is acknowledged as an acceptable tradeoff — syncing limits across devices would require resolving them before each review (latency-sensitive), which conflicts with offline-first.

**Deck settings resolution**: For all scheduler parameters, the resolution is:
1. The deck's own `deckSettings` record (if the field is present)
2. Global `settings` (for `defaultAlgorithm`, `dayStartHour`, `timezone`)
3. Hardcoded application defaults

There is no tree-walking inheritance from parent decks — this matches Anki's model where deck option groups are explicitly assigned per deck. When creating a child deck, the client copies the parent's deckSettings values into a new deckSettings record for the child. The user can then modify them independently.

**Limit inheritance**: A parent deck's `newCardsPerDay` / `reviewsPerDay` caps the total across itself and all children. The scheduler applies limits top-down: the parent's limit is consumed first, each child can only use its own limit or the parent's remaining budget, whichever is less. Note: this is limit *enforcement* (runtime queue building), not settings *inheritance* (data model).

---

## Review Undo

1. Before each review, snapshot current reviewState to local undo buffer
2. **Undo is only available before the reviewLog has been synced to PDS.** The undo button checks whether the outbox entry for the reviewLog is still pending (not yet sent). If the entry has been drained (sent to PDS), undo is disabled and the button greys out — the user must review the card again normally. If the drain completes between the user seeing "undo available" and pressing it, the undo action fails gracefully ("Review already synced — undo unavailable").
3. On undo (pre-sync only): within a single IndexedDB transaction, verify the outbox entry is still pending, restore the reviewState snapshot, delete the reviewLog from local IndexedDB, and remove the outbox entry.
4. Single-review depth, cleared on non-review actions, app close, or outbox drain.

---

## Import Path (.apkg → atproto)

```
.apkg file
  → ankiParser (format detection)
  → AnkiData { notes, decks, noteTypes, media, deckOptionGroups }
  → Transform:
      - Each Anki model        → noteType (template indices → stable ids "t0", "t1", ...)
      - Each Anki deck         → deck record
      - Each Anki note         → note record (with ankiNoteId)
      - Each card state        → reviewState record (with learningStepIndex inferred)
      - Each revlog entry      → reviewLog record
      - Each deck option group → deckSettings (flattened per deck)
      - Media files            → media collection records (deduplicated by filename)
  → Write to IndexedDB + queue for PDS sync
```

### Import idempotency

Dedup by `ankiNoteId` **globally** (not per-deck). Existing note newer → skip. Imported newer → update.

### Import rate limiting

Throttled: 10 `putRecord`/s, 2 `uploadBlob`/s. UI shows progress. Usable immediately from IndexedDB while PDS sync is background.

---

## Export Path (atproto → .apkg)

Reverse mapping for data portability:

1. Select deck(s) to export
2. Map lexicon records back to Anki SQLite schema:
   - noteType → Anki model (templates exported in array order; their `id` fields are stored in Anki's model JSON as a custom `_atprotoId` field for round-trip fidelity)
   - note → Anki note (use `ankiNoteId` if present, otherwise generate synthetic ID)
   - reviewState → Anki card (map `intervalDays`/`intervalMinutes` back to Anki's `ivl` field)
   - reviewLog → Anki revlog
   - deckSettings → deck option group (shared across exported decks with same settings)
3. Package as `.apkg` (ZIP with SQLite + media files)
4. Media resolved from the `media` collection by filename

> **ID generation**: Records without `ankiNoteId` need synthetic Anki note IDs. Anki expects IDs in the millisecond-timestamp range (~13 digits). The client extracts the microsecond timestamp embedded in the TID and divides by 1000 to get milliseconds. This produces IDs in Anki's expected range, is deterministic, and avoids collisions (TID timestamps are unique to microsecond precision; the millisecond truncation has negligible collision risk for sub-1000 notes/second creation rates).
>
> **Template ordering**: Templates are exported in their current array order. On import, template indices are mapped to stable IDs (`"t0"`, `"t1"`, etc.), so export can reconstruct the original ordering by sorting on `id` prefix. For natively-created templates, current array order is used. If templates were reordered since import, positional indices in the export may differ from the original — this is a **known limitation** (desktop Anki may show cards with different template assignments).

---

## PDS Storage Considerations

Estimated storage per user profile:

| Content | Count | Size each | Total |
|---------|-------|-----------|-------|
| Notes | 10,000 | ~500B | 5 MB |
| ReviewState | 10,000 | ~300B | 3 MB |
| ReviewLogs (1yr) | 50,000 | ~200B | 10 MB |
| Media | 2,000 | ~100KB avg | 200 MB |
| Other (decks, settings, etc.) | ~100 | ~200B | negligible |

**Total: ~220 MB** for a serious user after one year. This is within typical PDS quotas (bsky.social allows multiple GB). Media dominates — the shared media collection (vs per-note embedding) saves 5-50x for media-heavy decks where images are shared across notes.

Users on constrained PDS instances can manage storage by:
- Deleting unused decks (cascading delete removes all associated records)
- Exporting to .apkg before deletion for archival
- Using smaller media (compressed images, shorter audio clips)

---

## Lexicon Schema Evolution

- **Adding optional fields**: Safe. Old records valid. Clients treat absence as default.
- **Adding required fields**: Avoid. Use optional with documented defaults.
- **Removing fields**: Safe (Lexicon ignores unknown fields).
- **Breaking changes**: New lexicon ID + client-driven migration. Expensive, avoid.

---

## Blob & Media Garbage Collection

**Blobs**: PDS implementations GC unreferenced blobs after a grace period. When a media record is deleted, its blob becomes unreferenced and is eventually cleaned up by the PDS.

**Media records**: Unlike blobs, media *records* are never automatically garbage-collected — they're standalone records, not referenced by other records. If a user edits a note to remove an `<img src="photo.png">` reference, the `photo.png` media record persists even if no note references it anymore. Over time, orphaned media accumulates.

The client runs **periodic media GC** (weekly, or on user request):
1. Check for any in-progress bulk operations — skip GC if any `forkProgress` entry exists in IndexedDB or if an import is currently running (tracked via a local `importInProgress` flag). The outbox entry count is not a reliable proxy since it can drop between batches.
2. Scan all note field values **and** all noteType template fields (`qfmt`, `afmt`) **and** noteType `css` fields for media filename references. Use **DOM parsing** (not regex) for HTML fields — parse to a document fragment and walk `src`, `href`, `srcset`, and `style` attributes. Use a CSS parser for `css` fields to extract `url()` values. Regex-based extraction is insufficient: it misses single-quoted attributes, escaped characters, `srcset` lists, and inline `style=` background images, leading to false-negative GC (deleting in-use media).
3. Build the set of referenced filenames
4. Diff against the media collection — records not in the referenced set are orphans
5. Delete orphaned media records (queued in outbox)

This is O(notes × avg_field_length) but only runs weekly. For 10K notes it takes <1 second.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Vue 3 + TypeScript |
| Build | Vite |
| Styling | Tailwind CSS v4 |
| AT Protocol | `@atproto/api` SDK |
| Auth | `@atproto/oauth-client-browser` |
| Local Storage | IndexedDB (idb) |
| SRS Algorithms | `ts-fsrs` + ported SM-2 from anki-pwa |
| File Parsing | Ported from anki-pwa (`sql.js`, `protobufjs`, `@zip-js/zip-js`) |
| Math Rendering | KaTeX |
| Rich Text | Tiptap |
| Testing | Vitest + Playwright |

---

## Local Storage Schema (IndexedDB)

Database: `decay-flashcard-db`

**Schema versioning**: The database uses IndexedDB's built-in versioning (`version` parameter on `open()`). Each schema change increments the version number and runs a migration in the `onupgradeneeded` handler. Migrations are sequential — opening version 3 after version 1 runs the v1→v2 and v2→v3 migrations in order. Migrations must be non-destructive (adding stores/indexes, not removing data). The version number is tracked in the codebase alongside the schema definition.

| Store | Key | Indexes | Contents |
|-------|-----|---------|----------|
| `notes` | `tid` | `deckUri`, `noteTypeUri`, `ankiNoteId` | Notes (mirrors PDS) |
| `decks` | `tid` | — | Decks (mirrors PDS) |
| `noteTypes` | `tid` | `forkedFrom` | NoteTypes (mirrors PDS) |
| `media` | `normalizedKey` | `filename` | Media records (mirrors PDS). Keyed on normalized key (same as PDS record key) for consistency. Original filename stored as a field and indexed for display lookups. |
| `reviewState` | `noteTid_templateId` | `noteUri`, `phase`, `due` | Review state (mirrors PDS) |
| `reviewLogs` | `tid` | `noteUri`, `reviewedAt` | Review logs (mirrors PDS) |
| `cardFlags` | `noteTid_templateId` | — | Card flags (mirrors PDS) |
| `studySummary` | `date` | — | Daily summaries (mirrors PDS) |
| `settings` | `"self"` | — | Global settings (mirrors PDS) |
| `deckSettings` | `deckTid` | — | Per-deck settings (mirrors PDS) |
| `outbox` | autoIncrement | `collection`, `recordKey`, `groupId` | Pending PDS writes. `groupId` links entries in a cascade group. |
| `deadLetters` | autoIncrement | `collection`, `createdAt` | Failed writes |
| `syncState` | `collection` | — | Sync cursor/timestamp per collection |
| `dailyLimits` | `deckTid_date` | — | New/review counts consumed today (local-only) |
| `clozeOrdinals` | `noteTid` | — | Cached cloze ordinals (local-only) |
| `undoBuffer` | `"last"` | — | Previous reviewState snapshot (local-only) |
| `forkProgress` | `sourceDeckUri` | — | In-progress fork state for resumability |

---

## Project Structure

```
anki-atproto/
├── src/
│   ├── lexicons/              # Lexicon JSON schemas
│   │   └── cards/decay/flashcard/
│   │       ├── deck.json
│   │       ├── noteType.json
│   │       ├── note.json
│   │       ├── media.json
│   │       ├── reviewState.json
│   │       ├── reviewLog.json
│   │       ├── cardFlag.json
│   │       ├── settings.json
│   │       ├── deckSettings.json
│   │       ├── studySummary.json
│   │       ├── shareDeck.json
│   │       └── forkDeck.json
│   ├── atproto/
│   │   ├── client.ts          # ATP agent
│   │   ├── auth.ts            # OAuth flow
│   │   ├── sync.ts            # Sync engine
│   │   ├── records.ts         # Collection CRUD
│   │   └── blobs.ts           # Media upload/download
│   ├── db/
│   │   ├── schema.ts          # IndexedDB schema + migrations
│   │   ├── notes.ts
│   │   ├── decks.ts           # + cascading delete
│   │   ├── media.ts
│   │   ├── reviewState.ts
│   │   ├── reviewLogs.ts
│   │   ├── outbox.ts          # + dead letter + coalescing
│   │   └── syncState.ts
│   ├── scheduler/
│   │   ├── queue.ts
│   │   ├── anki-sm2-algorithm.ts
│   │   ├── fsrs-algorithm.ts
│   │   ├── conversion.ts      # SM-2 ↔ FSRS conversion
│   │   └── types.ts
│   ├── parser/
│   │   ├── index.ts
│   │   ├── anki2/
│   │   ├── anki21b/
│   │   └── shared.ts
│   ├── search/
│   │   └── engine.ts
│   ├── stats/
│   │   └── computeStats.ts
│   ├── components/
│   │   ├── DeckList.vue
│   │   ├── StudyView.vue
│   │   ├── CardBrowser.vue
│   │   ├── CardEditor.vue
│   │   ├── ImportWizard.vue
│   │   ├── ExportWizard.vue
│   │   ├── LoginView.vue
│   │   ├── SharedDecks.vue
│   │   ├── ProfileView.vue
│   │   └── SettingsView.vue
│   ├── stores/
│   ├── utils/
│   │   └── sanitize.ts
│   ├── App.vue
│   └── main.ts
├── package.json
├── vite.config.ts
├── tsconfig.json
└── SPEC.md
```

---

## Implementation Phases

### Phase 1: Core Local App
- Project scaffolding (Vue 3 + Vite + Tailwind)
- IndexedDB storage layer (full schema)
- Port scheduler (SM-2, FSRS, queue, algorithm conversion)
- Port card rendering (mustache, cloze, CSS, sanitization pipeline)
- Port .apkg import (option group flattening, ankiNoteId global dedup, media dedup, template ID assignment, learningStepIndex inference)
- Review undo, daily limits tracking
- Basic UI: deck list, study view, card browser

### Phase 2: AT Protocol Integration
- `@atproto/api` + OAuth (including offline token management)
- Lexicon schemas
- PDS CRUD + `applyWrites` batching
- Sync engine: outbox coalescing + dead letter UX, full-traversal diffing with rev short-circuit, conflict resolution
- **ReviewState after-state reconciliation** from reviewLogs
- **Phase 1→2 migration**: On first Phase 2 sync, upload all locally-stored reviewLogs to PDS in chronological order. This backfills the PDS with review history from the single-device phase so that after-state reconciliation has a complete log.
- Import rate limiting
- Cascading deletes via applyWrites
- Media blob upload/download (shared collection)

### Phase 3: Social Features
- Deck sharing (shareDeck)
- Deck forking (deep copy: noteTypes + notes + media)
- Discovery (handle entry, link sharing)
- Upstream update detection
- Study streak via studySummary

### Phase 4: Polish
- PWA + service worker
- Rich text card editor (Tiptap)
- Per-deck settings UI
- Search engine port
- Statistics dashboard
- .apkg export
- Multi-device hardening
- CAR-based incremental sync for large repos
