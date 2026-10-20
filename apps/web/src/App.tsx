import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applySolveResult,
  buildBars,
  formatTuning,
  midiToName,
  TUNING_PRESETS,
  parseTuning,
  solveFingering,
  STANDARD_TUNING,
  type NoteEvent,
  type Tab,
  type Tuning,
  type UnplayableNote,
} from "@tabsify/engine";
import { api, type SongSummary } from "./api.ts";
import { TabGrid } from "./TabGrid.tsx";
import { TabNotation } from "./TabNotation.tsx";
const TabReader = lazy(() =>
  import("./TabReader.tsx").then((module) => ({ default: module.TabReader })),
);
import { TuningBar } from "./TuningBar.tsx";
import { usePlayback } from "./usePlayback.ts";

type SaveState = { kind: "idle" | "saving" | "saved" | "error"; message?: string };

const DURATIONS = [
  { value: 240, label: "1/16" },
  { value: 480, label: "1/8" },
  { value: 960, label: "1/4" },
  { value: 1920, label: "1/2" },
  { value: 3840, label: "1" },
];

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "tab"
  );
}

export default function App() {
  const [songs, setSongs] = useState<SongSummary[]>([]);
  const [tab, setTab] = useState<Tab | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [gridTicks, setGridTicks] = useState(240);
  const [cellWidth, setCellWidth] = useState(26);
  const [flagCursor, setFlagCursor] = useState(0);
  const [handSpan, setHandSpan] = useState(4);
  const [maxFret, setMaxFret] = useState(24);
  const [keepManual, setKeepManual] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const [solveInfo, setSolveInfo] = useState<{ cost: number; unplayable: UnplayableNote[] } | null>(
    null,
  );
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [capabilities, setCapabilities] = useState<{
    transcribe: boolean;
    separate: boolean;
    backend: string;
    hint?: string;
  } | null>(null);
  const [audioState, setAudioState] = useState<{
    status: "idle" | "running" | "error" | "done";
    message?: string;
  }>({ status: "idle" });
  const [audioTempo, setAudioTempo] = useState("");
  const [audioStem, setAudioStem] = useState("auto");
  const [audioJobId, setAudioJobId] = useState<string | null>(null);
  const [audioStemAvailable, setAudioStemAvailable] = useState(false);
  const [view, setView] = useState<"notation" | "grid" | "reader">("notation");
  const [verifyState, setVerifyState] = useState<{
    status: "idle" | "running" | "done" | "error";
    message?: string;
    summary?: Record<string, unknown>;
    bars?: Array<{ index: number; score: number | null; flags: string[] }>;
  }>({ status: "idle" });
  const [audioTuning, setAudioTuning] = useState("");
  const [audioChords, setAudioChords] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const tabRef = useRef<Tab | null>(null);
  const historyRef = useRef<Tab[]>([]);

  useEffect(() => {
    tabRef.current = tab;
    if (tab) setAudioTuning(formatTuning(tab.tuning.strings));
  }, [tab]);

  const playback = usePlayback(tab);

  const refreshSongs = useCallback(async () => {
    try {
      setSongs(await api.listSongs());
    } catch {
      /* daftar lagu opsional */
    }
  }, []);

  const loadSong = useCallback(async (id: string) => {
    try {
      const song = await api.getSong(id);
      historyRef.current = [];
      setTab(song);
      setSelectedNoteId(null);
      setSolveInfo(null);
      setRevision(0);
      setSaveState({ kind: "idle" });
      setError(null);
    } catch (loadError) {
      setError((loadError as Error).message);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/capabilities");
        if (response.ok) {
          const data = (await response.json()) as {
            ml: { transcribe: boolean; separate: boolean; backend: string; hint?: string };
          };
          setCapabilities(data.ml);
        }
      } catch {
        /* endpoint opsional */
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const list = await api.listSongs();
        setSongs(list);
        if (list[0]) {
          const song = await api.getSong(list[0].id);
          setTab(song);
        }
      } catch (loadError) {
        setError((loadError as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // autosave: hanya jalan setelah user mengubah sesuatu (revision > 0)
  useEffect(() => {
    if (revision === 0) return;
    const timer = window.setTimeout(async () => {
      const snapshot = tabRef.current;
      if (!snapshot) return;
      setSaveState({ kind: "saving" });
      try {
        await api.saveSong(snapshot);
        setSaveState({ kind: "saved" });
        void refreshSongs();
      } catch (saveError) {
        setSaveState({ kind: "error", message: (saveError as Error).message });
      }
    }, 900);
    return () => window.clearTimeout(timer);
  }, [revision, refreshSongs]);

  const mutate = useCallback(
    (updater: (current: Tab) => Tab, options: { record?: boolean } = {}) => {
      setTab((current) => {
        if (!current) return current;
        const next = updater(current);
        if (next === current) return current;
        if (options.record !== false) {
          historyRef.current.push(current);
          if (historyRef.current.length > 80) historyRef.current.shift();
        }
        return next;
      });
      setRevision((value) => value + 1);
    },
    [],
  );

  const audioTuningPreset = useMemo(() => {
    const text = audioTuning.trim();
    return (
      TUNING_PRESETS.find((preset) => formatTuning(preset.strings) === text)?.name ?? "custom"
    );
  }, [audioTuning]);

  const bars = useMemo(() => {
    if (!tab) return [];
    const lastEnd = tab.notes.reduce((max, note) => Math.max(max, note.tick + note.duration), 0);
    return buildBars(tab.timeSignatures, lastEnd + 3840, 8);
  }, [tab]);

  const unplayableIds = useMemo(
    () => new Set((solveInfo?.unplayable ?? []).map((item) => item.noteId)),
    [solveInfo],
  );

  const barScores = useMemo(() => {
    const map = new Map<number, { score: number | null; flagged: boolean }>();
    for (const bar of verifyState.bars ?? []) {
      map.set(bar.index, { score: bar.score, flagged: bar.flags.length > 0 });
    }
    return map;
  }, [verifyState.bars]);

  const selectedNote = useMemo(
    () => tab?.notes.find((note) => note.id === selectedNoteId) ?? null,
    [selectedNoteId, tab],
  );

  const runSolve = useCallback(
    (mode: "all" | "missing" = "all") => {
      const current = tabRef.current;
      if (!current) return;
      const result = solveFingering(current, {
        handSpan,
        maxFret,
        keepExisting: mode === "missing" || keepManual,
      });
      mutate(() => applySolveResult(current, result));
      setSolveInfo({ cost: result.cost, unplayable: result.unplayable });
      setSelectedNoteId(null);
    },
    [handSpan, keepManual, maxFret, mutate],
  );

  const activeBar = useMemo(() => {
    if (bars.length === 0) return null;
    const tick = selectedNote?.tick ?? (playback.isPlaying ? playback.playheadTick : null);
    if (tick == null) return bars[0]!;
    return bars.find((bar) => tick >= bar.startTick && tick < bar.endTick) ?? bars[0]!;
  }, [bars, playback.isPlaying, playback.playheadTick, selectedNote]);

  const solveBar = useCallback(() => {
    const current = tabRef.current;
    if (!current || !activeBar) return;
    const inBar = current.notes.filter(
      (note) => note.tick >= activeBar.startTick && note.tick < activeBar.endTick,
    );
    if (inBar.length === 0) return;

    const subset: Tab = { ...current, notes: inBar };
    const result = solveFingering(subset, {
      handSpan,
      maxFret,
      keepExisting: false,
    });
    const solvedSubset = applySolveResult(subset, result);
    const byId = new Map(solvedSubset.notes.map((note) => [note.id, note]));

    mutate((existing) => ({
      ...existing,
      notes: existing.notes.map((note) => byId.get(note.id) ?? note),
    }));
    setSolveInfo({ cost: result.cost, unplayable: result.unplayable });
  }, [activeBar, handSpan, maxFret, mutate]);

  const applyTuning = useCallback(
    (tuning: Tuning) => {
      const current = tabRef.current;
      if (!current) return;
      const withTuning: Tab = { ...current, tuning };
      const result = solveFingering(withTuning, { handSpan, maxFret, keepExisting: false });
      mutate(() => applySolveResult(withTuning, result));
      setSolveInfo({ cost: result.cost, unplayable: result.unplayable });
    },
    [handSpan, maxFret, mutate],
  );

  const changeString = useCallback(
    (displayIndex: number, midi: number) => {
      const current = tabRef.current;
      if (!current) return;
      const strings = [...current.tuning.strings];
      const index = strings.length - 1 - displayIndex;
      if (index < 0 || index >= strings.length) return;
      strings[index] = midi;
      applyTuning({ name: `Custom (${formatTuning(strings)})`, strings });
    },
    [applyTuning],
  );

  const changeCapo = useCallback(
    (capo: number) => {
      const current = tabRef.current;
      if (!current) return;
      const withCapo: Tab = { ...current, capo };
      const result = solveFingering(withCapo, { handSpan, maxFret, keepExisting: false });
      mutate(() => applySolveResult(withCapo, result));
      setSolveInfo({ cost: result.cost, unplayable: result.unplayable });
    },
    [handSpan, maxFret, mutate],
  );

  const addNote = useCallback(
    (tick: number, stringIndex: number) => {
      const current = tabRef.current;
      if (!current) return;
      const open = current.tuning.strings[stringIndex];
      if (open == null) return;
      const note: NoteEvent = {
        id: crypto.randomUUID(),
        tick,
        duration: Math.max(240, gridTicks),
        midi: open + current.capo,
        string: stringIndex,
        fret: 0,
      };
      mutate((existing) => ({ ...existing, notes: [...existing.notes, note] }));
      setSelectedNoteId(note.id);
    },
    [gridTicks, mutate],
  );

  const setFret = useCallback(
    (id: string, fret: number) => {
      mutate((current) => {
        const note = current.notes.find((item) => item.id === id);
        if (!note || note.string == null) return current;
        const clamped = Math.max(0, Math.min(maxFret, fret));
        const midi = current.tuning.strings[note.string]! + clamped + current.capo;
        return {
          ...current,
          notes: current.notes.map((item) =>
            item.id === id ? { ...item, fret: clamped, midi } : item,
          ),
        };
      });
    },
    [maxFret, mutate],
  );

  const moveString = useCallback(
    (id: string, delta: number) => {
      mutate((current) => {
        const note = current.notes.find((item) => item.id === id);
        if (!note || note.string == null) return current;
        const nextString = note.string + delta;
        if (nextString < 0 || nextString >= current.tuning.strings.length) return current;
        const fret = note.midi - current.tuning.strings[nextString]! - current.capo;
        if (fret < 0 || fret > maxFret) return current;
        return {
          ...current,
          notes: current.notes.map((item) =>
            item.id === id ? { ...item, string: nextString, fret } : item,
          ),
        };
      });
    },
    [maxFret, mutate],
  );

  const deleteNote = useCallback(
    (id: string) => {
      mutate((current) => ({
        ...current,
        notes: current.notes.filter((note) => note.id !== id),
      }));
      setSelectedNoteId((current) => (current === id ? null : current));
    },
    [mutate],
  );

  const setDuration = useCallback(
    (id: string, duration: number) => {
      mutate((current) => ({
        ...current,
        notes: current.notes.map((note) => (note.id === id ? { ...note, duration } : note)),
      }));
    },
    [mutate],
  );

  const transcribeAudio = useCallback(
    async (file: File) => {
      setAudioState({ status: "running", message: "mengunggah…" });
      setAudioStemAvailable(false);
      setNotice(null);

      let tuningStrings: number[];
      try {
        tuningStrings = parseTuning(audioTuning.trim() || "E2 A2 D3 G3 B3 E4");
      } catch (tuningError) {
        setAudioState({ status: "error", message: (tuningError as Error).message });
        return;
      }

      const form = new FormData();
      form.append("file", file);
      form.append("tuning", JSON.stringify({ name: audioTuning.trim() || "Custom", strings: tuningStrings }));
      if (audioTempo.trim()) form.append("tempo", audioTempo.trim());
      form.append("stem", audioStem);
      form.append("chords", String(audioChords));
      form.append("title", file.name.replace(/\.[^.]+$/, ""));

      try {
        const startResponse = await fetch("/api/transcribe", { method: "POST", body: form });
        if (!startResponse.ok) {
          const body = (await startResponse.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${startResponse.status}`);
        }
        const { jobId } = (await startResponse.json()) as { jobId: string };
        setAudioJobId(jobId);

        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, 1200));
          const poll = await fetch(`/api/transcribe/${jobId}`);
          const payload = (await poll.json()) as {
            job: { status: string; progress?: string[]; error?: string; diagnostics?: Record<string, unknown> };
            song?: Tab;
          };

          if (payload.job.status === "running") {
            const latest = payload.job.progress?.at(-1);
            setAudioState({ status: "running", message: latest ?? "memproses…" });
            continue;
          }
          if (payload.job.status === "error") {
            throw new Error(payload.job.error ?? "Transkripsi gagal");
          }
          if (!payload.song) throw new Error("Pipeline selesai tanpa hasil");

          const song = payload.song;
          setTab(song);
          setRevision(0);
          setSelectedNoteId(null);
          setSolveInfo(null);
          const diagnostics = (payload.job.diagnostics ?? {}) as Record<string, unknown>;
          const extras: string[] = [];
          if (Number(diagnostics.chordNotes) > 0) extras.push(`${diagnostics.chordNotes} nada fifth`);
          if (Number(diagnostics.octaveCorrections) > 0) {
            extras.push(`${diagnostics.octaveCorrections} koreksi oktaf`);
          }
          const detail = extras.length > 0 ? ` (${extras.join(", ")})` : "";

          setAudioState({
            status: "done",
            message: `${song.notes.length} note · ${diagnostics.tempo ?? "?"} BPM`,
          });
          setAudioStemAvailable(Boolean(diagnostics.separated));
          const stemLabel = String(
            diagnostics.stem ? `${diagnostics.stem}${diagnostics.separated ? " (separation)" : " (fallback)"}` : "mix",
          );
          const pipelineWarnings = Array.isArray(diagnostics.warnings)
            ? (diagnostics.warnings as unknown[]).slice(0, 2).join(" ")
            : "";

          setNotice(
            `Transkripsi selesai: ${song.notes.length} note${detail}, tempo ${diagnostics.tempo ?? "?"} BPM` +
              `, sumber: ${stemLabel}.` +
              (pipelineWarnings ? ` Catatan: ${pipelineWarnings}` : "") +
              " Kalau hasilnya tidak masuk akal, coba ganti sumber audio lalu transkrip ulang.",
          );
          await refreshSongs();
          return;
        }
      } catch (transcribeError) {
        const message = (transcribeError as Error).message;
        setAudioState({ status: "error", message });
        setNotice(`Transkripsi gagal: ${message}`);
      }
    },
    [audioChords, audioStem, audioTempo, audioTuning, capabilities, refreshSongs],
  );

  const verifyAudio = useCallback(
    async (file: File) => {
      const current = tabRef.current;
      if (!current) return;

      setVerifyState({ status: "running", message: "mengunggah…" });
      setNotice(null);

      const form = new FormData();
      form.append("file", file);
      form.append("tempo", String(current.tempo));

      try {
        const startResponse = await fetch(`/api/songs/${current.id}/verify`, {
          method: "POST",
          body: form,
        });
        if (!startResponse.ok) {
          const body = (await startResponse.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${startResponse.status}`);
        }
        const { jobId } = (await startResponse.json()) as { jobId: string };

        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          const poll = await fetch(`/api/verify/${jobId}`);
          const payload = (await poll.json()) as {
            status: string;
            summary?: Record<string, unknown>;
            bars?: Array<{ index: number; score: number | null; flags: string[] }>;
            error?: string;
          };

          if (payload.status === "running") {
            setVerifyState({ status: "running", message: "menganalisis audio…" });
            continue;
          }
          if (payload.status === "error") throw new Error(payload.error ?? "Verifikasi gagal");
          if (!payload.bars) throw new Error("Verifikasi selesai tanpa hasil");

          setVerifyState({ status: "done", summary: payload.summary, bars: payload.bars });

          const flagged = payload.bars.filter((bar) => bar.flags.length > 0);
          const average = payload.summary?.averageScore;
          setNotice(
            `Cek audio selesai: ${flagged.length} dari ${payload.bars.length} bar perlu dicek` +
              (typeof average === "number" ? ` (rata-rata cocok ${Math.round(average * 100)}%)` : "") +
              `. Bar merah di grid = pitch-nya tidak cocok dengan rekaman.`,
          );
          return;
        }
      } catch (verifyError) {
        const message = (verifyError as Error).message;
        setVerifyState({ status: "error", message });
        setNotice(`Cek audio gagal: ${message}`);
      }
    },
    [],
  );

  const selectRelative = useCallback((id: string, delta: number) => {
    const current = tabRef.current;
    if (!current) return;
    const ordered = [...current.notes].sort(
      (a, b) => a.tick - b.tick || (a.string ?? 0) - (b.string ?? 0),
    );
    const index = ordered.findIndex((note) => note.id === id);
    if (index < 0) return;
    const next = ordered[Math.max(0, Math.min(ordered.length - 1, index + delta))];
    setSelectedNoteId(next ? next.id : null);
  }, []);

  const undo = useCallback(() => {
    const previous = historyRef.current.pop();
    if (!previous) return;
    setTab(previous);
    setSelectedNoteId(null);
    setRevision((value) => value + 1);
  }, []);

  const newSong = useCallback(async () => {
    try {
      const song = await api.createSong({
        title: "Lagu baru",
        tuning: STANDARD_TUNING,
        tempo: 120,
        capo: 0,
        timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }],
        notes: [],
      });
      setTab(song);
      setRevision(0);
      setSelectedNoteId(null);
      setSolveInfo(null);
      await refreshSongs();
    } catch (createError) {
      setError((createError as Error).message);
    }
  }, [refreshSongs]);

  const removeSong = useCallback(async () => {
    const current = tabRef.current;
    if (!current) return;
    if (!window.confirm(`Hapus "${current.title}"?`)) return;
    try {
      await api.deleteSong(current.id);
      const list = await api.listSongs();
      setSongs(list);
      if (list[0]) await loadSong(list[0].id);
      else setTab(null);
    } catch (removeError) {
      setError((removeError as Error).message);
    }
  }, [loadSong]);

  const exportAs = useCallback(
    async (kind: "gp" | "midi" | "alphatex" | "json") => {
      const current = tabRef.current;
      if (!current) return;
      const extension = kind === "midi" ? "mid" : kind === "alphatex" ? "atex" : kind;
      try {
        await api.download(current.id, kind, `${slugify(current.title)}.${extension}`);
      } catch (downloadError) {
        setError((downloadError as Error).message);
      }
    },
    [],
  );

  const importGuitarPro = useCallback(
    async (file: File) => {
      try {
        const song = await api.importGuitarPro(file);
        setTab(song);
        setSelectedNoteId(null);
        setSolveInfo(null);
        setRevision(0);
        await refreshSongs();
      } catch (importError) {
        setError((importError as Error).message);
      }
    },
    [refreshSongs],
  );

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undo();
        return;
      }
      if (event.code === "Space") {
        event.preventDefault();
        playback.toggle();
        return;
      }
      if (event.key === "Escape") {
        setSelectedNoteId(null);
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selectedNoteId) {
        event.preventDefault();
        deleteNote(selectedNoteId);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [deleteNote, playback, selectedNoteId, undo]);

  if (loading) {
    return <div className="boot">Memuat tabsify…</div>;
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">🎸</span> tabsify
        </div>

        <select
          className="song-select"
          value={tab?.id ?? ""}
          onChange={(event) => {
            if (event.target.value) void loadSong(event.target.value);
          }}
        >
          <option value="">— pilih lagu —</option>
          {songs.map((song) => (
            <option key={song.id} value={song.id}>
              {song.title} · {song.tuningName} · {song.noteCount} note
            </option>
          ))}
        </select>

        <button type="button" className="ghost" onClick={() => void newSong()}>
          + Baru
        </button>

        {capabilities?.transcribe ? (
          <details className="menu">
            <summary>{audioState.status === "running" ? "⏳ Audio…" : "Audio"}</summary>
            <div className="menu-body audio-menu">
              <label className="audio-file">
                <span>Pilih file audio</span>
                <input
                  type="file"
                  accept="audio/*,.mp3,.wav,.flac,.m4a,.ogg,.aiff"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void transcribeAudio(file);
                    event.target.value = "";
                  }}
                />
              </label>

              <div className="audio-field">
                <span>Tuning (senar terendah dulu)</span>
                <select
                  className="audio-preset"
                  value={audioTuningPreset}
                  onChange={(event) => {
                    const preset = TUNING_PRESETS.find((item) => item.name === event.target.value);
                    if (preset) setAudioTuning(formatTuning(preset.strings));
                  }}
                >
                  <option value="custom">Custom</option>
                  {TUNING_PRESETS.map((preset) => (
                    <option key={preset.name} value={preset.name}>
                      {preset.name} — {formatTuning(preset.strings)}
                    </option>
                  ))}
                </select>
                <input
                  className="audio-tuning-input"
                  value={audioTuning}
                  spellCheck={false}
                  placeholder="E2 A2 D3 G3 B3 E4"
                  onChange={(event) => setAudioTuning(event.target.value)}
                />
              </div>

              <label className="audio-row">
                <span>Tempo (kosong = auto)</span>
                <input
                  type="number"
                  min={40}
                  max={240}
                  placeholder="auto"
                  value={audioTempo}
                  onChange={(event) => setAudioTempo(event.target.value)}
                />
              </label>

              <label className="audio-field">
                <span>Sumber audio</span>
                <select
                  className="audio-preset"
                  value={audioStem}
                  disabled={!capabilities.separate}
                  onChange={(event) => setAudioStem(event.target.value)}
                >
                  <option value="auto">Otomatis (rekomendasi)</option>
                  <option value="other">Stem &quot;other&quot; 4-stem — vokal dibuang</option>
                  <option value="guitar">Stem gitar 6-stem</option>
                  <option value="mix">Full mix (tanpa separation)</option>
                </select>
                <small className="audio-hint">
                  Kalau hasil terdengar seperti vokal/bass, coba ganti sumber. Separation butuh
                  waktu lebih lama.
                </small>
              </label>

              <label className="audio-row">
                <span>Deteksi power chord (root+5)</span>
                <input
                  type="checkbox"
                  checked={audioChords}
                  onChange={(event) => setAudioChords(event.target.checked)}
                />
              </label>

              <small className="audio-hint">
                {capabilities.separate
                  ? "Demucs siap (lebih lambat, hasil lebih bersih)."
                  : "Demucs belum terinstall — memakai full mix + band-pass."}{" "}
                Backend pitch: {capabilities.backend}. Transkripsi monofonik: cocok untuk riff/lead,
                bukan chord.
              </small>

              {audioState.status !== "idle" && (
                <div className={`audio-status ${audioState.status}`}>{audioState.message}</div>
              )}
            </div>
          </details>
        ) : (
          <span className="ml-hint" title={capabilities?.hint ?? "Pipeline audio belum siap"}>
            Audio → tab (nonaktif)
          </span>
        )}

        {tab && capabilities?.transcribe && (
          <label className="file-button verify-button" title="Bandingkan tab dengan rekaman: bar yang pitch-nya tidak cocok ditandai">
            {verifyState.status === "running" ? "⏳ Cek audio…" : "Cek audio"}
            <input
              type="file"
              accept="audio/*,.mp3,.wav,.flac,.m4a,.ogg,.aiff"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void verifyAudio(file);
                event.target.value = "";
              }}
            />
          </label>
        )}

        {tab && (
          <>
            <input
              className="title-input"
              value={tab.title}
              onChange={(event) =>
                mutate((current) => ({ ...current, title: event.target.value }))
              }
              aria-label="Judul lagu"
            />
            <input
              className="artist-input"
              value={tab.artist ?? ""}
              placeholder="artis"
              onChange={(event) =>
                mutate((current) => ({ ...current, artist: event.target.value }))
              }
              aria-label="Artis"
            />
            <label className="tempo-field">
              ♩
              <input
                type="number"
                min={20}
                max={400}
                value={tab.tempo}
                onChange={(event) =>
                  mutate((current) => ({
                    ...current,
                    tempo: Math.max(20, Math.min(400, Number(event.target.value) || 120)),
                  }))
                }
              />
            </label>
          </>
        )}

        <div className="spacer" />

        <span className={`save-state ${saveState.kind}`}>
          {saveState.kind === "saving" && "menyimpan…"}
          {saveState.kind === "saved" && "tersimpan"}
          {saveState.kind === "error" && `gagal: ${saveState.message}`}
          {saveState.kind === "idle" && ""}
        </span>

        {tab && (
          <>
            <div className="view-toggle">
              <button
                type="button"
                className={view === "notation" ? "active" : ""}
                onClick={() => {
                  playback.stop();
                  setView("notation");
                }}
              >
                Notasi
              </button>
              <button
                type="button"
                className={view === "grid" ? "active" : ""}
                onClick={() => {
                  playback.stop();
                  setView("grid");
                }}
              >
                Grid
              </button>
              <button
                type="button"
                className={view === "reader" ? "active" : ""}
                onClick={() => {
                  playback.stop();
                  setView("reader");
                }}
              >
                Reader
              </button>
            </div>
            {view !== "reader" && (
              <button type="button" className="ghost play" onClick={playback.toggle}>
                {playback.isPlaying ? "■ Stop" : "▶ Play"}
              </button>
            )}
            <button type="button" className="primary" onClick={() => runSolve("all")} title="Hitung ulang fingering semua nada">
              Solve
            </button>
            <details className="menu">
              <summary>Export</summary>
              <div className="menu-body">
                <button type="button" onClick={() => void exportAs("gp")}>
                  Guitar Pro (.gp)
                </button>
                <button type="button" onClick={() => void exportAs("midi")}>
                  MIDI (.mid)
                </button>
                <button type="button" onClick={() => void exportAs("alphatex")}>
                  alphaTex (.atex)
                </button>
                <button type="button" onClick={() => void exportAs("json")}>
                  JSON (.json)
                </button>
              </div>
            </details>
            <label className="file-button" title="Import tab Guitar Pro (.gp)">
              Import
              <input
                type="file"
                accept=".gp,.gp3,.gp4,.gp5,.gpx,.gp7,.gp8"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void importGuitarPro(file);
                  event.target.value = "";
                }}
              />
            </label>
            <button type="button" className="ghost danger" onClick={() => void removeSong()}>
              Hapus
            </button>
          </>
        )}
      </header>

      {error && (
        <div className="error-bar">
          <span>{error}</span>
          <button type="button" className="ghost" onClick={() => setError(null)}>
            tutup
          </button>
        </div>
      )}

      {notice && (
        <div className="notice-bar">
          <span>{notice}</span>
          <div className="notice-actions">
            {audioStemAvailable && audioJobId && (
              <button
                type="button"
                className="ghost"
                onClick={() => window.open(`/api/transcribe/${audioJobId}/stem`, "_blank")}
                title="Dengarkan stem yang dipakai pipeline"
              >
                ▶ stem
              </button>
            )}
            <button type="button" className="ghost" onClick={() => setNotice(null)}>
              tutup
            </button>
          </div>
        </div>
      )}

      {!tab ? (
        <div className="empty-state">
          <h1>Belum ada lagu</h1>
          <p>
            Buat lagu kosong, import draft <code>.gp</code> dari Songsterr, atau biarkan solver
            mengisi fingering otomatis.
          </p>
          <button type="button" className="primary" onClick={() => void newSong()}>
            + Lagu baru
          </button>
        </div>
      ) : (
        <>
          <TuningBar
            tab={tab}
            gridTicks={gridTicks}
            handSpan={handSpan}
            maxFret={maxFret}
            keepManual={keepManual}
            onChangeString={changeString}
            onApplyPreset={applyTuning}
            onCapo={changeCapo}
            onGrid={setGridTicks}
            onHandSpan={setHandSpan}
            onMaxFret={setMaxFret}
            onKeepManual={setKeepManual}
            onSolveMissing={() => runSolve("missing")}
            activeBarLabel={activeBar ? `bar ${activeBar.index + 1}` : "bar"}
            onSolveBar={solveBar}
            cellWidth={cellWidth}
            onCellWidth={setCellWidth}
          />

          <main className="editor-wrap">
            {view === "reader" ? (
              <Suspense fallback={<div className="reader-loading">memuat reader…</div>}>
                <TabReader tab={tab} />
              </Suspense>
            ) : view === "notation" ? (
              <TabNotation
                tab={tab}
                bars={bars}
                gridTicks={gridTicks}
                cellWidth={cellWidth}
                selectedNoteId={selectedNoteId}
                playheadTick={playback.isPlaying ? playback.playheadTick : -1}
                unplayable={unplayableIds}
                barScores={barScores}
                onSelect={setSelectedNoteId}
                onAdd={addNote}
                onFretChange={setFret}
                onMoveString={moveString}
                onDelete={deleteNote}
                onSelectRelative={selectRelative}
              />
            ) : (
            <TabGrid
              tab={tab}
              bars={bars}
              gridTicks={gridTicks}
              selectedNoteId={selectedNoteId}
              playheadTick={playback.isPlaying ? playback.playheadTick : -1}
              unplayable={unplayableIds}
              barScores={barScores}
              cellWidth={cellWidth}
              onSelect={setSelectedNoteId}
              onAdd={addNote}
              onFretChange={setFret}
              onMoveString={moveString}
              onDelete={deleteNote}
              onSelectRelative={selectRelative}
            />
            )}
          </main>

          <footer className="statusbar">
            <span className="stat">
              <strong>{tab.notes.length}</strong> note
            </span>
            <span className="stat">
              tuning <strong>{tab.tuning.name}</strong> ({formatTuning(tab.tuning.strings)})
            </span>
            {solveInfo && (
              <span className="stat">
                biaya <strong>{solveInfo.cost.toFixed(1)}</strong>
              </span>
            )}
            {solveInfo && solveInfo.unplayable.length > 0 && (
              <span className="stat warn" title={solveInfo.unplayable.map((item) => item.message).join("\n")}>
                {solveInfo.unplayable.length} note tidak bisa dijangkau
              </span>
            )}
            <div className="spacer" />
            {selectedNote && (
              <>
                <span className="stat">
                  {midiToName(selectedNote.midi)} · senar {tab.tuning.strings.length - (selectedNote.string ?? 0)} · fret{" "}
                  {selectedNote.fret ?? 0}
                </span>
                <select
                  className="duration-select"
                  value={selectedNote.duration}
                  onChange={(event) => setDuration(selectedNote.id, Number(event.target.value))}
                >
                  {DURATIONS.map((duration) => (
                    <option key={duration.value} value={duration.value}>
                      {duration.label}
                    </option>
                  ))}
                </select>
              </>
            )}
            <span className="hint">
              {view === "reader"
                ? "reader: play untuk mendengar · klik bar untuk pindah posisi"
                : view === "notation"
                  ? "klik posisi string untuk tambah note · klik note untuk edit fret · ↑↓ pindah senar"
                  : "klik sel untuk tambah note · ketik fret · ↑↓ pindah senar · ⌫ hapus · ⌘Z undo"}
            </span>
          </footer>
        </>
      )}
    </div>
  );
}
