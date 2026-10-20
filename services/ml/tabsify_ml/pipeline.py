"""CLI pipeline: audio file → tab draft JSON yang kompatibel dengan tabsify.

Contoh:

    .venv/bin/python -m tabsify_ml.pipeline \
        --input song.mp3 --out draft.json \
        --tuning "D2 A2 D3 G3 B3 E4" --tempo 0 --grid 240

Output (stdout & --out):

    {"ok": true, "tab": {...}, "diagnostics": {...}}
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .audio import band_pass, convert_to_wav, load_audio
from .pitch import TICKS_PER_QUARTER, format_tuning, parse_tuning
from .transcribe import quantize, refine_tempo, transcribe

PROGRESS_PREFIX = "[tabsify-ml]"


def log(message: str) -> None:
    print(f"{PROGRESS_PREFIX} {message}", file=sys.stderr, flush=True)


def build_tab(
    notes: list,
    tempo: float,
    tuning: list[int],
    tuning_name: str,
    title: str,
    artist: str,
    song_id: str,
) -> dict:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return {
        "id": song_id,
        "title": title,
        "artist": artist or None,
        "tempo": int(round(tempo)),
        "tuning": {"name": tuning_name, "strings": tuning},
        "capo": 0,
        "timeSignatures": [{"tick": 0, "numerator": 4, "denominator": 4}],
        "notes": [
            {
                "id": f"ml-{index}",
                "tick": int(note.tick),
                "duration": int(note.duration),
                "midi": int(note.midi),
                "velocity": int(note.velocity),
            }
            for index, note in enumerate(notes)
        ],
        "createdAt": now,
        "updatedAt": now,
    }


def tuning_label(tuning: list[int], provided: str | None) -> str:
    if provided:
        return provided.strip()[:60]
    if tuning == [40, 45, 50, 55, 59, 64]:
        return "Standard E"
    return format_tuning(tuning)


def run(args: argparse.Namespace) -> dict:
    started = time.time()
    input_path = Path(args.input)
    if not input_path.exists():
        raise FileNotFoundError(f"File tidak ditemukan: {input_path}")

    workdir = Path(args.workdir).resolve()
    workdir.mkdir(parents=True, exist_ok=True)

    tuning = parse_tuning(args.tuning)
    warnings: list[str] = []

    log("decode audio via ffmpeg")
    wav_path = convert_to_wav(str(input_path), workdir=str(workdir / "audio"))

    stem_preference = args.stem or ("auto" if args.separate else "mix")
    stem_info: dict[str, str] | None = None

    if stem_preference != "mix":
        from .separate import demucs_available, separate_guitar

        if demucs_available():
            log(f"memisahkan stem (mode: {stem_preference}, bisa beberapa menit)")
            try:
                stem_info = separate_guitar(
                    wav_path, str(workdir / "stems"), preference=stem_preference
                )
                log(f"stem dipakai: {stem_info['stem']} ({stem_info.get('model', '-')})")
                if stem_info.get("warning"):
                    warnings.append(stem_info["warning"])
            except Exception as error:  # noqa: BLE001 - fallback ke mix
                warnings.append(f"Gagal memisahkan stem: {error}")
                log(f"separation gagal: {error}")
        else:
            warnings.append("Demucs tidak terinstall, memakai full mix.")
            log("demucs tidak tersedia, lanjut dengan full mix")

    log("load + band-pass")
    audio = load_audio(stem_info["stem_path"] if stem_info else wav_path)
    audio = band_pass(audio)

    tempo_hint = args.tempo if args.tempo and args.tempo > 0 else None

    # Rentang pitch mengikuti tuning: di bawah senar terendah dan di atas fret
    # maksimum tidak mungkin dimainkan, jadi aman dipakai sebagai pagar.
    pitch_low = min(tuning)
    pitch_high = max(tuning) + args.max_fret
    lowest_hz = 440.0 * 2 ** ((pitch_low - 69) / 12)
    highest_hz = 440.0 * 2 ** ((pitch_high - 69) / 12)
    fmin = args.fmin if args.fmin and args.fmin > 0 else max(28.0, lowest_hz * 0.94)
    fmax = args.fmax if args.fmax and args.fmax > 0 else min(5000.0, highest_hz * 1.06)

    log(
        f"transkripsi (backend={args.backend}, tempo_hint={tempo_hint or 'auto'}, "
        f"pitch {pitch_low}-{pitch_high}, f0 {fmin:.0f}-{fmax:.0f} Hz, chords={args.chords})"
    )
    result = transcribe(
        audio,
        tempo_hint=tempo_hint,
        backend=args.backend,
        fmin=fmin,
        fmax=fmax,
        pitch_low=pitch_low,
        pitch_high=pitch_high,
        chords=args.chords,
    )
    warnings.extend(result.warnings)

    log(f"{len(result.notes)} nada terdeteksi, tempo {result.tempo:.1f} BPM")

    if tempo_hint:
        grid_seconds = args.grid * (60.0 / tempo_hint) / TICKS_PER_QUARTER
        from .transcribe import estimate_phase

        phase = estimate_phase([note.start for note in result.notes], grid_seconds)
        tempo_used = tempo_hint
    else:
        tempo_used, phase = refine_tempo(result.notes, result.tempo, grid_ticks=args.grid)
        if abs(tempo_used - result.tempo) > 0.5:
            log(f"tempo disesuaikan ke grid: {tempo_used:.1f} BPM")

    notes = quantize(
        result.notes,
        tempo=tempo_used,
        grid=args.grid,
        align_start=args.align_start,
        phase=phase,
    )

    song_id = args.id or str(uuid.uuid4())
    title = args.title or input_path.stem
    tab = build_tab(
        notes=notes,
        tempo=tempo_used,
        tuning=tuning,
        tuning_name=tuning_label(tuning, args.tuning_name),
        title=title,
        artist=args.artist or "",
        song_id=song_id,
    )

    diagnostics = {
        "backend": result.backend,
        "separated": bool(stem_info and stem_info.get("stem") != "mix"),
        "stem": stem_info["stem"] if stem_info else "mix",
        "stemModel": stem_info.get("model", "none") if stem_info else "none",
        "stemPreference": stem_preference,
        "stemPath": stem_info.get("stem_path") if stem_info else wav_path,
        "tempo": round(tempo_used, 2),
        "tempoEstimate": round(result.tempo, 2),
        "tempoConfidence": round(result.tempo_confidence, 3),
        "tempoSource": "manual" if tempo_hint else "estimated",
        "noteCount": len(tab["notes"]),
        "audioSeconds": round(result.duration_seconds, 2),
        "elapsedSeconds": round(time.time() - started, 2),
        "gridTicks": args.grid,
        "pitchRange": [pitch_low, pitch_high],
        "octaveCorrections": result.octave_corrections,
        "chordNotes": result.chord_notes,
        "chords": args.chords,
        "warnings": warnings,
    }

    log(f"selesai dalam {diagnostics['elapsedSeconds']:.1f}s")
    return {"ok": True, "tab": tab, "diagnostics": diagnostics}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="tabsify_ml.pipeline", description=__doc__)
    parser.add_argument("--input", required=True, help="file audio (mp3/wav/flac/m4a)")
    parser.add_argument("--out", required=False, help="tulis JSON ke file ini")
    parser.add_argument("--tuning", default="40,45,50,55,59,64", help="tuning: nama nada atau MIDI")
    parser.add_argument("--tuning-name", default=None, help="label tuning untuk tab")
    parser.add_argument("--tempo", type=float, default=0, help="0 = estimasi otomatis")
    parser.add_argument("--grid", type=int, default=TICKS_PER_QUARTER // 4, help="grid kuantisasi (tick)")
    parser.add_argument("--backend", choices=["pyin", "crepe"], default="pyin")
    parser.add_argument("--fmin", type=float, default=0, help="0 = turunkan dari tuning")
    parser.add_argument("--fmax", type=float, default=0, help="0 = turunkan dari tuning + max-fret")
    parser.add_argument("--max-fret", type=int, default=24)
    parser.add_argument("--chords", action=argparse.BooleanOptionalAction, default=False,
                        help="deteksi power chord (root+5th) dari energi 1.5*f0 (opt-in)")
    parser.add_argument(
        "--stem",
        choices=["auto", "other", "guitar", "mix"],
        default=None,
        help="sumber audio: auto (4-stem other → 6-stem guitar → mix), other, guitar, mix",
    )
    parser.add_argument(
        "--separate",
        action="store_true",
        help="alias lama: sama dengan --stem auto",
    )
    parser.add_argument("--no-align-start", dest="align_start", action="store_false",
                        help="jangan geser nada pertama ke tick 0")
    parser.add_argument("--title", default=None)
    parser.add_argument("--artist", default=None)
    parser.add_argument("--id", default=None)
    parser.add_argument("--workdir", default=None, help="direktori kerja untuk wav/stem sementara")
    args = parser.parse_args(argv)
    if args.workdir is None:
        import tempfile

        args.workdir = tempfile.mkdtemp(prefix="tabsify-ml-")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        payload = run(args)
    except Exception as error:  # noqa: BLE001 - semua error dilaporkan sebagai JSON
        payload = {"ok": False, "error": f"{type(error).__name__}: {error}"}
        print(json.dumps(payload, ensure_ascii=False))
        return 1

    text = json.dumps(payload, ensure_ascii=False)
    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(text, encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
