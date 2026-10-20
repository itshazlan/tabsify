import { existsSync, mkdirSync, rmSync } from "node:fs";
import { extname, resolve } from "node:path";

const mlDir = process.env.TABSIFY_ML_DIR ?? resolve(import.meta.dir, "../../../services/ml");
const pythonPath = resolve(mlDir, ".venv/bin/python");
const workRoot = resolve(import.meta.dir, "../data/ml-work");

const VENV_HINT =
  "Python venv belum siap. Jalankan: cd services/ml && python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt";

export interface MlCapabilities {
  transcribe: boolean;
  separate: boolean;
  crepe: boolean;
  /** Backend default. CREPE akurat tapi ~30x lebih lambat di CPU, jadi opt-in lewat CLI. */
  backend: "pyin" | "crepe";
  python: string;
  hint?: string;
}

let cachedCapabilities: MlCapabilities | null = null;

async function pythonHasModule(module: string): Promise<boolean> {
  if (!existsSync(pythonPath)) return false;
  try {
    const proc = Bun.spawn({
      cmd: [
        pythonPath,
        "-c",
        `import importlib.util,sys;sys.exit(0 if importlib.util.find_spec("${module}") else 1)`,
      ],
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export async function mlCapabilities(force = false): Promise<MlCapabilities> {
  if (cachedCapabilities && !force) return cachedCapabilities;

  const transcribe = existsSync(pythonPath);
  const capabilities: MlCapabilities = {
    transcribe,
    separate: transcribe ? await pythonHasModule("demucs") : false,
    crepe: transcribe ? await pythonHasModule("torchcrepe") : false,
    backend: "pyin",
    python: pythonPath,
    hint: transcribe ? undefined : VENV_HINT,
  };

  cachedCapabilities = capabilities;
  return capabilities;
}

export interface TranscribeOptions {
  onLog?: (line: string) => void;
  /** Simpan file stem di job dir supaya bisa didengarkan lewat API. */
  keepArtifacts?: boolean;
  file: File;
  tuningMidi: number[];
  tuningName?: string;
  tempo?: number;
  gridTicks?: number;
  separate?: boolean;
  stem?: "auto" | "other" | "guitar" | "mix";
  chords?: boolean;
  backend?: "pyin" | "crepe";
  title?: string;
  artist?: string;
  timeoutMs?: number;
}

export interface TranscribeResult {
  tab: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
  stemPath?: string;
  jobDir?: string;
}

function safeExtension(name: string): string {
  const extension = extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,5}$/.test(extension) ? extension : ".wav";
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    return JSON.parse(await file.text()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readJsonLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"));

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]!) as Record<string, unknown>;
    } catch {
      /* baris bukan JSON valid, coba sebelumnya */
    }
  }
  return null;
}


export interface VerifyOptions {
  file: File;
  tab: unknown;
  offset?: number;
  tempo?: number;
  timeoutMs?: number;
  onLog?: (line: string) => void;
}

export interface VerifyResult {
  summary: Record<string, unknown>;
  bars: unknown[];
}

export async function runVerification(options: VerifyOptions): Promise<VerifyResult> {
  const capabilities = await mlCapabilities();
  if (!capabilities.transcribe) {
    throw new Error(capabilities.hint ?? "Python venv belum siap");
  }
  if (options.file.size === 0) throw new Error("File audio kosong");
  if (options.file.size > 80 * 1024 * 1024) throw new Error("File audio terlalu besar (maks 80 MB)");

  mkdirSync(workRoot, { recursive: true });
  const jobDir = resolve(workRoot, crypto.randomUUID());
  mkdirSync(jobDir, { recursive: true });

  const inputPath = resolve(jobDir, `input${safeExtension(options.file.name)}`);
  await Bun.write(inputPath, await options.file.arrayBuffer());
  const tabPath = resolve(jobDir, "tab.json");
  await Bun.write(tabPath, JSON.stringify(options.tab));
  const outputPath = resolve(jobDir, "verify.json");

  const args = [
    "-m",
    "tabsify_ml.verify",
    "--input",
    inputPath,
    "--tab",
    tabPath,
    "--out",
    outputPath,
  ];
  if (options.offset !== undefined && Number.isFinite(options.offset)) {
    args.push("--offset", String(options.offset));
  }
  if (options.tempo && Number.isFinite(options.tempo)) {
    args.push("--tempo", String(options.tempo));
  }

  const proc = Bun.spawn({
    cmd: [pythonPath, ...args],
    cwd: mlDir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      HF_HOME: resolve(mlDir, ".cache/hf"),
      TORCH_HOME: resolve(mlDir, ".cache/torch"),
      XDG_CACHE_HOME: resolve(mlDir, ".cache/xdg"),
    },
  });

  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* sudah berhenti */
    }
  }, timeoutMs);

  let stdout = "";
  let stderr = "";
  let exitCode: number;
  try {
    [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    exitCode = await proc.exited;
  } finally {
    clearTimeout(timer);
  }

  const payload = (await readJsonFile(outputPath)) ?? readJsonLine(stdout);
  rmSync(jobDir, { recursive: true, force: true });

  if (!payload) {
    const detail = (stderr || stdout).trim().slice(-900);
    throw new Error(`Verifikasi gagal (exit ${exitCode}): ${detail || "tanpa pesan"}`);
  }
  if (payload.ok !== true) {
    throw new Error(String(payload.error ?? "Verifikasi gagal tanpa pesan"));
  }

  return {
    summary: (payload.summary as Record<string, unknown>) ?? {},
    bars: (payload.bars as unknown[]) ?? [],
  };
}

export async function runTranscription(options: TranscribeOptions): Promise<TranscribeResult> {
  const capabilities = await mlCapabilities();
  if (!capabilities.transcribe) {
    throw new Error(capabilities.hint ?? "Pipeline audio belum siap");
  }
  if (options.file.size === 0) {
    throw new Error("File audio kosong");
  }
  if (options.file.size > 80 * 1024 * 1024) {
    throw new Error("File audio terlalu besar (maks 80 MB)");
  }

  mkdirSync(workRoot, { recursive: true });
  const jobDir = resolve(workRoot, crypto.randomUUID());
  mkdirSync(jobDir, { recursive: true });

  const inputPath = resolve(jobDir, `input${safeExtension(options.file.name)}`);
  await Bun.write(inputPath, await options.file.arrayBuffer());
  const outputPath = resolve(jobDir, "draft.json");

  const args = [
    "-m",
    "tabsify_ml.pipeline",
    "--input",
    inputPath,
    "--out",
    outputPath,
    "--tuning",
    options.tuningMidi.join(","),
    "--grid",
    String(options.gridTicks ?? 240),
    "--backend",
    options.backend ?? capabilities.backend,
    "--workdir",
    jobDir,
  ];

  if (options.tuningName) args.push("--tuning-name", options.tuningName);
  if (options.tempo && options.tempo > 0) args.push("--tempo", String(options.tempo));
  if (options.title) args.push("--title", options.title);
  if (options.artist) args.push("--artist", options.artist);
  const stem = options.stem ?? (options.separate ? "auto" : "mix");
  if (capabilities.separate && stem !== "mix") args.push("--stem", stem);
  if (options.chords === true) args.push("--chords");

  const timeoutMs = options.timeoutMs ?? 20 * 60 * 1000;
  const proc = Bun.spawn({
    cmd: [pythonPath, ...args],
    cwd: mlDir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      // simpan cache model di dalam workspace supaya tidak kena sandbox ~/.cache
      HF_HOME: resolve(mlDir, ".cache/hf"),
      TORCH_HOME: resolve(mlDir, ".cache/torch"),
      XDG_CACHE_HOME: resolve(mlDir, ".cache/xdg"),
    },
  });

  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* proses sudah berhenti */
    }
  }, timeoutMs);

  let stdout = "";
  let stderr = "";
  let exitCode: number;
  const decoder = new TextDecoder();
  let stderrBuffer = "";

  const pump = async (stream: ReadableStream<Uint8Array>, sink: (chunk: string) => void) => {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sink(decoder.decode(value, { stream: true }));
    }
  };

  try {
    [, , exitCode] = await Promise.all([
      pump(proc.stdout, (chunk) => {
        stdout += chunk;
      }),
      pump(proc.stderr, (chunk) => {
        stderr += chunk;
        stderrBuffer += chunk;
        const lines = stderrBuffer.split("\n");
        stderrBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const message = line.replace(/^\[tabsify-ml\]\s*/, "").trim();
          if (message) options.onLog?.(message);
        }
      }),
      proc.exited,
    ]);
  } finally {
    clearTimeout(timer);
  }

  const payload = (await readJsonFile(outputPath)) ?? readJsonLine(stdout);
  const diagnostics = (payload?.diagnostics as Record<string, unknown>) ?? {};
  const stemPath =
    typeof diagnostics.stemPath === "string" && diagnostics.stemPath !== inputPath
      ? diagnostics.stemPath
      : undefined;

  if (!options.keepArtifacts) {
    rmSync(jobDir, { recursive: true, force: true });
  }

  if (!payload) {
    const detail = (stderr || stdout).trim().slice(-900);
    throw new Error(
      exitCode === 0
        ? "Pipeline tidak mengembalikan JSON"
        : `Pipeline gagal (exit ${exitCode}): ${detail || "tanpa pesan"}`,
    );
  }
  if (payload.ok !== true) {
    throw new Error(String(payload.error ?? "Pipeline gagal tanpa pesan"));
  }

  return {
    tab: payload.tab as Record<string, unknown>,
    diagnostics,
    stemPath: options.keepArtifacts ? stemPath : undefined,
    jobDir: options.keepArtifacts ? jobDir : undefined,
  };
}
