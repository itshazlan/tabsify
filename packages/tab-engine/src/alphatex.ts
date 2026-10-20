import { TICKS_PER_WHOLE, type BarInfo, type NoteEvent, type Tab } from "./types.ts";
import { buildBars } from "./timeline.ts";
import { formatTuning } from "./pitch.ts";

/** Plain note values in ticks (whole ... 64th). */
const PLAIN: Array<{ ticks: number; token: number }> = [
  { ticks: 3840, token: 1 },
  { ticks: 1920, token: 2 },
  { ticks: 960, token: 4 },
  { ticks: 480, token: 8 },
  { ticks: 240, token: 16 },
  { ticks: 120, token: 32 },
  { ticks: 60, token: 64 },
];

/** Eighth/quarter/... triplets (3 in the space of 2). */
const TRIPLETS: Array<{ ticks: number; token: number }> = [
  { ticks: 1280, token: 2 },
  { ticks: 640, token: 4 },
  { ticks: 320, token: 8 },
  { ticks: 160, token: 16 },
  { ticks: 80, token: 32 },
];

export interface AlphaTexOptions {
  /** Quantize onsets/durations to this grid. 80 = 1/48 note, covers 16ths and triplets. 0 = off. */
  quantize?: number;
  /** Minimum number of bars in the output. */
  minBars?: number;
  /** Include the tuning label above the first bar. */
  tuningLabel?: boolean;
}

interface Chunk {
  ticks: number;
  token: number;
  tuplet?: number;
}

function chooseChunk(remaining: number): Chunk | null {
  for (const plain of PLAIN) {
    if (plain.ticks === remaining) return plain;
  }
  for (const triplet of TRIPLETS) {
    if (triplet.ticks === remaining) return { ...triplet, tuplet: 3 };
  }
  for (const plain of PLAIN) {
    if (plain.ticks < remaining) return plain;
  }
  for (const triplet of TRIPLETS) {
    if (triplet.ticks < remaining) return { ...triplet, tuplet: 3 };
  }
  return null;
}

function quantize(value: number, grid: number): number {
  if (grid <= 0) return Math.round(value);
  return Math.round(value / grid) * grid;
}

function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

interface QuantizedNote {
  tick: number;
  duration: number;
  alphaString: number;
  fret: number;
}

function prepareNotes(tab: Tab, grid: number): QuantizedNote[] {
  const stringCount = tab.tuning.strings.length;
  const result: QuantizedNote[] = [];

  for (const note of tab.notes) {
    if (note.string == null || note.fret == null) continue;
    if (note.string < 0 || note.string >= stringCount) continue;
    if (note.fret < 0) continue;

    const tick = Math.max(0, quantize(note.tick, grid));
    const duration = Math.max(grid > 0 ? grid : 60, quantize(note.duration, grid));

    result.push({
      tick,
      duration,
      // alphaTex numbers strings from the highest string (1) down to the lowest.
      alphaString: stringCount - note.string,
      fret: Math.round(note.fret),
    });
  }

  result.sort((a, b) => a.tick - b.tick || a.alphaString - b.alphaString);
  return result;
}

interface Group {
  tick: number;
  notes: QuantizedNote[];
  end: number;
}

function groupByOnset(notes: QuantizedNote[], barStart: number, barEnd: number): Group[] {
  const groups: Group[] = [];
  for (const note of notes) {
    if (note.tick < barStart || note.tick >= barEnd) continue;
    const last = groups[groups.length - 1];
    if (last && last.tick === note.tick) {
      last.notes.push(note);
      last.end = Math.max(last.end, Math.min(barEnd, note.tick + note.duration));
    } else {
      groups.push({
        tick: note.tick,
        notes: [note],
        end: Math.min(barEnd, note.tick + note.duration),
      });
    }
  }
  return groups;
}

function noteToken(note: QuantizedNote): string {
  return `${note.fret}.${note.alphaString}`;
}

function formatBeat(notes: QuantizedNote[] | null, chunk: Chunk, tied: boolean): string {
  const durationToken = `:${chunk.token}`;
  const tupletToken = chunk.tuplet ? `{tu ${chunk.tuplet}}` : "";

  if (!notes || notes.length === 0) {
    return `${durationToken} r${tupletToken}`;
  }

  const body = tied
    ? notes.length === 1
      ? `-.${notes[0]!.alphaString}`
      : `(${notes.map((note) => `-.${note.alphaString}`).join(" ")})`
    : notes.length === 1
      ? noteToken(notes[0]!)
      : `(${notes.map(noteToken).join(" ")})`;

  return `${durationToken} ${body}${tupletToken}`;
}

function serializeBar(
  bar: BarInfo,
  notes: QuantizedNote[],
  grid: number,
): { content: string; empty: boolean } {
  const groups = groupByOnset(notes, bar.startTick, bar.endTick);
  const beats: string[] = [];

  let position = bar.startTick;
  let groupIndex = 0;

  if (groups.length === 0) {
    let remaining = bar.endTick - bar.startTick;
    while (remaining > 0) {
      const chunk = chooseChunk(remaining);
      if (!chunk) break;
      beats.push(formatBeat(null, chunk, false));
      remaining -= chunk.ticks;
    }
    return { content: beats.join(" "), empty: true };
  }

  while (position < bar.endTick) {
    while (groupIndex < groups.length && groups[groupIndex]!.tick < position) {
      groupIndex += 1;
    }

    const group = groups[groupIndex];
    const hasNote = group != null && group.tick === position;
    const nextOnset =
      groupIndex + 1 < groups.length ? groups[groupIndex + 1]!.tick : bar.endTick;

    let segmentEnd: number;
    if (hasNote) {
      segmentEnd = Math.min(bar.endTick, nextOnset, Math.max(group.end, position + grid));
    } else {
      segmentEnd = Math.min(bar.endTick, nextOnset);
    }
    if (segmentEnd <= position) {
      segmentEnd = Math.min(bar.endTick, position + (grid > 0 ? grid : 240));
    }

    let cursor = position;
    let first = true;
    while (cursor < segmentEnd) {
      const chunk = chooseChunk(segmentEnd - cursor);
      if (!chunk) break;
      beats.push(formatBeat(hasNote ? group.notes : null, chunk, hasNote && !first));
      cursor += chunk.ticks;
      first = false;
    }

    position = cursor > position ? cursor : segmentEnd;
    if (hasNote) groupIndex += 1;
  }

  return { content: beats.join(" "), empty: false };
}

/**
 * Serializes the tab as alphaTex. Only notes with a string/fret assignment are
 * written, run the finger solver first if you want an auto-fingered export.
 */
export function toAlphaTex(tab: Tab, options: AlphaTexOptions = {}): string {
  const grid = options.quantize ?? 80;
  const notes = prepareNotes(tab, grid);
  const lastNoteEnd = notes.reduce((max, note) => Math.max(max, note.tick + note.duration), 0);
  const bars = buildBars(tab.timeSignatures, lastNoteEnd + (grid || 240), options.minBars ?? 4);

  const lines: string[] = [];
  const title = tab.title?.trim() || "Untitled";
  lines.push(`\\title "${escapeText(title)}"`);
  if (tab.artist?.trim()) {
    lines.push(`\\subtitle "${escapeText(tab.artist.trim())}"`);
    lines.push(`\\artist "${escapeText(tab.artist.trim())}"`);
  }
  lines.push(`\\tempo ${Math.max(20, Math.round(tab.tempo || 120))}`);

  const tuningLabel = options.tuningLabel === false ? "" : ` { label "${escapeText(tab.tuning.name)}" }`;
  lines.push(`\\tuning (${formatTuning([...tab.tuning.strings].reverse())})${tuningLabel}`);
  if (tab.capo > 0) lines.push(`\\capo ${Math.round(tab.capo)}`);
  lines.push("\\staff {tabs}");
  lines.push("");

  let previousSignature = "";
  const barTexts: string[] = [];

  for (const bar of bars) {
    const signature = `${bar.ts.numerator} ${bar.ts.denominator}`;
    const prefix = signature !== previousSignature ? `\\ts (${signature}) ` : "";
    previousSignature = signature;

    const { content } = serializeBar(bar, notes, grid);
    barTexts.push(`${prefix}${content} |`);
  }

  lines.push(barTexts.join("\n"));
  lines.push("");
  return lines.join("\n");
}

/** Total length of the tab in ticks, useful for progress bars and playback. */
export function tabDurationTicks(tab: Tab): number {
  return tab.notes.reduce((max, note: NoteEvent) => Math.max(max, note.tick + note.duration), 0);
}

export function ticksToSeconds(tab: Pick<Tab, "tempo">, ticks: number): number {
  return (ticks / TICKS_PER_WHOLE) * 4 * (60 / Math.max(1, tab.tempo));
}
