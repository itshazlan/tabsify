"""Generator audio sintetis untuk test pipeline (tanpa file eksternal)."""

from __future__ import annotations

import numpy as np

SAMPLE_RATE = 22050


def pluck(midi: int, duration: float, sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    count = max(1, int(duration * sample_rate))
    time = np.arange(count) / sample_rate
    frequency = 440.0 * (2.0 ** ((midi - 69) / 12.0))

    signal = np.zeros(count)
    for harmonic in range(1, 9):
        partial = frequency * harmonic
        if partial >= sample_rate / 2:
            break
        signal += (1.0 / harmonic**1.25) * np.sin(2 * np.pi * partial * time + harmonic * 0.1)

    envelope = (1.0 - np.exp(-time * 400.0)) * np.exp(-5.5 * time)
    signal = signal * envelope
    peak = float(np.max(np.abs(signal))) or 1.0
    return (0.6 * signal / peak).astype(np.float32)


def make_riff(
    path: str,
    notes: tuple[int, ...] = (36, 43, 48, 50),
    note_seconds: float = 0.5,
    sample_rate: int = SAMPLE_RATE,
) -> None:
    import soundfile as sf

    total = int(len(notes) * note_seconds * sample_rate) + sample_rate // 4
    audio = np.zeros(total, dtype=np.float32)

    for index, midi in enumerate(notes):
        start = int(index * note_seconds * sample_rate)
        voice = pluck(midi, note_seconds * 0.98, sample_rate=sample_rate)
        end = min(total, start + voice.size)
        audio[start:end] += voice[: end - start]

    noise = np.random.default_rng(7).normal(0.0, 0.0004, audio.shape).astype(np.float32)
    audio = np.clip(audio + noise, -1.0, 1.0)
    sf.write(path, audio, sample_rate, subtype="PCM_16")


def make_mix(
    path: str,
    notes: tuple[int, ...] = (36, 43, 48, 50),
    note_seconds: float = 0.5,
    sample_rate: int = SAMPLE_RATE,
) -> None:
    """Riff gitar + bass + kick/snare sederhana, untuk menguji Demucs."""
    import soundfile as sf

    total = int(len(notes) * note_seconds * sample_rate) + sample_rate // 4
    guitar = np.zeros(total, dtype=np.float32)
    bass = np.zeros(total, dtype=np.float32)
    drums = np.zeros(total, dtype=np.float32)
    rng = np.random.default_rng(11)

    for index, midi in enumerate(notes):
        start = int(index * note_seconds * sample_rate)
        voice = pluck(midi, note_seconds * 0.98, sample_rate=sample_rate)
        end = min(total, start + voice.size)
        guitar[start:end] += voice[: end - start] * 0.55

        low = midi - 24
        if low >= 28:
            length = int(note_seconds * 0.9 * sample_rate)
            time = np.arange(length) / sample_rate
            tone = np.sin(2 * np.pi * (440.0 * 2 ** ((low - 69) / 12)) * time)
            bass[start : start + length] += (0.35 * tone * np.exp(-2.5 * time)).astype(np.float32)[: max(0, total - start)]

        # kick di tiap ketukan, snare di ketukan genap
        kick_len = int(0.12 * sample_rate)
        kick_time = np.arange(kick_len) / sample_rate
        kick = np.sin(2 * np.pi * 55 * kick_time) * np.exp(-25 * kick_time) * 0.6
        drums[start : start + kick_len] += kick[: max(0, total - start)]

        if index % 2 == 1:
            noise = rng.normal(0, 0.25, kick_len) * np.exp(-30 * kick_time)
            drums[start : start + kick_len] += noise[: max(0, total - start)]

    mix = guitar + bass + drums
    peak = float(np.max(np.abs(mix))) or 1.0
    mix = np.clip(mix / peak * 0.95, -1.0, 1.0).astype(np.float32)
    sf.write(path, mix, sample_rate, subtype="PCM_16")


def make_power_chords(
    path: str,
    roots: tuple[int, ...] = (38, 41, 43, 38),
    note_seconds: float = 0.45,
    gap_seconds: float = 0.05,
    sample_rate: int = SAMPLE_RATE,
) -> None:
    """Power chord distorsi (root + fifth + oktaf), untuk test tuning rendah."""
    import soundfile as sf

    total = int(len(roots) * (note_seconds + gap_seconds) * sample_rate) + sample_rate // 4
    audio = np.zeros(total, dtype=np.float32)

    for index, root in enumerate(roots):
        start = int(index * (note_seconds + gap_seconds) * sample_rate)
        count = int(note_seconds * sample_rate)
        time = np.arange(count) / sample_rate
        signal = np.zeros(count)

        for midi in (root, root + 7, root + 12):
            frequency = 440.0 * 2 ** ((midi - 69) / 12)
            for harmonic in range(1, 14):
                partial = frequency * harmonic
                if partial >= sample_rate / 2:
                    break
                signal += (1.0 / harmonic**0.9) * np.sin(2 * np.pi * partial * time + harmonic * 0.3)

        envelope = (1.0 - np.exp(-time * 300.0)) * np.exp(-1.2 * time)
        signal = np.tanh(signal * envelope * 2.5)
        peak = float(np.max(np.abs(signal))) or 1.0
        voice = (0.5 * signal / peak).astype(np.float32)
        end = min(total, start + voice.size)
        audio[start:end] += voice[: end - start]

    peak = float(np.max(np.abs(audio))) or 1.0
    audio = np.clip(audio / peak * 0.9, -1.0, 1.0).astype(np.float32)
    sf.write(path, audio, sample_rate, subtype="PCM_16")
