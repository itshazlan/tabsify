import { useEffect, useMemo, useRef, useState } from "react";
import { midiToName, type BarInfo, type NoteEvent, type Tab } from "@tabsify/engine";
import { NoteField } from "./NoteField.tsx";

const DEFAULT_CELL_WIDTH = 26;
const GUTTER_WIDTH = 66;
const BAR_PADDING = 6;

interface TabGridProps {
  tab: Tab;
  bars: BarInfo[];
  gridTicks: number;
  selectedNoteId: string | null;
  playheadTick: number;
  unplayable: Set<string>;
  barScores?: Map<number, { score: number | null; flagged: boolean }>;
  cellWidth?: number;
  onSelect: (id: string | null) => void;
  onAdd: (tick: number, stringIndex: number) => void;
  onFretChange: (id: string, fret: number) => void;
  onMoveString: (id: string, delta: number) => void;
  onDelete: (id: string) => void;
  onSelectRelative: (id: string, delta: number) => void;
}

interface PlacedNote {
  note: NoteEvent;
  barIndex: number;
  slot: number;
}

export function TabGrid({
  tab,
  bars,
  gridTicks,
  selectedNoteId,
  playheadTick,
  unplayable,
  barScores,
  cellWidth = DEFAULT_CELL_WIDTH,
  onSelect,
  onAdd,
  onFretChange,
  onMoveString,
  onDelete,
  onSelectRelative,
}: TabGridProps) {
  const stringCount = tab.tuning.strings.length;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [availableWidth, setAvailableWidth] = useState(() =>
    typeof window === "undefined" ? 1200 : Math.max(600, window.innerWidth - 40),
  );

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setAvailableWidth(entry.contentRect.width);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const slotsFor = (bar: BarInfo) =>
    Math.max(1, Math.round((bar.endTick - bar.startTick) / gridTicks));

  const placed = useMemo(() => {
    const map = new Map<string, PlacedNote>();

    const findBar = (tick: number): number => {
      let low = 0;
      let high = bars.length - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const bar = bars[mid]!;
        if (tick < bar.startTick) high = mid - 1;
        else if (tick >= bar.endTick) low = mid + 1;
        else return mid;
      }
      return Math.max(0, Math.min(bars.length - 1, low));
    };

    for (const note of tab.notes) {
      if (note.string == null) continue;
      const barIndex = findBar(note.tick);
      const bar = bars[barIndex];
      if (!bar) continue;
      const slots = Math.max(1, Math.round((bar.endTick - bar.startTick) / gridTicks));
      const slot = Math.min(
        slots,
        Math.max(0, Math.round((note.tick - bar.startTick) / gridTicks)),
      );
      const key = `${barIndex}:${note.string}:${slot}`;
      if (!map.has(key)) map.set(key, { note, barIndex, slot });
    }
    return map;
  }, [bars, gridTicks, tab.notes]);

  const playheadBarIndex = useMemo(() => {
    for (let index = 0; index < bars.length; index += 1) {
      const bar = bars[index]!;
      if (playheadTick >= bar.startTick && playheadTick < bar.endTick) return index;
    }
    return -1;
  }, [bars, playheadTick]);

  const activeBarIndex = useMemo(() => {
    if (!selectedNoteId) return -1;
    const note = tab.notes.find((item) => item.id === selectedNoteId);
    if (!note) return -1;
    return bars.findIndex((bar) => note.tick >= bar.startTick && note.tick < bar.endTick);
  }, [bars, selectedNoteId, tab.notes]);

  const displayStrings = useMemo(
    () => Array.from({ length: stringCount }, (_, index) => stringCount - 1 - index),
    [stringCount],
  );

  const systems = useMemo(() => {
    const usable = Math.max(160, availableWidth - GUTTER_WIDTH - 8);
    const result: BarInfo[][] = [];
    let current: BarInfo[] = [];
    let width = 0;

    for (const bar of bars) {
      const barWidth = slotsFor(bar) * cellWidth + BAR_PADDING;
      if (current.length > 0 && width + barWidth > usable) {
        result.push(current);
        current = [];
        width = 0;
      }
      current.push(bar);
      width += barWidth;
    }
    if (current.length > 0) result.push(current);
    return result.length > 0 ? result : [[]];
  }, [availableWidth, bars, cellWidth, gridTicks]);

  const renderGutter = (key: string) => (
    <div className="string-gutter" key={key}>
      <div className="gutter-head">senar</div>
      {displayStrings.map((stringIndex) => (
        <div className="gutter-cell" key={stringIndex}>
          <span className="gutter-note">{midiToName(tab.tuning.strings[stringIndex]!)}</span>
          <span className="gutter-index">{stringCount - stringIndex}</span>
        </div>
      ))}
    </div>
  );

  return (
    <div className="tab-editor" ref={containerRef}>
      {systems.map((systemBars, systemIndex) => (
        <div className="system" key={`system-${systemIndex}`}>
          {renderGutter(`gutter-${systemIndex}`)}
          <div className="bars">
            {systemBars.map((bar) => {
              const slots = slotsFor(bar);
              const showSignature =
                bar.index === 0 ||
                bars[bar.index - 1]!.ts.numerator !== bar.ts.numerator ||
                bars[bar.index - 1]!.ts.denominator !== bar.ts.denominator;

              const barScore = barScores?.get(bar.index);
              const classes = ["bar"];
              if (bar.index === activeBarIndex) classes.push("active");
              if (barScore?.flagged) classes.push("flagged");

              return (
                <div
                  className={classes.join(" ")}
                  key={bar.index}
                  id={`bar-${bar.index}`}
                  style={{ width: slots * cellWidth + BAR_PADDING }}
                >
                  <div className="bar-head">
                    <span className="bar-number">{bar.index + 1}</span>
                    {showSignature && (
                      <span className="bar-signature">
                        {bar.ts.numerator}/{bar.ts.denominator}
                      </span>
                    )}
                    {barScore?.score != null && (
                      <span className="bar-score">{Math.round(barScore.score * 100)}%</span>
                    )}
                  </div>
                  <div
                    className="bar-cells"
                    style={{ gridTemplateColumns: `repeat(${slots}, ${cellWidth}px)` }}
                  >
                    {displayStrings.map((stringIndex) =>
                      Array.from({ length: slots }, (_, slot) => {
                        const key = `${bar.index}:${stringIndex}:${slot}`;
                        const entry = placed.get(key);
                        const cellTick = bar.startTick + slot * gridTicks;
                        const isPlayhead =
                          bar.index === playheadBarIndex &&
                          playheadTick >= cellTick &&
                          playheadTick < cellTick + gridTicks;
                        const classes = ["cell"];
                        if (slot % 4 === 0) classes.push("beat");
                        if (isPlayhead) classes.push("playhead");

                        if (!entry) {
                          return (
                            <button
                              type="button"
                              key={`${stringIndex}-${slot}`}
                              className={classes.join(" ")}
                              onClick={() => {
                                onSelect(null);
                                onAdd(cellTick, stringIndex);
                              }}
                              aria-label={`Tambah note di bar ${bar.index + 1}, senar ${
                                stringCount - stringIndex
                              }`}
                            />
                          );
                        }

                        const { note } = entry;
                        if (note.id === selectedNoteId) classes.push("selected");
                        if (unplayable.has(note.id)) classes.push("unplayable");

                        return (
                          <div
                            key={`${stringIndex}-${slot}`}
                            className={[...classes, "filled"].join(" ")}
                            onClick={() => onSelect(note.id)}
                            title={`${midiToName(note.midi)} · senar ${
                              stringCount - stringIndex
                            } · fret ${note.fret}`}
                          >
                            {note.id === selectedNoteId ? (
                              <NoteField
                                note={note}
                                onFretChange={onFretChange}
                                onMoveString={onMoveString}
                                onDelete={onDelete}
                                onSelectRelative={onSelectRelative}
                              />
                            ) : (
                              <span className="fret">{note.fret}</span>
                            )}
                          </div>
                        );
                      }),
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
