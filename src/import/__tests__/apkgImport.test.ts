import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { deleteDb } from "../../db/schema";
import { decksDb } from "../../db/decks";
import { notesDb } from "../../db/notes";
import { noteTypesDb } from "../../db/noteTypes";
import { reviewStateDb } from "../../db/reviewState";
import { importAnkiData } from "../apkgImport";
import type { AnkiData } from "../../ankiParser/index";
import type { AnkiDB2Data } from "../../ankiParser/anki2/index";

beforeEach(async () => {
  await deleteDb();
});

function makeMinimalAnkiData(
  overrides: {
    cards?: AnkiDB2Data["cards"];
    decks?: AnkiData["decks"];
    deckConfigs?: AnkiData["deckConfigs"];
  } = {},
): AnkiData {
  return {
    files: new Map(),
    cards: overrides.cards ?? [
      {
        ankiCardId: 1001,
        values: { Front: "Hello", Back: "World" },
        tags: ["vocab"],
        templates: [{ name: "Card 1", qfmt: "{{Front}}", afmt: "{{Back}}", ord: 0 }],
        css: ".card { font-size: 20px; }",
        deckName: "Default",
        guid: "guid1",
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
      },
    ],
    deckName: "Default",
    decks: overrides.decks ?? { "1": { id: 1, name: "Default" } },
    notesTypes: [],
    collectionCreationTime: 1700000000,
    deckConfigs: overrides.deckConfigs ?? {},
    colConf: null,
  };
}

describe("importAnkiData", () => {
  it("imports a minimal deck with one note", async () => {
    const data = makeMinimalAnkiData();
    const result = await importAnkiData(data);

    expect(result.decksCreated).toBe(1);
    expect(result.noteTypesCreated).toBe(1);
    expect(result.notesCreated).toBe(1);

    const decks = await decksDb.getAll();
    expect(decks).toHaveLength(1);
    expect(decks[0]!.name).toBe("Default");

    const noteTypes = await noteTypesDb.getAll();
    expect(noteTypes).toHaveLength(1);
    expect(noteTypes[0]!.fields).toHaveLength(2); // Front, Back
    expect(noteTypes[0]!.fields[0]!.id).toBe("f0");
    expect(noteTypes[0]!.fields[0]!.name).toBe("Front");
    expect(noteTypes[0]!.templates).toHaveLength(1);
    expect(noteTypes[0]!.templates[0]!.id).toBe("t0");

    const notes = await notesDb.getAll();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.fields[0]!.fieldId).toBe("f0");
    expect(notes[0]!.fields[0]!.value).toBe("Hello");
    expect(notes[0]!.tags).toEqual(["vocab"]);
    expect(notes[0]!.ankiNoteId).toBe(1001);
  });

  it("deduplicates by ankiNoteId on re-import", async () => {
    const data = makeMinimalAnkiData();
    const r1 = await importAnkiData(data);
    expect(r1.notesCreated).toBe(1);

    // Import again — should skip
    const r2 = await importAnkiData(data);
    expect(r2.notesCreated).toBe(0);
    expect(r2.notesSkipped).toBe(1);

    const notes = await notesDb.getAll();
    expect(notes).toHaveLength(1);
  });

  it("imports scheduling data into reviewState", async () => {
    const data = makeMinimalAnkiData({
      cards: [
        {
          ankiCardId: 2001,
          values: { Front: "Q", Back: "A" },
          tags: [],
          templates: [{ name: "Card 1", qfmt: "{{Front}}", afmt: "{{Back}}", ord: 0 }],
          css: "",
          deckName: "Default",
          guid: "guid2",
          scheduling: {
            type: 2, // review
            typeName: "review",
            queue: 2,
            queueName: "review",
            due: Math.floor(Date.now() / 1000) + 86400, // tomorrow
            dueType: "timestamp",
            ivl: 10,
            ivlUnit: "days",
            factor: 2500,
            easeFactor: 2.5,
            reps: 5,
            lapses: 1,
            odue: 0,
            flags: 0,
            left: 0,
            fsrs: null,
          },
          noteType: 0,
          latexSvg: false,
          latexPre: "",
          latexPost: "",
          req: null,
          fieldDescriptions: {},
          noteData: null,
          csum: null,
          sfld: null,
        },
      ],
    });

    const result = await importAnkiData(data);
    expect(result.reviewStatesCreated).toBe(1);

    const states = await reviewStateDb.getAll();
    expect(states).toHaveLength(1);
    expect(states[0]!.phase).toBe("review");
    expect(states[0]!.algorithm).toBe("sm2");
    expect(states[0]!.easeFactor).toBe(2.5);
    expect(states[0]!.intervalDays).toBe(10);
    expect(states[0]!.reps).toBe(5);
    expect(states[0]!.lapses).toBe(1);
    expect(states[0]!.due).toBeDefined();
  });

  it("imports FSRS scheduling", async () => {
    const data = makeMinimalAnkiData({
      cards: [
        {
          ankiCardId: 3001,
          values: { Front: "Q", Back: "A" },
          tags: [],
          templates: [{ name: "Card 1", qfmt: "{{Front}}", afmt: "{{Back}}", ord: 0 }],
          css: "",
          deckName: "Default",
          guid: "guid3",
          scheduling: {
            type: 2,
            typeName: "review",
            queue: 2,
            queueName: "review",
            due: Math.floor(Date.now() / 1000) + 86400,
            dueType: "timestamp",
            ivl: 15,
            ivlUnit: "days",
            factor: 0,
            easeFactor: null,
            reps: 8,
            lapses: 0,
            odue: 0,
            flags: 0,
            left: 0,
            fsrs: { stability: 12.5, difficulty: 0.3, desiredRetention: undefined },
          },
          noteType: 0,
          latexSvg: false,
          latexPre: "",
          latexPost: "",
          req: null,
          fieldDescriptions: {},
          noteData: null,
          csum: null,
          sfld: null,
        },
      ],
    });

    const result = await importAnkiData(data);
    expect(result.reviewStatesCreated).toBe(1);

    const states = await reviewStateDb.getAll();
    expect(states[0]!.algorithm).toBe("fsrs");
    expect(states[0]!.stability).toBe(12.5);
    expect(states[0]!.difficulty).toBe(0.3);
  });

  it("imports nested decks with parentDeck", async () => {
    const data = makeMinimalAnkiData({
      cards: [
        {
          ankiCardId: 4001,
          values: { Front: "Q", Back: "A" },
          tags: [],
          templates: [{ name: "C1", qfmt: "{{Front}}", afmt: "{{Back}}", ord: 0 }],
          css: "",
          deckName: "Japanese::Vocab",
          guid: "guid4",
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
        },
      ],
      decks: {
        "1": { id: 1, name: "Japanese" },
        "2": { id: 2, name: "Japanese::Vocab" },
      },
    });

    await importAnkiData(data);
    const decks = await decksDb.getAll();
    expect(decks).toHaveLength(2);

    const parent = decks.find((d) => d.name === "Japanese");
    const child = decks.find((d) => d.name === "Vocab");
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(child!.parentDeck).toContain(parent!.tid);
  });

  it("imports suspended cards", async () => {
    const data = makeMinimalAnkiData({
      cards: [
        {
          ankiCardId: 5001,
          values: { Front: "Q", Back: "A" },
          tags: [],
          templates: [{ name: "C1", qfmt: "{{Front}}", afmt: "{{Back}}", ord: 0 }],
          css: "",
          deckName: "Default",
          guid: "guid5",
          scheduling: {
            type: 2,
            typeName: "review",
            queue: -1,
            queueName: "suspended",
            due: 0,
            dueType: "position",
            ivl: 5,
            ivlUnit: "days",
            factor: 2500,
            easeFactor: 2.5,
            reps: 3,
            lapses: 0,
            odue: 0,
            flags: 0,
            left: 0,
            fsrs: null,
          },
          noteType: 0,
          latexSvg: false,
          latexPre: "",
          latexPost: "",
          req: null,
          fieldDescriptions: {},
          noteData: null,
          csum: null,
          sfld: null,
        },
      ],
    });

    await importAnkiData(data);
    const states = await reviewStateDb.getAll();
    expect(states[0]!.suspended).toBe(true);
  });

  it("tracks import progress", async () => {
    const data = makeMinimalAnkiData();
    const phases: string[] = [];
    await importAnkiData(data, (p) => phases.push(p.phase));
    expect(phases).toContain("noteTypes");
    expect(phases).toContain("decks");
    expect(phases).toContain("notes");
  });
});
