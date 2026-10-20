/** Ticks per quarter note. Guitar Pro uses 960, we keep the same resolution. */
export const TICKS_PER_QUARTER = 960;
export const TICKS_PER_WHOLE = TICKS_PER_QUARTER * 4;

/**
 * Tuning model.
 *
 * `strings` is ordered from the LOWEST displayed row to the HIGHEST one:
 * index 0 is the 6th string (bottom line of the tab), index N-1 is the 1st string (top line).
 * Values are MIDI notes of the open strings.
 *
 * Because the value per slot is explicit, any custom/extreme tuning works
 * (including non monotonic tunings where a higher row is not a higher pitch).
 */
export interface Tuning {
  name: string;
  strings: number[];
}

export interface TimeSignature {
  /** Absolute tick where this signature starts. */
  tick: number;
  numerator: number;
  denominator: number;
}

export interface NoteEvent {
  id: string;
  /** Absolute tick from the beginning of the song. */
  tick: number;
  /** Duration in ticks. */
  duration: number;
  midi: number;
  /** Index into `Tuning.strings` (0 = lowest row). `undefined` = belum di-assign. */
  string?: number;
  /** Fret number relative to the capo. `undefined` = belum di-assign. */
  fret?: number;
  velocity?: number;
}

export interface Tab {
  id: string;
  title: string;
  artist?: string;
  tempo: number;
  tuning: Tuning;
  capo: number;
  timeSignatures: TimeSignature[];
  notes: NoteEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface BarInfo {
  index: number;
  startTick: number;
  endTick: number;
  ts: TimeSignature;
}

export const STANDARD_TUNING: Tuning = {
  name: "Standard E",
  strings: [40, 45, 50, 55, 59, 64],
};

export const TUNING_PRESETS: Tuning[] = [
  STANDARD_TUNING,
  { name: "Drop D", strings: [38, 45, 50, 55, 59, 64] },
  { name: "D Standard", strings: [38, 43, 48, 53, 57, 62] },
  { name: "C# Standard", strings: [37, 42, 47, 52, 56, 61] },
  { name: "Drop C", strings: [36, 43, 48, 53, 57, 62] },
  { name: "Open G", strings: [38, 43, 50, 55, 59, 62] },
  { name: "Open D", strings: [38, 45, 50, 54, 57, 62] },
  { name: "DADGAD", strings: [38, 45, 50, 55, 57, 62] },
  { name: "Open C", strings: [36, 43, 48, 52, 55, 60] },
  { name: "7 string standard", strings: [35, 40, 45, 50, 55, 59, 64] },
  { name: "8 string standard", strings: [30, 35, 40, 45, 50, 55, 59, 64] },
];
