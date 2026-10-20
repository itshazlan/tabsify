import { useCallback, useEffect, useRef, useState } from "react";
import type { Tab } from "@tabsify/engine";

const TICKS_PER_QUARTER = 960;

function schedulePluck(
  context: AudioContext,
  destination: AudioNode,
  midi: number,
  when: number,
  duration: number,
) {
  const frequency = 440 * Math.pow(2, (midi - 69) / 12);
  const oscillator = context.createOscillator();
  oscillator.type = "sawtooth";
  oscillator.frequency.value = frequency;

  const filter = context.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = Math.min(9000, frequency * 7);
  filter.Q.value = 1.4;

  const gain = context.createGain();
  const peak = 0.16;
  const span = Math.max(0.09, duration * 0.95);
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(peak, when + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + span);

  oscillator.connect(filter);
  filter.connect(gain);
  gain.connect(destination);
  oscillator.start(when);
  oscillator.stop(when + span + 0.05);
}

export interface PlaybackState {
  isPlaying: boolean;
  playheadTick: number;
  toggle: () => void;
  stop: () => void;
  startAt: (tick: number) => void;
}

export function usePlayback(tab: Tab | null): PlaybackState {
  const [isPlaying, setIsPlaying] = useState(false);
  const [playheadTick, setPlayheadTick] = useState(0);

  const contextRef = useRef<AudioContext | null>(null);
  const startTimeRef = useRef(0);
  const startTickRef = useRef(0);
  const frameRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    contextRef.current?.close().catch(() => undefined);
    contextRef.current = null;
    setIsPlaying(false);
    setPlayheadTick(0);
  }, []);

  const startAt = useCallback(
    (fromTick: number) => {
      if (!tab) return;
      stop();

      const tempo = Math.max(20, tab.tempo || 120);
      const secondsPerTick = 60 / tempo / TICKS_PER_QUARTER;
      const context = new AudioContext();
      contextRef.current = context;

      const master = context.createGain();
      master.gain.value = 0.7;
      master.connect(context.destination);

      const startTime = context.currentTime + 0.12;
      startTimeRef.current = startTime;
      startTickRef.current = fromTick;

      for (const note of tab.notes) {
        if (note.tick + note.duration <= fromTick) continue;
        const relativeTick = Math.max(0, note.tick - fromTick);
        const when = startTime + relativeTick * secondsPerTick;
        schedulePluck(context, master, note.midi, when, note.duration * secondsPerTick);
      }

      const endTick = tab.notes.reduce((max, note) => Math.max(max, note.tick + note.duration), fromTick);
      const totalTicks = Math.max(1, endTick - fromTick);

      setIsPlaying(true);

      const tick = () => {
        const elapsed = context.currentTime - startTime;
        const position = fromTick + Math.max(0, elapsed) / secondsPerTick;
        setPlayheadTick(position);
        if (position - fromTick < totalTicks + 480) {
          frameRef.current = requestAnimationFrame(tick);
        } else {
          setIsPlaying(false);
          setPlayheadTick(0);
          context.close().catch(() => undefined);
          contextRef.current = null;
        }
      };
      frameRef.current = requestAnimationFrame(tick);
    },
    [stop, tab],
  );

  const toggle = useCallback(() => {
    if (isPlaying) stop();
    else startAt(playheadTick);
  }, [isPlaying, playheadTick, startAt, stop]);

  useEffect(() => () => stop(), [stop]);

  return { isPlaying, playheadTick, toggle, stop, startAt };
}
