"""Transkripsi audio: pitch tracking + segmentasi onset + koreksi oktaf.

Dua mode:
- monofonik: satu nada per waktu (riff/lead line)
- + power chord: mendeteksi fifth (root+7) kalau spektrum menunjukkan energi
  kuat di 1.5*f0 — khas gitar distorsi.

Fret assignment tetap dilakukan solver di packages/tab-engine (TypeScript).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .audio import SAMPLE_RATE, estimate_tempo, load_audio, rms_envelope
from .pitch import (
    TICKS_PER_QUARTER,
    NoteDraft,
    frequency_to_midi,
)

HOP_LENGTH = 256
FRAME_LENGTH = 2048
FFT_SIZE = 4096
MIN_NOTE_SECONDS = 0.045
MIN_ONSET_GAP = 0.055
SILENCE_RATIO = 0.03
# Kalau energi di f0/2 >= 50% energi di f0, kemungkinan pyin terkunci ke harmonik
# (sering pada distorsi / tuning rendah).
SUBHARMONIC_RATIO = 0.5
# Ambang energi fifth (1.5*f0) untuk deteksi power chord.
FIFTH_RATIO = 0.45
CHORD_GROUP_TOLERANCE = 0.02


@dataclass
class TranscriptionResult:
    notes: list[NoteDraft]
    tempo: float
    tempo_confidence: float
    backend: str
    duration_seconds: float
    warnings: list[str] = field(default_factory=list)
    octave_corrections: int = 0
    chord_notes: int = 0


@dataclass
class _Segment:
    start: float
    end: float
    midi: int
    velocity: int
    confidence: float
    has_fifth: bool = False
    from_onset: bool = True


def track_pitch(
    audio: np.ndarray,
    sample_rate: int = SAMPLE_RATE,
    backend: str = "pyin",
    fmin: float = 55.0,
    fmax: float = 1200.0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Mengembalikan (times, f0, confidence 0-1).

    f0 = NaN untuk frame yang tidak voiced. Confidence dinormalisasi: librosa
    1.0 bisa mengembalikan probabilitas ~0.01 untuk sinyal distorsi walaupun
    voiced_flag aktif, jadi skala mentahnya tidak bisa dipakai sebagai gate.
    """
    import librosa

    if backend == "crepe":
        try:
            import torchcrepe  # noqa: F401
        except ImportError:
            backend = "pyin"

    if backend == "crepe":
        import torch
        import torchcrepe

        audio_16k = librosa.resample(audio, orig_sr=sample_rate, target_sr=16000)
        tensor = torch.from_numpy(audio_16k).unsqueeze(0)
        pitch, periodicity = torchcrepe.predict(
            tensor,
            sample_rate=16000,
            hop_length=160,
            fmin=fmin,
            fmax=fmax,
            model="full",
            batch_size=512,
            device="cpu",
            return_periodicity=True,
        )
        f0 = pitch.squeeze(0).numpy().astype(np.float32)
        probability = periodicity.squeeze(0).numpy().astype(np.float32)
        times = librosa.times_like(f0, sr=16000, hop_length=160)
        f0[probability < 0.2] = np.nan
        return times, f0, probability

    f0, _voiced_flag, voiced_prob = librosa.pyin(
        y=audio,
        fmin=fmin,
        fmax=fmax,
        sr=sample_rate,
        frame_length=FRAME_LENGTH,
        hop_length=HOP_LENGTH,
        fill_na=np.nan,
        center=True,
    )
    times = librosa.times_like(f0, sr=sample_rate, hop_length=HOP_LENGTH)
    f0 = np.asarray(f0, dtype=np.float32)
    probability = np.asarray(voiced_prob, dtype=np.float32)

    voiced = np.isfinite(f0)
    probability = np.where(voiced, probability, 0.0).astype(np.float32)

    informative = probability[voiced]
    if informative.size > 0 and float(np.nanmax(informative)) < 0.2:
        # Probabilitas kolaps (umum pada distorsi): pakai nilai netral supaya
        # frame tetap dipakai dan confidence tidak menipu.
        probability = np.where(voiced, 0.55, 0.0).astype(np.float32)

    return times, f0, probability


def frequency_to_midi_array(frequencies: np.ndarray) -> np.ndarray:
    safe = np.maximum(frequencies, 1e-6)
    return 69.0 + 12.0 * np.log2(safe / 440.0)


def _magnitude_spectrum(
    audio: np.ndarray, sample_rate: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    import librosa

    stft = np.abs(librosa.stft(audio, n_fft=FFT_SIZE, hop_length=HOP_LENGTH))
    freqs = librosa.fft_frequencies(sr=sample_rate, n_fft=FFT_SIZE)
    times = np.arange(stft.shape[1]) * HOP_LENGTH / sample_rate
    return stft, freqs, times


def _magnitude_at(
    freqs: np.ndarray, spectrum: np.ndarray, frequency: float, tolerance: float = 0.035
) -> float:
    if frequency <= 0:
        return 0.0
    window = np.abs(freqs - frequency) <= max(1.5, frequency * tolerance)
    if not np.any(window):
        return 0.0
    return float(np.max(spectrum[window]))


def _segment_spectrum(
    stft: np.ndarray, spectrum_times: np.ndarray, start: float, end: float
) -> np.ndarray | None:
    window = (spectrum_times >= start) & (spectrum_times < end)
    if not np.any(window):
        return None
    return stft[:, window].mean(axis=1)


def _correct_subharmonic(
    f0: float,
    spectrum: np.ndarray,
    freqs: np.ndarray,
    fmin: float,
    max_steps: int = 2,
) -> tuple[float, bool]:
    """Turunkan f0 satu oktaf kalau energi sub-harmoniknya kuat.

    Pada gitar distorsi, pyin sering memilih harmonik kedua (oktaf di atas nada
    asli). Energi di f0/2 yang hampir sebesar f0 menandakan nada asli ada di
    bawahnya.
    """
    corrected = False
    for _ in range(max_steps):
        half = f0 / 2.0
        if half < fmin:
            break
        full_magnitude = _magnitude_at(freqs, spectrum, f0)
        half_magnitude = _magnitude_at(freqs, spectrum, half)
        if full_magnitude <= 0 or half_magnitude < SUBHARMONIC_RATIO * full_magnitude:
            break
        f0 = half
        corrected = True
    return f0, corrected


def _prefer_lower_octave(
    f0: float,
    spectrum: np.ndarray,
    freqs: np.ndarray,
    fmin: float,
    odd_ratio: float = 0.1,
) -> tuple[float, bool]:
    """Koreksi oktaf saat fundamental hilang (umum pada gitar distorsi/chorus).

    Kalau nada asli ada satu oktaf di bawah f0, harmonik ke-3 dan ke-5 dari nada
    asli itu muncul di 1.5*f0 dan 2.5*f0 — frekuensi yang bukan harmonik dari
    f0. Kehadiran energi di sana adalah bukti nada asli lebih rendah satu oktaf.
    """
    half = f0 / 2.0
    if half < fmin:
        return f0, False

    second = _magnitude_at(freqs, spectrum, f0)
    third = _magnitude_at(freqs, spectrum, f0 * 1.5)
    fifth = _magnitude_at(freqs, spectrum, f0 * 2.5)
    odd = max(third, fifth * 0.7)
    if second > 0 and odd >= odd_ratio * second:
        return half, True
    return f0, False


def _has_fifth(
    f0: float, spectrum: np.ndarray, freqs: np.ndarray, threshold: float = FIFTH_RATIO
) -> bool:
    """Power chord: ada energi signifikan di 1.5*f0 (bukan harmonik bilangan bulat)."""
    root_magnitude = _magnitude_at(freqs, spectrum, f0)
    fifth_magnitude = _magnitude_at(freqs, spectrum, f0 * 1.5, tolerance=0.03)
    return root_magnitude > 0 and fifth_magnitude >= threshold * root_magnitude


def _fold_into_range(midi: int, low: int | None, high: int | None) -> int:
    if low is None or high is None:
        return midi
    while midi < low:
        midi += 12
    while midi > high:
        midi -= 12
    return midi


def _boundaries_from_pitch(
    times: np.ndarray,
    f0: np.ndarray,
    min_stable_frames: int = 6,
    min_semitone: int = 1,
) -> list[float]:
    """Deteksi pergantian nada (legato/hammer-on) dari track pitch.

    Track pitch pyin suka bergetar 1 semitone saat distorsi/sustain, jadi nilai
    dihaluskan dulu dan hanya transisi yang stabil yang dianggap batas nada.
    """
    from scipy.ndimage import median_filter

    sentinel = -9999
    rounded = np.full(f0.shape, sentinel, dtype=int)
    valid = np.isfinite(f0)
    rounded[valid] = np.round(frequency_to_midi_array(f0[valid])).astype(int)

    if rounded.size < 5:
        return []

    smoothed = median_filter(rounded, size=5, mode="nearest")
    boundaries: list[float] = []

    index = 0
    length = smoothed.size
    while index < length:
        value = int(smoothed[index])
        start = index
        index += 1
        while index < length and int(smoothed[index]) == value:
            index += 1

        run = index - start
        if (
            value != sentinel
            and run >= min_stable_frames
            and start > 0
            and int(smoothed[start - 1]) != sentinel
            and abs(value - int(smoothed[start - 1])) >= min_semitone
        ):
            boundaries.append(float(times[start]))

    return boundaries


ONSET_HOP = 128
ONSET_DELTA = 0.012


def _detect_onsets(audio: np.ndarray, sample_rate: int) -> list[float]:
    import librosa

    # Envelope dinormalisasi supaya threshold tidak tergantung level audio
    # (normalisasi peak di load_audio dulu membuat deteksi tidak konsisten).
    envelope = librosa.onset.onset_strength(y=audio, sr=sample_rate, hop_length=ONSET_HOP)
    if envelope.size == 0:
        return []

    normalized = envelope / (float(np.max(envelope)) + 1e-9)
    peaks = librosa.util.peak_pick(
        normalized,
        pre_max=3,
        post_max=3,
        pre_avg=8,
        post_avg=8,
        delta=ONSET_DELTA,
        wait=1,
    )
    times = librosa.frames_to_time(peaks, sr=sample_rate, hop_length=ONSET_HOP)
    strengths = normalized[peaks] if len(peaks) else np.array([])

    # Beberapa puncak bisa muncul dalam satu serangan (ramp attack). Ambil yang
    # paling kuat per cluster 80 ms supaya satu nada tidak jadi dua.
    result: list[float] = []
    index = 0
    cluster: list[int] = []
    count = len(times)
    while index < count:
        cluster = [index]
        start = float(times[index])
        index += 1
        while index < count and float(times[index]) - start < 0.08:
            cluster.append(index)
            index += 1
        best = max(cluster, key=lambda i: float(strengths[i]) if i < len(strengths) else 0.0)
        time = float(times[best])
        if not result or time - result[-1] >= MIN_ONSET_GAP:
            result.append(time)
    return result


def _filter_rising_onsets(
    onsets: list[float], rms: np.ndarray, rms_times: np.ndarray
) -> list[float]:
    """Buang onset yang jatuh di ekor decay (bukan serangan baru)."""
    kept: list[float] = []
    for time in onsets:
        before_window = (rms_times >= time - 0.05) & (rms_times < time - 0.005)
        after_window = (rms_times >= time) & (rms_times <= time + 0.06)
        if np.count_nonzero(before_window) < 2 or np.count_nonzero(after_window) < 2:
            kept.append(time)
            continue

        before = float(np.max(rms[before_window]))
        after = float(np.max(rms[after_window]))
        # Harus ada kenaikan energi; plateau di dalam nada yang disustain bukan onset.
        if after >= 1.03 * before:
            kept.append(time)
    return kept


def _segment_pitch(
    times: np.ndarray,
    f0: np.ndarray,
    probability: np.ndarray,
    start: float,
    end: float,
) -> tuple[float, float] | None:
    window = (times >= start) & (times < end) & np.isfinite(f0)
    if np.count_nonzero(window) < 2:
        return None

    values = f0[window]
    weights = probability[window]

    # Buang frame awal/akhir yang biasanya transient atau glide.
    if values.size >= 6:
        trim = max(1, int(values.size * 0.15))
        if values.size - 2 * trim >= 2:
            values = values[trim:-trim]
            weights = weights[trim:-trim]

    pitches = frequency_to_midi_array(values)
    pitch = float(np.median(pitches))

    # Segmen dengan pitch yang berantakan biasanya bukan nada gitar (drum,
    # noise, atau sisa separation). Ukur berapa persen frame yang dekat dengan
    # median; kalau minoritas, buang.
    inliers = float(np.mean(np.abs(pitches - pitch) <= 1.0))
    if inliers < 0.55:
        return None

    confidence = (float(np.mean(weights)) * inliers) if weights.size else 0.5
    return pitch, confidence


def transcribe(
    audio: np.ndarray,
    sample_rate: int = SAMPLE_RATE,
    tempo_hint: float | None = None,
    backend: str = "pyin",
    fmin: float = 55.0,
    fmax: float = 1200.0,
    pitch_low: int | None = None,
    pitch_high: int | None = None,
    chords: bool = True,
    chord_threshold: float = FIFTH_RATIO,
) -> TranscriptionResult:
    warnings: list[str] = []
    duration = float(len(audio) / sample_rate)

    if tempo_hint and tempo_hint > 0:
        tempo = float(tempo_hint)
        tempo_confidence = 1.0
    else:
        tempo, tempo_confidence = estimate_tempo(audio, sample_rate)
        if tempo_confidence < 0.35:
            warnings.append(
                f"Tempo hasil estimasi ({tempo:.1f} BPM) kurang yakin; cek/ubah manual."
            )

    times, f0, probability = track_pitch(
        audio, sample_rate=sample_rate, backend=backend, fmin=fmin, fmax=fmax
    )
    stft, freqs, spectrum_times = _magnitude_spectrum(audio, sample_rate)

    rms, _ = rms_envelope(audio, frame_length=FRAME_LENGTH, hop_length=HOP_LENGTH)
    rms_times = np.arange(rms.size) * HOP_LENGTH / sample_rate

    onset_boundaries = _filter_rising_onsets(_detect_onsets(audio, sample_rate), rms, rms_times)
    pitch_boundaries = _boundaries_from_pitch(times, f0)
    boundaries = sorted(onset_boundaries + pitch_boundaries)

    deduped: list[float] = []
    for value in boundaries:
        if not deduped or value - deduped[-1] >= MIN_ONSET_GAP:
            deduped.append(value)

    loud_reference = float(np.percentile(rms, 90)) if rms.size else 0.0
    silence_threshold = loud_reference * SILENCE_RATIO

    # Jangan bikin segmen mini di awal hanya karena onset pertama telat sedikit.
    if not deduped:
        starts = [0.0]
    elif deduped[0] <= 0.08:
        starts = deduped
    else:
        starts = [0.0, *deduped]
    segments: list[_Segment] = []
    dropped = 0
    octave_corrections = 0

    for index, start in enumerate(starts):
        end = starts[index + 1] if index + 1 < len(starts) else duration
        if end - start < MIN_NOTE_SECONDS:
            continue

        in_window = (rms_times >= start) & (rms_times < end)
        rms_window = rms[in_window]
        if rms_window.size > 0 and float(np.max(rms_window)) < silence_threshold:
            dropped += 1
            continue

        pitch = _segment_pitch(times, f0, probability, start, end)
        if pitch is None:
            dropped += 1
            continue

        midi_float, confidence = pitch
        frequency = 440.0 * (2.0 ** ((midi_float - 69.0) / 12.0))
        spectrum = _segment_spectrum(stft, spectrum_times, start, end)
        has_fifth = False

        if spectrum is not None:
            frequency, corrected = _correct_subharmonic(frequency, spectrum, freqs, fmin)
            frequency, corrected_odd = _prefer_lower_octave(frequency, spectrum, freqs, fmin)
            if corrected or corrected_odd:
                octave_corrections += 1
            if chords:
                has_fifth = _has_fifth(frequency, spectrum, freqs, chord_threshold)

        midi = int(round(frequency_to_midi(frequency)))
        midi = _fold_into_range(midi, pitch_low, pitch_high)
        if not 24 <= midi <= 108:
            dropped += 1
            continue

        if rms_window.size > 0 and loud_reference > 0:
            level = float(np.max(rms_window)) / loud_reference
            velocity = int(max(30, min(120, 30 + level * 90)))
        else:
            velocity = 80

        fifth_allowed = pitch_high is None or midi + 7 <= pitch_high
        from_onset = any(abs(start - onset) < 0.02 for onset in onset_boundaries)
        segments.append(
            _Segment(
                start=float(start),
                end=float(end),
                midi=midi,
                velocity=velocity,
                confidence=confidence,
                has_fifth=bool(has_fifth and fifth_allowed),
                from_onset=from_onset,
            )
        )

    slot_seconds = 60.0 / max(20.0, tempo) / 4.0
    short_threshold = max(0.06, 0.75 * slot_seconds)

    segments = _merge_same_pitch(segments)
    segments = _drop_transitions(segments, short_threshold=short_threshold)

    notes: list[NoteDraft] = []
    chord_notes = 0
    for segment in segments:
        notes.append(
            NoteDraft(
                start=segment.start,
                end=segment.end,
                midi=segment.midi,
                velocity=segment.velocity,
                confidence=segment.confidence,
            )
        )
        if segment.has_fifth:
            notes.append(
                NoteDraft(
                    start=segment.start,
                    end=segment.end,
                    midi=segment.midi + 7,
                    velocity=segment.velocity,
                    confidence=segment.confidence,
                )
            )
            chord_notes += 1

    notes.sort(key=lambda note: (note.start, note.midi))

    beats = max(1.0, duration / (60.0 / max(20.0, tempo)))
    if len(notes) > beats * 6:
        warnings.append(
            f"Kepadatan nada tinggi ({len(notes)} nada / {beats:.0f} ketukan). "
            "Kemungkinan banyak nada palsu dari drum/bass — coba aktifkan pemisahan stem."
        )

    if dropped > 0:
        warnings.append(f"{dropped} segmen dilewati (hening atau pitch tidak terbaca).")
    if not notes:
        warnings.append(
            "Tidak ada nada yang terdeteksi. Coba audio dengan gitar yang lebih dominan."
        )

    return TranscriptionResult(
        notes=notes,
        tempo=tempo,
        tempo_confidence=tempo_confidence,
        backend=backend,
        duration_seconds=duration,
        warnings=warnings,
        octave_corrections=octave_corrections,
        chord_notes=chord_notes,
    )


def _drop_transitions(
    segments: list[_Segment], short_threshold: float = 0.13
) -> list[_Segment]:
    """Membuang segmen pendek yang sebenarnya glide/transisi antar dua nada.

    Ambangnya relatif terhadap tempo: pada riff 16th, nada sah bisa hanya 0.12 s.
    """
    if len(segments) < 3:
        return segments

    result: list[_Segment] = []
    pending_start: float | None = None

    for index, segment in enumerate(segments):
        if pending_start is not None:
            # Nada berikutnya menyerap bagian transisi yang dibuang supaya
            # onset-nya tidak bergeser ke belakang (pyin butuh waktu konvergen).
            segment = _Segment(
                start=min(pending_start, segment.start),
                end=segment.end,
                midi=segment.midi,
                velocity=segment.velocity,
                confidence=segment.confidence,
                has_fifth=segment.has_fifth,
                from_onset=segment.from_onset,
            )
            pending_start = None

        if 0 < index < len(segments) - 1:
            previous = segments[index - 1]
            following = segments[index + 1]
            short = (segment.end - segment.start) < short_threshold
            lowest = min(previous.midi, following.midi) - 1
            highest = max(previous.midi, following.midi) + 1
            between = lowest <= segment.midi <= highest
            if short and between and segment.confidence < 0.8:
                pending_start = segment.start
                continue

        result.append(segment)

    return result


def _merge_same_pitch(segments: list[_Segment]) -> list[_Segment]:
    merged: list[_Segment] = []
    for segment in segments:
        if merged:
            previous = merged[-1]
            near_duplicate = (segment.start - previous.start) <= 0.1
            if (
                previous.midi == segment.midi
                and segment.start - previous.end <= 0.06
                and (not segment.from_onset or near_duplicate)
            ):
                # Kalau segmen kedua lebih yakin, pakai start-nya: segmen pertama
                # biasanya sisa transisi yang mulai terlalu awal.
                start = segment.start if segment.confidence > previous.confidence else previous.start
                merged[-1] = _Segment(
                    start=start,
                    end=max(previous.end, segment.end),
                    midi=previous.midi,
                    velocity=max(previous.velocity, segment.velocity),
                    confidence=max(previous.confidence, segment.confidence),
                    has_fifth=previous.has_fifth or segment.has_fifth,
                    from_onset=previous.from_onset and segment.from_onset,
                )
                continue
        merged.append(segment)
    return merged


@dataclass
class QuantizedNote:
    tick: int
    duration: int
    midi: int
    velocity: int


def _grid_cost(
    times: np.ndarray,
    tempo: float,
    grid_ticks: int,
    phase_steps: int = 64,
) -> tuple[float, float]:
    """Residual kuantisasi terbaik untuk satu tempo: (cost, phase)."""
    grid_seconds = grid_ticks * (60.0 / tempo) / TICKS_PER_QUARTER
    if grid_seconds <= 0 or times.size == 0:
        return float("inf"), 0.0

    phases = np.arange(phase_steps, dtype=float) * grid_seconds / phase_steps
    difference = times[None, :] - phases[:, None]
    nearest = np.round(difference / grid_seconds) * grid_seconds
    residual = ((difference - nearest) ** 2).sum(axis=1)
    index = int(np.argmin(residual))
    return float(residual[index]), float(phases[index])


def refine_tempo(
    notes: list[NoteDraft],
    tempo_estimate: float,
    grid_ticks: int = TICKS_PER_QUARTER // 4,
) -> tuple[float, float]:
    """Mencari tempo + phase yang paling pas dengan grid.

    Estimasi beat tracker bisa meleset beberapa BPM; refinement memilih tempo
    (di sekitar estimasi) yang residual kuantisasinya paling kecil, supaya nada
    tidak melenceng dari grid setelah beberapa bar.
    """
    if len(notes) < 3:
        times = np.array([note.start for note in notes], dtype=float)
        grid_seconds = grid_ticks * (60.0 / max(20.0, tempo_estimate)) / TICKS_PER_QUARTER
        return tempo_estimate, estimate_phase(times.tolist(), grid_seconds)

    times = np.array(sorted(note.start for note in notes), dtype=float)
    candidates: set[float] = {tempo_estimate}

    intervals = np.diff(times)
    if intervals.size > 0:
        median_interval = float(np.median(intervals))
        if median_interval > 0.05:
            base_bpm = 60.0 / median_interval
            for multiplier in (0.5, 1.0, 2.0):
                candidates.add(base_bpm * multiplier)

    expanded: set[float] = set()
    for base in candidates:
        for factor in np.linspace(0.96, 1.04, 17):
            value = float(base) * float(factor)
            while value > 200.0:
                value /= 2.0
            while value < 55.0:
                value *= 2.0
            # Jangan biarkan refinement kabur jauh dari estimasi beat tracker:
            # tempo 1.5x/3x sering punya residual grid yang sama-sama kecil.
            if 0.92 * tempo_estimate <= value <= 1.08 * tempo_estimate:
                expanded.add(round(value, 3))

    if not expanded:
        expanded.add(round(tempo_estimate, 3))

    best_key: tuple[float, float] | None = None
    best_tempo = tempo_estimate
    best_phase = 0.0
    for candidate in sorted(expanded):
        cost, phase = _grid_cost(times, candidate, grid_ticks)
        key = (cost, abs(candidate - tempo_estimate))
        if best_key is None or key < best_key:
            best_key = key
            best_tempo = candidate
            best_phase = phase

    return best_tempo, best_phase


def estimate_phase(times: list[float], grid_seconds: float, steps: int = 160) -> float:
    """Mencari offset grid yang paling pas dengan onset (least squares)."""
    if not times or grid_seconds <= 0:
        return 0.0

    best_phase = 0.0
    best_cost = float("inf")
    for step in range(steps):
        phase = grid_seconds * step / steps
        cost = 0.0
        for time in times:
            distance = time - phase
            nearest = round(distance / grid_seconds) * grid_seconds
            cost += (distance - nearest) ** 2
        if cost < best_cost:
            best_cost = cost
            best_phase = phase
    return best_phase


def quantize(
    notes: list[NoteDraft],
    tempo: float,
    grid: int = TICKS_PER_QUARTER // 4,
    align_start: bool = True,
    max_duration: int = TICKS_PER_QUARTER * 4,
    phase: float | None = None,
) -> list[QuantizedNote]:
    """Detik → tick di grid terdekat, dengan chord tetap pada tick yang sama."""
    if not notes:
        return []

    seconds_per_tick = 60.0 / max(20.0, tempo) / TICKS_PER_QUARTER
    grid = max(1, int(grid))
    grid_seconds = grid * seconds_per_tick
    if phase is None:
        phase = estimate_phase([note.start for note in notes], grid_seconds)

    groups: list[list[NoteDraft]] = []
    for note in sorted(notes, key=lambda item: item.start):
        if groups and abs(note.start - groups[-1][0].start) <= CHORD_GROUP_TOLERANCE:
            groups[-1].append(note)
        else:
            groups.append([note])

    result: list[QuantizedNote] = []
    group_ticks: list[int] = []
    previous_tick: int | None = None

    for group in groups:
        relative = group[0].start - phase
        tick = int(round(relative / seconds_per_tick / grid) * grid)
        if previous_tick is not None and tick <= previous_tick:
            tick = previous_tick + grid
        previous_tick = tick
        group_ticks.append(tick)

        for note in group:
            duration = int(round(note.duration / seconds_per_tick / grid) * grid)
            duration = max(grid, min(max_duration, duration))
            result.append(
                QuantizedNote(
                    tick=tick,
                    duration=duration,
                    midi=note.midi,
                    velocity=note.velocity,
                )
            )

    # Phase grid bersifat periodik: hasil bisa bergeser satu grid dan membuat
    # nada pertama negatif. Geser semuanya supaya nada pertama tepat di tick 0
    # (menjaga jarak antar nada tetap konsisten).
    if group_ticks:
        shift = min(group_ticks) if align_start else min(0, min(group_ticks))
        if shift != 0:
            for note in result:
                note.tick -= shift
            group_ticks = [tick - shift for tick in group_ticks]

    for note in result:
        if note.tick < 0:
            note.tick = 0

    # Durasi tidak boleh menabrak onset berikutnya.
    cursor = 0
    for index, group in enumerate(groups):
        next_tick = group_ticks[index + 1] if index + 1 < len(group_ticks) else None
        for _ in group:
            note = result[cursor]
            cursor += 1
            if next_tick is not None:
                available = next_tick - note.tick
                if 0 < available < note.duration:
                    note.duration = max(grid, available)

    return result


def transcribe_file(
    path: str,
    tempo_hint: float | None = None,
    backend: str = "pyin",
    fmin: float = 55.0,
    fmax: float = 1200.0,
    pitch_low: int | None = None,
    pitch_high: int | None = None,
    chords: bool = True,
) -> TranscriptionResult:
    audio = load_audio(path)
    return transcribe(
        audio,
        tempo_hint=tempo_hint,
        backend=backend,
        fmin=fmin,
        fmax=fmax,
        pitch_low=pitch_low,
        pitch_high=pitch_high,
        chords=chords,
    )
