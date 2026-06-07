/**
 * Test with real geography .apkg files to verify deck hierarchy parsing.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import initSqlJs from "sql.js";
import path from "path";
import { BlobReader, ZipReader, BlobWriter } from "@zip-js/zip-js";
import { deleteDb } from "../db/schema";
import { decksDb } from "../db/decks";
import { notesDb } from "../db/notes";
import { isFileEntry } from "../utils/zipUtils";

const NATIONS_PATH = resolve(__dirname, "fixtures/Nations_of_the_World.apkg");
const GEOGRAPHY_PATH = resolve(__dirname, "fixtures/Ultimate_Geography_v53.apkg");

async function inspectApkgDecks(apkgPath: string) {
  const bytes = readFileSync(apkgPath);
  const blob = new Blob([bytes]);
  const reader = new ZipReader(new BlobReader(blob));
  const entries = await reader.getEntries();

  // Find the SQLite database
  let sqliteEntry = entries.find((e) => e.filename === "collection.anki2");
  if (!sqliteEntry) sqliteEntry = entries.find((e) => e.filename === "collection.anki21");
  if (!sqliteEntry) sqliteEntry = entries.find((e) => e.filename === "collection.anki21b");

  if (!sqliteEntry || !isFileEntry(sqliteEntry)) {
    const names = entries.map((e) => e.filename);
    throw new Error(`No SQLite database found. Files: ${names.join(", ")}`);
  }

  const writer = new BlobWriter();
  const sqliteBlob = await sqliteEntry.getData(writer);
  const sqliteBytes = new Uint8Array(await sqliteBlob.arrayBuffer());

  const wasmPath = path.join(process.cwd(), "node_modules", "sql.js", "dist", "sql-wasm.wasm");
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const db = new SQL.Database(sqliteBytes);

  // Get decks
  let deckNames: string[] = [];
  try {
    const colResult = db.exec("SELECT decks FROM col");
    const decksJson = colResult[0]?.values[0]?.[0] as string;
    const decks = JSON.parse(decksJson);
    deckNames = Object.values(decks).map((d: any) => d.name as string);
  } catch {
    // anki21b format - decks in separate table
    try {
      const deckResult = db.exec("SELECT name FROM decks");
      deckNames = (deckResult[0]?.values ?? []).map((r) => r[0] as string);
    } catch {
      // ignore
    }
  }

  // Get card deck IDs
  let cardDeckNames: string[] = [];
  try {
    const colResult = db.exec("SELECT decks FROM col");
    const decksJson = colResult[0]?.values[0]?.[0] as string;
    const decks = JSON.parse(decksJson);
    const cardResult = db.exec("SELECT did FROM cards");
    const dids = (cardResult[0]?.values ?? []).map((r) => r[0] as number);
    const uniqueDids = [...new Set(dids)];
    cardDeckNames = uniqueDids.map(
      (did) => (decks[did.toString()] as any)?.name ?? `unknown-${did}`,
    );
  } catch {
    // ignore
  }

  db.close();
  await reader.close();

  return { deckNames, cardDeckNames, entryNames: entries.map((e) => e.filename) };
}

beforeEach(async () => {
  await deleteDb();
});

describe("Nations_of_the_World.apkg", () => {
  it("inspect raw deck structure", async () => {
    const { deckNames, cardDeckNames, entryNames } = await inspectApkgDecks(NATIONS_PATH);

    console.log("Zip entries:", entryNames.slice(0, 10), "...");
    console.log("All deck names:", deckNames);
    console.log(
      "Has :: hierarchy:",
      deckNames.some((n) => n.includes("::")),
    );
    console.log("Card deck names:", [...new Set(cardDeckNames)]);

    expect(deckNames.length).toBeGreaterThan(0);
    expect(deckNames.some((n) => n.includes("::"))).toBe(true);
  });

  it("imports with correct hierarchy", async () => {
    const bytes = readFileSync(NATIONS_PATH);
    const blob = new Blob([bytes]);
    const { getAnkiDataFromBlob } = await import("../ankiParser/index");
    const data = await getAnkiDataFromBlob(blob);
    const { importAnkiData } = await import("../import/apkgImport");
    const result = await importAnkiData(data);

    console.log("Import result:", result);

    const allDecks = await decksDb.getAll();
    console.log("Created decks:");
    for (const d of allDecks) {
      const notes = await notesDb.getByDeck(`at://self/cards.decay.flashcard.deck/${d.tid}`);
      console.log(
        `  "${d.name}" parent=${d.parentDeck ? "→" + d.parentDeck.split("/").pop() : "root"} notes=${notes.length}`,
      );
    }

    // Should NOT have "Default" (no cards in it)
    const defaultDeck = allDecks.find((d) => d.name === "Default");
    expect(defaultDeck).toBeUndefined();

    // Should have parent "Nations of the World"
    const parent = allDecks.find((d) => d.name === "Nations of the World");
    expect(parent).toBeDefined();
    expect(parent!.parentDeck).toBeUndefined();

    // Should have child decks with parentDeck set
    const children = allDecks.filter((d) => d.parentDeck);
    expect(children.length).toBe(6); // Africa, Asia, Europe, North America, Oceania, South America

    for (const child of children) {
      expect(child.parentDeck).toContain(parent!.tid);
      const notes = await notesDb.getByDeck(`at://self/cards.decay.flashcard.deck/${child.tid}`);
      expect(notes.length).toBeGreaterThan(0);
      console.log(`  Child "${child.name}": ${notes.length} notes`);
    }

    // Parent should have 0 direct notes
    const parentNotes = await notesDb.getByDeck(
      `at://self/cards.decay.flashcard.deck/${parent!.tid}`,
    );
    expect(parentNotes.length).toBe(0);

    // Total notes should match cards
    const allNotes = await notesDb.getAll();
    expect(allNotes.length).toBe(data.cards.length);
  });
});

describe("Ultimate_Geography_v53.apkg", () => {
  it("inspect raw deck structure", async () => {
    const { deckNames, cardDeckNames, entryNames } = await inspectApkgDecks(GEOGRAPHY_PATH);

    console.log("Zip entries:", entryNames.slice(0, 10), "...");
    console.log("All deck names:", deckNames);
    console.log(
      "Has :: hierarchy:",
      deckNames.some((n) => n.includes("::")),
    );
    console.log("Card deck names:", [...new Set(cardDeckNames)]);

    expect(deckNames.length).toBeGreaterThan(0);
  });
});
