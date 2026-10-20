import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";

const scratchDir = `${import.meta.dir}/../../../.tmp`;
mkdirSync(scratchDir, { recursive: true });
process.env.TABSIFY_DB = `${scratchDir}/api-test-${Date.now()}.db`;
const { app } = await import("../src/index.ts");

const json = (body: unknown, method = "POST") => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const sampleSong = {
  title: "Test Song",
  artist: "Unit Test",
  tempo: 100,
  tuning: { name: "Drop C", strings: [36, 43, 48, 53, 57, 62] },
  capo: 0,
  timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }],
  notes: [
    { midi: 36, tick: 0, duration: 480 },
    { midi: 43, tick: 480, duration: 480 },
    { midi: 48, tick: 960, duration: 480 },
    { midi: 55, tick: 1440, duration: 480 },
  ],
};

describe("tabsify api", () => {
  test("health", async () => {
    const response = await app.request("/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  test("seeds a demo song", async () => {
    const response = await app.request("/api/songs");
    const body = (await response.json()) as { songs: Array<{ title: string; noteCount: number }> };
    expect(body.songs.length).toBeGreaterThan(0);
    expect(body.songs[0]!.noteCount).toBeGreaterThan(0);
  });

  test("creates, solves and exports a song", async () => {
    const created = await app.request("/api/songs", json(sampleSong));
    expect(created.status).toBe(201);
    const { song } = (await created.json()) as { song: { id: string } };

    const solved = await app.request(`/api/songs/${song.id}/solve`, json({ handSpan: 4 }));
    const solvedBody = (await solved.json()) as {
      assignments: Array<{ noteId: string; string: number; fret: number }>;
      unplayable: unknown[];
    };
    expect(solvedBody.assignments).toHaveLength(4);
    expect(solvedBody.unplayable).toHaveLength(0);

    const alphatex = await app.request(`/api/songs/${song.id}/export/alphatex`);
    expect(alphatex.status).toBe(200);
    const text = await alphatex.text();
    expect(text).toContain("\\title \"Test Song\"");
    expect(text).toContain("\\tuning (D4 A3 F3 C3 G2 C2)");

    const gp = await app.request(`/api/songs/${song.id}/export/gp`);
    expect(gp.status).toBe(200);
    const bytes = new Uint8Array(await gp.arrayBuffer());
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);

    const midi = await app.request(`/api/songs/${song.id}/export/midi`);
    expect(midi.status).toBe(200);
    const midiBytes = new Uint8Array(await midi.arrayBuffer());
    expect(new TextDecoder().decode(midiBytes.slice(0, 4))).toBe("MThd");

    const imported = await app.request("/api/import/gp?filename=draft.gp", {
      method: "POST",
      body: bytes,
    });
    expect(imported.status).toBe(201);
    const importedBody = (await imported.json()) as { song: { title: string; notes: unknown[] } };
    expect(importedBody.song.title).toBe("draft");
    expect(importedBody.song.notes.length).toBe(4);
  });

  test("keeps revisions and restores them", async () => {
    const created = await app.request("/api/songs", json({ ...sampleSong, title: "Revisions" }));
    const { song } = (await created.json()) as { song: { id: string } };

    const updated = await app.request(
      `/api/songs/${song.id}`,
      json({ ...sampleSong, title: "Revisions v2", notes: [] }, "PUT"),
    );
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as { song: { notes: unknown[] } };
    expect(updatedBody.song.notes).toHaveLength(0);

    const revisions = await app.request(`/api/songs/${song.id}/revisions`);
    const revisionBody = (await revisions.json()) as { revisions: Array<{ id: number }> };
    expect(revisionBody.revisions.length).toBeGreaterThan(0);

    const restored = await app.request(
      `/api/songs/${song.id}/revisions/${revisionBody.revisions[0]!.id}/restore`,
      { method: "POST" },
    );
    expect(restored.status).toBe(200);
    const restoredBody = (await restored.json()) as { song: { notes: unknown[]; title: string } };
    expect(restoredBody.song.notes).toHaveLength(4);
    expect(restoredBody.song.title).toBe("Revisions");
  });

  test("rejects invalid notes", async () => {
    const response = await app.request(
      "/api/songs",
      json({ ...sampleSong, notes: [{ midi: 999, tick: 0, duration: 480 }] }),
    );
    expect(response.status).toBe(400);
  });
  test(
    "transcribes audio into a tab when the ml venv is available",
    async () => {
      const repoRoot = `${import.meta.dir}/../../..`;
      const venvPython = `${repoRoot}/services/ml/.venv/bin/python`;
      if (!existsSync(venvPython)) {
        console.log("skip: services/ml/.venv belum dibuat");
        return;
      }

      const wavPath = `${scratchDir}/riff-${Date.now()}.wav`;
      const synth = Bun.spawnSync({
        cmd: [
          venvPython,
          "-c",
          `import sys;sys.path.insert(0,"services/ml/tests");from synth import make_riff;make_riff(r"${wavPath}", notes=(36,43,48,50), note_seconds=0.5)`,
        ],
        cwd: repoRoot,
      });
      expect(synth.exitCode).toBe(0);

      const form = new FormData();
      form.append(
        "file",
        new File([await Bun.file(wavPath).arrayBuffer()], "riff.wav", { type: "audio/wav" }),
      );
      form.append("tuning", JSON.stringify({ name: "Open C", strings: [36, 43, 48, 52, 55, 60] }));

      const started = await app.request("/api/transcribe", { method: "POST", body: form });
      expect(started.status).toBe(202);
      const { jobId } = (await started.json()) as { jobId: string };

      type TranscribePayload = {
        job: { status: string; error?: string };
        song?: { notes: Array<{ midi: number }> };
      };

      let payload: TranscribePayload | null = null;

      for (let attempt = 0; attempt < 90; attempt += 1) {
        await Bun.sleep(1000);
        const response = await app.request(`/api/transcribe/${jobId}`);
        payload = (await response.json()) as TranscribePayload;
        if (payload?.job.status !== "running") break;
      }

      expect(payload?.job.status).toBe("done");
      expect(payload?.song?.notes.length).toBe(4);
      expect(payload?.song?.notes.map((note) => note.midi)).toEqual([36, 43, 48, 50]);
    },
    180_000,
  );
  test(
    "verifies a tab against audio and flags wrong bars",
    async () => {
      const repoRoot = `${import.meta.dir}/../../..`;
      const venvPython = `${repoRoot}/services/ml/.venv/bin/python`;
      if (!existsSync(venvPython)) {
        console.log("skip: services/ml/.venv belum dibuat");
        return;
      }

      const wavPath = `${scratchDir}/verify-${Date.now()}.wav`;
      const synth = Bun.spawnSync({
        cmd: [
          venvPython,
          "-c",
          `import sys;sys.path.insert(0,"services/ml/tests");from synth import make_riff;make_riff(r"${wavPath}", notes=(36,43,48,50), note_seconds=0.5)`,
        ],
        cwd: repoRoot,
      });
      expect(synth.exitCode).toBe(0);

      const correct = {
        title: "Verify",
        tempo: 120,
        tuning: { name: "Standard E", strings: [40, 45, 50, 55, 59, 64] },
        timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }],
        notes: [
          { midi: 36, tick: 0, duration: 480 },
          { midi: 43, tick: 960, duration: 480 },
          { midi: 48, tick: 1920, duration: 480 },
          { midi: 50, tick: 2880, duration: 480 },
        ],
      };

      const created = await app.request("/api/songs", json(correct));
      const { song } = (await created.json()) as { song: { id: string } };

      const verifyOnce = async (id: string) => {
        const form = new FormData();
        form.append("file", new File([await Bun.file(wavPath).arrayBuffer()], "riff.wav", { type: "audio/wav" }));
        form.append("tempo", "120");

        const started = await app.request(`/api/songs/${id}/verify`, { method: "POST", body: form });
        expect(started.status).toBe(202);
        const { jobId } = (await started.json()) as { jobId: string };

        type VerifyPayload = { status: string; summary?: Record<string, unknown>; bars?: unknown[] };
        let payload: VerifyPayload | null = null;
        for (let attempt = 0; attempt < 60; attempt += 1) {
          await Bun.sleep(1000);
          const response = await app.request(`/api/verify/${jobId}`);
          payload = (await response.json()) as VerifyPayload;
          if (payload?.status !== "running") break;
        }
        return payload;
      };

      const good = await verifyOnce(song.id);
      expect(good?.status).toBe("done");
      expect((good?.summary?.flaggedBars as number[]) ?? []).toEqual([]);

      const wrong = { ...correct, notes: correct.notes.map((note, index) => (index === 2 ? { ...note, midi: 55 } : note)) };
      const updated = await app.request(`/api/songs/${song.id}`, json(wrong, "PUT"));
      expect(updated.status).toBe(200);

      const bad = await verifyOnce(song.id);
      expect(bad?.status).toBe("done");
      expect(((bad?.summary?.flaggedBars as number[]) ?? []).length).toBeGreaterThan(0);
    },
    240_000,
  );
});
