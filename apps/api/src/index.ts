import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  applySolveResult,
  DEFAULT_SOLVE_OPTIONS,
  formatTuning,
  solveFingering,
  STANDARD_TUNING,
  solveMissingFingerings,
  toAlphaTex,
  toMidi,
  TUNING_PRESETS,
  type NoteEvent,
  type SolveOptions,
  type Tab,
  type TimeSignature,
  type Tuning,
} from "@tabsify/engine";
import { tabFromAlphaTex, tabFromGuitarPro, tabToGuitarPro } from "@tabsify/engine/alphatab";
import {
  addRevision,
  deleteTab,
  getRevision,
  getTab,
  listRevisions,
  listTabs,
  saveTab,
} from "./db.ts";
import { seedIfEmpty } from "./seed.ts";
import { mlCapabilities, runTranscription, runVerification } from "./ml.ts";

const app = new Hono();

app.use("/api/*", cors({ origin: ["http://localhost:5173", "http://127.0.0.1:5173"] }));

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function normalizeTuning(input: unknown): Tuning {
  if (!input || typeof input !== "object") {
    throw new HttpError(400, "Tuning wajib diisi");
  }
  const candidate = input as { name?: unknown; strings?: unknown };
  const strings = Array.isArray(candidate.strings)
    ? candidate.strings.map((value) => Math.round(Number(value)))
    : [];
  if (strings.length < 4 || strings.length > 10) {
    throw new HttpError(400, "Tuning harus punya 4 sampai 10 senar");
  }
  if (strings.some((value) => !Number.isFinite(value) || value < 0 || value > 127)) {
    throw new HttpError(400, "Nada tuning harus berupa MIDI 0-127");
  }
  const name =
    typeof candidate.name === "string" && candidate.name.trim()
      ? candidate.name.trim()
      : formatTuning(strings);
  return { name, strings };
}

function normalizeNotes(input: unknown): NoteEvent[] {
  if (!Array.isArray(input)) throw new HttpError(400, "notes harus berupa array");
  if (input.length > 8000) throw new HttpError(400, "Maksimal 8000 note per lagu");

  return input.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new HttpError(400, `Note #${index + 1} tidak valid`);
    }
    const note = raw as Record<string, unknown>;
    const midi = Math.round(Number(note.midi));
    const tick = Math.round(Number(note.tick));
    const duration = Math.round(Number(note.duration ?? 480));

    if (!Number.isFinite(midi) || midi < 0 || midi > 127) {
      throw new HttpError(400, `Note #${index + 1} punya midi tidak valid`);
    }
    if (!Number.isFinite(tick) || tick < 0) {
      throw new HttpError(400, `Note #${index + 1} punya tick tidak valid`);
    }

    const result: NoteEvent = {
      id: typeof note.id === "string" && note.id ? note.id : crypto.randomUUID(),
      midi,
      tick,
      duration: Math.max(30, duration),
    };

    if (Number.isFinite(Number(note.string))) {
      const stringIndex = Math.round(Number(note.string));
      if (stringIndex >= 0 && stringIndex <= 9) result.string = stringIndex;
    }
    if (Number.isFinite(Number(note.fret)) && note.fret !== null) {
      const fret = Math.round(Number(note.fret));
      if (fret >= 0 && fret <= 36) result.fret = fret;
    }
    if (Number.isFinite(Number(note.velocity))) {
      result.velocity = Math.max(1, Math.min(127, Math.round(Number(note.velocity))));
    }
    return result;
  });
}

function normalizeTimeSignatures(input: unknown): TimeSignature[] {
  if (!Array.isArray(input) || input.length === 0) {
    return [{ tick: 0, numerator: 4, denominator: 4 }];
  }
  const signatures = input
    .map((raw) => {
      const candidate = (raw ?? {}) as Record<string, unknown>;
      return {
        tick: Math.max(0, Math.round(Number(candidate.tick ?? 0))),
        numerator: Math.max(1, Math.min(32, Math.round(Number(candidate.numerator ?? 4)))),
        denominator: Math.max(1, Math.min(32, Math.round(Number(candidate.denominator ?? 4)))),
      };
    })
    .sort((a, b) => a.tick - b.tick);

  if (signatures[0]!.tick !== 0) {
    signatures.unshift({ tick: 0, numerator: 4, denominator: 4 });
  }
  return signatures;
}

function normalizeTab(raw: unknown, fallbackId?: string): Tab {
  if (!raw || typeof raw !== "object") throw new HttpError(400, "Body lagu tidak valid");
  const body = raw as Record<string, unknown>;
  const now = new Date().toISOString();

  return {
    id: typeof body.id === "string" && body.id ? body.id : (fallbackId ?? crypto.randomUUID()),
    title: typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : "Untitled",
    artist: typeof body.artist === "string" && body.artist.trim() ? body.artist.trim().slice(0, 200) : undefined,
    tempo: Math.max(20, Math.min(400, Math.round(Number(body.tempo ?? 120)))),
    tuning: normalizeTuning(body.tuning),
    capo: Math.max(0, Math.min(12, Math.round(Number(body.capo ?? 0)))),
    timeSignatures: normalizeTimeSignatures(body.timeSignatures),
    notes: normalizeNotes(body.notes ?? []),
    createdAt: typeof body.createdAt === "string" ? body.createdAt : now,
    updatedAt: now,
  };
}

function readSolveOptions(raw: unknown): Partial<SolveOptions> {
  if (!raw || typeof raw !== "object") return {};
  const body = raw as Record<string, unknown>;
  const options: Partial<SolveOptions> = {};

  const numericKeys: Array<keyof SolveOptions> = [
    "maxFret",
    "handSpan",
    "beamWidth",
    "candidateLimit",
    "openStringBonus",
    "highFretCost",
    "positionMoveCost",
    "stringJumpCost",
    "repeatOnSameStringBonus",
    "spanPenaltyPerFret",
    "chordToleranceTicks",
    "startPosition",
  ];
  for (const key of numericKeys) {
    const value = Number(body[key]);
    if (Number.isFinite(value)) {
      (options as Record<string, number>)[key] = value;
    }
  }
  if (typeof body.keepExisting === "boolean") options.keepExisting = body.keepExisting;
  return options;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "tab"
  );
}

app.onError((error, c) => {
  if (error instanceof HttpError) {
    return c.json({ error: error.message }, error.status as 400);
  }
  console.error(error);
  return c.json({ error: error.message ?? "Internal error" }, 500);
});

app.get("/api/health", (c) => c.json({ ok: true, version: "0.1.0" }));

app.get("/api/capabilities", async (c) =>
  c.json({ ml: await mlCapabilities(c.req.query("refresh") === "1") }),
);

app.get("/api/tunings", (c) => c.json({ presets: TUNING_PRESETS }));
app.get("/api/solve-options", (c) => c.json({ defaults: DEFAULT_SOLVE_OPTIONS }));

app.get("/api/songs", (c) => c.json({ songs: listTabs() }));

app.post("/api/songs", async (c) => {
  const body = await c.req.json();
  const tab = normalizeTab(body);
  const saved = saveTab(tab);
  return c.json({ song: saved }, 201);
});

app.get("/api/songs/:id", (c) => {
  const tab = getTab(c.req.param("id"));
  if (!tab) throw new HttpError(404, "Lagu tidak ditemukan");
  return c.json({ song: tab });
});

app.put("/api/songs/:id", async (c) => {
  const id = c.req.param("id");
  const existing = getTab(id);
  if (!existing) throw new HttpError(404, "Lagu tidak ditemukan");

  const body = await c.req.json();
  const tab = normalizeTab({ ...body, id }, id);
  const message = typeof (body as { message?: unknown }).message === "string"
    ? (body as { message: string }).message
    : undefined;

  addRevision(existing, message ?? "autosave");
  const saved = saveTab(tab);
  return c.json({ song: saved });
});

app.delete("/api/songs/:id", (c) => {
  const removed = deleteTab(c.req.param("id"));
  if (!removed) throw new HttpError(404, "Lagu tidak ditemukan");
  return c.json({ ok: true });
});

app.post("/api/songs/:id/solve", async (c) => {
  const id = c.req.param("id");
  const tab = getTab(id);
  if (!tab) throw new HttpError(404, "Lagu tidak ditemukan");

  const body = await c.req.json().catch(() => ({}));
  const options = readSolveOptions(body);
  const result = solveFingering(tab, options);
  const solved = applySolveResult(tab, result);

  if ((body as { persist?: unknown }).persist === true) {
    addRevision(tab, "before solve");
    saveTab(solved);
  }

  return c.json({
    song: solved,
    assignments: result.assignments,
    unplayable: result.unplayable,
    cost: result.cost,
  });
});

app.post("/api/solve", async (c) => {
  const body = (await c.req.json()) as Record<string, unknown>;
  const tab = normalizeTab({ ...body, title: "adhoc" });
  const result = solveFingering(tab, readSolveOptions(body.options));
  return c.json(result);
});

app.get("/api/songs/:id/export/:format", (c) => {
  const id = c.req.param("id");
  const format = c.req.param("format");
  const stored = getTab(id);
  if (!stored) throw new HttpError(404, "Lagu tidak ditemukan");

  const tab = solveMissingFingerings(stored);
  const filename = slug(tab.title);

  switch (format) {
    case "alphatex": {
      const tex = toAlphaTex(tab);
      c.header("Content-Type", "text/plain; charset=utf-8");
      c.header("Content-Disposition", `attachment; filename="${filename}.atex"`);
      return c.body(tex);
    }
    case "midi": {
      const midi = toMidi(tab);
      c.header("Content-Type", "audio/midi");
      c.header("Content-Disposition", `attachment; filename="${filename}.mid"`);
      return c.body(midi.buffer as ArrayBuffer);
    }
    case "gp": {
      const gp = tabToGuitarPro(tab);
      c.header("Content-Type", "application/octet-stream");
      c.header("Content-Disposition", `attachment; filename="${filename}.gp"`);
      return c.body(gp.buffer as ArrayBuffer);
    }
    case "json": {
      c.header("Content-Type", "application/json");
      c.header("Content-Disposition", `attachment; filename="${filename}.json"`);
      return c.body(JSON.stringify(tab, null, 2));
    }
    default:
      throw new HttpError(400, `Format "${format}" tidak didukung (alphatex|midi|gp|json)`);
  }
});

app.post("/api/import/:format", async (c) => {
  const format = c.req.param("format");
  const filename = c.req.query("filename") ?? undefined;
  let tab: Tab;

  if (format === "gp") {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length === 0) throw new HttpError(400, "File kosong");
    try {
      tab = tabFromGuitarPro(bytes);
    } catch (error) {
      throw new HttpError(422, `Gagal membaca file Guitar Pro: ${(error as Error).message}`);
    }
  } else if (format === "alphatex" || format === "atex") {
    const tex = await c.req.text();
    try {
      tab = tabFromAlphaTex(tex);
    } catch (error) {
      throw new HttpError(422, `Gagal membaca alphaTex: ${(error as Error).message}`);
    }
  } else {
    throw new HttpError(400, `Format import "${format}" tidak didukung (gp|alphatex)`);
  }

  if (filename) tab.title = filename.replace(/\.[a-z0-9]+$/i, "");
  const saved = saveTab(tab);
  return c.json({ song: saved }, 201);
});

interface TranscribeJob {
  id: string;
  status: "running" | "done" | "error";
  createdAt: number;
  progress: string[];
  songId?: string;
  diagnostics?: Record<string, unknown>;
  error?: string;
  stemPath?: string;
  jobDir?: string;
}

const transcribeJobs = new Map<string, TranscribeJob>();
const JOB_TTL_MS = 60 * 60 * 1000;

function pruneTranscribeJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of transcribeJobs) {
    if (job.createdAt >= cutoff) continue;
    if (job.jobDir) rmSync(job.jobDir, { recursive: true, force: true });
    transcribeJobs.delete(id);
  }
}

app.post("/api/transcribe", async (c) => {
  pruneTranscribeJobs();

  const capabilities = await mlCapabilities();
  if (!capabilities.transcribe) {
    throw new HttpError(503, capabilities.hint ?? "Pipeline audio belum siap");
  }

  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) {
    throw new HttpError(400, "Field 'file' berisi file audio wajib dikirim");
  }

  let tuning: Tuning = { ...STANDARD_TUNING };
  const rawTuning = body["tuning"];
  if (typeof rawTuning === "string" && rawTuning.trim()) {
    try {
      tuning = normalizeTuning(JSON.parse(rawTuning));
    } catch {
      throw new HttpError(400, "Format tuning tidak valid");
    }
  }

  const tempoValue = Number(body["tempo"]);
  const gridValue = Number(body["grid"]);
  const separate = String(body["separate"] ?? "") === "true";
  const chords = String(body["chords"] ?? "false") === "true";
  const stemValue = String(body["stem"] ?? "");
  const stem = (["auto", "other", "guitar", "mix"] as const).includes(
    stemValue as "auto" | "other" | "guitar" | "mix",
  )
    ? (stemValue as "auto" | "other" | "guitar" | "mix")
    : undefined;
  const title =
    typeof body["title"] === "string" && body["title"].trim()
      ? body["title"].trim().slice(0, 200)
      : file.name.replace(/\.[^.]+$/, "");

  const job: TranscribeJob = {
    id: crypto.randomUUID(),
    status: "running",
    createdAt: Date.now(),
    progress: [],
  };
  transcribeJobs.set(job.id, job);

  void (async () => {
    try {
      const parsed = await runTranscription({
        file,
        tuningMidi: tuning.strings,
        tuningName: tuning.name,
        tempo: Number.isFinite(tempoValue) && tempoValue > 0 ? tempoValue : undefined,
        gridTicks: Number.isFinite(gridValue) && gridValue >= 60 ? Math.round(gridValue) : 240,
        separate,
        stem,
        chords,
        title,
        keepArtifacts: true,
        onLog: (line) => {
          job.progress.push(line);
          if (job.progress.length > 12) job.progress.shift();
        },
      });

      const tab = normalizeTab({ ...parsed.tab, tuning });
      const solvedResult = solveFingering(tab, { handSpan: 4, maxFret: 24, keepExisting: false });
      const solved = applySolveResult(tab, solvedResult);
      const saved = saveTab(solved);

      job.songId = saved.id;
      job.diagnostics = { ...parsed.diagnostics, unplayable: solvedResult.unplayable.length };
      job.stemPath = parsed.stemPath;
      job.jobDir = parsed.jobDir;
      job.status = "done";
    } catch (error) {
      job.status = "error";
      job.error = (error as Error).message;
    }
  })();

  return c.json({ jobId: job.id }, 202);
});

app.get("/api/transcribe/:jobId/stem", (c) => {
  const job = transcribeJobs.get(c.req.param("jobId"));
  if (!job?.stemPath || !existsSync(job.stemPath)) {
    throw new HttpError(404, "Stem tidak tersedia untuk job ini");
  }
  c.header("Content-Type", "audio/wav");
  return c.body(Bun.file(job.stemPath).stream());
});

app.get("/api/transcribe/:jobId", (c) => {
  const job = transcribeJobs.get(c.req.param("jobId"));
  if (!job) throw new HttpError(404, "Job transkripsi tidak ditemukan");

  const payload = {
    id: job.id,
    status: job.status,
    progress: job.progress,
    diagnostics: job.diagnostics,
    error: job.error,
  };

  if (job.status === "done" && job.songId) {
    const song = getTab(job.songId);
    return c.json({ job: payload, song });
  }
  return c.json({ job: payload });
});

interface VerifyJob {
  id: string;
  status: "running" | "done" | "error";
  createdAt: number;
  summary?: Record<string, unknown>;
  bars?: unknown[];
  error?: string;
}

const verifyJobs = new Map<string, VerifyJob>();
const VERIFY_TTL_MS = 30 * 60 * 1000;

function pruneVerifyJobs(): void {
  const cutoff = Date.now() - VERIFY_TTL_MS;
  for (const [id, job] of verifyJobs) {
    if (job.createdAt < cutoff) verifyJobs.delete(id);
  }
}

app.post("/api/songs/:id/verify", async (c) => {
  pruneVerifyJobs();

  const songId = c.req.param("id");
  const tab = getTab(songId);
  if (!tab) throw new HttpError(404, "Lagu tidak ditemukan");

  const capabilities = await mlCapabilities();
  if (!capabilities.transcribe) {
    throw new HttpError(503, capabilities.hint ?? "Pipeline audio belum siap");
  }

  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) {
    throw new HttpError(400, "Field 'file' berisi audio wajib dikirim");
  }

  const tempoValue = Number(body["tempo"]);
  const offsetValue = Number(body["offset"]);

  const job: VerifyJob = {
    id: crypto.randomUUID(),
    status: "running",
    createdAt: Date.now(),
  };
  verifyJobs.set(job.id, job);

  void (async () => {
    try {
      const result = await runVerification({
        file,
        tab,
        tempo: Number.isFinite(tempoValue) && tempoValue > 0 ? tempoValue : undefined,
        offset: Number.isFinite(offsetValue) ? offsetValue : undefined,
      });
      job.summary = result.summary;
      job.bars = result.bars;
      job.status = "done";
    } catch (error) {
      job.status = "error";
      job.error = (error as Error).message;
    }
  })();

  return c.json({ jobId: job.id }, 202);
});

app.get("/api/verify/:jobId", (c) => {
  const job = verifyJobs.get(c.req.param("jobId"));
  if (!job) throw new HttpError(404, "Job verifikasi tidak ditemukan");
  return c.json({
    id: job.id,
    status: job.status,
    summary: job.summary,
    bars: job.bars,
    error: job.error,
  });
});

app.get("/api/songs/:id/revisions", (c) => {
  const id = c.req.param("id");
  if (!getTab(id)) throw new HttpError(404, "Lagu tidak ditemukan");
  return c.json({ revisions: listRevisions(id) });
});

app.post("/api/songs/:id/revisions/:revisionId/restore", (c) => {
  const id = c.req.param("id");
  const revisionId = Number(c.req.param("revisionId"));
  const current = getTab(id);
  if (!current) throw new HttpError(404, "Lagu tidak ditemukan");

  const snapshot = getRevision(id, revisionId);
  if (!snapshot) throw new HttpError(404, "Revisi tidak ditemukan");

  addRevision(current, "before restore");
  const restored = saveTab({ ...snapshot, id });
  return c.json({ song: restored });
});

seedIfEmpty();

const webDist = resolve(import.meta.dir, "../../web/dist");
if (existsSync(webDist)) {
  app.use("/*", serveStatic({ root: webDist }));
  app.get("*", serveStatic({ path: resolve(webDist, "index.html") }));
}

export { app };

const port = Number(process.env.PORT ?? 3001);
console.log(`🎸 tabsify api listening on http://localhost:${port}`);

export default { port, fetch: app.fetch };
