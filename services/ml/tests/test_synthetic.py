"""Test end-to-end pipeline tanpa dependency jaringan/file eksternal."""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from synth import make_power_chords, make_riff  # noqa: E402
from tabsify_ml.audio import band_pass, load_audio  # noqa: E402
from tabsify_ml.pitch import (  # noqa: E402
    format_tuning,
    midi_to_name,
    name_to_midi,
    parse_tuning,
)
from tabsify_ml.transcribe import quantize, transcribe  # noqa: E402
from tabsify_ml.verify import verify_file  # noqa: E402

PASSED = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASSED
    if condition:
        PASSED += 1
        print(f"  ok  {name}")
    else:
        print(f"  FAIL {name} {detail}")
        raise AssertionError(name)


def test_pitch_helpers() -> None:
    check("name_to_midi E2", name_to_midi("E2") == 40)
    check("name_to_midi C#4", name_to_midi("C#4") == 61)
    check("name_to_midi Bb1", name_to_midi("Bb1") == 34)
    check("midi_to_name 40", midi_to_name(40) == "E2")
    check("parse_tuning names", parse_tuning("D2 A2 D3 G3 B3 E4") == [38, 45, 50, 55, 59, 64])
    check("parse_tuning midi", parse_tuning("36,43,48,52,55,60") == [36, 43, 48, 52, 55, 60])
    check("format_tuning", format_tuning([36, 43, 48, 52, 55, 60]) == "C2 G2 C3 E3 G3 C4")


def test_riff_recovery() -> None:
    expected = [36, 43, 48, 50]
    with tempfile.TemporaryDirectory() as directory:
        path = str(Path(directory) / "riff.wav")
        make_riff(path, notes=tuple(expected), note_seconds=0.5)

        audio = band_pass(load_audio(path))
        result = transcribe(audio, tempo_hint=120.0)

        detected = [note.midi for note in result.notes]
        print(f"      detected={detected} tempo={result.tempo} warnings={result.warnings}")
        check("semua nada terdeteksi", detected == expected, f"dapat {detected}")

        quantized = quantize(result.notes, tempo=120.0, grid=240)
        ticks = [note.tick for note in quantized]
        print(f"      ticks={ticks}")
        check("nada pertama di tick 0", ticks[0] == 0)
        check("grid 1/16", ticks == [0, 960, 1920, 2880], f"dapat {ticks}")
        check("semua durasi positif", all(note.duration > 0 for note in quantized))


def test_auto_tempo() -> None:
    with tempfile.TemporaryDirectory() as directory:
        path = str(Path(directory) / "riff.wav")
        # 0.5 detik per nada = 120 BPM kalau dianggap seperempat
        make_riff(path, notes=(40, 47, 52), note_seconds=0.5)
        audio = band_pass(load_audio(path))
        result = transcribe(audio)
        print(f"      auto tempo={result.tempo} confidence={result.tempo_confidence:.2f}")
        check("tempo masuk akal", 60 <= result.tempo <= 200, f"dapat {result.tempo}")
        check("ada nada terdeteksi", len(result.notes) >= 2, f"dapat {len(result.notes)}")




def test_power_chords_low_tuning() -> None:
    """Distorsi + D standard: dulu gagal total (0 nada), sekarang root+fifth tepat."""
    with tempfile.TemporaryDirectory() as directory:
        path = str(Path(directory) / "chords.wav")
        make_power_chords(path, roots=(38, 41, 43, 38))

        audio = band_pass(load_audio(path))
        result = transcribe(
            audio,
            tempo_hint=120.0,
            fmin=69.0,
            fmax=1245.0,
            pitch_low=38,
            pitch_high=86,
            chords=True,
        )

        midi = [note.midi for note in result.notes]
        print(f"      midi={midi} octaveCorrections={result.octave_corrections}")
        check("root + fifth per chord", midi == [38, 45, 41, 48, 43, 50, 38, 45], f"dapat {midi}")

        quantized = quantize(result.notes, tempo=120.0, grid=240)
        ticks = [note.tick for note in quantized]
        print(f"      ticks={ticks}")
        check("kuantisasi per ketukan", ticks == [0, 0, 960, 960, 1920, 1920, 2880, 2880], f"dapat {ticks}")


def test_octave_correction() -> None:
    """Nada rendah distorsi: pyin condong ke oktaf atas, koreksi harus turun."""
    with tempfile.TemporaryDirectory() as directory:
        path = str(Path(directory) / "low.wav")
        make_power_chords(path, roots=(38,), note_seconds=0.6)

        audio = band_pass(load_audio(path))
        result = transcribe(
            audio,
            tempo_hint=120.0,
            fmin=69.0,
            fmax=1245.0,
            pitch_low=38,
            pitch_high=86,
            chords=True,
        )

        midi = [note.midi for note in result.notes]
        print(f"      midi={midi} octaveCorrections={result.octave_corrections}")
        check("root D2 terdeteksi", 38 in midi, f"dapat {midi}")
        check("tidak ada nada di bawah tuning", all(value >= 38 for value in midi), f"dapat {midi}")




def test_verify_flags_wrong_bar() -> None:
    """Tab yang benar harus skor tinggi; satu nada salah harus ditandai."""
    tab = {
        "id": "t",
        "title": "riff",
        "tempo": 120,
        "tuning": {"name": "Standard E", "strings": [40, 45, 50, 55, 59, 64]},
        "timeSignatures": [{"tick": 0, "numerator": 4, "denominator": 4}],
        "notes": [
            {"tick": 0, "duration": 480, "midi": 36},
            {"tick": 960, "duration": 480, "midi": 43},
            {"tick": 1920, "duration": 480, "midi": 48},
            {"tick": 2880, "duration": 480, "midi": 50},
        ],
    }

    with tempfile.TemporaryDirectory() as directory:
        path = str(Path(directory) / "riff.wav")
        make_riff(path, notes=(36, 43, 48, 50), note_seconds=0.5)

        good = verify_file(path, tab)
        print(f"      good avg={good['summary']['averageScore']} flagged={good['summary']['flaggedBars']}")
        check("tab benar skor tinggi", (good["summary"]["averageScore"] or 0) >= 0.9)
        check("tab benar tanpa flag bar", good["summary"]["flaggedBars"] == [])

        bad_tab = json.loads(json.dumps(tab))
        bad_tab["notes"][2]["midi"] = 55
        bad = verify_file(path, bad_tab)
        print(f"      bad avg={bad['summary']['averageScore']} flagged={bad['summary']['flaggedBars']}")
        check("bar salah ditandai", 0 in bad["summary"]["flaggedBars"], str(bad["summary"]))


def main() -> int:
    print("test_pitch_helpers")
    test_pitch_helpers()
    print("test_riff_recovery")
    test_riff_recovery()
    print("test_auto_tempo")
    test_auto_tempo()
    print("test_power_chords_low_tuning")
    test_power_chords_low_tuning()
    print("test_octave_correction")
    test_octave_correction()
    print("test_verify_flags_wrong_bar")
    test_verify_flags_wrong_bar()
    print(f"\n{PASSED} assertion lulus")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as error:
        print(f"\nGAGAL: {error}")
        raise SystemExit(1)
