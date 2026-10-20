"""Utilitas audio: decode lewat ffmpeg, load, band-pass, estimasi tempo."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np

SAMPLE_RATE = 22050


def have_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


def convert_to_wav(input_path: str, sample_rate: int = SAMPLE_RATE, workdir: str | None = None) -> str:
    """Decode mp3/m4a/flac/wav ke wav mono 16-bit lewat ffmpeg.

    Kalau ffmpeg tidak tersedia, mengembalikan path asli dan biar librosa yang
    menangani (mp3 mungkin gagal tergantung libsndfile).
    """
    if not have_ffmpeg():
        return input_path

    directory = Path(workdir or tempfile.mkdtemp(prefix="tabsify-"))
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f"{Path(input_path).stem}-{sample_rate}.wav"

    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        input_path,
        "-ac",
        "1",
        "-ar",
        str(sample_rate),
        "-sample_fmt",
        "s16",
        str(target),
    ]
    subprocess.run(command, check=True)
    return str(target)


def load_audio(path: str, sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    import librosa

    audio, _ = librosa.load(path, sr=sample_rate, mono=True)
    if audio.size == 0:
        raise ValueError("Audio kosong atau tidak bisa dibaca")
    peak = float(np.max(np.abs(audio)))
    if peak > 0:
        audio = audio / peak * 0.98
    return audio.astype(np.float32)


def band_pass(audio: np.ndarray, sample_rate: int = SAMPLE_RATE, low: float = 60.0, high: float = 1400.0) -> np.ndarray:
    """Membatasi ke rentang fundamental gitar supaya pitch tracker tidak
    terkunci ke hi-hat/simbal."""
    from scipy.signal import butter, sosfiltfilt

    nyquist = sample_rate / 2.0
    low_norm = max(20.0, min(low, nyquist * 0.9)) / nyquist
    high_norm = max(low_norm + 0.01, min(high, nyquist * 0.95)) / nyquist
    sos = butter(4, [low_norm, high_norm], btype="bandpass", output="sos")
    return sosfiltfilt(sos, audio).astype(np.float32)


def estimate_tempo(audio: np.ndarray, sample_rate: int = SAMPLE_RATE) -> tuple[float, float]:
    """Mengembalikan (tempo, confidence kasar 0-1)."""
    import librosa

    onset_envelope = librosa.onset.onset_strength(y=audio, sr=sample_rate)
    tempo_value, beats = librosa.beat.beat_track(
        onset_envelope=onset_envelope, sr=sample_rate, trim=False
    )
    tempo = float(np.atleast_1d(tempo_value)[0])
    if not np.isfinite(tempo) or tempo <= 0:
        return 120.0, 0.0

    # Normalisasi ke rentang yang masuk akal untuk lagu gitar.
    while tempo > 198.0:
        tempo /= 2.0
    while tempo < 60.0:
        tempo *= 2.0

    confidence = 0.0
    if beats is not None and len(beats) > 4:
        intervals = np.diff(np.asarray(beats, dtype=float))
        if intervals.size > 0 and np.mean(intervals) > 0:
            variation = float(np.std(intervals) / np.mean(intervals))
            confidence = float(max(0.0, min(1.0, 1.0 - variation)))
    return round(tempo, 2), confidence


def rms_envelope(audio: np.ndarray, frame_length: int = 1024, hop_length: int = 256) -> tuple[np.ndarray, int]:
    """RMS per frame, dengan hop yang sama seperti pitch tracker."""
    import librosa

    rms = librosa.feature.rms(y=audio, frame_length=frame_length, hop_length=hop_length)[0]
    return rms.astype(np.float32), hop_length
