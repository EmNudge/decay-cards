/**
 * Test that deck names and hierarchy are correctly parsed from .apkg files.
 * Uses the ap_gov_vocab fixture to verify the import pipeline.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import initSqlJs from "sql.js";
import path from "path";
import { BlobReader, ZipReader } from "@zip-js/zip-js";
import { deleteDb } from "../db/schema";
import { decksDb } from "../db/decks";
import { notesDb } from "../db/notes";
import { importAnkiData } from "../import/apkgImport";
import { isFileEntry } from "../utils/zipUtils";

const AP_GOV_PATH = resolve(__dirname, "../ankiParser/__tests__/ap_gov_vocab_anki11.apkg");

beforeEach(async () => {
  await deleteDb();
});

async function parseApkgDeckInfo(apkgPath: string) {
  const bytes = readFileSync(apkgPath);
  const blob = new Blob([bytes]);

  // Manually extract and parse to inspect raw deck data
  const reader = new ZipReader(new BlobReader(blob));
  const entries = await reader.getEntries();

  let sqliteEntry = entries.find((e) => e.filename === "collection.anki2");
  if (!sqliteEntry) sqliteEntry = entries.find((e) => e.filename === "collection.anki21");

  if (!sqliteEntry || !isFileEntry(sqliteEntry)) {
    throw new Error("No SQLite database found in .apkg");
  }

  const writer = new (await import("@zip-js/zip-js")).BlobWriter();
  const sqliteBlob = await sqliteEntry.getData(writer);
  const sqliteBytes = new Uint8Array(await sqliteBlob.arrayBuffer());

  const wasmPath = path.join(process.cwd(), "node_modules", "sql.js", "dist", "sql-wasm.wasm");
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const db = new SQL.Database(sqliteBytes);

  // Get raw decks JSON
  const colResult = db.exec("SELECT decks FROM col");
  const decksJson = colResult[0]?.values[0]?.[0] as string;
  const decks = JSON.parse(decksJson);

  // Get card→deck mapping
  const cardDecks = db.exec("SELECT id, did FROM cards");
  const cardDeckIds = new Set<number>();
  for (const row of cardDecks[0]?.values ?? []) {
    cardDeckIds.add(row[1] as number);
  }

  db.close();
  await reader.close();

  return { decks, cardDeckIds };
}

describe("Deck name parsing", () => {
  it("inspects raw deck names from ap_gov_vocab", async () => {
    const { decks, cardDeckIds } = await parseApkgDeckInfo(AP_GOV_PATH);

    console.log("Raw deck data:");
    for (const [id, deck] of Object.entries(decks)) {
      const d = deck as { name: string; id: number };
      const hasCards = cardDeckIds.has(d.id);
      console.log(`  ID=${id} name="${d.name}" hasCards=${hasCards}`);
    }

    // Check if any names contain ::
    const deckNames = Object.values(decks).map((d: any) => d.name as string);
    const hasHierarchy = deckNames.some((n) => n.includes("::"));
    console.log("Has :: hierarchy:", hasHierarchy);
    console.log("All names:", deckNames);
  });

  it("imports with correct deck structure", async () => {
    const bytes = readFileSync(AP_GOV_PATH);
    const blob = new Blob([bytes]);

    // Use the real parser
    const { getAnkiDataFromBlob } = await import("../ankiParser/index");
    const data = await getAnkiDataFromBlob(blob);

    console.log("Parsed deck names from data.decks:");
    for (const [id, deck] of Object.entries(data.decks)) {
      const d = deck as { name?: string; id?: number };
      console.log(`  ID=${id} name="${d.name}"`);
    }

    console.log("\nCard deck names:");
    const cardDeckNames = new Set(data.cards.map((c) => c.deckName));
    for (const name of cardDeckNames) {
      const count = data.cards.filter((c) => c.deckName === name).length;
      console.log(`  "${name}" → ${count} cards`);
    }

    // Import
    const result = await importAnkiData(data);
    console.log("\nImport result:", result);

    // Check created decks
    const createdDecks = await decksDb.getAll();
    console.log("\nCreated decks:");
    for (const d of createdDecks) {
      const notes = await notesDb.getByDeck(`at://self/cards.decay.flashcard.deck/${d.tid}`);
      console.log(
        `  "${d.name}" tid=${d.tid} parent=${d.parentDeck ?? "none"} notes=${notes.length}`,
      );
    }

    // Verify no empty decks were created (except parents with children)
    for (const d of createdDecks) {
      const deckUri = `at://self/cards.decay.flashcard.deck/${d.tid}`;
      const notes = await notesDb.getByDeck(deckUri);
      const children = createdDecks.filter((c) => c.parentDeck === deckUri);
      if (notes.length === 0 && children.length === 0) {
        console.warn(`  WARNING: empty deck with no children: "${d.name}"`);
      }
    }

    expect(result.notesCreated).toBeGreaterThan(0);
  });

  it("handles :: hierarchy correctly with synthetic data", async () => {
    // Simulate what a geography deck with :: separators looks like
    const { importAnkiData: importFn } = await import("../import/apkgImport");

    const makeCard = (deckName: string, front: string, back: string) => ({
      ankiCardId: Math.floor(Math.random() * 1000000),
      values: { Front: front, Back: back },
      tags: [],
      templates: [{ name: "Basic", qfmt: "{{Front}}", afmt: "{{Back}}", ord: 0 }],
      css: ".card {}",
      deckName,
      guid: `guid-${Math.random()}`,
      scheduling: null,
      noteType: 0,
      latexSvg: false,
      latexPre: "",
      latexPost: "",
      req: null,
      fieldDescriptions: {},
      noteData: null,
      csum: null,
      sfld: null,
    });

    const data = {
      files: new Map(),
      cards: [
        makeCard("Nations of the World::North America", "Capital of Canada", "Ottawa"),
        makeCard("Nations of the World::North America", "Capital of USA", "Washington DC"),
        makeCard("Nations of the World::Europe", "Capital of France", "Paris"),
        makeCard("Nations of the World::Europe", "Capital of Germany", "Berlin"),
        makeCard("Nations of the World::Asia", "Capital of Japan", "Tokyo"),
      ],
      deckName: "Nations of the World",
      decks: {
        "1": { id: 1, name: "Default" },
        "2": { id: 2, name: "Nations of the World" },
        "3": { id: 3, name: "Nations of the World::North America" },
        "4": { id: 4, name: "Nations of the World::Europe" },
        "5": { id: 5, name: "Nations of the World::Asia" },
      },
      notesTypes: [],
      collectionCreationTime: 1700000000,
      deckConfigs: {},
      colConf: null,
    } as any;

    const result = await importFn(data);
    console.log("\nHierarchy import result:", result);

    const createdDecks = await decksDb.getAll();
    console.log("Created decks:");
    for (const d of createdDecks) {
      const notes = await notesDb.getByDeck(`at://self/cards.decay.flashcard.deck/${d.tid}`);
      console.log(`  "${d.name}" parent=${d.parentDeck ? "yes" : "none"} notes=${notes.length}`);
    }

    // Should create 4 decks: parent + 3 children (no Default since it has no cards)
    expect(createdDecks.length).toBe(4);

    // Parent deck should exist
    const parent = createdDecks.find((d) => d.name === "Nations of the World");
    expect(parent).toBeDefined();
    expect(parent!.parentDeck).toBeUndefined();

    // Children should reference parent
    const children = createdDecks.filter((d) => d.parentDeck);
    expect(children.length).toBe(3);
    for (const child of children) {
      expect(child.parentDeck).toContain(parent!.tid);
      expect(["North America", "Europe", "Asia"]).toContain(child.name);
    }

    // Notes should be in child decks, not parent
    const parentNotes = await notesDb.getByDeck(
      `at://self/cards.decay.flashcard.deck/${parent!.tid}`,
    );
    expect(parentNotes.length).toBe(0);

    // Each child should have correct note counts
    for (const child of children) {
      const notes = await notesDb.getByDeck(`at://self/cards.decay.flashcard.deck/${child.tid}`);
      if (child.name === "North America") expect(notes.length).toBe(2);
      else if (child.name === "Europe") expect(notes.length).toBe(2);
      else if (child.name === "Asia") expect(notes.length).toBe(1);
    }
  });
});
