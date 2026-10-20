import { TICKS_PER_WHOLE, type BarInfo, type TimeSignature } from "./types.ts";

const MAX_BARS = 20000;

export function barLengthTicks(ts: Pick<TimeSignature, "numerator" | "denominator">): number {
  const denominator = Math.max(1, Math.round(ts.denominator));
  const numerator = Math.max(1, Math.round(ts.numerator));
  return (TICKS_PER_WHOLE * numerator) / denominator;
}

export function normalizeTimeSignatures(timeSignatures: TimeSignature[]): TimeSignature[] {
  const sorted = timeSignatures
    .filter((ts) => Number.isFinite(ts.tick) && ts.numerator > 0 && ts.denominator > 0)
    .sort((a, b) => a.tick - b.tick);

  const result: TimeSignature[] = [];
  for (const ts of sorted) {
    const previous = result[result.length - 1];
    if (previous && previous.tick === ts.tick) {
      result[result.length - 1] = ts;
      continue;
    }
    result.push(ts);
  }

  if (result.length === 0 || result[0]!.tick !== 0) {
    result.unshift({ tick: 0, numerator: 4, denominator: 4 });
  }
  return result;
}

/**
 * Builds the bar grid until `lastTick` (plus at least `minBars` bars).
 * A time signature change always starts a new bar; if a change lands inside a
 * running bar the bar is cut short so nothing overlaps.
 */
export function buildBars(
  timeSignatures: TimeSignature[],
  lastTick: number,
  minBars = 1,
): BarInfo[] {
  const signatures = normalizeTimeSignatures(timeSignatures);
  const bars: BarInfo[] = [];

  let start = 0;
  let signatureIndex = 0;

  while (bars.length < MAX_BARS) {
    while (
      signatureIndex + 1 < signatures.length &&
      signatures[signatureIndex + 1]!.tick <= start
    ) {
      signatureIndex += 1;
    }

    const ts = signatures[signatureIndex]!;
    let end = start + barLengthTicks(ts);

    const nextChange = signatures[signatureIndex + 1];
    if (nextChange && nextChange.tick > start && nextChange.tick < end) {
      end = nextChange.tick;
    }

    bars.push({ index: bars.length, startTick: start, endTick: end, ts });

    start = end;
    if (start >= lastTick && bars.length >= minBars) break;
    if (start > lastTick + TICKS_PER_WHOLE * 64 && bars.length >= minBars) break;
  }

  return bars;
}

export function barAtTick(bars: BarInfo[], tick: number): BarInfo {
  if (bars.length === 0) {
    throw new Error("Bar grid kosong");
  }
  let low = 0;
  let high = bars.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const bar = bars[mid]!;
    if (tick < bar.startTick) high = mid - 1;
    else if (tick >= bar.endTick) low = mid + 1;
    else return bar;
  }
  return tick < bars[0]!.startTick ? bars[0]! : bars[bars.length - 1]!;
}

export function quantizeTick(tick: number, grid: number): number {
  if (grid <= 0) return tick;
  return Math.max(0, Math.round(tick / grid) * grid);
}

/** Duration in ticks for a note value like 4 (quarter), 8 (eighth), 16, 32, 64. */
export function noteValueTicks(value: number): number {
  return TICKS_PER_WHOLE / value;
}
