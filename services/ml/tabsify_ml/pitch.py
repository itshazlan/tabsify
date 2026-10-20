"""Konversi nada dan parameter dasar tablature.

Konvensi tick sama dengan tab-engine TypeScript: 960 tick per quarter note,
MIDI 60 = C4, senar diurutkan dari yang terendah.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

TICKS_PER_QUARTER = 960
TICKS_PER_WHOLE = TICKS_PER_QUARTER * 4

STANDARD_TUNING = [40, 45, 50, 55, 59, 64]

_LETTER_SEMITONES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
_SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_NOTE_RE = re.compile(r"^([A-Ga-g])([#bx]{0,2})(-?\d+)$")


def name_to_midi(name: str) -> int:
    match = _NOTE_RE.match(name.strip())
    if not match:
        raise ValueError(f"Nama nada tidak valid: {name!r}")
    letter, accidentals, octave = match.groups()
    semitone = _LETTER_SEMITONES[letter.upper()]
    for accidental in accidentals:
        if accidental == "#":
            semitone += 1
        elif accidental == "b":
            semitone -= 1
        elif accidental == "x":
            semitone += 2
    midi = (int(octave) + 1) * 12 + semitone
    if not 0 <= midi <= 127:
        raise ValueError(f"Nada {name!r} di luar rentang MIDI")
    return midi


def midi_to_name(midi: int) -> str:
    value = max(0, min(127, int(round(midi))))
    return f"{_SHARP_NAMES[value % 12]}{value // 12 - 1}"


def format_tuning(strings: list[int]) -> str:
    return " ".join(midi_to_name(value) for value in strings)


def parse_tuning(value: str | None) -> list[int]:
    """Menerima "D2 A2 D3 G3 B3 E4" atau "38,45,50,55,59,64"."""
    if not value:
        return list(STANDARD_TUNING)
    tokens = [token for token in re.split(r"[\s,]+", value.strip()) if token]
    if not tokens:
        return list(STANDARD_TUNING)
    result: list[int] = []
    for token in tokens:
        result.append(int(token) if token.lstrip("-").isdigit() else name_to_midi(token))
    if not 4 <= len(result) <= 10:
        raise ValueError(f"Tuning harus 4-10 senar, dapat {len(result)}")
    return result


def midi_to_frequency(midi: float) -> float:
    return 440.0 * (2.0 ** ((midi - 69.0) / 12.0))


def frequency_to_midi(frequency: float) -> float:
    if frequency <= 0:
        return float("nan")
    return 69.0 + 12.0 * math.log2(frequency / 440.0)


@dataclass(frozen=True)
class NoteDraft:
    start: float  # detik
    end: float
    midi: int
    velocity: int = 80
    confidence: float = 1.0

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)
