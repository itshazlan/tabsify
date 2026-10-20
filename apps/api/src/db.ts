import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { NoteEvent, Tab, TimeSignature, Tuning } from "@tabsify/engine";

const dbPath = resolve(process.env.TABSIFY_DB ?? "data/tabsify.db");
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS songs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    artist TEXT,
    tempo INTEGER NOT NULL DEFAULT 120,
    tuning_json TEXT NOT NULL,
    capo INTEGER NOT NULL DEFAULT 0,
    time_signatures_json TEXT NOT NULL,
    notes_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    song_id TEXT NOT NULL,
    message TEXT,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
  );
`);
db.exec("CREATE INDEX IF NOT EXISTS revisions_song_idx ON revisions(song_id, created_at DESC);");

export interface SongRow {
  id: string;
  title: string;
  artist: string | null;
  tempo: number;
  tuning_json: string;
  capo: number;
  time_signatures_json: string;
  notes_json: string;
  created_at: string;
  updated_at: string;
}

export function rowToTab(row: SongRow): Tab {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist ?? undefined,
    tempo: row.tempo,
    tuning: JSON.parse(row.tuning_json) as Tuning,
    capo: row.capo,
    timeSignatures: JSON.parse(row.time_signatures_json) as TimeSignature[],
    notes: JSON.parse(row.notes_json) as NoteEvent[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function saveTab(tab: Tab): Tab {
  const now = new Date().toISOString();
  const existing = db.query<{ created_at: string }, [string]>("SELECT created_at FROM songs WHERE id = ?").get(tab.id);

  const record = {
    id: tab.id,
    title: tab.title,
    artist: tab.artist ?? null,
    tempo: Math.round(tab.tempo),
    tuning_json: JSON.stringify(tab.tuning),
    capo: Math.round(tab.capo ?? 0),
    time_signatures_json: JSON.stringify(tab.timeSignatures),
    notes_json: JSON.stringify(tab.notes),
    created_at: existing?.created_at ?? tab.createdAt ?? now,
    updated_at: now,
  };

  db.query(`
    INSERT INTO songs (id, title, artist, tempo, tuning_json, capo, time_signatures_json, notes_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      artist = excluded.artist,
      tempo = excluded.tempo,
      tuning_json = excluded.tuning_json,
      capo = excluded.capo,
      time_signatures_json = excluded.time_signatures_json,
      notes_json = excluded.notes_json,
      updated_at = excluded.updated_at
  `).run(
    record.id,
    record.title,
    record.artist,
    record.tempo,
    record.tuning_json,
    record.capo,
    record.time_signatures_json,
    record.notes_json,
    record.created_at,
    record.updated_at,
  );

  return { ...tab, createdAt: record.created_at, updatedAt: record.updated_at };
}

export function getTab(id: string): Tab | null {
  const row = db.query<SongRow, [string]>("SELECT * FROM songs WHERE id = ?").get(id);
  return row ? rowToTab(row) : null;
}

export interface SongSummary {
  id: string;
  title: string;
  artist?: string;
  tempo: number;
  tuningName: string;
  noteCount: number;
  updatedAt: string;
}

export function listTabs(): SongSummary[] {
  const rows = db
    .query<SongRow, []>("SELECT * FROM songs ORDER BY updated_at DESC")
    .all();
  return rows.map((row) => {
    const tab = rowToTab(row);
    return {
      id: tab.id,
      title: tab.title,
      artist: tab.artist,
      tempo: tab.tempo,
      tuningName: tab.tuning.name,
      noteCount: tab.notes.length,
      updatedAt: tab.updatedAt,
    };
  });
}

export function deleteTab(id: string): boolean {
  const existing = db.query<{ id: string }, [string]>("SELECT id FROM songs WHERE id = ?").get(id);
  if (!existing) return false;
  db.query("DELETE FROM revisions WHERE song_id = ?").run(id);
  db.query("DELETE FROM songs WHERE id = ?").run(id);
  return true;
}

export interface RevisionRow {
  id: number;
  song_id: string;
  message: string | null;
  snapshot_json: string;
  created_at: string;
}

export function addRevision(tab: Tab, message?: string): void {
  db.query(
    "INSERT INTO revisions (song_id, message, snapshot_json, created_at) VALUES (?, ?, ?, ?)",
  ).run(tab.id, message ?? null, JSON.stringify(tab), new Date().toISOString());
}

export function listRevisions(songId: string): Array<{ id: number; message?: string; createdAt: string; noteCount: number }> {
  const rows = db
    .query<RevisionRow, [string]>(
      "SELECT * FROM revisions WHERE song_id = ? ORDER BY created_at DESC LIMIT 100",
    )
    .all(songId);
  return rows.map((row) => {
    const tab = JSON.parse(row.snapshot_json) as Tab;
    return {
      id: row.id,
      message: row.message ?? undefined,
      createdAt: row.created_at,
      noteCount: tab.notes.length,
    };
  });
}

export function getRevision(songId: string, revisionId: number): Tab | null {
  const row = db
    .query<RevisionRow, [string, number]>(
      "SELECT * FROM revisions WHERE song_id = ? AND id = ?",
    )
    .get(songId, revisionId);
  return row ? (JSON.parse(row.snapshot_json) as Tab) : null;
}
