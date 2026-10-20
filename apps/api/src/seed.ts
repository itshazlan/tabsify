import { solveFingering, applySolveResult, type NoteEvent, type Tab } from "@tabsify/engine";
import { listTabs, saveTab } from "./db.ts";

export function buildDemoTab(): Tab {
  const tuning = { name: "Open C", strings: [36, 43, 48, 52, 55, 60] };
  const now = new Date().toISOString();

  // Riff yang memakai open string + nada fretted, biar solver-nya kelihatan kerjanya.
  const pitches: Array<[number, number, number]> = [
    // [midi, tick, duration]
    [36, 0, 480],
    [36, 480, 240],
    [43, 720, 240],
    [48, 960, 240],
    [50, 1200, 240],
    [52, 1440, 240],
    [55, 1680, 240],
    [57, 1920, 240],
    [55, 2160, 240],
    [53, 2400, 240],
    [52, 2640, 240],
    [50, 2880, 240],
    [48, 3120, 240],
    [43, 3360, 240],
    [36, 3600, 240],
    [36, 3840, 1920],
    [48, 3840, 1920],
    [52, 3840, 1920],
    [55, 3840, 1920],
  ];

  const notes: NoteEvent[] = pitches.map(([midi, tick, duration], index) => ({
    id: `demo-${index}`,
    midi,
    tick,
    duration,
  }));

  const tab: Tab = {
    id: crypto.randomUUID(),
    title: "Demo — Open C riff",
    artist: "Tabsify",
    tempo: 92,
    tuning,
    capo: 0,
    timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }],
    notes,
    createdAt: now,
    updatedAt: now,
  };

  return applySolveResult(tab, solveFingering(tab));
}

export function seedIfEmpty(): void {
  if (listTabs().length > 0) return;
  saveTab(buildDemoTab());
}
