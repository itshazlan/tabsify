import { useEffect, useState } from "react";
import {
  midiToName,
  nameToMidi,
  TUNING_PRESETS,
  type Tab,
  type Tuning,
} from "@tabsify/engine";

interface TuningBarProps {
  tab: Tab;
  gridTicks: number;
  handSpan: number;
  maxFret: number;
  keepManual: boolean;
  onChangeString: (displayIndex: number, midi: number) => void;
  onApplyPreset: (preset: Tuning) => void;
  onCapo: (capo: number) => void;
  onGrid: (ticks: number) => void;
  onHandSpan: (value: number) => void;
  onMaxFret: (value: number) => void;
  onKeepManual: (value: boolean) => void;
  onSolveMissing: () => void;
  activeBarLabel: string;
  onSolveBar: () => void;
  cellWidth: number;
  onCellWidth: (value: number) => void;
}

function StringField({ midi, onChange }: { midi: number; onChange: (midi: number) => void }) {
  const [value, setValue] = useState(midiToName(midi));
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setValue(midiToName(midi));
    setInvalid(false);
  }, [midi]);

  const commit = () => {
    try {
      const next = nameToMidi(value);
      setInvalid(false);
      if (next !== midi) onChange(next);
    } catch {
      setInvalid(true);
      setValue(midiToName(midi));
    }
  };

  return (
    <input
      className={`tuning-field${invalid ? " invalid" : ""}`}
      value={value}
      spellCheck={false}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      title={`${midiToName(midi)} — ketik nama nada, mis. D2 / C#3 / Bb1`}
    />
  );
}

function matchesPreset(strings: number[], preset: Tuning): boolean {
  return (
    strings.length === preset.strings.length &&
    strings.every((value, index) => value === preset.strings[index])
  );
}

export function TuningBar({
  tab,
  gridTicks,
  handSpan,
  maxFret,
  keepManual,
  onChangeString,
  onApplyPreset,
  onCapo,
  onGrid,
  onHandSpan,
  onMaxFret,
  onKeepManual,
  onSolveMissing,
  activeBarLabel,
  onSolveBar,
  cellWidth,
  onCellWidth,
}: TuningBarProps) {
  const stringCount = tab.tuning.strings.length;
  const displayOrder = Array.from({ length: stringCount }, (_, index) => stringCount - 1 - index);
  const activePreset = TUNING_PRESETS.find((preset) => matchesPreset(tab.tuning.strings, preset));

  return (
    <div className="tuning-bar">
      <div className="tuning-group">
        <span className="field-label">Tuning</span>
        <select
          className="preset-select"
          value={activePreset?.name ?? "custom"}
          onChange={(event) => {
            const preset = TUNING_PRESETS.find((item) => item.name === event.target.value);
            if (preset) onApplyPreset(preset);
          }}
        >
          <option value="custom">Custom</option>
          {TUNING_PRESETS.map((preset) => (
            <option key={preset.name} value={preset.name}>
              {preset.name}
            </option>
          ))}
        </select>

        <div className="string-fields" title="Senar 1 (paling atas) di kiri">
          {displayOrder.map((stringIndex, displayIndex) => (
            <StringField
              key={stringIndex}
              midi={tab.tuning.strings[stringIndex]!}
              onChange={(midi) => onChangeString(displayIndex, midi)}
            />
          ))}
        </div>
      </div>

      <div className="tuning-group">
        <label className="field-label" htmlFor="capo">
          Capo
        </label>
        <input
          id="capo"
          type="number"
          className="number-field"
          min={0}
          max={12}
          value={tab.capo}
          onChange={(event) => onCapo(Math.max(0, Math.min(12, Number(event.target.value) || 0)))}
        />

        <label className="field-label" htmlFor="handspan">
          Span
        </label>
        <input
          id="handspan"
          type="number"
          className="number-field"
          min={2}
          max={8}
          value={handSpan}
          onChange={(event) => onHandSpan(Math.max(2, Math.min(8, Number(event.target.value) || 4)))}
        />

        <label className="field-label" htmlFor="maxfret">
          Fret max
        </label>
        <input
          id="maxfret"
          type="number"
          className="number-field"
          min={12}
          max={27}
          value={maxFret}
          onChange={(event) => onMaxFret(Math.max(12, Math.min(27, Number(event.target.value) || 24)))}
        />

        <label className="field-label" htmlFor="grid">
          Grid
        </label>
        <select
          id="grid"
          className="preset-select"
          value={gridTicks}
          onChange={(event) => onGrid(Number(event.target.value))}
        >
          <option value={240}>1/16</option>
          <option value={120}>1/32</option>
          <option value={320}>1/8 T</option>
          <option value={160}>1/16 T</option>
        </select>

        <label className="field-label" htmlFor="zoom">
          Lebar
        </label>
        <select
          id="zoom"
          className="preset-select"
          value={cellWidth}
          onChange={(event) => onCellWidth(Number(event.target.value))}
        >
          <option value={22}>S</option>
          <option value={26}>M</option>
          <option value={32}>L</option>
        </select>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={keepManual}
            onChange={(event) => onKeepManual(event.target.checked)}
          />
          pertahankan edit manual
        </label>

        <button type="button" className="ghost" onClick={onSolveMissing}>
          Solve yang kosong
        </button>

        <button type="button" className="ghost" onClick={onSolveBar} title="Hitung ulang fingering bar yang sedang aktif saja">
          Solve {activeBarLabel}
        </button>
      </div>
    </div>
  );
}
