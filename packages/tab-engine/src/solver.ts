import { TICKS_PER_QUARTER, type NoteEvent, type Tab, type Tuning } from "./types.ts";
import { midiToName } from "./pitch.ts";

export type UnplayableReason = "too-low" | "too-high" | "out-of-fret-range" | "no-combination";

export interface UnplayableNote {
  noteId: string;
  midi: number;
  note: string;
  reason: UnplayableReason;
  message: string;
}

export interface SolveOptions {
  /** Highest physical fret of the instrument. */
  maxFret: number;
  /** How many frets a single hand position may cover. */
  handSpan: number;
  beamWidth: number;
  candidateLimit: number;
  /** Cost bonus for playing an open string. */
  openStringBonus: number;
  /** Cost per fret above the 9th fret, pushes toward lower positions. */
  highFretCost: number;
  /** Cost per fret of hand movement between consecutive notes. */
  positionMoveCost: number;
  /** Cost per string jump, scaled by pitch distance. */
  stringJumpCost: number;
  /** Bonus for repeating a pitch on the same string. */
  repeatOnSameStringBonus: number;
  /** Extra cost per fret a chord exceeds the hand span. */
  spanPenaltyPerFret: number;
  /** Notes closer than this are treated as one chord. */
  chordToleranceTicks: number;
  /** Keep already assigned notes pinned instead of re-fingering them. */
  keepExisting: boolean;
  /** Preferred starting hand position. */
  startPosition?: number;
}

export const DEFAULT_SOLVE_OPTIONS: SolveOptions = {
  maxFret: 24,
  handSpan: 4,
  beamWidth: 64,
  candidateLimit: 600,
  openStringBonus: 2.5,
  highFretCost: 0.12,
  positionMoveCost: 0.55,
  stringJumpCost: 0.55,
  repeatOnSameStringBonus: 1.2,
  spanPenaltyPerFret: 14,
  chordToleranceTicks: 0,
  keepExisting: true,
};

export interface FretAssignment {
  noteId: string;
  string: number;
  fret: number;
  midi: number;
  tick: number;
}

export interface SolveResult {
  assignments: FretAssignment[];
  unplayable: UnplayableNote[];
  /** Total playability cost, lower is better. Useful to compare tunings. */
  cost: number;
  groupCount: number;
  solvedCount: number;
}

interface NoteOption {
  string: number;
  fret: number;
}

interface Candidate {
  strings: number[];
  frets: number[];
  midis: number[];
  position: number;
  localCost: number;
}

interface State {
  cand: Candidate;
  cost: number;
  prev: number;
  tick: number;
}

interface Layer {
  groupIndex: number | null;
  states: State[];
}

function feasibleFret(fret: number, capo: number, maxFret: number): boolean {
  return fret >= 0 && fret + capo <= maxFret;
}

function optionsForNote(
  note: NoteEvent,
  tuning: Tuning,
  capo: number,
  options: SolveOptions,
): NoteOption[] {
  const stringCount = tuning.strings.length;
  const result: NoteOption[] = [];

  const allowed =
    options.keepExisting && note.string != null && note.string >= 0 && note.string < stringCount
      ? [note.string]
      : Array.from({ length: stringCount }, (_, index) => index);

  for (const string of allowed) {
    const fret = note.midi - tuning.strings[string]! - capo;
    if (feasibleFret(fret, capo, options.maxFret)) {
      result.push({ string, fret });
    }
  }
  return result;
}

function localCost(frets: number[], options: SolveOptions): { cost: number; position: number } {
  let cost = 0;
  let minFretted = Number.POSITIVE_INFINITY;
  let maxFretted = -1;

  for (const fret of frets) {
    if (fret === 0) {
      cost -= options.openStringBonus;
      continue;
    }
    cost += options.highFretCost * Math.max(0, fret - 9);
    if (fret < minFretted) minFretted = fret;
    if (fret > maxFretted) maxFretted = fret;
  }

  if (maxFretted >= 0) {
    const span = maxFretted - minFretted;
    if (span > options.handSpan) {
      cost += (span - options.handSpan) * options.spanPenaltyPerFret;
    }
    return { cost, position: minFretted };
  }
  return { cost, position: 0 };
}

const ENUMERATION_BUDGET = 30000;

function enumerateCandidates(
  noteOptions: NoteOption[][],
  midis: number[],
  options: SolveOptions,
): Candidate[] {
  const candidates: Candidate[] = [];
  const used = new Set<number>();
  const strings: number[] = [];
  const frets: number[] = [];
  let visited = 0;

  const walk = (index: number): void => {
    if (visited++ > ENUMERATION_BUDGET) return;
    if (index === noteOptions.length) {
      const { cost, position } = localCost(frets, options);
      candidates.push({
        strings: [...strings],
        frets: [...frets],
        midis: [...midis],
        position,
        localCost: cost,
      });
      return;
    }

    for (const option of noteOptions[index]!) {
      if (used.has(option.string)) continue;
      used.add(option.string);
      strings.push(option.string);
      frets.push(option.fret);
      walk(index + 1);
      frets.pop();
      strings.pop();
      used.delete(option.string);
    }
  };

  walk(0);
  return candidates;
}

function candidateKey(candidate: Candidate): string {
  return candidate.strings
    .map((string, index) => `${string}:${candidate.frets[index]}`)
    .sort()
    .join("|");
}

function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const result: Candidate[] = [];
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

/** Keeps candidates cheap while preserving options around different hand positions. */
function narrowCandidates(candidates: Candidate[], options: SolveOptions): Candidate[] {
  if (candidates.length <= options.candidateLimit) return candidates;

  const sorted = [...candidates].sort((a, b) => a.localCost - b.localCost);
  const perPosition = Math.max(4, Math.floor(options.candidateLimit / 10));
  const buckets = new Map<number, Candidate[]>();
  for (const candidate of sorted) {
    const bucket = buckets.get(candidate.position);
    if (!bucket) buckets.set(candidate.position, [candidate]);
    else if (bucket.length < perPosition) bucket.push(candidate);
  }

  const narrowed: Candidate[] = [];
  for (const bucket of buckets.values()) narrowed.push(...bucket);
  narrowed.sort((a, b) => a.localCost - b.localCost);
  return narrowed.slice(0, options.candidateLimit);
}

function transitionCost(
  previous: State,
  candidate: Candidate,
  tick: number,
  options: SolveOptions,
): number {
  if (previous.cand.strings.length === 0) return 0;

  const gap = Math.max(0, tick - previous.tick);
  const gapBeats = gap / TICKS_PER_QUARTER;
  const timeFactor = 1 / (1 + gapBeats * 0.75);

  let cost =
    Math.abs(candidate.position - previous.cand.position) * options.positionMoveCost * timeFactor;

  for (let index = 0; index < candidate.midis.length; index += 1) {
    const midi = candidate.midis[index]!;
    const string = candidate.strings[index]!;

    let closest = 0;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let other = 0; other < previous.cand.midis.length; other += 1) {
      const distance = Math.abs(previous.cand.midis[other]! - midi);
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = other;
      }
    }

    const stringDistance = Math.abs(string - previous.cand.strings[closest]!);
    cost += (stringDistance * options.stringJumpCost) / (1 + closestDistance / 6);
    if (closestDistance === 0 && stringDistance === 0) {
      cost -= options.repeatOnSameStringBonus;
    }
  }

  return cost;
}

function groupNotes(notes: NoteEvent[], tolerance: number): NoteEvent[][] {
  const sorted = [...notes].sort((a, b) => a.tick - b.tick || a.midi - b.midi);
  const groups: NoteEvent[][] = [];

  let current: NoteEvent[] = [];
  let anchor = Number.NEGATIVE_INFINITY;
  for (const note of sorted) {
    if (current.length === 0) {
      current = [note];
      anchor = note.tick;
      continue;
    }
    if (note.tick - anchor <= tolerance) {
      current.push(note);
    } else {
      groups.push(current);
      current = [note];
      anchor = note.tick;
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

export function solveFingering(
  tab: Pick<Tab, "tuning" | "capo" | "notes">,
  overrides: Partial<SolveOptions> = {},
): SolveResult {
  const options: SolveOptions = { ...DEFAULT_SOLVE_OPTIONS, ...overrides };
  const { tuning } = tab;
  const capo = Math.max(0, Math.round(tab.capo ?? 0));
  const playableNotes = tab.notes.filter((note) => Number.isFinite(note.midi));

  if (tuning.strings.length === 0) {
    throw new Error("Tuning tidak punya senar");
  }

  const lowest = Math.min(...tuning.strings);
  const highest = Math.max(...tuning.strings);
  const unplayable: UnplayableNote[] = [];
  const groups = groupNotes(playableNotes, options.chordToleranceTicks);

  let beam: State[] = [
    {
      cand: {
        strings: [],
        frets: [],
        midis: [],
        position: options.startPosition ?? 0,
        localCost: 0,
      },
      cost: 0,
      prev: -1,
      tick: Number.NEGATIVE_INFINITY,
    },
  ];
  const layers: Layer[] = [];

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex]!;
    const noteOptions: NoteOption[][] = [];
    let hasUnplayableNote = false;

    for (const note of group) {
      const perNote = optionsForNote(note, tuning, capo, options);
      if (perNote.length === 0) {
        hasUnplayableNote = true;
        const tooLow = note.midi < lowest;
        const tooHigh = note.midi > highest + options.maxFret - capo;
        unplayable.push({
          noteId: note.id,
          midi: note.midi,
          note: midiToName(note.midi),
          reason: tooLow ? "too-low" : tooHigh ? "too-high" : "out-of-fret-range",
          message: tooLow
            ? `Nada ${midiToName(note.midi)} lebih rendah dari senar terendah tuning ini (${midiToName(lowest)}).`
            : tooHigh
              ? `Nada ${midiToName(note.midi)} melebihi fret ${options.maxFret} pada tuning ini.`
              : `Nada ${midiToName(note.midi)} tidak bisa dijangkau dengan tuning ini.`,
        });
      }
      noteOptions.push(perNote);
    }

    if (hasUnplayableNote) {
      layers.push({ groupIndex: null, states: beam });
      continue;
    }

    const rawCandidates = enumerateCandidates(
      noteOptions,
      group.map((note) => note.midi),
      options,
    );

    const candidates = narrowCandidates(dedupeCandidates(rawCandidates), options);

    if (candidates.length === 0) {
      for (const note of group) {
        unplayable.push({
          noteId: note.id,
          midi: note.midi,
          note: midiToName(note.midi),
          reason: "no-combination",
          message: `Chord di bar ini tidak punya kombinasi senar yang valid (${group
            .map((item) => midiToName(item.midi))
            .join(", ")}).`,
        });
      }
      layers.push({ groupIndex: null, states: beam });
      continue;
    }

    const tick = group[0]!.tick;
    const nextStates: State[] = [];
    for (const candidate of candidates) {
      let bestCost = Number.POSITIVE_INFINITY;
      let bestIndex = -1;
      for (let index = 0; index < beam.length; index += 1) {
        const previous = beam[index]!;
        const total = previous.cost + transitionCost(previous, candidate, tick, options);
        if (total < bestCost) {
          bestCost = total;
          bestIndex = index;
        }
      }
      nextStates.push({
        cand: candidate,
        cost: bestCost + candidate.localCost,
        prev: bestIndex,
        tick,
      });
    }

    nextStates.sort((a, b) => a.cost - b.cost);
    beam = nextStates.slice(0, options.beamWidth);
    layers.push({ groupIndex, states: beam });
  }

  const assignments: FretAssignment[] = [];
  const finalLayer = layers[layers.length - 1];
  const best = finalLayer?.states[0];

  if (best) {
    let stateIndex = 0;
    for (let layerIndex = layers.length - 1; layerIndex >= 0; layerIndex -= 1) {
      const layer = layers[layerIndex]!;
      const state = layer.states[stateIndex];
      if (!state) break;

      if (layer.groupIndex != null) {
        const group = groups[layer.groupIndex]!;
        for (let index = 0; index < group.length; index += 1) {
          const note = group[index]!;
          const string = state.cand.strings[index];
          const fret = state.cand.frets[index];
          if (string == null || fret == null) continue;
          assignments.push({
            noteId: note.id,
            string,
            fret,
            midi: note.midi,
            tick: note.tick,
          });
        }
      }

      stateIndex = state.prev;
      if (stateIndex < 0) break;
    }
    assignments.sort((a, b) => a.tick - b.tick);
  }

  return {
    assignments,
    unplayable,
    cost: best?.cost ?? 0,
    groupCount: groups.length,
    solvedCount: assignments.length,
  };
}

/** Returns a copy of the tab with the solver result applied. */
export function applySolveResult(tab: Tab, result: SolveResult): Tab {
  const byId = new Map(result.assignments.map((assignment) => [assignment.noteId, assignment]));
  return {
    ...tab,
    notes: tab.notes.map((note) => {
      const assignment = byId.get(note.id);
      if (!assignment) return note;
      return { ...note, string: assignment.string, fret: assignment.fret };
    }),
    updatedAt: new Date().toISOString(),
  };
}

/** Solves only notes that have no string/fret yet, leaving manual edits untouched. */
export function solveMissingFingerings(tab: Tab, overrides: Partial<SolveOptions> = {}): Tab {
  const missing = tab.notes.some((note) => note.string == null || note.fret == null);
  if (!missing) return tab;
  const result = solveFingering(tab, overrides);
  return applySolveResult(tab, result);
}
