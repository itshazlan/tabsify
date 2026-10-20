# tabsify-ml — audio → tab draft

Sidecar Python untuk mengubah file audio menjadi draft tablature. Hasilnya langsung
dikonsumsi `apps/api` (endpoint `/api/transcribe`) atau dipakai standalone lewat CLI.

**Sifat pipeline ini: monofonik.** Satu nada per waktu — cocok untuk riff, melodi, dan
lead line gitar. Chord tidak ditranskripsi; untuk chord tetap pakai tab dari Ultimate
Guitar/Songsterr lalu re-fret dengan solver.

```
audio (mp3/wav/flac/m4a)
   │  ffmpeg → wav mono 22.05 kHz
   ├─ (opsional) demucs htdemucs_6s → stem gitar
   │
   ├─ band-pass 60–1400 Hz        # fokus ke fundamental gitar
   ├─ librosa.pyin                # pitch per frame (mask = isfinite(f0))
   ├─ onset detect + slope filter # buang onset di ekor decay
   ├─ pitch-change boundaries     # dihaluskan median filter
   ├─ segmentasi → median pitch   # buang glide/transisi
   ├─ koreksi oktaf (spektrum)    # f0/2 ≥ 50% energi f0 → turun oktaf
   ├─ deteksi fifth (1.5*f0)      # opsional power chord root+7
   ├─ tempo + phase refinement    # kuantisasi least-squares
   └─ JSON tab (tick 960/quarter) → solver TS → editor
```

## Setup

Butuh Python 3.12 (PyTorch belum mendukung 3.14). Di mesin ini:
`/opt/homebrew/bin/python3.12`.

```bash
cd services/ml
/opt/homebrew/bin/python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Opsional (lebih akurat / lebih bersih, butuh torch ~200 MB):

```bash
.venv/bin/pip install demucs torchcrepe
```

Setelah itu `GET /api/capabilities` akan melaporkan `separate: true` dan
`backend: "crepe"` otomatis.

## CLI

```bash
.venv/bin/python -m tabsify_ml.pipeline \
  --input lagu.mp3 \
  --out draft.json \
  --tuning "D2 A2 D3 G3 B3 E4" \
  --tempo 0 \            # 0 = estimasi otomatis
  --grid 240 \           # 1/16 note
  --separate             # pakai demucs kalau terinstall
```

Output di stdout (dan `--out`):

```json
{"ok": true, "tab": {...}, "diagnostics": {...}}
```

Kalau gagal: `{"ok": false, "error": "..."}` dengan exit code 1.

Opsi penting:

| Flag | Arti |
| --- | --- |
| `--tuning` | nama nada (`D2 A2 ...`) atau MIDI (`38,45,...`) |
| `--tempo` | 0 = auto; isi manual kalau estimasi meleset |
| `--grid` | 240 = 1/16, 120 = 1/32, 320 = triplet 1/8 |
| `--backend` | `pyin` (default) atau `crepe` (butuh torchcrepe) |
| `--stem` | `auto` (6-stem guitar → 4-stem other → mix), `other`, `guitar`, `mix` |
| `--separate` | alias lama, sama dengan `--stem auto` |
| `--chords` / `--no-chords` | deteksi power chord (root+fifth), default aktif |
| `--max-fret` | fret maksimum instrumen, dipakai untuk batas pitch (default 24) |
| `--align-start` | paksa nada pertama di tick 0 (default: ikut grid absolut) |
| `--fmin` / `--fmax` | rentang pitch yang dicari (default 55–1200 Hz) |

## Modul

| File | Isi |
| --- | --- |
| `tabsify_ml/audio.py` | decode ffmpeg, load, band-pass, estimasi tempo |
| `tabsify_ml/transcribe.py` | pitch tracking, segmentasi onset, filter glide, kuantisasi + refinement tempo |
| `tabsify_ml/separate.py` | wrapper demucs (guitar/other stem) |
| `tabsify_ml/pipeline.py` | CLI + perakitan JSON tab |
| `tabsify_ml/verify.py` | skor kecocokan tab vs audio per bar (offset otomatis) |
| `tabsify_ml/pitch.py` | konversi nada/MIDI/frekuensi, parsing tuning |

## Verifikasi tab vs audio

```bash
.venv/bin/python -m tabsify_ml.verify \
  --input lagu.mp3 --tab tab.json --out hasil.json
```

Output: skor 0–1 per bar, daftar bar yang ditandai, offset hasil auto-align, dan detail tiap nada
(`expected` vs `detected`).

Cara kerja singkat:

1. Pitch tracking audio (pyin) dengan rentang dari tuning + nada di tab.
2. Auto-offset: cari pergeseran waktu yang memaksimalkan kecocokan pitch *dan* onset.
3. Untuk tiap nada/chord di tab: ambil median pitch audio di window-nya, bandingkan (toleransi ±1
   semitone; pitch-class dapat kredit 0.75).
4. Skor per bar = rata-rata skor nada; bar dengan skor < 0.5 atau satu nada < 0.35 ditandai.

Batasan: verifikasi ini monofonik — kalau tab memuat chord, dicocokkan ke salah satu nada saja;
tempo tab harus mendekati tempo rekaman (offset dicari otomatis, skala waktu tidak).

## Test

```bash
.venv/bin/python tests/test_synthetic.py
```

Test membuat audio sintetis (pluck gitar + harmonik + noise) di dalam tempdir, lalu
memastikan pitch, jumlah nada, dan posisi tick kembali dengan benar. Tidak butuh
file audio eksternal maupun jaringan.

## Akurasi di audio distorsi / tuning rendah

Kasus yang dulu gagal (power chord distorsi D standard, 4 chord):

| Tahap | Sebelum | Sesudah |
| --- | --- | --- |
| Nada terdeteksi | 0 | 8 (root + fifth) |
| Pitch | — | D2/A2/F2/A2 + fifth, semua benar |
| Tick | — | 0, 960, 1920, 2880 |
| Koreksi oktaf | — | 3 (pyin sempat terkunci ke oktaf atas) |

Penyebab utamanya probabilitas pyin yang kolaps (~0.01) pada sinyal distorsi, threshold
voicing yang terlalu tinggi, dan onset palsu di ekor decay. Semua sudah ditangani.

## Catatan performa (M1 Pro, 16 GB)

Diukur dengan audio sintetis:

| Proses | Hasil |
| --- | --- |
| pyin, klip 4 detik | ~2.5 detik |
| CREPE (`full`), klip 4 detik | ~46 detik — tidak layak untuk lagu penuh di CPU |
| demucs htdemucs_6s, klip 2.25 detik | ~5 detik (model sudah ter-cache) |

Lagu 4 menit: pyin kira-kira 30–60 detik; demucs bisa 1–3 menit. Memori puncak
pyin < 500 MB, demucs ~2 GB. API memakai job async supaya request tidak menunggu.

Kalau stem `guitar` hasil demucs RMS-nya < 12% dari mix, pipeline memakai `other`,
lalu `piano`, dan akhirnya kembali ke full mix dengan peringatan. Ini menghindari
tab kosong saat model 6-source "kehilangan" gitar (sering terjadi pada audio sintetis).

## Batasan yang diketahui

- Monofonik: chord hanya terdeteksi nada terkuat/terendah.
- Distorsi berat dan tuning rendah ekstrem bisa memicu octave error.
- Onset yang bertumpuk (drum di mix) bisa menghasilkan nada palsu; pakai `--separate`.
- Tempo hasil estimasi bisa meleset beberapa BPM; refinement memilih tempo yang paling
  pas dengan grid, bukan tempo "musikal" yang eksak. Ubah tempo manual kalau perlu.
