import { createDatabase } from "../utils/sql";
import { BlobWriter, ZipWriter, Uint8ArrayReader } from "@zip-js/zip-js";
import { decksDb } from "../db/decks";
import { notesDb } from "../db/notes";
import { noteTypesDb } from "../db/noteTypes";
import { reviewStateDb } from "../db/reviewState";
import { mediaDb, normalizeMediaKey } from "../db/media";
import type { DeckRecord, NoteRecord, ReviewStateRecord } from "../db/schema";

/**
 * Export a deck (and optionally its subdecks) as an .apkg file.
 */
export async function exportDeckAsApkg(deckTid: string): Promise<Blob> {
  const allDecks = await decksDb.getAllActive();
  const allNoteTypes = await noteTypesDb.getAll();
  const allNotes = await notesDb.getAll();
  const allStates = await reviewStateDb.getAll();

  // Find the target deck and its children
  const deckUris = new Set<string>();
  const deckRecords: DeckRecord[] = [];

  // Collect deck and all sub-decks
  function collectDecks(tid: string) {
    const uri = `at://self/cards.decay.flashcard.deck/${tid}`;
    if (deckUris.has(uri)) return;
    const deck = allDecks.find((d) => d.tid === tid);
    if (!deck) return;
    deckUris.add(uri);
    deckRecords.push(deck);
    // Find children
    for (const d of allDecks) {
      if (d.parentDeck === uri) {
        collectDecks(d.tid);
      }
    }
  }
  collectDecks(deckTid);

  // Collect notes in these decks
  const notes = allNotes.filter((n) => deckUris.has(n.deck));

  // Collect note types used by these notes
  const usedNoteTypeUris = new Set(notes.map((n) => n.noteType));
  const noteTypes = allNoteTypes.filter((nt) =>
    usedNoteTypeUris.has(`at://self/cards.decay.flashcard.noteType/${nt.tid}`),
  );

  // Collect review states for these notes
  const noteTids = new Set(notes.map((n) => n.tid));
  const states = allStates.filter((rs) => {
    const noteTid = rs.key.split("_")[0]!;
    return noteTids.has(noteTid);
  });

  // Collect media filenames referenced in notes
  const mediaFilenames = new Set<string>();
  const mediaSrcRegex = /src="([^"]+)"/g;
  const soundRegex = /\[sound:([^\]]+)\]/g;
  for (const note of notes) {
    for (const field of note.fields) {
      for (const match of field.value.matchAll(mediaSrcRegex)) {
        const src = match[1]!;
        if (!src.startsWith("data:") && !src.startsWith("http")) {
          mediaFilenames.add(src);
        }
      }
      for (const match of field.value.matchAll(soundRegex)) {
        mediaFilenames.add(match[1]!);
      }
    }
  }

  // Build the SQLite database
  const db = await createDatabase();
  createAnkiSchema(db);

  // Assign stable numeric IDs
  const deckIdMap = new Map<string, number>(); // tid → numeric id
  const modelIdMap = new Map<string, number>(); // tid → numeric id
  const noteIdMap = new Map<string, number>(); // tid → numeric id

  let nextId = 1000000000;
  for (const deck of deckRecords) {
    deckIdMap.set(deck.tid, nextId++);
  }
  for (const nt of noteTypes) {
    modelIdMap.set(nt.tid, nextId++);
  }
  for (const note of notes) {
    noteIdMap.set(note.tid, nextId++);
  }

  // Build deck full paths
  const deckFullPaths = new Map<string, string>();
  function getDeckPath(deck: DeckRecord): string {
    if (deckFullPaths.has(deck.tid)) return deckFullPaths.get(deck.tid)!;
    if (deck.parentDeck) {
      const parentTid = deck.parentDeck.split("/").pop()!;
      const parent = deckRecords.find((d) => d.tid === parentTid);
      if (parent) {
        const path = `${getDeckPath(parent)}::${deck.name}`;
        deckFullPaths.set(deck.tid, path);
        return path;
      }
    }
    deckFullPaths.set(deck.tid, deck.name);
    return deck.name;
  }
  for (const deck of deckRecords) getDeckPath(deck);

  // Insert col row
  const models: Record<string, any> = {};
  for (const nt of noteTypes) {
    const mid = modelIdMap.get(nt.tid)!;
    models[mid] = {
      id: mid,
      name: nt.name,
      type: nt.isCloze ? 1 : 0,
      mod: Math.floor(new Date(nt.updatedAt).getTime() / 1000),
      usn: -1,
      sortf: 0,
      did: deckIdMap.get(deckRecords[0]!.tid)!,
      tmpls: nt.templates.map((t, i) => ({
        name: t.name,
        ord: i,
        qfmt: t.qfmt,
        afmt: t.afmt,
        bqfmt: "",
        bafmt: "",
        did: null,
        bfont: "",
        bsize: 0,
      })),
      flds: nt.fields.map((f, i) => ({
        name: f.name,
        ord: i,
        sticky: false,
        rtl: false,
        font: "Arial",
        size: 20,
        description: f.description ?? "",
        media: [],
      })),
      css:
        nt.css ??
        ".card { font-family: arial; font-size: 20px; text-align: center; color: black; background-color: white; }",
      latexPre:
        "\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n",
      latexPost: "\\end{document}",
      latexsvg: false,
      req: nt.templates.map((_, i) => [i, "any", [0]]),
    };
  }

  const decksJson: Record<string, any> = {
    "1": {
      id: 1,
      name: "Default",
      mod: 0,
      usn: 0,
      lrnToday: [0, 0],
      revToday: [0, 0],
      newToday: [0, 0],
      timeToday: [0, 0],
      collapsed: false,
      browserCollapsed: false,
      desc: "",
      dyn: 0,
      conf: 1,
    },
  };
  for (const deck of deckRecords) {
    const did = deckIdMap.get(deck.tid)!;
    decksJson[did] = {
      id: did,
      name: deckFullPaths.get(deck.tid)!,
      mod: Math.floor(new Date(deck.updatedAt).getTime() / 1000),
      usn: -1,
      lrnToday: [0, 0],
      revToday: [0, 0],
      newToday: [0, 0],
      timeToday: [0, 0],
      collapsed: false,
      browserCollapsed: false,
      desc: deck.description ?? "",
      dyn: 0,
      conf: 1,
    };
  }

  const dconf: Record<string, any> = {
    "1": {
      id: 1,
      name: "Default",
      new: { delays: [1, 10], ints: [1, 4, 0], initialFactor: 2500, order: 1, perDay: 20 },
      rev: { perDay: 200, ease4: 1.3, ivlFct: 1, maxIvl: 36500, fuzz: 0.05 },
      lapse: { delays: [10], mult: 0, minInt: 1, leechFails: 8, leechAction: 0 },
      maxTaken: 60,
      timer: 0,
      autoplay: true,
      replayq: true,
      mod: 0,
      usn: 0,
    },
  };

  const crt = Math.floor(Date.now() / 1000) - 86400;
  // col columns: id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags
  const conf = JSON.stringify({
    activeDecks: [1],
    curDeck: 1,
    newSpread: 0,
    collapseTime: 1200,
    timeLim: 0,
    estTimes: true,
    dueCounts: true,
    curModel: null,
    nextPos: 1,
    sortType: "noteFld",
    sortBackwards: false,
    addToCur: true,
  });
  const mod = Math.floor(Date.now() / 1000);
  db.run("INSERT INTO col VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", [
    1,
    crt,
    mod,
    crt * 1000,
    11,
    0,
    -1,
    0,
    conf,
    JSON.stringify(models),
    JSON.stringify(decksJson),
    JSON.stringify(dconf),
    "{}",
  ]);

  // Insert notes
  for (const note of notes) {
    const nid = noteIdMap.get(note.tid)!;
    const ntTid = note.noteType.split("/").pop()!;
    const mid = modelIdMap.get(ntTid)!;
    const nt = noteTypes.find((t) => t.tid === ntTid)!;
    const flds = nt.fields
      .map((f) => {
        const val = note.fields.find((nf) => nf.fieldId === f.id);
        return val?.value ?? "";
      })
      .join("\x1f");
    const sfld = note.fields[0]?.value ?? "";
    const tags = (note.tags ?? []).join(" ");
    const mod = Math.floor(new Date(note.updatedAt).getTime() / 1000);

    db.run("INSERT INTO notes VALUES(?,?,?,?,?,?,?,?,?,?,?)", [
      nid,
      note.tid.slice(0, 10),
      mid,
      mod,
      -1,
      tags,
      flds,
      sfld,
      0,
      0,
      "",
    ]);
  }

  // Insert cards
  let cardId = 2000000000;
  const statesByNote = new Map<string, ReviewStateRecord[]>();
  for (const rs of states) {
    const noteTid = rs.key.split("_")[0]!;
    const arr = statesByNote.get(noteTid) ?? [];
    arr.push(rs);
    statesByNote.set(noteTid, arr);
  }

  for (const note of notes) {
    const nid = noteIdMap.get(note.tid)!;
    const ntTid = note.noteType.split("/").pop()!;
    const nt = noteTypes.find((t) => t.tid === ntTid)!;
    const deckTidForNote = note.deck.split("/").pop()!;
    const did = deckIdMap.get(deckTidForNote) ?? deckIdMap.get(deckRecords[0]!.tid)!;
    const noteStates = statesByNote.get(note.tid) ?? [];

    const templates = nt.isCloze
      ? getClozeTemplates(note)
      : nt.templates.map((t, i) => ({ id: t.id, ord: i }));

    for (const tmpl of templates) {
      const rs = noteStates.find((s) => s.templateId === tmpl.id);
      const cid = cardId++;
      const ord = tmpl.ord;

      let type = 0; // new
      let queue = 0; // new
      let due = 0;
      let ivl = 0;
      let factor = 0;
      let reps = 0;
      let lapses = 0;

      if (rs) {
        reps = rs.reps;
        lapses = rs.lapses;
        factor = Math.round((rs.easeFactor ?? 2.5) * 1000);

        switch (rs.phase) {
          case "review":
            type = 2;
            queue = rs.suspended ? -1 : 2;
            ivl = rs.intervalDays ?? 0;
            due = rs.due ? Math.floor((new Date(rs.due).getTime() - Date.now()) / 86400000) : 0;
            break;
          case "learning":
          case "relearning":
            type = rs.phase === "learning" ? 1 : 3;
            queue = rs.suspended ? -1 : 1;
            ivl = rs.intervalMinutes ? Math.round(rs.intervalMinutes / 1440) : 0;
            due = rs.due ? Math.floor(new Date(rs.due).getTime() / 1000) : 0;
            break;
          default:
            type = 0;
            queue = rs.suspended ? -1 : 0;
            due = 0;
        }
      }

      const mod = rs
        ? Math.floor(new Date(rs.updatedAt).getTime() / 1000)
        : Math.floor(Date.now() / 1000);

      db.run("INSERT INTO cards VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
        cid,
        nid,
        did,
        ord,
        mod,
        -1,
        type,
        queue,
        due,
        ivl,
        factor,
        reps,
        lapses,
        0,
        0,
        0,
        0,
        "",
      ]);
    }
  }

  // Export database as binary
  const dbData = db.export();
  db.close();

  // Build zip file
  const zipBlobWriter = new BlobWriter("application/zip");
  const zipWriter = new ZipWriter(zipBlobWriter);

  // Add collection.anki2
  await zipWriter.add("collection.anki2", new Uint8ArrayReader(dbData));

  // Add media mapping and files
  const mediaMapping: Record<string, string> = {};
  let mediaIdx = 0;

  for (const filename of mediaFilenames) {
    const key = normalizeMediaKey(filename);
    const record = await mediaDb.get(key);
    if (!record) continue;
    const idxStr = String(mediaIdx);
    mediaMapping[idxStr] = filename;
    const arrayBuf = await record.blob.arrayBuffer();
    await zipWriter.add(idxStr, new Uint8ArrayReader(new Uint8Array(arrayBuf)));
    mediaIdx++;
  }

  // Add media JSON
  const mediaJson = new TextEncoder().encode(JSON.stringify(mediaMapping));
  await zipWriter.add("media", new Uint8ArrayReader(mediaJson));

  await zipWriter.close();
  return zipBlobWriter.getData();
}

function createAnkiSchema(db: any) {
  db.run(`
    CREATE TABLE col (
      id integer primary key,
      crt integer not null,
      mod integer not null,
      scm integer not null,
      ver integer not null,
      dty integer not null,
      usn integer not null,
      ls integer not null,
      conf text not null,
      models text not null,
      decks text not null,
      dconf text not null,
      tags text not null
    )
  `);
  db.run(`
    CREATE TABLE notes (
      id integer primary key,
      guid text not null,
      mid integer not null,
      mod integer not null,
      usn integer not null,
      tags text not null,
      flds text not null,
      sfld text not null,
      csum integer not null,
      flags integer not null,
      data text not null
    )
  `);
  db.run(`
    CREATE TABLE cards (
      id integer primary key,
      nid integer not null,
      did integer not null,
      ord integer not null,
      mod integer not null,
      usn integer not null,
      type integer not null,
      queue integer not null,
      due integer not null,
      ivl integer not null,
      factor integer not null,
      reps integer not null,
      lapses integer not null,
      left integer not null,
      odue integer not null,
      odid integer not null,
      flags integer not null,
      data text not null
    )
  `);
  db.run(`
    CREATE TABLE revlog (
      id integer primary key,
      cid integer not null,
      usn integer not null,
      ease integer not null,
      ivl integer not null,
      lastIvl integer not null,
      factor integer not null,
      time integer not null,
      type integer not null
    )
  `);
  db.run("CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null)");
}

const CLOZE_REGEX = /\{\{c(\d+)::/g;
function getClozeTemplates(note: NoteRecord): { id: string; ord: number }[] {
  const ordinals = new Set<number>();
  for (const field of note.fields) {
    CLOZE_REGEX.lastIndex = 0;
    let match;
    while ((match = CLOZE_REGEX.exec(field.value)) !== null) {
      ordinals.add(parseInt(match[1]!, 10));
    }
  }
  return Array.from(ordinals)
    .sort((a, b) => a - b)
    .map((n) => ({ id: `c${n}`, ord: n - 1 }));
}
