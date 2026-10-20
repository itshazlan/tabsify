import type { Tab } from "./types.ts";

const PPQ = 960;

function variableLength(value: number): number[] {
  let buffer = value & 0x7f;
  const bytes: number[] = [];
  let remaining = value;
  while ((remaining >>= 7) > 0) {
    buffer <<= 8;
    buffer |= (remaining & 0x7f) | 0x80;
  }
  // eslint-disable-next-line no-constant-condition
  for (;;) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
  return bytes;
}

interface MidiEvent {
  tick: number;
  order: number;
  bytes: number[];
}

function textEvent(type: number, text: string): number[] {
  const encoded = Array.from(new TextEncoder().encode(text));
  return [0xff, type, ...variableLength(encoded.length), ...encoded];
}

export interface MidiOptions {
  /** MIDI channel (0-15). */
  channel?: number;
  /** Adds the tuning to the track name so the file is self documenting. */
  includeTuningInName?: boolean;
}

/** Exports the tab as a standard MIDI file (format 1, single track). */
export function toMidi(tab: Tab, options: MidiOptions = {}): Uint8Array {
  const channel = Math.max(0, Math.min(15, options.channel ?? 0));
  const events: MidiEvent[] = [];
  let order = 0;

  const push = (tick: number, bytes: number[], priority = 1) => {
    events.push({ tick: Math.max(0, Math.round(tick)), order: priority * 100000 + order++, bytes });
  };

  const microsecondsPerQuarter = Math.round(60_000_000 / Math.max(20, tab.tempo || 120));
  push(
    0,
    [
      0xff,
      0x51,
      0x03,
      (microsecondsPerQuarter >> 16) & 0xff,
      (microsecondsPerQuarter >> 8) & 0xff,
      microsecondsPerQuarter & 0xff,
    ],
    -3,
  );

  const label = options.includeTuningInName === false
    ? tab.title || "Tabsify"
    : `${tab.title || "Tabsify"} [${tab.tuning.name}]`;
  push(0, textEvent(0x03, label), -2);

  for (const signature of tab.timeSignatures) {
    const denominatorPower = Math.round(Math.log2(signature.denominator));
    push(signature.tick, [0xff, 0x58, 0x04, signature.numerator, denominatorPower, 24, 8], -2.5);
  }

  for (const note of tab.notes) {
    if (!Number.isFinite(note.midi)) continue;
    const velocity = Math.max(1, Math.min(127, note.velocity ?? 80));
    const start = note.tick;
    const end = note.tick + Math.max(30, note.duration);
    push(start, [0x90 | channel, note.midi & 0x7f, velocity], 1);
    push(end, [0x80 | channel, note.midi & 0x7f, 0x40], 0);
  }

  events.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const track: number[] = [];
  let previousTick = 0;
  for (const event of events) {
    track.push(...variableLength(event.tick - previousTick), ...event.bytes);
    previousTick = event.tick;
  }
  track.push(0x00, 0xff, 0x2f, 0x00);

  const header = [
    0x4d,
    0x54,
    0x68,
    0x64, // MThd
    0x00,
    0x00,
    0x00,
    0x06,
    0x00,
    0x01, // format 1
    0x00,
    0x01, // one track
    (PPQ >> 8) & 0xff,
    PPQ & 0xff,
  ];

  const trackLength = track.length;
  const trackHeader = [
    0x4d,
    0x54,
    0x72,
    0x6b, // MTrk
    (trackLength >> 24) & 0xff,
    (trackLength >> 16) & 0xff,
    (trackLength >> 8) & 0xff,
    trackLength & 0xff,
  ];

  return new Uint8Array([...header, ...trackHeader, ...track]);
}
