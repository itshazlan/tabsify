"""Verifikasi tab terhadap audio: skor kecocokan per bar.

Idenya: tab referensi (Ultimate Guitar/Songsterr) biasanya sudah benar secara
pitch. Kalau ada bar yang salah (salah ketik, salah tuning, atau versi lagu
berbeda), kita bisa menemukannya dengan membandingkan pitch hasil tracking audio
dengan pitch yang seharusnya dibunyikan tab pada waktu yang sama.

Output: skor 0-1 per bar + daftar bar yang perlu dicek.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

import numpy as np

from .audio import SAMPLE_RATE, load_audio, rms_envelope
from .transcribe import ONSET_HOP, track_pitch

TICKS_PER_QUARTER = 960
TICKS_PER_WHOLE = 3840
MATCH_TOLERANCE = 1  # semitone
PITCH_CLASS_CREDIT = 0.75
FLAG_THRESHOLD = 0.5
MIN_SCORE_FRAMES = 3


@dataclass
class NoteGroup:
    start_tick: int
    end_tick: int
    midis: list[int]


@dataclass
class GroupScore:
    start_tick: int
    midis: list[int]
    score: float | None
    detected: int | None


@dataclass
class BarScore:
    index: int
    start_tick: int
    end_tick: int
    score: float | None
    flags: list[str] = field(default_factory=list)
    groups: list[GroupScore] = field(default_factory=list)


def _bar_length(numerator: int, denominator: int) -> int:
    return int(TICKS_PER_WHOLE * numerator / max(1, denominator))


def build_bar_ranges(time_signatures: list[dict], last_tick: int) -> list[tuple[int, int]]:
    signatures = sorted(time_signatures or [{"tick": 0, "numerator": 4, "denominator": 4}], key=lambda ts: ts["tick"])
    if signatures[0]["tick"] != 0:
        signatures.insert(0, {"tick": 0, "numerator": 4, "denominator": 4})

    bars: list[tuple[int, int]] = []
    start = 0
    index = 0
    guard = 0
    while start <= last_tick + TICKS_PER_WHOLE or len(bars) < 1:
        guard += 1
        if guard > 5000:
            break
        while index + 1 < len(signatures) and signatures[index + 1]["tick"] <= start:
            index += 1
        ts = signatures[index]
        end = start + _bar_length(int(ts["numerator"]), int(ts["denominator"]))
        next_change = signatures[index + 1]["tick"] if index + 1 < len(signatures) else None
        if next_change is not None and start < next_change < end:
            end = next_change
        bars.append((start, end))
        start = end
    return bars


def group_notes(notes: list[dict]) -> list[NoteGroup]:
    groups: dict[int, list[dict]] = {}
    for note in notes:
        tick = int(note["tick"])
        groups.setdefault(tick, []).append(note)

    ticks = sorted(groups)
    result: list[NoteGroup] = []
    for position, tick in enumerate(ticks):
        members = groups[tick]
        longest = max(int(member.get("duration", TICKS_PER_QUARTER // 4)) for member in members)
        natural_end = tick + longest
        if position + 1 < len(ticks):
            natural_end = min(natural_end, ticks[position + 1])
        natural_end = max(natural_end, tick + TICKS_PER_QUARTER // 8)
        result.append(
            NoteGroup(
                start_tick=tick,
                end_tick=natural_end,
                midis=sorted({int(member["midi"]) for member in members}),
            )
        )
    return result


def _frame_score(detected_midi: float, expected: list[int]) -> float:
    for midi in expected:
        if abs(detected_midi - midi) <= MATCH_TOLERANCE:
            return 1.0
    for midi in expected:
        if int(round(detected_midi)) % 12 == midi % 12:
            return PITCH_CLASS_CREDIT
    return 0.0


def _auto_offset(
    groups: list[NoteGroup],
    tempo: float,
    times: np.ndarray,
    f0: np.ndarray,
    onset_envelope: np.ndarray,
    sample_rate: int,
    search: tuple[float, float] = (-2.0, 6.0),
    step: float = 0.02,
) -> tuple[float, float]:
    """Cari offset global (detik) yang paling mencocokkan pitch tab dengan audio.

    Skor berbasis pitch, bukan onset: onset yang berulang tiap ketukan membuat
    alignment berbasis onset ambigu (bisa geser satu nada).
    """
    valid = np.isfinite(f0)
    if times.size == 0 or not np.any(valid):
        return 0.0, 0.0

    midi_frames = 69.0 + 12.0 * np.log2(np.maximum(f0, 1e-6) / 440.0)
    seconds_per_tick = 60.0 / max(20.0, tempo) / TICKS_PER_QUARTER

    hop_seconds = ONSET_HOP / sample_rate
    best_offset = 0.0
    best_score = -1.0
    best_pitch = 0.0

    for offset in np.arange(search[0], search[1], step):
        pitch_total = 0.0
        onset_total = 0.0
        count = 0
        for group in groups:
            start = group.start_tick * seconds_per_tick + offset
            span = (group.end_tick - group.start_tick) * seconds_per_tick
            center = start + min(0.06, span * 0.35)
            index = int(np.searchsorted(times, center))
            if index < times.size and valid[index]:
                pitch_total += _frame_score(midi_frames[index], group.midis)
            # onset strength di titik mulai nada: membedakan offset yang benar
            # dari offset yang kebetulan pitch-nya sama.
            envelope_index = int(round(start / hop_seconds))
            if 0 <= envelope_index < onset_envelope.size:
                onset_total += float(onset_envelope[envelope_index])
            count += 1

        if count == 0:
            continue

        pitch_score = pitch_total / count
        onset_score = onset_total / count
        combined = pitch_score + 0.25 * onset_score
        if combined > best_score:
            best_score = combined
            best_pitch = pitch_score
            best_offset = float(offset)

    return best_offset, best_pitch


def verify_tab(
    audio: np.ndarray,
    tab: dict,
    sample_rate: int = SAMPLE_RATE,
    offset: float | None = None,
    tempo_override: float | None = None,
) -> dict:
    tempo = float(tempo_override or tab.get("tempo") or 120)
    notes = [note for note in tab.get("notes", []) if note.get("midi") is not None]
    tuning = tab.get("tuning", {}).get("strings") or [40, 45, 50, 55, 59, 64]
    note_midis = [int(note["midi"]) for note in tab.get("notes", []) if note.get("midi") is not None]
    # Rentang pitch mengikuti tuning DAN nada di tab: tab bisa berisi nada di
    # luar tuning (mis. hasil import yang belum di-fret), jangan sampai terlewat.
    lowest = min([*tuning, *(note_midis or tuning)])
    highest = max([max(tuning) + 24, *(note_midis or tuning)])

    times, f0, probability = track_pitch(
        audio,
        sample_rate=sample_rate,
        backend="pyin",
        fmin=max(28.0, 440.0 * 2 ** ((lowest - 69) / 12) * 0.94),
        fmax=min(5000.0, 440.0 * 2 ** ((highest - 69) / 12) * 1.06),
    )

    import librosa

    onset_envelope = librosa.onset.onset_strength(y=audio, sr=sample_rate, hop_length=ONSET_HOP)
    if onset_envelope.size:
        onset_envelope = onset_envelope / (float(np.max(onset_envelope)) + 1e-9)

    groups = group_notes(notes)
    auto_offset, offset_score = _auto_offset(
        groups, tempo, times, f0, onset_envelope, sample_rate
    )
    used_offset = float(offset) if offset is not None else auto_offset

    seconds_per_tick = 60.0 / max(20.0, tempo) / TICKS_PER_QUARTER
    valid_frames = np.isfinite(f0)

    scored: list[GroupScore] = []

    for group in groups:
        start = group.start_tick * seconds_per_tick + used_offset
        end = group.end_tick * seconds_per_tick + used_offset
        start += 0.02
        window = (times >= start) & (times < end) & valid_frames
        if np.count_nonzero(window) < MIN_SCORE_FRAMES:
            scored.append(
                GroupScore(start_tick=group.start_tick, midis=group.midis, score=None, detected=None)
            )
            continue

        detected_values = f0[window]
        midi_values = 69.0 + 12.0 * np.log2(np.maximum(detected_values, 1e-6) / 440.0)
        detected_median_float = float(np.median(midi_values))

        # Skor per nada memakai median window: lebih stabil daripada rata-rata
        # frame (serangan dan pelepasan sering bikin pitch melayang).
        score = _frame_score(detected_median_float, group.midis)

        scored.append(
            GroupScore(
                start_tick=group.start_tick,
                midis=group.midis,
                score=round(score, 3),
                detected=int(round(detected_median_float)),
            )
        )

    last_tick = max((group.end_tick for group in groups), default=0)
    bars = build_bar_ranges(tab.get("timeSignatures") or [], last_tick)

    bar_scores: list[BarScore] = []
    for index, (start, end) in enumerate(bars):
        in_bar = [g for g in scored if start <= g.start_tick < end]
        if not in_bar:
            bar_scores.append(BarScore(index=index, start_tick=start, end_tick=end, score=None))
            continue

        values = [g.score for g in in_bar if g.score is not None]
        score = round(float(np.mean(values)), 3) if values else None
        flags: list[str] = []
        if score is not None and score < FLAG_THRESHOLD and len(in_bar) >= 2:
            flags.append("pitch-mismatch")

        worst = min(
            (g for g in in_bar if g.score is not None),
            key=lambda g: g.score or 0.0,
            default=None,
        )
        if worst is not None and worst.score is not None and worst.score < 0.35:
            flags.append("suspicious-note")

        bar_scores.append(
            BarScore(
                index=index,
                start_tick=start,
                end_tick=end,
                score=score,
                flags=flags,
                groups=in_bar,
            )
        )

    flagged = [bar for bar in bar_scores if bar.flags]
    scored_bars = [bar.score for bar in bar_scores if bar.score is not None]
    average = round(float(np.mean(scored_bars)), 3) if scored_bars else None

    return {
        "ok": True,
        "summary": {
            "barCount": len(bar_scores),
            "scoredBars": len(scored_bars),
            "flaggedBars": [bar.index for bar in flagged],
            "averageScore": average,
            "offsetSeconds": round(used_offset, 3),
            "offsetScore": round(offset_score, 3),
            "tempo": tempo,
            "noteCount": len(notes),
        },
        "bars": [
            {
                "index": bar.index,
                "startTick": bar.start_tick,
                "endTick": bar.end_tick,
                "score": bar.score,
                "flags": bar.flags,
                "notes": [
                    {
                        "tick": group.start_tick,
                        "expected": group.midis,
                        "detected": group.detected,
                        "score": group.score,
                    }
                    for group in bar.groups
                ],
            }
            for bar in bar_scores
        ],
    }


def verify_file(
    audio_path: str,
    tab: dict,
    offset: float | None = None,
    tempo_override: float | None = None,
) -> dict:
    import shutil
    import tempfile

    from .audio import convert_to_wav

    workdir = tempfile.mkdtemp(prefix="tabsify-verify-")
    try:
        wav_path = convert_to_wav(audio_path, workdir=workdir)
        audio = load_audio(wav_path)
        return verify_tab(audio, tab, offset=offset, tempo_override=tempo_override)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="tabsify_ml.verify", description=__doc__)
    parser.add_argument("--input", required=True, help="file audio")
    parser.add_argument("--tab", required=True, help="tab JSON (format tabsify)")
    parser.add_argument("--out", default=None)
    parser.add_argument("--offset", type=float, default=None, help="detik; default auto")
    parser.add_argument("--tempo", type=float, default=None)
    args = parser.parse_args(argv)

    tab = json.loads(open(args.tab, encoding="utf-8").read())
    result = verify_file(args.input, tab, offset=args.offset, tempo_override=args.tempo)
    text = json.dumps(result, ensure_ascii=False)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(text)
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
