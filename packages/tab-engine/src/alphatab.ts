/**
 * alphaTab adapter: Guitar Pro import/export and alphaTex ↔ tab conversion.
 *
 * This module pulls in the full alphaTab build, keep it out of bundles that
 * only need the finger solver (`@tabsify/engine` barrel does not export it).
 */
import { exporter, importer, model, Settings } from "@coderline/alphatab";
import { TICKS_PER_QUARTER, type NoteEvent, type Tab, type TimeSignature } from "./types.ts";
import { midiToName, formatTuning } from "./pitch.ts";
import { toAlphaTex } from "./alphatex.ts";

export interface ImportOptions {
  id?: string;
  title?: string;
  artist?: string;
}

function makeIdFactory(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `n${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  };
}

export function alphaTexToScore(tex: string): model.Score {
  const alphaImporter = new importer.AlphaTexImporter();
  alphaImporter.initFromString(tex, new Settings());
  return alphaImporter.readScore();
}

interface TieTrack {
  note: NoteEvent;
}

export function tabFromScore(score: model.Score, options: ImportOptions = {}): Tab {
  const nextId = makeIdFactory();
  const track = score.tracks[0];
  const staff = track?.staves?.[0];
  if (!staff) {
    throw new Error("Score tidak punya staff/track yang bisa dibaca");
  }

  const tuningModel = staff.stringTuning?.tunings ?? [];
  const strings = tuningModel.length > 0 ? [...tuningModel].reverse() : [40, 45, 50, 55, 59, 64];

  const timeSignatures: TimeSignature[] = [];
  for (const masterBar of score.masterBars) {
    const numerator = masterBar.timeSignatureNumerator || 4;
    const denominator = masterBar.timeSignatureDenominator || 4;
    const last = timeSignatures[timeSignatures.length - 1];
    if (!last || last.numerator !== numerator || last.denominator !== denominator) {
      timeSignatures.push({ tick: masterBar.start, numerator, denominator });
    }
  }

  const notes: NoteEvent[] = [];
  const seen = new Set<string>();
  const lastByString = new Map<number, TieTrack>();

  for (const bar of staff.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        if (beat.isRest) continue;
        const tick = beat.absolutePlaybackStart;
        const duration = Math.max(Math.round(TICKS_PER_QUARTER / 4), beat.playbackDuration);

        for (const note of beat.notes) {
          if (note.isDead || note.fret < 0) continue;
          const stringIndex = Math.max(0, Math.min(strings.length - 1, note.string - 1));

          if (note.isTieDestination) {
            const origin = lastByString.get(stringIndex);
            if (origin) {
              const end = tick + duration;
              origin.note.duration = Math.max(origin.note.duration, end - origin.note.tick);
            }
            continue;
          }

          const key = `${tick}:${stringIndex}:${note.fret}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const event: NoteEvent = {
            id: nextId(),
            tick,
            duration,
            midi: note.realValue,
            string: stringIndex,
            fret: note.fret,
          };
          notes.push(event);
          lastByString.set(stringIndex, { note: event });
        }
      }
    }
  }

  notes.sort((a, b) => a.tick - b.tick);

  const now = new Date().toISOString();
  const tuningName = formatTuning(strings);

  return {
    id: options.id ?? crypto.randomUUID(),
    title: options.title ?? score.title ?? "Untitled",
    artist: options.artist ?? score.artist ?? undefined,
    tempo: Math.round(score.tempo || 120),
    tuning: { name: tuningName, strings },
    capo: staff.capo ?? 0,
    timeSignatures: timeSignatures.length > 0 ? timeSignatures : [{ tick: 0, numerator: 4, denominator: 4 }],
    notes,
    createdAt: now,
    updatedAt: now,
  };
}

export function tabFromAlphaTex(tex: string, options: ImportOptions = {}): Tab {
  return tabFromScore(alphaTexToScore(tex), options);
}

export function tabFromGuitarPro(bytes: Uint8Array, options: ImportOptions = {}): Tab {
  const score = importer.ScoreLoader.loadScoreFromBytes(bytes, new Settings());
  return tabFromScore(score, options);
}

export function scoreFromTab(tab: Tab): model.Score {
  return alphaTexToScore(toAlphaTex(tab));
}

/** Serializes as a Guitar Pro 7 file (.gp). */
export function tabToGuitarPro(tab: Tab): Uint8Array {
  const score = scoreFromTab(tab);
  return new exporter.Gp7Exporter().export(score);
}

export { midiToName };
