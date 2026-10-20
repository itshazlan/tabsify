import { describe, expect, test } from "bun:test";
import {
  applySolveResult,
  DEFAULT_SOLVE_OPTIONS,
  solveFingering,
  STANDARD_TUNING,
  type NoteEvent,
  type Tab,
  type Tuning,
} from "../src/index.ts";

function note(id: string, midi: number, tick: number, duration = 480): NoteEvent {
  return { id, midi, tick, duration };
}

function makeTab(notes: NoteEvent[], tuning: Tuning = STANDARD_TUNING, capo = 0): Tab {
  return {
    id: "test",
    title: "Test",
    tempo: 120,
    tuning,
    capo,
    timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }],
    notes,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function expectAssignmentsMatchPitches(tab: Tab, assignments: { string: number; fret: number; midi: number }[]) {
  for (const assignment of assignments) {
    const open = tab.tuning.strings[assignment.string];
    expect(open).toBeDefined();
    expect(open! + assignment.fret + tab.capo).toBe(assignment.midi);
  }
}

describe("solveFingering", () => {
  test("assigns every note of a simple phrase in standard tuning", () => {
    const tab = makeTab([
      note("a", 64, 0),
      note("b", 67, 480),
      note("c", 71, 960),
      note("d", 64, 1440),
    ]);

    const result = solveFingering(tab);
    expect(result.assignments).toHaveLength(4);
    expect(result.unplayable).toHaveLength(0);
    expectAssignmentsMatchPitches(tab, result.assignments);
  });

  test("keeps a chromatic run on one string instead of jumping around", () => {
    const tab = makeTab([
      note("a", 55, 0),
      note("b", 56, 240),
      note("c", 57, 480),
      note("d", 58, 720),
    ]);

    const result = solveFingering(tab);
    const strings = new Set(result.assignments.map((assignment) => assignment.string));
    expect(strings.size).toBe(1);
  });

  test("uses the open string for drop D riffs", () => {
    const dropD: Tuning = { name: "Drop D", strings: [38, 45, 50, 55, 59, 64] };
    const tab = makeTab([note("low", 38, 0), note("low2", 38, 960)], dropD);

    const result = solveFingering(tab);
    const low = result.assignments.find((assignment) => assignment.noteId === "low");
    expect(low).toBeDefined();
    expect(low!.fret).toBe(0);
    expect(low!.string).toBe(0);
  });

  test("supports extreme custom per string tunings", () => {
    const weird: Tuning = { name: "Custom chaos", strings: [34, 41, 46, 51, 56, 61] };
    const tab = makeTab(
      [note("a", 46, 0), note("b", 53, 480), note("c", 60, 960), note("d", 36, 1440)],
      weird,
    );

    const result = solveFingering(tab);
    expect(result.unplayable).toHaveLength(0);
    expect(result.assignments).toHaveLength(4);
    expectAssignmentsMatchPitches(tab, result.assignments);
  });

  test("reports notes below the lowest string", () => {
    const tab = makeTab([note("tooLow", 30, 0), note("ok", 64, 480)]);
    const result = solveFingering(tab);

    expect(result.unplayable).toHaveLength(1);
    expect(result.unplayable[0]!.reason).toBe("too-low");
    expect(result.assignments).toHaveLength(1);
  });

  test("never puts two notes of a chord on the same string", () => {
    const tab = makeTab([
      note("root", 45, 0),
      note("third", 57, 0),
      note("fifth", 62, 0),
      note("octave", 69, 0),
    ]);

    const result = solveFingering(tab);
    expect(result.assignments).toHaveLength(4);
    const strings = result.assignments.map((assignment) => assignment.string);
    expect(new Set(strings).size).toBe(4);
  });

  test("keeps manual assignments when keepExisting is on", () => {
    const pinned: NoteEvent = { id: "pinned", midi: 64, tick: 0, duration: 480, string: 5, fret: 0 };
    const tab = makeTab([pinned, note("next", 65, 480)]);

    const result = solveFingering(tab, { keepExisting: true });
    const pinnedResult = result.assignments.find((assignment) => assignment.noteId === "pinned");
    expect(pinnedResult!.string).toBe(5);
    expect(pinnedResult!.fret).toBe(0);
  });

  test("applies the capo offset", () => {
    const tab = makeTab([note("a", 66, 0)], STANDARD_TUNING, 2);
    const result = solveFingering(tab);
    const assignment = result.assignments[0]!;
    // high E (index 5, 64) + capo 2 + fret 0 = 66
    expect(assignment.fret).toBe(0);
    expect(assignment.string).toBe(5);
    expectAssignmentsMatchPitches(tab, [assignment]);
  });

  test("solves a long song quickly", () => {
    const notes: NoteEvent[] = [];
    for (let index = 0; index < 800; index += 1) {
      notes.push(note(`n${index}`, 52 + ((index * 5) % 24), index * 240));
      if (index % 4 === 0) notes.push(note(`c${index}`, 40 + (index % 12), index * 240));
    }

    const tab = makeTab(notes);
    const startedAt = performance.now();
    const result = solveFingering(tab);
    const elapsed = performance.now() - startedAt;

    expect(result.assignments.length).toBe(notes.length - result.unplayable.length);
    expect(elapsed).toBeLessThan(3000);
  });

  test("is deterministic for the same input", () => {
    const notes = [note("a", 64, 0), note("b", 59, 480), note("c", 62, 960)];
    const first = solveFingering(makeTab(notes));
    const second = solveFingering(makeTab(notes));
    expect(first.assignments).toEqual(second.assignments);
    expect(first.cost).toBeCloseTo(second.cost, 6);
  });

  test("defaults are stable", () => {
    expect(DEFAULT_SOLVE_OPTIONS.beamWidth).toBeGreaterThan(8);
    const tab = makeTab([note("a", 64, 0)]);
    const solved = applySolveResult(tab, solveFingering(tab));
    expect(solved.notes[0]!.string).toBeDefined();
    expect(solved.notes[0]!.fret).toBeDefined();
  });
});
