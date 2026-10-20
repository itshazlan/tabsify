import { useEffect, useRef, useState } from "react";
import { AlphaTabApi } from "@coderline/alphatab";
import { solveMissingFingerings, toAlphaTex, type Tab } from "@tabsify/engine";

interface TabReaderProps {
  tab: Tab;
}

export function TabReader({ tab }: TabReaderProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<AlphaTabApi | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playerReady, setPlayerReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    let api: AlphaTabApi;
    try {
      api = new AlphaTabApi(element, {
        core: {
          fontDirectory: "/font/",
          useWorkers: false,
          logLevel: "warning",
        },
        player: {
          enablePlayer: true,
          soundFont: "/soundfont/sonivox.sf2",
          enableCursor: true,
          enableUserInteraction: true,
        },
        display: {
          scale: 1,
          layoutMode: "page",
          resources: {
            mainGlyphColor: "#e7ebf1",
            secondaryGlyphColor: "#8b95a5",
            staffLineColor: "#39424f",
            barSeparatorColor: "#39424f",
            scoreInfoColor: "#e7ebf1",
            barNumberColor: "#8b95a5",
          },
        },
      });
    } catch (setupError) {
      setError((setupError as Error).message);
      return;
    }

    apiRef.current = api;
    api.playerReady.on(() => setPlayerReady(true));
    api.playerStateChanged.on((args) => {
      // PlayerState.Playing = 1 (enum-nya tidak diekspor dari paket)
      setPlaying(args.state === 1);
    });
    api.playerFinished.on(() => setPlaying(false));
    api.error.on((apiError) => {
      setError(apiError?.message ?? String(apiError));
    });

    return () => {
      apiRef.current = null;
      try {
        api.destroy();
      } catch {
        /* sudah dibuang */
      }
    };
  }, []);

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    try {
      const solved = solveMissingFingerings(tab);
      api.tex(toAlphaTex(solved, { minBars: 4 }));
      setError(null);
    } catch (renderError) {
      setError((renderError as Error).message);
    }
  }, [tab]);

  const togglePlay = () => {
    apiRef.current?.playPause();
  };

  return (
    <div className="reader">
      <div className="reader-toolbar">
        <button type="button" className="ghost" onClick={togglePlay}>
          {playing ? "■ Stop" : "▶ Play"}
        </button>
        <span className="reader-meta">
          {tab.notes.length} note · {tab.tempo} BPM · {tab.tuning.name}
        </span>
        <span className="reader-hint">
          Notasi alphaTab — playback memakai soundfont, kursor mengikuti lagu.
        </span>
        {!playerReady && <span className="reader-loading">memuat soundfont…</span>}
      </div>

      {error && <div className="reader-error">{error}</div>}
      <div className="reader-score" ref={containerRef} />
    </div>
  );
}
