<script setup lang="ts">
import { ref } from "vue";
import { generateTid } from "../scheduler/bridge";
import { decksDb } from "../db/decks";
import { noteTypesDb } from "../db/noteTypes";
import { notesDb } from "../db/notes";
import type { DeckRecord, NoteTypeRecord, NoteRecord } from "../db/schema";
import { downloadBlob } from "../utils/downloadBlob";

const emit = defineEmits<{
  done: [];
}>();

const fileInput = ref<HTMLInputElement>();
const error = ref("");
const importing = ref(false);
const result = ref<{ decks: number; notes: number } | null>(null);

const TEMPLATE_CSV = `deck,tags,front,back
Japanese::Vocabulary,japanese vocab,犬,dog
Japanese::Vocabulary,japanese vocab,猫,cat
Japanese::Grammar,japanese grammar,食べる,to eat
Physics,,F = ma,Newton's second law of motion
`;

function downloadTemplate() {
  downloadBlob(new Blob([TEMPLATE_CSV], { type: "text/csv" }), "deck-template.csv");
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let current = "";
  let inQuotes = false;
  let row: string[] = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(current);
        current = "";
      } else if (ch === "\n" || (ch === "\r" && text[i + 1] === "\n")) {
        row.push(current);
        current = "";
        if (row.some((c) => c.trim())) rows.push(row);
        row = [];
        if (ch === "\r") i++;
      } else {
        current += ch;
      }
    }
  }
  // Last row
  row.push(current);
  if (row.some((c) => c.trim())) rows.push(row);

  return rows;
}

async function handleFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;

  error.value = "";
  result.value = null;
  importing.value = true;

  try {
    const text = await file.text();
    const rows = parseCsv(text);

    if (rows.length < 2) {
      error.value = "CSV must have a header row and at least one data row.";
      importing.value = false;
      return;
    }

    const header = rows[0]!.map((h) => h.trim().toLowerCase());
    const deckIdx = header.indexOf("deck");
    const tagsIdx = header.indexOf("tags");

    if (deckIdx === -1) {
      error.value = 'CSV must have a "deck" column.';
      importing.value = false;
      return;
    }

    // Field columns are everything except deck and tags
    const fieldIndices: { idx: number; name: string }[] = [];
    for (let i = 0; i < header.length; i++) {
      if (i !== deckIdx && i !== tagsIdx) {
        fieldIndices.push({ idx: i, name: rows[0]![i]!.trim() || `Field ${i}` });
      }
    }

    if (fieldIndices.length === 0) {
      error.value = "CSV must have at least one field column (e.g., front, back).";
      importing.value = false;
      return;
    }

    const now = new Date().toISOString();

    // Collect unique deck paths and create deck hierarchy
    const deckPaths = new Set<string>();
    for (let i = 1; i < rows.length; i++) {
      const deckPath = rows[i]![deckIdx]?.trim();
      if (deckPath) deckPaths.add(deckPath);
    }

    // Create decks (handling :: hierarchy)
    const deckMap = new Map<string, DeckRecord>(); // fullPath → DeckRecord
    for (const path of deckPaths) {
      const parts = path.split("::");
      for (let depth = 0; depth < parts.length; depth++) {
        const fullPath = parts.slice(0, depth + 1).join("::");
        if (deckMap.has(fullPath)) continue;

        const parentPath = depth > 0 ? parts.slice(0, depth).join("::") : null;
        const parentDeck = parentPath ? deckMap.get(parentPath) : null;

        const deck: DeckRecord = {
          tid: generateTid(),
          name: parts[depth]!.trim(),
          parentDeck: parentDeck
            ? `at://self/cards.decay.flashcard.deck/${parentDeck.tid}`
            : undefined,
          createdAt: now,
          updatedAt: now,
        };
        await decksDb.put(deck);
        deckMap.set(fullPath, deck);
      }
    }

    // Create a note type based on field columns
    const noteType: NoteTypeRecord = {
      tid: generateTid(),
      name: `CSV Import (${fieldIndices.map((f) => f.name).join(", ")})`,
      fields: fieldIndices.map((f, i) => ({ id: `f${i}`, name: f.name })),
      templates: [
        {
          id: "t0",
          name: "Card 1",
          qfmt: `{{${fieldIndices[0]!.name}}}`,
          afmt: `{{FrontSide}}<hr id="answer">${fieldIndices.length > 1 ? `{{${fieldIndices[1]!.name}}}` : ""}`,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    await noteTypesDb.put(noteType);
    const noteTypeUri = `at://self/cards.decay.flashcard.noteType/${noteType.tid}`;

    // Create notes
    let noteCount = 0;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]!;
      const deckPath = row[deckIdx]?.trim();
      if (!deckPath) continue;

      const deck = deckMap.get(deckPath);
      if (!deck) continue;

      const tags =
        tagsIdx !== -1 && row[tagsIdx] ? row[tagsIdx]!.split(/\s+/).filter(Boolean) : undefined;

      const fields = fieldIndices.map((f, idx) => ({
        fieldId: `f${idx}`,
        value: row[f.idx] ?? "",
      }));

      // Skip rows where all fields are empty
      if (fields.every((f) => !f.value.trim())) continue;

      const note: NoteRecord = {
        tid: generateTid(),
        deck: `at://self/cards.decay.flashcard.deck/${deck.tid}`,
        noteType: noteTypeUri,
        fields,
        tags,
        createdAt: now,
        updatedAt: now,
      };
      await notesDb.put(note);
      noteCount++;
    }

    result.value = { decks: deckMap.size, notes: noteCount };
  } catch (e: any) {
    error.value = e.message ?? "Failed to import CSV.";
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <div class="max-w-xl mx-auto px-4 py-6">
    <h2 class="text-xl font-semibold mb-5 tracking-tight">Import from CSV</h2>

    <input
      ref="fileInput"
      type="file"
      accept=".csv,.tsv,.txt"
      class="hidden"
      @change="handleFile"
    />

    <!-- Instructions -->
    <div v-if="!importing && !result" class="space-y-4">
      <div class="card p-4 text-sm space-y-2">
        <p class="font-medium">CSV format:</p>
        <ul class="list-disc pl-5 text-fg-muted space-y-1">
          <li>
            <strong>deck</strong> — deck name (use <code>::</code> for subdecks, e.g.
            <code>Japanese::Vocab</code>)
          </li>
          <li><strong>tags</strong> — space-separated tags (optional column)</li>
          <li>All other columns become card fields (first = front, second = back, etc.)</li>
        </ul>
      </div>

      <button class="btn-pill text-sm" @click="downloadTemplate">Download template CSV</button>

      <div
        class="border-2 border-dashed border-line-strong rounded-[var(--r-lg)] p-14 text-center cursor-pointer hover:border-accent hover:bg-accent-soft"
        @click="fileInput?.click()"
      >
        <div class="text-4xl mb-3 opacity-50">↧</div>
        <p class="font-medium mb-1">Click to select a CSV file</p>
        <p class="text-sm text-fg-muted">Supports .csv files</p>
      </div>

      <p v-if="error" class="text-sm" style="color: var(--c-again)">{{ error }}</p>
    </div>

    <!-- Importing -->
    <div v-if="importing" class="card p-8 text-center">
      <p class="text-lg font-semibold mb-2">Importing…</p>
    </div>

    <!-- Result -->
    <div v-if="result" class="card p-6 text-center space-y-3">
      <div class="text-3xl">✓</div>
      <p class="font-semibold">Import complete</p>
      <p class="text-sm text-fg-muted">
        Created {{ result.decks }} deck(s) and {{ result.notes }} note(s).
      </p>
      <button
        class="btn-pill mt-2"
        style="background: var(--c-accent); color: var(--c-accent-fg)"
        @click="emit('done')"
      >
        Done
      </button>
    </div>
  </div>
</template>
