import { describe, expect, test } from "bun:test";
import { tabFromAlphaTex, tabFromGuitarPro, tabToGuitarPro } from "../src/alphatab.ts";
import { toAlphaTex } from "../src/alphatex.ts";
import { solveFingering, applySolveResult } from "../src/solver.ts";
import { STANDARD_TUNING, type NoteEvent, type Tab } from "../src/index.ts";

function makeTab(notes: NoteEvent[], overrides: Partial<Tab> = {}): Tab {
  return {
    id: "t1",
    title: "Roundtrip",
    artist: "Test",
    tempo: 100,
    tuning: STANDARD_TUNING,
    capo: 0,
    timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }],
    notes,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function solved(notes: NoteEvent[], overrides: Partial<Tab> = {}): Tab {
  const tab = makeTab(notes, overrides);
  return applySolveResult(tab, solveFingering(tab));
}

describe("alphaTex export", () => {
  test("roundtrips pitches, ticks and tuning", () => {
    const tab = solved([
      { id: "a", midi: 40, tick: 0, duration: 960 },
      { id: "b", midi: 47, tick: 960, duration: 480 },
      { id: "c", midi: 52, tick: 1440, duration: 480 },
      { id: "d", midi: 57, tick: 1920, duration: 1920 },
    ]);

    const tex = toAlphaTex(tab);
    const imported = tabFromAlphaTex(tex);

    expect(imported.tuning.strings).toEqual(tab.tuning.strings);
    expect(imported.tempo).toBe(100);

    const pitches = imported.notes.map((note) => note.midi);
    expect(pitches).toEqual([40, 47, 52, 57]);
    expect(imported.notes.map((note) => note.tick)).toEqual([0, 960, 1440, 1920]);
  });

  test("keeps chords on distinct strings", () => {
    const tab = solved([
      { id: "a", midi: 45, tick: 0, duration: 960 },
      { id: "b", midi: 57, tick: 0, duration: 960 },
      { id: "c", midi: 62, tick: 0, duration: 960 },
    ]);

    const imported = tabFromAlphaTex(toAlphaTex(tab));
    expect(imported.notes).toHaveLength(3);
    expect(new Set(imported.notes.map((note) => note.string)).size).toBe(3);
    expect(imported.notes.map((note) => note.midi).sort()).toEqual([45, 57, 62]);
  });

  test("writes triplets as tuplets and they survive the import", () => {
    const tab = solved([
      { id: "a", midi: 52, tick: 0, duration: 320 },
      { id: "b", midi: 53, tick: 320, duration: 320 },
      { id: "c", midi: 54, tick: 640, duration: 320 },
    ]);

    const tex = toAlphaTex(tab);
    expect(tex).toContain("{tu 3}");

    const imported = tabFromAlphaTex(tex);
    expect(imported.notes.map((note) => note.tick)).toEqual([0, 320, 640]);
  });

  test("respects custom tunings when exporting", () => {
    const custom = { name: "Open C", strings: [36, 43, 48, 52, 55, 60] };
    const tab = solved([{ id: "a", midi: 36, tick: 0, duration: 960 }], { tuning: custom });

    const imported = tabFromAlphaTex(toAlphaTex(tab));
    expect(imported.tuning.strings).toEqual(custom.strings);
    expect(imported.notes[0]!.midi).toBe(36);
    expect(imported.notes[0]!.fret).toBe(0);
  });

  test("produces bars that match the time signature", () => {
    const tab = solved([{ id: "a", midi: 64, tick: 0, duration: 240 }], {
      timeSignatures: [{ tick: 0, numerator: 3, denominator: 4 }],
    });
    const tex = toAlphaTex(tab);
    expect(tex).toContain("\\ts (3 4)");

    const imported = tabFromAlphaTex(tex);
    expect(imported.timeSignatures[0]).toMatchObject({ numerator: 3, denominator: 4 });
  });

  test("survives an empty tab", () => {
    const tex = toAlphaTex(makeTab([]));
    expect(tex).toContain("\\title");
    const imported = tabFromAlphaTex(tex);
    expect(imported.notes).toHaveLength(0);
    expect(imported.tuning.strings).toEqual(STANDARD_TUNING.strings);
  });
});

describe("guitar pro export", () => {
  test("writes a valid gp7 archive that can be read back", () => {
    const tab = solved([
      { id: "a", midi: 40, tick: 0, duration: 480 },
      { id: "b", midi: 45, tick: 480, duration: 480 },
      { id: "c", midi: 50, tick: 960, duration: 960 },
    ]);

    const bytes = tabToGuitarPro(tab);
    expect(bytes.length).toBeGreaterThan(100);
    // zip signature: "PK\x03\x04"
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);

    const imported = tabFromGuitarPro(bytes);
    expect(imported.notes.map((note) => note.midi)).toEqual([40, 45, 50]);
    expect(imported.tuning.strings).toEqual(STANDARD_TUNING.strings);
  });
});
