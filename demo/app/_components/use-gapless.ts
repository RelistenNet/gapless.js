'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { Queue, type TrackInfo } from 'gapless';
import type { DemoTrack } from './tracks';
import { claimPlayback, registerPlayer } from './exclusive-playback';

export interface LogEntry {
  id: number;
  time: string;
  msg: string;
  level: 'info' | 'debug' | 'error';
}

export interface Handoff {
  from: number;
  to: number;
  /** True when the incoming track started from its decoded Web Audio buffer. */
  gapless: boolean;
}

export type PlayerState = 'idle' | 'playing' | 'paused' | 'ended';

export interface GaplessSnapshot {
  state: PlayerState;
  current: TrackInfo | undefined;
  tracks: readonly TrackInfo[];
  queueState: string;
  volume: number;
  playbackRate: number;
  logs: readonly LogEntry[];
  lastHandoff: Handoff | null;
}

const MAX_LOGS = 300;
let nextLogId = 0;

/**
 * Bridges a gapless Queue to React. The Queue is the source of truth for
 * playback; on every callback we rebuild one immutable snapshot from it and
 * notify subscribers. The store only keeps what the Queue can't tell us:
 * idle vs. ended, the last natural handoff, and the event log.
 *
 * The Queue is created in connect() (from an effect), never during render,
 * so pre-rendering on the server never touches browser audio APIs.
 */
class GaplessStore {
  private queue: Queue | null = null;
  private listeners = new Set<() => void>();
  private snapshot: GaplessSnapshot;
  /** Last progress seen per track index, for detecting natural handoffs. */
  private lastProgress = new Map<number, TrackInfo>();
  readonly initial: GaplessSnapshot;

  constructor(
    private readonly id: string,
    private readonly list: DemoTrack[],
    volume: number
  ) {
    this.initial = {
      state: 'idle',
      current: undefined,
      tracks: [],
      queueState: 'idle',
      volume,
      playbackRate: 1,
      logs: [],
      lastHandoff: null,
    };
    this.snapshot = this.initial;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => this.initial;

  connect(): () => void {
    const queue = new Queue({
      tracks: this.list.map((t) => t.url),
      trackMetadata: this.list.map((t) => ({ title: t.title })),
      volume: this.snapshot.volume,
      onProgress: (info) => {
        this.lastProgress.set(info.index, info);
        this.sync();
      },
      onStartNewTrack: (info) => this.onStartNewTrack(info),
      onEnded: () => this.sync({ state: 'ended' }, 'Queue finished'),
      onError: (err) => this.sync({}, err.message, 'error'),
      // Buffer state changes surface as debug messages before the next progress tick.
      onDebug: (msg) => this.sync({}, msg, 'debug'),
      onPlayBlocked: () =>
        this.sync({ state: 'paused' }, 'Autoplay was blocked. Press play to start.', 'error'),
    });
    this.queue = queue;
    this.sync();

    const unregister = registerPlayer(this.id, () => {
      if (queue.isPlaying) queue.pause();
      this.sync();
    });

    return () => {
      unregister();
      queue.destroy();
      if (this.queue === queue) this.queue = null;
    };
  }

  private sync(
    patch: Partial<GaplessSnapshot> = {},
    msg?: string,
    level: LogEntry['level'] = 'info'
  ) {
    const q = this.queue;
    const prev = this.snapshot;
    let state = prev.state;
    if (q?.isPlaying) state = 'playing';
    else if (state === 'playing') state = 'paused';

    const next: GaplessSnapshot = {
      ...prev,
      ...(q && {
        current: q.currentTrack,
        tracks: q.tracks,
        queueState: q.queueSnapshot.state,
        volume: q.volume,
        playbackRate: q.playbackRate,
      }),
      state,
      ...patch,
    };
    if (msg) {
      const entry = { id: nextLogId++, time: new Date().toLocaleTimeString(), msg, level };
      next.logs = [entry, ...prev.logs].slice(0, MAX_LOGS);
    }
    this.snapshot = next;
    for (const l of this.listeners) l();
  }

  private onStartNewTrack(info: TrackInfo) {
    // A natural handoff is the previous track running out on its own, as
    // opposed to the listener pressing next or picking from the playlist.
    // (snapshot.current may already point at the new track by now.)
    const prev = this.lastProgress.get(info.index - 1);
    const natural =
      prev !== undefined && Number.isFinite(prev.duration) && prev.duration - prev.currentTime < 1;
    if (!natural) {
      this.sync({}, `Now playing "${info.metadata?.title}"`);
      return;
    }
    const gapless = info.playbackType === 'WEBAUDIO';
    this.sync(
      { lastHandoff: { from: prev.index, to: info.index, gapless } },
      gapless
        ? `Gapless handoff → "${info.metadata?.title}" started on the Web Audio clock`
        : `Handoff → "${info.metadata?.title}" fell back to HTML5 (next buffer not decoded yet)`
    );
  }

  /** Run fn after this user gesture unlocks the AudioContext. */
  private withAudio(fn: (q: Queue) => void) {
    const q = this.queue;
    if (!q) return;
    this.lastProgress.clear();
    claimPlayback(this.id);
    q.resumeAudioContext().then(() => fn(q));
  }

  readonly actions = {
    toggle: () => {
      if (this.queue?.isPlaying) {
        this.queue.pause();
        this.sync();
      } else {
        this.withAudio((q) => q.play());
      }
    },
    next: () => this.withAudio((q) => q.next()),
    previous: () => this.withAudio((q) => q.previous()),
    gotoTrack: (index: number, startTime?: number) =>
      this.withAudio((q) => q.gotoTrack(index, true, startTime)),
    seek: (time: number) => this.queue?.seek(time),
    /** Jump to `secondsBefore` the end of the current track and keep playing. */
    seekNearEnd: (secondsBefore: number) => {
      const cur = this.queue?.currentTrack;
      if (!cur || !Number.isFinite(cur.duration)) return;
      this.withAudio((q) => {
        q.seek(Math.max(0, cur.duration - secondsBefore));
        if (!q.isPlaying) q.play();
      });
      this.sync({}, `Seeked to ${secondsBefore}s before the end of "${cur.metadata?.title}"`);
    },
    setVolume: (v: number) => {
      this.queue?.setVolume(v);
      this.sync({ volume: v });
    },
    setPlaybackRate: (rate: number) => {
      this.queue?.setPlaybackRate(rate);
      this.sync({ playbackRate: rate });
    },
    clearHandoff: () => this.sync({ lastHandoff: null }),
  };
}

export function useGapless(id: string, tracks: DemoTrack[], options: { volume?: number } = {}) {
  const [store] = useState(() => new GaplessStore(id, tracks, options.volume ?? 0.8));
  useEffect(() => store.connect(), [store]);
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot
  );
  return { ...snapshot, ...store.actions };
}

export type GaplessPlayer = ReturnType<typeof useGapless>;
