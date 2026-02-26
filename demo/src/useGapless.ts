import { useState, useRef, useEffect, useCallback } from 'react';
import { Queue, type TrackInfo } from 'gapless.js';

export interface LogEntry {
  time: string;
  msg: string;
  level: 'info' | 'warn' | 'err';
}

export interface GaplessState {
  state: 'idle' | 'playing' | 'paused' | 'ended';
  currentTrack: TrackInfo | undefined;
  tracks: readonly TrackInfo[];
  logs: LogEntry[];
  volume: number;
}

export interface GaplessControls {
  play: () => void;
  pause: () => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (time: number) => void;
  gotoTrack: (index: number) => void;
  setVolume: (v: number) => void;
  seekToEnd: () => void;
}

export function useGapless(options: {
  tracks: string[];
  titles: string[];
  volume: number;
}): GaplessState & GaplessControls {
  const [state, setState] = useState<'idle' | 'playing' | 'paused' | 'ended'>('idle');
  const [currentTrack, setCurrentTrack] = useState<TrackInfo | undefined>();
  const [tracks, setTracks] = useState<readonly TrackInfo[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [volume, setVolumeState] = useState(options.volume);
  const ctxReady = useRef(false);
  const queueRef = useRef<Queue | null>(null);

  const addLog = useCallback((msg: string, level: LogEntry['level'] = 'info') => {
    setLogs((prev) => {
      const entry: LogEntry = { time: new Date().toLocaleTimeString(), msg, level };
      const next = [entry, ...prev];
      if (next.length > 200) next.length = 200;
      return next;
    });
  }, []);

  useEffect(() => {
    const queue = new Queue({
      tracks: options.tracks,
      volume: options.volume,
      trackMetadata: options.titles.map((title) => ({ title })),

      onProgress(info) {
        setCurrentTrack(info);
        setTracks(queue.tracks);
        setVolumeState(queue.volume);
        if (info.isPaused) {
          setState('paused');
        } else if (info.isPlaying) {
          setState('playing');
        }
      },

      onStartNewTrack(info) {
        addLog(`\u25b6 started: "${info.metadata?.title ?? info.trackUrl}" (index ${info.index})`);
        setTracks(queue.tracks);
      },

      onPlayNextTrack(info) {
        addLog(`\u2192 next: "${info.metadata?.title}"`);
      },

      onPlayPreviousTrack(info) {
        addLog(`\u2190 prev: "${info.metadata?.title}"`);
      },

      onEnded() {
        addLog('\u25fc queue ended');
        setState('ended');
      },

      onError(err) {
        addLog(`ERROR: ${err.message}`, 'err');
      },

      onDebug(msg) {
        addLog(`DBG: ${msg}`, 'warn');
      },

      onPlayBlocked() {
        addLog('Autoplay blocked \u2014 click Play', 'warn');
      },
    });

    queueRef.current = queue;
    setTracks(queue.tracks);
    addLog('Ready \u2014 click Play to start');
    addLog(`Queue created: ${options.tracks.length} tracks`);

    return () => {
      queueRef.current = null;
    };
    // Run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const withCtx = useCallback((fn: () => void) => {
    const queue = queueRef.current;
    if (!queue) return;
    if (ctxReady.current) {
      fn();
    } else {
      ctxReady.current = true;
      queue.resumeAudioContext().then(fn);
    }
  }, []);

  const toggle = useCallback(() => withCtx(() => queueRef.current?.togglePlayPause()), [withCtx]);
  const play = useCallback(() => withCtx(() => queueRef.current?.play()), [withCtx]);
  const pause = useCallback(() => withCtx(() => queueRef.current?.pause()), [withCtx]);
  const next = useCallback(() => withCtx(() => queueRef.current?.next()), [withCtx]);
  const prev = useCallback(() => withCtx(() => queueRef.current?.previous()), [withCtx]);

  const seek = useCallback((time: number) => {
    queueRef.current?.seek(time);
  }, []);

  const gotoTrack = useCallback((index: number) => {
    withCtx(() => {
      queueRef.current?.gotoTrack(index, true);
      addLog(`jumped to track ${index + 1}`);
    });
  }, [withCtx, addLog]);

  const setVolume = useCallback((v: number) => {
    queueRef.current?.setVolume(v);
    setVolumeState(v);
  }, []);

  const seekToEnd = useCallback(() => {
    const queue = queueRef.current;
    const cur = queue?.currentTrack;
    if (!cur || isNaN(cur.duration)) {
      addLog('duration not yet known', 'warn');
      return;
    }
    const t = Math.max(0, cur.duration - 5);
    queue!.seek(t);
    const mins = Math.floor(t / 60);
    const secs = String(Math.floor(t % 60)).padStart(2, '0');
    addLog(`seek \u2192 ${mins}:${secs} (end \u2212 5s)`);
  }, [addLog]);

  return {
    state,
    currentTrack,
    tracks,
    logs,
    volume,
    play,
    pause,
    toggle,
    next,
    prev,
    seek,
    gotoTrack,
    setVolume,
    seekToEnd,
  };
}
