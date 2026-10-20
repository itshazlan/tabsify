import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { midiToName, type BarInfo, type NoteEvent, type Tab } from "@tabsify/engine";
import { NoteField } from "./NoteField.tsx";

const ROW = 24;
const HEADER = 28;
const GUTTER = 58;
const BAR_GAP = 6;
const PAD_BOTTOM = 10;

interface TabNotationProps {
  tab: Tab;
  bars: BarInfo[];
  gridTicks: number;
  cellWidth: number;
  selectedNoteId: string | null;
  playheadTick: number;
  unplayable: Set<string>;
  barScores?: Map<number, { score: number | null; flagged: boolean }>;
  onSelect: (id: string | null) => void;
  onAdd: (tick: number, stringIndex: number) => void;
  onFretChange: (id: string, fret: number) => void;
  onMoveString: (id: string, delta: number) => void;
  onDelete: (id: string) => void;
  onSelectRelative: (id: string, delta: number) => void;
}

interface PlacedNote {
  note: NoteEvent;
  slot: number;
}

function slotCount(bar: BarInfo, gridTicks: number): number {
  return Math.max(1, Math.round((bar.endTick - bar.startTick) / gridTicks));
}

function flagCount(duration: number): number {
  if (duration <= 120) return 3;
  if (duration <= 240) return 2;
  if (duration <= 480) return 1;
  return 0;
}

export function TabNotation({
  tab,
  bars,
  gridTicks,
  cellWidth,
  selectedNoteId,
  playheadTick,
  unplayable,
  barScores,
  onSelect,
  onAdd,
  onFretChange,
  onMoveString,
  onDelete,
  onSelectRelative,
}: TabNotationProps) {
  const stringCount = tab.tuning.strings.length;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [availableWidth, setAvailableWidth] = useState(() =>
    typeof window === "undefined" ? 1200 : Math.max(600, window.innerWidth - 40),
  );

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setAvailableWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const barIndexForTick = (tick: number): number => {
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

  const placed = useMemo(() => {
    const map = new Map<string, PlacedNote>();
    for (const note of tab.notes) {
      if (note.string == null) continue;
      const barIndex = barIndexForTick(note.tick);
      const bar = bars[barIndex];
      if (!bar) continue;
      const slots = slotCount(bar, gridTicks);
      const slot = Math.min(slots - 1, Math.max(0, Math.round((note.tick - bar.startTick) / gridTicks)));
      const key = `${barIndex}:${note.string}:${slot}`;
      if (!map.has(key)) map.set(key, { note, slot });
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, gridTicks, tab.notes]);

  const systems = useMemo(() => {
    const usable = Math.max(160, availableWidth - GUTTER - 20);
    const result: BarInfo[][] = [];
    let current: BarInfo[] = [];
    let width = 0;

    for (const bar of bars) {
      const barWidth = slotCount(bar, gridTicks) * cellWidth + BAR_GAP;
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

  const systemIndexOfBar = (barIndex: number): number => {
    for (let index = 0; index < systems.length; index += 1) {
      if (systems[index]!.some((bar) => bar.index === barIndex)) return index;
    }
    return 0;
  };

  const height = HEADER + stringCount * ROW + PAD_BOTTOM;
  const displayRows = useMemo(
    () => Array.from({ length: stringCount }, (_, index) => stringCount - 1 - index),
    [stringCount],
  );

  const selectedNote = selectedNoteId
    ? (tab.notes.find((note) => note.id === selectedNoteId) ?? null)
    : null;

  const handleClick = (event: ReactMouseEvent<SVGSVGElement>, systemBars: BarInfo[]) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < GUTTER) return;

    let cursorX = GUTTER;
    for (const bar of systemBars) {
      const slots = slotCount(bar, gridTicks);
      const width = slots * cellWidth + BAR_GAP;
      if (x >= cursorX && x < cursorX + width) {
        const slot = Math.max(0, Math.min(slots - 1, Math.floor((x - cursorX) / cellWidth)));
        const row = Math.floor((y - HEADER) / ROW);
        if (row < 0 || row >= stringCount) return;

        const stringIndex = stringCount - 1 - row;
        const entry = placed.get(`${bar.index}:${stringIndex}:${slot}`);
        if (entry) {
          onSelect(entry.note.id);
        } else {
          onSelect(null);
          onAdd(bar.startTick + slot * gridTicks, stringIndex);
        }
        return;
      }
      cursorX += width;
    }
  };

  // posisi input untuk note terpilih (overlay di atas SVG)
  let selectedOverlay: { systemIndex: number; left: number; top: number } | null = null;
  if (selectedNote && selectedNote.string != null) {
    const barIndex = barIndexForTick(selectedNote.tick);
    const bar = bars[barIndex];
    if (bar) {
      const systemIndex = systemIndexOfBar(barIndex);
      const systemBars = systems[systemIndex] ?? [];
      let left = GUTTER;
      for (const systemBar of systemBars) {
        if (systemBar.index === bar.index) break;
        left += slotCount(systemBar, gridTicks) * cellWidth + BAR_GAP;
      }
      const slots = slotCount(bar, gridTicks);
      const slot = Math.min(
        slots - 1,
        Math.max(0, Math.round((selectedNote.tick - bar.startTick) / gridTicks)),
      );
      const row = stringCount - 1 - selectedNote.string;
      selectedOverlay = {
        systemIndex,
        left: left + slot * cellWidth + cellWidth / 2,
        top: HEADER + row * ROW + ROW / 2,
      };
    }
  }

  return (
    <div className="notation" ref={containerRef}>
      {systems.map((systemBars, systemIndex) => {
        const systemWidth =
          GUTTER + systemBars.reduce((sum, bar) => sum + slotCount(bar, gridTicks) * cellWidth + BAR_GAP, 0);
        const overlay = selectedOverlay?.systemIndex === systemIndex ? selectedOverlay : null;

        return (
          <div className="notation-system" key={`system-${systemIndex}`} style={{ width: systemWidth }}>
            <svg
              width={systemWidth}
              height={height}
              className="notation-svg"
              onClick={(event) => handleClick(event, systemBars)}
            >
              {displayRows.map((stringIndex) => {
                const row = stringCount - 1 - stringIndex;
                const y = HEADER + row * ROW + ROW / 2;
                return (
                  <text key={`tune-${stringIndex}`} x={10} y={y} className="nt-tuning">
                    {midiToName(tab.tuning.strings[stringIndex]!)}
                  </text>
                );
              })}

              {systemBars.map((bar) => {
                const slots = slotCount(bar, gridTicks);
                const barWidth = slots * cellWidth + BAR_GAP;
                let x = GUTTER;
                for (const previous of systemBars) {
                  if (previous.index === bar.index) break;
                  x += slotCount(previous, gridTicks) * cellWidth + BAR_GAP;
                }

                const score = barScores?.get(bar.index);
                const showSignature =
                  bar.index === 0 ||
                  bars[bar.index - 1]!.ts.numerator !== bar.ts.numerator ||
                  bars[bar.index - 1]!.ts.denominator !== bar.ts.denominator;
                const playheadX =
                  playheadTick >= bar.startTick && playheadTick < bar.endTick
                    ? x + ((playheadTick - bar.startTick) / gridTicks) * cellWidth
                    : null;

                return (
                  <g key={`bar-${bar.index}`} id={`bar-${bar.index}`}>
                    {score?.flagged && (
                      <rect
                        x={x}
                        y={HEADER - 4}
                        width={barWidth}
                        height={stringCount * ROW + 6}
                        className="nt-flagged"
                      />
                    )}

                    <text x={x + 3} y={15} className="nt-bar-number">
                      {bar.index + 1}
                    </text>
                    {showSignature && (
                      <text x={x + 22} y={15} className="nt-signature">
                        {bar.ts.numerator}/{bar.ts.denominator}
                      </text>
                    )}
                    {score?.score != null && (
                      <text x={x + barWidth - 8} y={15} textAnchor="end" className={`nt-score${score.flagged ? " flagged" : ""}`}>
                        {Math.round(score.score * 100)}%
                      </text>
                    )}

                    {Array.from({ length: stringCount }, (_, row) => (
                      <line
                        key={`string-${row}`}
                        x1={x}
                        x2={x + barWidth - BAR_GAP}
                        y1={HEADER + row * ROW + ROW / 2}
                        y2={HEADER + row * ROW + ROW / 2}
                        className="nt-string"
                      />
                    ))}

                    {Array.from({ length: Math.ceil(slots / 4) }, (_, beat) => (
                      <line
                        key={`beat-${beat}`}
                        x1={x + beat * 4 * cellWidth}
                        x2={x + beat * 4 * cellWidth}
                        y1={HEADER - 2}
                        y2={HEADER + stringCount * ROW}
                        className="nt-beat"
                      />
                    ))}

                    <line
                      x1={x + barWidth - BAR_GAP + 1}
                      x2={x + barWidth - BAR_GAP + 1}
                      y1={HEADER - 2}
                      y2={HEADER + stringCount * ROW}
                      className="nt-barline"
                    />

                    {Array.from({ length: slots }, (_, slot) =>
                      displayRows.map((stringIndex) => {
                        const entry = placed.get(`${bar.index}:${stringIndex}:${slot}`);
                        if (!entry) return null;

                        const note = entry.note;
                        const row = stringCount - 1 - stringIndex;
                        const cx = x + slot * cellWidth + cellWidth / 2;
                        const cy = HEADER + row * ROW + ROW / 2;
                        const selected = note.id === selectedNoteId;
                        const flags = flagCount(note.duration);

                        return (
                          <g key={`note-${note.id}`} className="nt-note">
                            <rect
                              x={cx - 9}
                              y={cy - 8}
                              width={18}
                              height={16}
                              rx={3}
                              className={`nt-note-bg${selected ? " selected" : ""}`}
                            />
                            <text
                              x={cx}
                              y={cy + 1}
                              textAnchor="middle"
                              dominantBaseline="middle"
                              className={`nt-fret${unplayable.has(note.id) ? " unplayable" : ""}`}
                            >
                              {note.fret}
                            </text>
                            <line x1={cx + 7} x2={cx + 7} y1={cy - 7} y2={cy - 23} className="nt-stem" />
                            {Array.from({ length: flags }, (_, flag) => (
                              <line
                                key={`flag-${flag}`}
                                x1={cx + 7}
                                x2={cx + 13}
                                y1={cy - 23 + flag * 4}
                                y2={cy - 19 + flag * 4}
                                className="nt-flag"
                              />
                            ))}
                          </g>
                        );
                      }),
                    )}

                    {playheadX != null && (
                      <line
                        x1={playheadX}
                        x2={playheadX}
                        y1={HEADER - 4}
                        y2={HEADER + stringCount * ROW}
                        className="nt-playhead"
                      />
                    )}
                  </g>
                );
              })}
            </svg>

            {overlay && selectedNote && (
              <div
                className="notation-field"
                style={{ left: overlay.left - 15, top: overlay.top - 11 }}
              >
                <NoteField
                  note={selectedNote}
                  onFretChange={onFretChange}
                  onMoveString={onMoveString}
                  onDelete={onDelete}
                  onSelectRelative={onSelectRelative}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
