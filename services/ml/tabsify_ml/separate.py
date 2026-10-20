"""Pemisahan stem gitar dengan Demucs (opsional).

Dua model dipakai:

- ``htdemucs`` (4 stem): gitar biasanya masuk ke stem ``other``, sedangkan
  vokal terpisah bersih. Ini pilihan default untuk lagu dengan vokal karena
  vokal tidak bocor ke track gitar.
- ``htdemucs_6s`` (6 stem): punya stem ``guitar`` khusus, tapi kualitasnya
  tidak konsisten dan vokal bisa bocor.

Demucs tidak diinstall default karena butuh PyTorch. Aktifkan dengan:

    services/ml/.venv/bin/pip install demucs

Kalau tidak tersedia, pipeline tetap jalan memakai full mix + band-pass.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

MODEL_FOUR_STEM = "htdemucs"
MODEL_SIX_STEM = "htdemucs_6s"
DEFAULT_MODEL = MODEL_FOUR_STEM


def demucs_available() -> bool:
    return importlib.util.find_spec("demucs") is not None


def _rms(path: str) -> float:
    import numpy as np
    import soundfile as sf

    try:
        data, _ = sf.read(path, dtype="float32", always_2d=False)
    except Exception:  # noqa: BLE001
        return 0.0
    if getattr(data, "size", 0) == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(data))))


def _run_demucs(input_path: str, out_dir: str, model: str, timeout_seconds: int) -> Path:
    if not demucs_available():
        raise RuntimeError(
            "Demucs belum terinstall. Jalankan: services/ml/.venv/bin/pip install demucs"
        )

    output = Path(out_dir)
    output.mkdir(parents=True, exist_ok=True)

    command = [
        sys.executable,
        "-m",
        "demucs.separate",
        "--name",
        model,
        "--out",
        str(output),
        "--device",
        "cpu",
        input_path,
    ]
    completed = subprocess.run(command, capture_output=True, text=True, timeout=timeout_seconds)
    if completed.returncode != 0:
        raise RuntimeError(f"demucs gagal: {completed.stderr[-1000:] or completed.stdout[-1000:]}")

    return output / model / Path(input_path).stem


def _pick_stem(track_dir: Path, names: tuple[str, ...], mix_level: float, min_ratio: float) -> str | None:
    for name in names:
        candidate = track_dir / f"{name}.wav"
        if not candidate.exists():
            continue
        ratio = (_rms(str(candidate)) / mix_level) if mix_level > 0 else 1.0
        if ratio >= min_ratio:
            return name
    return None


def separate_guitar(
    input_path: str,
    out_dir: str,
    preference: str = "auto",
    timeout_seconds: int = 1800,
    min_level_ratio: float = 0.12,
) -> dict[str, str]:
    """Menjalankan demucs dan mengembalikan info stem yang dipakai.

    preference:
      - ``auto``   : 6-stem ``guitar`` dulu, lalu 4-stem ``other``, lalu mix
      - ``other``  : 4-stem ``other`` saja
      - ``guitar`` : 6-stem ``guitar`` saja
      - ``mix``    : tanpa separation
    """
    preference = (preference or "auto").lower()
    mix_level = _rms(input_path)

    if preference == "mix":
        return {
            "stem_path": input_path,
            "stem": "mix",
            "model": "none",
            "separated": "false",
        }

    attempts: list[tuple[str, str, tuple[str, ...]]] = []
    if preference in ("auto", "guitar"):
        attempts.append(("guitar", MODEL_SIX_STEM, ("guitar", "other")))
    if preference in ("auto", "other"):
        attempts.append(("other", MODEL_FOUR_STEM, ("other",)))

    ran: set[str] = set()
    for label, model, names in attempts:
        track_dir: Path | None = None
        if model in ran:
            track_dir = Path(out_dir) / model / Path(input_path).stem
        else:
            track_dir = _run_demucs(input_path, out_dir, model, timeout_seconds)
            ran.add(model)

        if not track_dir.exists():
            continue

        chosen = _pick_stem(track_dir, names, mix_level, min_level_ratio)
        if chosen is None:
            continue

        return {
            "stem_path": str(track_dir / f"{chosen}.wav"),
            "stem": chosen,
            "model": model,
            "separated": "true",
        }

    available: list[str] = []
    for model in ran:
        track_dir = Path(out_dir) / model / Path(input_path).stem
        if track_dir.exists():
            available.extend(sorted(path.name for path in track_dir.glob("*.wav")))

    if not available:
        raise RuntimeError("Demucs tidak menghasilkan stem")

    return {
        "stem_path": input_path,
        "stem": "mix",
        "model": "none",
        "separated": "false",
        "warning": (
            "Stem hasil separation terlalu pelan; memakai full mix. "
            "Coba rekaman dengan gitar yang lebih dominan atau pilih sumber lain."
        ),
    }
