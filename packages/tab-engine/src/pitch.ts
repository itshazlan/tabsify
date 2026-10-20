/**
 * Pitch helpers. Convention used across the whole engine:
 * MIDI 60 = C4 (scientific pitch notation), guitar low E = MIDI 40 = E2.
 */

const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

export const MIN_MIDI = 0;
export const MAX_MIDI = 127;

const LETTER_SEMITONES: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

export function midiToName(midi: number): string {
  const clamped = Math.max(MIN_MIDI, Math.min(MAX_MIDI, Math.round(midi)));
  const octave = Math.floor(clamped / 12) - 1;
  return `${SHARP_NAMES[clamped % 12]}${octave}`;
}

/**
 * Parses note names like `E2`, `C#4`, `Bb3`, `F##2`, `Dx5`.
 * Throws on anything that is not a valid note name.
 */
export function nameToMidi(name: string): number {
  const match = /^([A-Ga-g])([#bx]{0,2})(-?\d+)$/.exec(name.trim());
  if (!match) {
    throw new Error(`Nama nada tidak valid: "${name}"`);
  }
  const letter = match[1]!.toUpperCase();
  const accidentals = match[2]!;
  const octave = Number.parseInt(match[3]!, 10);

  let semitone = LETTER_SEMITONES[letter]!;
  for (const accidental of accidentals) {
    if (accidental === "#") semitone += 1;
    else if (accidental === "b") semitone -= 1;
    else if (accidental === "x") semitone += 2;
  }

  const midi = (octave + 1) * 12 + semitone;
  if (midi < MIN_MIDI || midi > MAX_MIDI) {
    throw new Error(`Nada "${name}" di luar rentang MIDI (${midi})`);
  }
  return midi;
}

export function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Accepts `"E2 A2 D3 G3 B3 E4"`, `"E2,A2,D3"` or already numeric midi values. */
export function parseTuning(input: string | number[]): number[] {
  if (Array.isArray(input)) return input.map((value) => Math.round(value));
  const tokens = input
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    throw new Error("Tuning kosong");
  }
  return tokens.map((token) => (/^-?\d+$/.test(token) ? Number.parseInt(token, 10) : nameToMidi(token)));
}

/** Formats as a human readable tuning: `"E2 A2 D3 G3 B3 E4"` (lowest string first). */
export function formatTuning(strings: number[]): string {
  return strings.map((midi) => midiToName(midi)).join(" ");
}

/**
 * Parses a compact custom tuning where unchanged strings can be written as `-`.
 * Example: `"D2 - - G3 - -"` keeps standard tuning on A, D... wait, `-` means "keep standard".
 */
export function parseTuningWithBase(input: string, base: number[]): number[] {
  const tokens = input
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length !== base.length) {
    throw new Error(`Tuning harus punya ${base.length} senar, dapat ${tokens.length}`);
  }
  return tokens.map((token, index) => (token === "-" || token === "*" ? base[index]! : nameToMidi(token)));
}
