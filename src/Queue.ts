// ---------------------------------------------------------------------------
// Queue — public API class; orchestrates tracks via QueueMachine
// ---------------------------------------------------------------------------

import { createActor } from 'xstate';
import { getAudioContext, resumeAudioContext as _resumeAudioContext } from './utils/audioContext';
import {
  setupMediaSession,
  updateMediaSessionMetadata,
  updateMediaSessionPlaybackState,
  updateMediaSessionPositionState,
} from './utils/mediaSession';
import { createQueueMachine } from './machines/queue.machine';
import type { PlayList } from './machines/queue.machine';
import { Track, normalizeClip } from './Track';
import type { TrackQueueRef } from './Track';
import { throttle } from './utils/throttle';
import type {
  GaplessOptions,
  AddTrackOptions,
  Entry,
  Position,
  QueueChange,
  QueueSnapshot,
  RepeatMode,
  TrackInfo,
  TrackMetadata,
  PlaybackMethod,
  PlaybackType,
} from './types';

const MAX_SCHEDULE_LOOKAHEAD = 5;

/** Leeway past the scheduling horizon, so a lookahead notice right at it isn't refused. */
const HORIZON_SLACK_SEC = 0.5;
/** A crossfade shorter than this is played as a gapless cut instead. */
const MIN_CROSSFADE_SEC = 0.1;
/** How far a fade in progress tolerates its end time moving before it is redone. */
const FADE_DRIFT_SEC = 0.25;
/** How far ahead of now a crossfade can start, so both ramps are in the future. */
const CROSSFADE_LEAD_SEC = 0.05;

/** Whether a track still plays what `e` describes (same file, same clip). */
function sameSource(t: Track, e: Entry): boolean {
  return t.sourceUrl === e.url && t.clipStart === (e.start ?? 0) && t.clipEnd === (e.end ?? null);
}

function assertCrossfade(seconds: number | undefined): void {
  if (seconds !== undefined && !(seconds >= 0 && isFinite(seconds))) {
    throw new Error(`gapless: crossfade must be a finite number >= 0 (got ${seconds})`);
  }
}

/**
 * Lazy singleton Blob URL for a 10-second silent WAV.
 * Chrome requires a media element with >= 5 s intrinsic duration to treat it
 * as a "controllable" media session. Generated once at first use; 8 kHz mono
 * 8-bit keeps it ~80 KB.
 */
let _silentWavUrl: string | null = null;
function getSilentWavUrl(): string {
  if (_silentWavUrl) return _silentWavUrl;
  const sampleRate = 8000;
  const numSamples = sampleRate * 10;
  const fileSize = 44 + numSamples;
  const buffer = new ArrayBuffer(fileSize);
  const view = new DataView(buffer);

  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, fileSize - 8, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true); // byte rate
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // 8 bits per sample
  writeStr(36, 'data');
  view.setUint32(40, numSamples, true);
  new Uint8Array(buffer, 44).fill(128); // 8-bit PCM silence = 128

  _silentWavUrl = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
  return _silentWavUrl;
}

export class Queue implements TrackQueueRef {
  private _tracks: Track[] = [];
  private readonly _actor;

  private readonly _onProgress?: (info: TrackInfo) => void;
  private readonly _onEnded?: () => void;
  private readonly _onPlayNextTrack?: (info: TrackInfo) => void;
  private readonly _onPlayPreviousTrack?: (info: TrackInfo) => void;
  private readonly _onStartNewTrack?: (info: TrackInfo) => void;
  private readonly _onError?: (error: Error) => void;
  private readonly _onPlayBlocked?: () => void;
  private readonly _onDebug?: (msg: string) => void;

  readonly playbackMethod: PlaybackMethod;

  private _volume: number;
  private _repeat: RepeatMode;
  private _crossfade: number;
  private readonly _changeListeners = new Set<(change: QueueChange) => void>();
  /** Bumped on every structural edit; with currentKey and repeat, decides when onChange fires. */
  private _orderVersion = 0;
  /** Counter for generated keys; see _newKey. */
  private _keySeq = 0;
  private _changePending = false;
  private _lastChange: { version: number; currentKey: string | null; repeat: RepeatMode } | null =
    null;
  private _preloadNumTracks: number;
  private _playbackRate: number;

  /** Silent looping element that keeps the browser's MediaSession anchor alive. */
  private _mediaSessionAnchor: HTMLAudioElement | null = null;

  /**
   * The track with a pre-scheduled gapless start, or null. Held by reference,
   * not index, so reordering the queue can't make it point at another track.
   */
  private _scheduledNext: Track | null = null;
  /**
   * What the scheduled transition was timed against: the current track's end
   * time and backend, and the fade asked for. A reschedule that would come
   * out the same keeps it (see _rescheduleGapless).
   */
  private _scheduledFor: {
    endTime: number;
    start: number;
    type: PlaybackType;
    want: number;
  } | null = null;

  /** The scheduled track, if it reported its end before it became current. */
  private _scheduledEndedEarly: Track | null = null;
  /** Retries a transition deferred until it is near (see _tryScheduleGapless). */
  private _retryTimer: ReturnType<typeof setTimeout> | null = null;

  /** @internal Index of the scheduled track (debugging and tests). */
  get _scheduledNextIndex(): number | null {
    return this._scheduledNext ? this._tracks.indexOf(this._scheduledNext) : null;
  }
  set _scheduledNextIndex(index: number | null) {
    this._scheduledNext = index === null ? null : (this._tracks[index] ?? null);
  }

  private _throttledUpdatePositionState = throttle(
    (duration: number, currentTime: number, playbackRate: number) =>
      updateMediaSessionPositionState(duration, currentTime, playbackRate),
    1000
  );

  constructor(options: GaplessOptions = {}) {
    const {
      tracks = [],
      onProgress,
      onEnded,
      onPlayNextTrack,
      onPlayPreviousTrack,
      onStartNewTrack,
      onError,
      onPlayBlocked,
      onDebug,
      playbackMethod = 'HYBRID',
      trackMetadata = [],
      volume: initialVolume = 1,
      preloadNumTracks = 2,
      playbackRate: initialPlaybackRate = 1,
      repeat = 'off',
      crossfade = 0,
    } = options;
    this._repeat = repeat;
    assertCrossfade(crossfade);
    this._crossfade = crossfade;

    this._volume = Math.min(1, Math.max(0, initialVolume));
    this._preloadNumTracks = Math.max(0, preloadNumTracks);
    this._playbackRate = Math.min(4, Math.max(0.25, initialPlaybackRate));
    this.playbackMethod = playbackMethod;
    this._onProgress = onProgress;
    this._onEnded = onEnded;
    this._onPlayNextTrack = onPlayNextTrack;
    this._onPlayPreviousTrack = onPlayPreviousTrack;
    this._onStartNewTrack = onStartNewTrack;
    this._onError = onError;
    this._onPlayBlocked = onPlayBlocked;
    this._onDebug = onDebug;

    this._tracks = tracks.map(
      (url, i) =>
        new Track({
          trackUrl: url,
          queue: this,
          key: `gapless-${++this._keySeq}`,
          metadata: trackMetadata[i],
        })
    );

    // -----------------------------------------------------------------------
    // Wire up the queue machine with real action implementations.
    //
    // IMPORTANT: actions receive ({ context }) which reflects the in-progress
    // context (updated by prior assign() calls within the same transition).
    // Do NOT use this._actor.getSnapshot() inside actions — that returns the
    // pre-transition snapshot and won't reflect intermediate assign() updates.
    // -----------------------------------------------------------------------
    // The machine asks the queue about order; repeat lives here, in _nextOf.
    const list: PlayList<Track> = {
      next: (t) => this._nextOf(t),
      previous: (t) => this._tracks[this._tracks.indexOf(t) - 1] ?? null,
      first: () => this._tracks[0] ?? null,
      size: () => this._tracks.length,
      repeatsCurrent: () =>
        this._repeat === 'one' || (this._repeat === 'all' && this._tracks.length === 1),
    };

    const machine = createQueueMachine<Track>({
      current: this._tracks[0] ?? null,
      list,
    }).provide({
      actions: {
        deactivateCurrent: ({ context }) => {
          context.current?.deactivate();
        },
        deactivateEndedTrack: ({ context }) => {
          context.current?.deactivate();
        },
        activateCurrent: ({ context }) => {
          context.current?.activate();
        },
        playOrContinueGapless: ({ context }) => {
          const cur = context.current;
          if (!cur) return;
          if (this._scheduledNext !== cur) {
            cur.play();
          } else {
            this._scheduledNext = null;
            this._scheduledFor = null;
            // A crossfade start over HTML5 is now just the track playing on.
            cur.takeOverScheduledStart();
            // It already finished (its end notice came first, while it
            // wasn't current yet): end it now rather than sit silent.
            if (this._scheduledEndedEarly === cur) {
              this._scheduledEndedEarly = null;
              queueMicrotask(() => this.onTrackEnded(cur));
              return;
            }
            // Ask for its own next transition now: a track that started early
            // may have spent its lookahead notice while it was still incoming.
            queueMicrotask(() => {
              if (this._currentTrack === cur && this.isPlaying) this._tryScheduleGapless(cur);
            });
            this.onDebug(
              `onTrackEnded: gapless track ${cur.key} — sourceNode=${cur.hasSourceNode} isPlaying=${cur.isPlaying} machineState=${cur.machineState}`
            );
            cur.startProgressLoop();
          }
        },
        cancelAllGapless: () => this._cancelScheduledGapless(),
        notifyStartNewTrack: ({ context }) => {
          if (context.current) this._onStartNewTrack?.(context.current.toInfo());
        },
        notifyPlayNextTrack: ({ context }) => {
          if (context.current) this._onPlayNextTrack?.(context.current.toInfo());
        },
        notifyPlayPreviousTrack: ({ context }) => {
          if (context.current) this._onPlayPreviousTrack?.(context.current.toInfo());
        },
        notifyEnded: () => this._onEnded?.(),
        updateMediaSessionMetadata: ({ context }) => {
          if (context.current) updateMediaSessionMetadata(context.current.metadata);
        },
        preloadAhead: ({ context }) => {
          this._preloadAhead(context.current);
        },
        playCurrent: ({ context }) => {
          context.current?.play();
        },
        pauseCurrent: ({ context }) => {
          context.current?.pause();
        },
        seekCurrent: ({ context, event }) => {
          const e = event as { type: 'SEEK'; time: number };
          context.current?.seek(e.time);
        },
        seekCurrentToStartTime: ({ context, event }) => {
          const e = event as { type: 'GOTO'; startTime?: number };
          context.current?.seek(e.startTime ?? 0);
        },
        scheduleGapless: ({ context }) => {
          this._tryScheduleGapless(context.current);
        },
        cancelScheduledGapless: () => {
          this._cancelScheduledGapless();
        },
        cancelAndRescheduleGapless: ({ context, event }) => {
          // A seek restarts the current track's source, which resets its
          // fade-out: always redo the transition. Other callers (a buffer or
          // lookahead notice) may keep one that comes out the same.
          this._rescheduleGapless(context.current, event.type === 'SEEK');
        },
      },
    });

    this._actor = createActor(machine);

    let wasPlaying = false;
    this._actor.subscribe((snapshot) => {
      this._emitChange();
      const playing = snapshot.value === 'playing';
      // Media Session handlers are page-global. With several queues on one
      // page, the one that starts playing takes over the OS controls.
      if (playing && !wasPlaying) this._claimMediaSession();
      wasPlaying = playing;
      updateMediaSessionPlaybackState(playing);
      if (playing) {
        this._startMediaSessionAnchor();
      } else {
        this._stopMediaSessionAnchor();
      }
    });

    this._actor.start();

    setupMediaSession(this._mediaSessionHandlers);
  }

  private readonly _mediaSessionHandlers = {
    onPlay: () => this.play(),
    onPause: () => {
      if (this._actor.getSnapshot().value === 'playing') this.pause();
    },
    onNext: () => this.next(),
    onPrevious: () => this.previous(),
    onSeek: (t: number) => this.seek(t),
  };

  /** Point the OS media controls and metadata at this queue. */
  private _claimMediaSession(): void {
    setupMediaSession(this._mediaSessionHandlers);
    const cur = this._currentTrack;
    if (cur) updateMediaSessionMetadata(cur.metadata);
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  play(): void {
    if (!this._currentTrack) return;
    this._actor.send({ type: 'PLAY' });
  }

  pause(): void {
    this._actor.send({ type: 'PAUSE' });
  }

  togglePlayPause(): void {
    if (this._actor.getSnapshot().value === 'playing') {
      this.pause();
    } else {
      this.play();
    }
  }

  next(): void {
    const cur = this._currentTrack;
    if (!cur || this._nextOf(cur) === null) return;

    this._actor.send({ type: 'NEXT' });
  }

  previous(): void {
    const ct = this._currentTrack;
    if (ct && ct.currentTime > 8) {
      this._actor.send({ type: 'SEEK', time: 0 });
      return;
    }

    this._actor.send({ type: 'PREVIOUS' });
  }

  gotoTrack(index: number, playImmediately = false, startTime?: number): void {
    const track = this._tracks[index];
    if (!track) return;
    this.onDebug(
      `gotoTrack(${index} = ${track.key}, playImmediately=${playImmediately}, startTime=${startTime}) queueState=${this._actor.getSnapshot().value} current=${this.currentKey}`
    );
    this._actor.send({ type: 'GOTO', track, playImmediately, startTime });
  }

  seek(time: number): void {
    this._actor.send({ type: 'SEEK', time });
  }

  setVolume(volume: number): void {
    const clamped = Math.min(1, Math.max(0, volume));
    this._volume = clamped;
    for (const track of this._tracks) track.setVolume(clamped);
  }

  setPlaybackRate(rate: number): void {
    const clamped = Math.min(4, Math.max(0.25, rate));
    this._playbackRate = clamped;
    const cur = this._currentTrack;
    cur?.setPlaybackRate(clamped);
    // Mid-fade, both tracks are audible: rescheduling would restart the
    // incoming one and snap the outgoing one back to full level. Run both at
    // the new rate instead and re-aim the fades at the new end time.
    const next = this._scheduledNext;
    const was = this._scheduledFor;
    const ctx = getAudioContext();
    if (cur && next && was && ctx && was.want > 0 && was.start <= ctx.currentTime) {
      next.setPlaybackRate(clamped);
      const end = this._computeTrackEndTime(cur);
      if (end !== null) {
        cur.retimeFade(0, end);
        next.retimeFade(1, end);
        this._scheduledFor = { ...was, endTime: end };
        return;
      }
    }
    this._cancelScheduledGapless();
    if (this.isPlaying) this._tryScheduleGapless(cur);
  }

  addTrack(url: string, options: AddTrackOptions = {}): void {
    if (options.key !== undefined) this._assertUniqueKeys([options.key], true);
    normalizeClip(options.start, options.end);
    assertCrossfade(options.crossfade);
    const metadata = options.metadata ?? ({} as TrackMetadata);
    const track = new Track({
      trackUrl: url,
      queue: this,
      key: options.key ?? this._newKey(),
      skipHEAD: options.skipHEAD,
      metadata,
      start: options.start,
      end: options.end,
      crossfade: options.crossfade,
    });
    this._tracks.push(track);
    this._orderVersion++;
    this._actor.send({ type: 'LIST_CHANGED', current: this._currentTrack ?? track });
    // Appending can change what plays next: on the last track it becomes the
    // new entry, and under repeat 'all' that replaces a scheduled wrap to 0.
    this._rescheduleIfNextChanged();
  }

  removeTrack(index: number): void {
    if (index < 0 || index >= this._tracks.length) return;
    const removed = this._tracks[index];
    // Cancel its transition first: that also undoes the outgoing fade.
    if (this._scheduledNext === removed) this._cancelScheduledGapless();
    removed.destroy();
    this._tracks.splice(index, 1);
    this._orderVersion++;
    // If it was current, the track that took its place plays next (or, if it
    // was last, the one before it).
    const successor = this._tracks[index] ?? this._tracks[index - 1] ?? null;
    this._actor.send({ type: 'REMOVE_TRACK', track: removed, successor });
  }

  // --------------------------------------------------------------------------
  // Key-based API
  // --------------------------------------------------------------------------

  /**
   * Replace the list, reconciling by key. Tracks whose key survives keep their
   * decoded buffers and in-flight preloads. If the current track's key
   * survives it keeps playing, untouched; otherwise playback moves to
   * `startKey` (or the first entry).
   *
   * A surviving key takes its entry's new `crossfade`. One whose source
   * changed (`url`, `start` or `end`) is rebuilt, except the playing entry,
   * which keeps playing what it was.
   */
  setEntries(
    entries: readonly Entry[],
    opts: { startKey?: string; startTime?: number; play?: boolean } = {}
  ): void {
    this._assertUniqueKeys(
      entries.map((e) => e.key),
      false
    );
    this._assertValidClips(entries);
    const byKey = new Map(this._tracks.map((t) => [t.key, t]));
    const cur = this._currentTrack;
    let fadeChanged = false;
    const next = entries.map((e) => {
      const old = byKey.get(e.key);
      if (!old || (old !== cur && !sameSource(old, e))) return this._createTrack(e);
      const fade = e.crossfade ?? null;
      if (fade !== old.crossfadeIn) {
        old.setCrossfadeIn(fade);
        fadeChanged = true;
      }
      return old;
    });
    const kept = new Set(next);

    if (cur && kept.has(cur)) {
      for (const t of this._tracks) if (!kept.has(t)) this._dropTrack(t);
      this._applyOrder(next);
      // A fade into the next entry changed: redo (or now try) its transition.
      if (fadeChanged && this.isPlaying) this._rescheduleGapless(cur);
      return;
    }

    // The current track is gone (or there wasn't one): rebuild around the new
    // start. Deactivate before dropping so the old track stops cleanly.
    this._cancelScheduledGapless();
    cur?.deactivate();
    for (const t of this._tracks) if (!kept.has(t)) this._dropTrack(t);
    this._tracks = next;
    this._orderVersion++;
    const start =
      (opts.startKey ? next.find((t) => t.key === opts.startKey) : undefined) ?? next[0] ?? null;
    const play = opts.play ?? this.isPlaying;
    this._actor.send({ type: 'LIST_CHANGED', current: start });
    if (!start) return;
    this._actor.send({
      type: 'GOTO',
      track: start,
      playImmediately: play,
      startTime: opts.startTime,
    });
  }

  /** Insert entries after a key, after the current entry, or at either end. */
  insert(entries: readonly Entry[], position: Position = { after: 'end' }): void {
    this._assertUniqueKeys(
      entries.map((e) => e.key),
      true
    );
    this._assertValidClips(entries);
    const at = this._insertionIndex(position);
    if (at === -1) return;
    const next = [...this._tracks];
    next.splice(at, 0, ...entries.map((e) => this._createTrack(e)));
    this._applyOrder(next);
  }

  /** Move an entry. Moving the current entry never interrupts it. */
  move(key: string, position: Position): void {
    const from = this._indexOfKey(key);
    if (from === -1 || position.after === key) return;
    const next = [...this._tracks];
    const [track] = next.splice(from, 1);
    const anchor = this._insertionIndexIn(next, position);
    if (anchor === -1) return;
    next.splice(anchor, 0, track);
    this._applyOrder(next);
  }

  /** Remove an entry by key. Removing the current entry advances. */
  remove(key: string): void {
    const i = this._indexOfKey(key);
    if (i !== -1) this.removeTrack(i);
  }

  /** Jump to an entry by key. */
  goto(key: string, opts: { play?: boolean; startTime?: number } = {}): void {
    const i = this._indexOfKey(key);
    if (i !== -1) this.gotoTrack(i, opts.play ?? false, opts.startTime);
  }

  /**
   * 'all' loops the whole list (gaplessly, across the wrap). 'one' restarts
   * the current entry when it ends; that restart is not sample-gapless.
   */
  setRepeat(mode: RepeatMode): void {
    if (mode === this._repeat) return;
    this._repeat = mode;
    this._rescheduleIfNextChanged();
    this._emitChange();
  }

  get repeat(): RepeatMode {
    return this._repeat;
  }

  /**
   * Default crossfade (seconds) between tracks, for entries that don't set
   * their own `crossfade`. 0 (the default) keeps transitions gapless.
   */
  setCrossfade(seconds: number): void {
    assertCrossfade(seconds);
    if (seconds === this._crossfade) return;
    this._crossfade = seconds;
    // A transition already scheduled was timed for the old length.
    const cur = this._currentTrack;
    if (!cur) return;
    if (this._scheduledNext && this._scheduledNext.crossfadeIn === null) {
      this._cancelScheduledGapless();
    }
    // With nothing scheduled (before or now) try: the lookahead may have
    // passed already, and a fade can start a transition a cut couldn't.
    if (this.isPlaying && !this._scheduledNext) this._tryScheduleGapless(cur);
  }

  get crossfade(): number {
    return this._crossfade;
  }

  /** A plain-data copy of the queue, for persisting and `restore()`. */
  snapshot(): QueueSnapshot {
    const cur = this._currentTrack;
    return {
      entries: this._tracks.map((t) => ({
        key: t.key,
        url: t.sourceUrl,
        metadata: t.metadata,
        ...(t.skipHEAD ? { skipHEAD: true } : {}),
        ...(t.clipStart > 0 ? { start: t.clipStart } : {}),
        ...(t.clipEnd !== null ? { end: t.clipEnd } : {}),
        ...(t.crossfadeIn !== null ? { crossfade: t.crossfadeIn } : {}),
      })),
      currentKey: cur?.key ?? null,
      currentTime: cur ? cur.currentTime : 0,
      repeat: this._repeat,
    };
  }

  /**
   * Rebuild the queue from a snapshot and move to its position. Meant for a
   * fresh or stopped queue (e.g. after a reload): unlike setEntries, it always
   * seeks to the snapshot's time, even if its current entry is already current.
   */
  restore(snapshot: QueueSnapshot, opts: { play?: boolean } = {}): void {
    this.setRepeat(snapshot.repeat);
    const play = opts.play ?? false;
    const current = this._currentTrack;
    const keptCurrent = !!current && snapshot.entries.some((e) => e.key === current.key);
    this.setEntries(snapshot.entries, {
      startKey: snapshot.currentKey ?? undefined,
      startTime: snapshot.currentTime || undefined,
      play,
    });
    // setEntries keeps a surviving current track where it is, ignoring
    // startKey and startTime; restore always moves to the saved position.
    if (keptCurrent && snapshot.currentKey) {
      this.goto(snapshot.currentKey, { play, startTime: snapshot.currentTime });
    }
  }

  /**
   * Listen for changes to the order, the current entry or the repeat mode.
   * Not called for progress, play/pause or seeks. Called in a microtask after
   * the edit, once per edit, with the final state. Returns an unsubscribe function.
   */
  onChange(listener: (change: QueueChange) => void): () => void {
    // Nothing is tracked while nobody listens, so the first listener sets the
    // baseline: it hears about changes from now on, not about the past.
    if (this._changeListeners.size === 0) {
      this._lastChange = {
        version: this._orderVersion,
        currentKey: this.currentKey,
        repeat: this._repeat,
      };
    }
    this._changeListeners.add(listener);
    return () => this._changeListeners.delete(listener);
  }

  get keys(): string[] {
    return this._tracks.map((t) => t.key);
  }

  get currentKey(): string | null {
    return this._currentTrack?.key ?? null;
  }

  resumeAudioContext(): Promise<void> {
    return _resumeAudioContext();
  }

  destroy(): void {
    if (this._retryTimer !== null) clearTimeout(this._retryTimer);
    this._retryTimer = null;
    this._stopMediaSessionAnchor();
    this._mediaSessionAnchor = null;
    for (const track of this._tracks) track.destroy();
    this._tracks = [];
    this._actor.stop();
    this._changeListeners.clear();
  }

  // --------------------------------------------------------------------------
  // Getters
  // --------------------------------------------------------------------------

  get currentTrack(): TrackInfo | undefined {
    return this._currentTrack?.toInfo();
  }

  /** Position of the current track in play order (0 when the queue is empty). */
  get currentTrackIndex(): number {
    const cur = this._currentTrack;
    return cur ? Math.max(0, this._tracks.indexOf(cur)) : 0;
  }

  get tracks(): readonly TrackInfo[] {
    return this._tracks.map((t) => t.toInfo());
  }

  get isPlaying(): boolean {
    return this._actor.getSnapshot().value === 'playing';
  }

  get isPaused(): boolean {
    return this._actor.getSnapshot().value === 'paused';
  }

  get volume(): number {
    return this._volume;
  }

  get preloadNumTracks(): number {
    return this._preloadNumTracks;
  }

  set preloadNumTracks(value: number) {
    this._preloadNumTracks = Math.max(0, value);
    if (this.isPlaying) {
      this._preloadAhead(this._currentTrack);
    } else {
      this._unloadOutsideWindow(this._currentTrack);
    }
  }

  get playbackRate(): number {
    return this._playbackRate;
  }

  /** The queue machine's state name, with positions derived for debugging. */
  get queueSnapshot(): {
    state: string;
    context: { currentTrackIndex: number; trackCount: number; currentKey: string | null };
  } {
    const snap = this._actor.getSnapshot();
    return {
      state: snap.value as string,
      context: {
        currentTrackIndex: this.currentTrackIndex,
        trackCount: this._tracks.length,
        currentKey: this.currentKey,
      },
    };
  }

  // --------------------------------------------------------------------------
  // TrackQueueRef — called by Track instances
  // --------------------------------------------------------------------------

  onTrackEnded(track: Track): void {
    const snap = this._actor.getSnapshot();
    this.onDebug(
      `onTrackEnded track=${track.key} queueState=${snap.value} current=${this.currentKey}`
    );
    if (track !== snap.context.current) {
      // An incoming track can end before its handoff; remember it for then.
      if (track === this._scheduledNext) this._scheduledEndedEarly = track;
      return;
    }

    this._actor.send({ type: 'TRACK_ENDED' });
    this.onDebug(
      `onTrackEnded after TRACK_ENDED → queueState=${this._actor.getSnapshot().value} current=${this.currentKey}`
    );
  }

  onTrackBufferReady(track: Track): void {
    if (!this._owns(track)) return;
    this._actor.send({ type: 'TRACK_LOADED', track });
  }

  onProgress(track: Track, info: TrackInfo): void {
    if (track !== this._currentTrack) return;
    if (!isNaN(info.duration)) {
      this._throttledUpdatePositionState(info.duration, info.currentTime, this._playbackRate);
    }
    this._onProgress?.(info);
  }

  onError(error: Error): void {
    this._onError?.(error);
  }

  onPlayBlocked(): void {
    this._actor.send({ type: 'PAUSE' });
    this._onPlayBlocked?.();
  }

  onPreloadReady(track: Track): void {
    if (track !== this._currentTrack) return;
    this._preloadAhead(track);
  }

  indexOf(track: Track): number {
    return this._tracks.indexOf(track);
  }

  crossfadeAfter(track: Track): number {
    const next = this._scheduleTargetOf(track);
    return next ? (next.crossfadeIn ?? this._crossfade) : 0;
  }

  onDebug(msg: string): void {
    this._onDebug?.(msg);
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /**
   * Rearrange the play order without changing which track is current. Every
   * key-based edit that keeps the current track goes through here.
   */
  private _applyOrder(next: Track[]): void {
    const cur = this._currentTrack ?? null;
    const prevNext = cur ? this._nextOf(cur) : null;
    this._tracks = next;
    this._orderVersion++;
    if (cur && !next.includes(cur)) throw new Error('_applyOrder: current track was dropped');
    const current = cur ?? next[0] ?? null;

    const newNext = current ? this._nextOf(current) : null;
    const nextChanged = newNext !== prevNext;
    if (nextChanged) this._cancelScheduledGapless();

    this._actor.send({ type: 'LIST_CHANGED', current });
    this.onDebug(
      `_applyOrder: ${next.length} tracks, current=${current?.key ?? null} nextChanged=${nextChanged}`
    );

    if (nextChanged && this.isPlaying) {
      this._preloadAhead(current);
      this._tryScheduleGapless(current);
    } else {
      // "Next" is unchanged, but a move can still push a loading or loaded
      // track out of the window.
      this._unloadOutsideWindow(current);
    }
  }

  /**
   * The track that plays after `track`: the next one, wrapping to the first
   * under repeat 'all', or null at the end. Repeat 'one' is ignored here —
   * skipping still moves on, and preloading still looks ahead. The one answer
   * to "what plays next", for the machine, preloading and scheduling.
   */
  private _nextOf(track: Track): Track | null {
    const i = this._tracks.indexOf(track);
    if (i === -1) return null;
    if (i + 1 < this._tracks.length) return this._tracks[i + 1];
    if (this._repeat === 'all' && this._tracks.length > 1) return this._tracks[0];
    return null;
  }

  /** The track whose gapless start can be scheduled after `track`, or null. */
  private _scheduleTargetOf(track: Track): Track | null {
    // Repeat 'one' restarts the same Track, which can't be scheduled against
    // itself; the restart is handled by the machine instead.
    if (this._repeat === 'one') return null;
    return this._nextOf(track);
  }

  /** After a change to what follows the current track: drop a stale schedule, look ahead again. */
  private _rescheduleIfNextChanged(): void {
    const cur = this._currentTrack;
    const target = cur ? this._scheduleTargetOf(cur) : null;
    if (this._scheduledNext && this._scheduledNext !== target) this._cancelScheduledGapless();
    if (this.isPlaying) {
      this._preloadAhead(cur);
      this._tryScheduleGapless(cur);
    } else {
      this._unloadOutsideWindow(cur);
    }
  }

  /**
   * Change events are batched into a microtask: an edit that takes several
   * machine transitions reports once, with its final state, and listeners can
   * edit the queue without re-entering a transition in progress.
   */
  private _emitChange(): void {
    if (this._changeListeners.size === 0 || this._changePending) return;
    this._changePending = true;
    queueMicrotask(() => {
      this._changePending = false;
      this._flushChange();
    });
  }

  private _flushChange(): void {
    if (this._changeListeners.size === 0) return;
    const currentKey = this.currentKey;
    const last = this._lastChange;
    if (
      last &&
      last.version === this._orderVersion &&
      last.currentKey === currentKey &&
      last.repeat === this._repeat
    )
      return;
    this._lastChange = { version: this._orderVersion, currentKey, repeat: this._repeat };
    const change: QueueChange = { keys: this.keys, currentKey, repeat: this._repeat };
    for (const listener of this._changeListeners) listener(change);
  }

  private _createTrack(e: Entry): Track {
    return new Track({
      trackUrl: e.url,
      queue: this,
      key: e.key,
      skipHEAD: e.skipHEAD,
      metadata: e.metadata ?? {},
      start: e.start,
      end: e.end,
      crossfade: e.crossfade,
    });
  }

  private _dropTrack(t: Track): void {
    if (this._scheduledNext === t) this._cancelScheduledGapless();
    t.destroy();
  }

  /** True if the track is still in this queue (callbacks from dropped tracks are ignored). */
  private _owns(track: Track): boolean {
    return this._tracks.includes(track);
  }

  /**
   * A key that isn't in the queue. Keys restored from a snapshot may look like
   * generated ones (the counter starts over on reload), so skip any in use.
   */
  private _newKey(): string {
    const used = new Set(this._tracks.map((t) => t.key));
    let key: string;
    do key = `gapless-${++this._keySeq}`;
    while (used.has(key));
    return key;
  }

  /**
   * Throws on a key repeated in `keys`, or (with `againstQueue`) already in
   * the queue. Checked before any change, so a rejected edit leaves the queue
   * as it was.
   */
  /** Throws on a bad clip range before any track is created, so a failed edit changes nothing. */
  private _assertValidClips(entries: readonly Entry[]): void {
    for (const e of entries) {
      normalizeClip(e.start, e.end);
      assertCrossfade(e.crossfade);
    }
  }

  private _assertUniqueKeys(keys: readonly string[], againstQueue: boolean): void {
    const seen = new Set(againstQueue ? this._tracks.map((t) => t.key) : []);
    for (const key of keys) {
      if (seen.has(key)) throw new Error(`gapless: duplicate key "${key}"`);
      seen.add(key);
    }
  }

  private _indexOfKey(key: string): number {
    return this._tracks.findIndex((t) => t.key === key);
  }

  private _insertionIndex(position: Position): number {
    return this._insertionIndexIn(this._tracks, position);
  }

  private _insertionIndexIn(list: readonly Track[], { after }: Position): number {
    if (after === 'start') return 0;
    if (after === 'end') return list.length;
    const anchor = after === 'current' ? this._currentTrack : list.find((t) => t.key === after);
    if (!anchor) return after === 'current' && list.length === 0 ? 0 : -1;
    const i = list.indexOf(anchor);
    return i === -1 ? -1 : i + 1;
  }

  private get _currentTrack(): Track | undefined {
    return this._actor.getSnapshot().context.current ?? undefined;
  }

  /** The current track and the next preloadNumTracks in play order. */
  private _preloadWindow(from: Track): Track[] {
    const window = [from];
    for (
      let step = 1, t = this._nextOf(from);
      step <= this._preloadNumTracks && t !== null && t !== from;
      step++, t = this._nextOf(t)
    ) {
      window.push(t);
    }
    return window;
  }

  /**
   * Unload tracks that are no longer in the preload window (the current track
   * plus the next preloadNumTracks in play order): abort their downloads, so
   * they don't compete with the tracks about to play, and release their
   * decoded audio, which is large. They load again if they come back.
   */
  private _unloadOutsideWindow(from: Track | null | undefined): void {
    const window = new Set(from ? this._preloadWindow(from) : []);
    for (const t of this._tracks) if (!window.has(t)) t.unload();
  }

  private _preloadAhead(from: Track | null | undefined): void {
    this._unloadOutsideWindow(from);
    if (!from) return;
    const cur = from;

    // Bandwidth-contention gate: while the current track is playing via HTML5
    // and its own Web Audio buffer is still being fetched+decoded, holding
    // off on every next-track preload prevents two concurrent large MP3
    // downloads from delaying the current track's crossover (and therefore
    // the moment from which all future gapless transitions are
    // sample-accurate). When the current track's BUFFER_READY fires,
    // notifyBufferReady → TRACK_LOADED → preloadAhead re-runs, this gate
    // is no longer engaged, and next-track fetches proceed sequentially
    // as buffers complete.
    //
    // This lives here (not in the queue machine) because preloadAhead is
    // invoked as a transition action from ~7 different events, and the
    // gate's data source — the current track's machine state — isn't
    // owned by the queue machine. Pushing the check into every caller
    // would just duplicate the same read.
    if (cur.isPlaying && cur.playbackType === 'HTML5' && cur.webAudioLoadingState === 'LOADING') {
      this.onDebug(`_preloadAhead(${cur.key}): deferring all — current track buffer still loading`);
      return;
    }

    // Speculative-load throttle: the immediate next track is always allowed
    // (it must be ready for gapless scheduling), but tracks beyond that are
    // deferred until the current track has played past min(duration*0.2, 15s)
    // — the point at which we have evidence the user is committing to
    // listening, not skipping.
    const curBelowThreshold =
      cur.isPlaying &&
      cur.currentTime < (isNaN(cur.duration) ? 15 : Math.min(cur.duration * 0.2, 15));

    this.onDebug(
      `_preloadAhead(${cur.key}) ahead=${this._preloadNumTracks} trackCount=${this._tracks.length} belowThreshold=${curBelowThreshold}`
    );
    // Walk forward in play order (wrapping under repeat 'all'), never past
    // the current track. One download at a time.
    const ahead = this._preloadWindow(cur).slice(1);
    for (let step = 1; step <= ahead.length; step++) {
      const t = ahead[step - 1];
      if (step > 1 && curBelowThreshold) {
        this.onDebug(
          `_preloadAhead: deferring track ${t.key} (current at ${cur.currentTime.toFixed(1)}s, below threshold)`
        );
        return;
      }
      if (!t.isBufferLoaded) {
        this.onDebug(`_preloadAhead: starting preload for track ${t.key}`);
        t.preload();
        return;
      } else {
        this.onDebug(`_preloadAhead: track ${t.key} already loaded`);
      }
    }
  }

  private _cancelScheduledGapless(): void {
    const track = this._scheduledNext;
    if (track === null) return;
    track.cancelGaplessStart();
    this.onDebug(`_cancelScheduledGapless: cancelled track ${track.key}`);
    // Cancel any HTML5 gain mute that was scheduled on the current track,
    // but only if it's still in HTML5 state. After crossover the gain node
    // is managed by the crossfade ramp — cancelScheduledValues would wipe it.
    const cur = this._currentTrack;
    if (cur && cur.playbackType === 'HTML5') cur.cancelHtml5Mute();
    // A crossfade's fade-out on the current track goes with it.
    cur?.cancelFadeOut();
    this._scheduledNext = null;
    this._scheduledFor = null;
    this._scheduledEndedEarly = null;
  }

  /**
   * Cancel and redo the scheduled transition, unless redoing it would give the
   * same one: same next track, same end time, same backend, same fade. A
   * redundant reschedule isn't harmless mid-crossfade: the incoming track
   * is already playing, and cancelling restarts it from its beginning.
   */
  private _rescheduleGapless(current: Track | null | undefined, force = false): void {
    const next = this._scheduledNext;
    const was = this._scheduledFor;
    if (!force && current && next && was && next === this._scheduleTargetOf(current)) {
      const endTime = this._computeTrackEndTime(current);
      const sameFade = (next.crossfadeIn ?? this._crossfade) === was.want;
      const unchanged =
        endTime !== null &&
        Math.abs(endTime - was.endTime) < 0.002 &&
        current.playbackType === was.type;
      // A fade under way survives the end time firming up (a streaming track
      // crossing over to Web Audio, an HTML5 estimate drifting): restarting
      // the incoming track would be far worse than a fade a little off. A
      // seek moves the end time much further and still reschedules.
      const ctx = getAudioContext();
      const fading = !!ctx && was.want > 0 && was.start <= ctx.currentTime;
      const close = endTime !== null && Math.abs(endTime - was.endTime) < FADE_DRIFT_SEC;
      if (sameFade && (unchanged || (fading && close))) {
        this.onDebug(`_rescheduleGapless: ${next.key} unchanged, keeping its schedule`);
        return;
      }
    }
    this._cancelScheduledGapless();
    this._tryScheduleGapless(current);
  }

  private _tryScheduleGapless(current: Track | null | undefined): void {
    const ctx = getAudioContext();
    if (!ctx || this.playbackMethod === 'HTML5_ONLY' || !current) return;

    const next = this._scheduleTargetOf(current);
    if (!next || this._scheduledNext === next || !current.isPlaying) return;

    // A crossfade doesn't need sample accuracy, so either side may still be
    // streaming over HTML5 (see _crossfadeWindow). A gapless start does:
    // both tracks must be decoded.
    const want = next.crossfadeIn ?? this._crossfade;
    const mayFade = want > 0 && this._canFadeOut(current);
    if (!mayFade && (!current.isBufferLoaded || !next.isBufferLoaded)) return;

    const endTime = this._computeTrackEndTime(current);
    if (endTime === null) return;

    if (endTime < ctx.currentTime + 0.01) return;

    // Wait until the transition is near when either side is on HTML5: an
    // HTML5 end time is a prediction that drifts, and an incoming track not
    // decoded yet would start streaming from a long timer (and compete with
    // its own decode, which may well finish meanwhile and do better).
    const timeUntilEnd = endTime - ctx.currentTime;
    // Wall-clock seconds, as the track's lookahead is (see Track); the slack
    // absorbs rounding and estimate jitter at the boundary.
    const horizon = MAX_SCHEDULE_LOOKAHEAD + (mayFade ? want : 0) + HORIZON_SLACK_SEC;
    const nearOnly = current.playbackType === 'HTML5' || !next.isBufferLoaded;
    if (nearOnly && timeUntilEnd > horizon) {
      this.onDebug(
        `_tryScheduleGapless: deferring — ${current.key} has ${timeUntilEnd.toFixed(1)}s remaining (max lookahead=${horizon}s)`
      );
      // The track's lookahead notice may already be spent (a fade shortened
      // after it, say), so come back when the transition is near.
      this._retryScheduleIn(timeUntilEnd - horizon + 0.1, current);
      return;
    }

    const win = mayFade
      ? this._crossfadeWindow(current, next, endTime, ctx.currentTime)
      : { start: endTime, fade: 0 };
    const { start, fade } = win;
    if (fade === 0 && (!current.isBufferLoaded || !next.isBufferLoaded)) return;

    // Decoded: start sample-accurately on the AudioContext clock. Not yet
    // (only when fading): stream it in over HTML5 from a timer.
    const how = next.isBufferLoaded ? 'webaudio' : 'html5';
    const ok =
      how === 'webaudio'
        ? next.scheduleGaplessStart(start, fade)
        : next.scheduleHtml5Start(start, fade);
    if (!ok) {
      this.onDebug(
        `_tryScheduleGapless: track ${next.key} rejected a ${how} start (state=${next.machineState})`
      );
      return;
    }
    if (fade > 0) {
      current.scheduleFadeOut(start, fade);
    } else if (current.playbackType === 'HTML5') {
      // Scheduling from an HTML5-clock prediction: mute the HTML5 gain at
      // endTime so a stalled/late element is silenced rather than
      // overlapping the next track.
      current.scheduleHtml5Mute(endTime);
    }
    this.onDebug(
      `_tryScheduleGapless: scheduled track ${next.key} (${how}) at ${start.toFixed(3)} endTime=${endTime.toFixed(3)} (in ${(start - ctx.currentTime).toFixed(1)}s) crossfade=${fade.toFixed(2)}s curPlaybackType=${current.playbackType}`
    );
    this._scheduledNext = next;
    this._scheduledFor = { endTime, start, type: current.playbackType, want };
  }

  private _retryScheduleIn(seconds: number, current: Track): void {
    if (this._retryTimer !== null) clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      if (this._currentTrack === current && this.isPlaying && !this._scheduledNext) {
        this._tryScheduleGapless(current);
      }
    }, seconds * 1000);
  }

  /** Whether `track` can fade out: on Web Audio, or streaming through the AudioContext. */
  private _canFadeOut(track: Track): boolean {
    return track.playbackType === 'WEBAUDIO' || track.canFadeHtml5;
  }

  /**
   * When `next` starts and how long it fades in, for a transition ending at
   * `endTime`: `fade` seconds early, cut to fit both tracks (where their
   * length is known) and the time left, and dropped (a gapless start at
   * endTime) when too little is left.
   */
  private _crossfadeWindow(
    current: Track,
    next: Track,
    endTime: number,
    now: number
  ): { start: number; fade: number } {
    const gapless = { start: endTime, fade: 0 };
    const want = next.crossfadeIn ?? this._crossfade;
    if (want <= 0 || !this._canFadeOut(current)) return gapless;
    const rate = this._playbackRate;
    // At most half of the incoming entry overlaps, so it still plays after
    // the handoff (one that ended first would leave the queue nothing to play).
    const lengths = [current.duration, next.duration / 2].filter((d) => isFinite(d));
    const fit = Math.min(want, ...lengths.map((d) => d / rate));
    const start = Math.max(endTime - fit, now + CROSSFADE_LEAD_SEC);
    const fade = endTime - start;
    return fade >= MIN_CROSSFADE_SEC ? { start, fade } : gapless;
  }

  private _computeTrackEndTime(track: Track): number | null {
    const ctx = getAudioContext();
    if (!ctx) return null;

    // Web Audio playback: derive the end time from the source node's live
    // playback anchor. For an uninterrupted gapless chain this equals
    // scheduledStart + duration exactly, but unlike that formula it remains
    // correct after a pause/resume re-anchors the source at a later context
    // time. (Using the stale scheduled start here is how the next track got
    // scheduled mid-track, with both tracks audible simultaneously.)
    const anchoredEnd = track.playbackEndContextTime;
    if (anchoredEnd !== null) {
      return anchoredEnd > ctx.currentTime ? anchoredEnd : null;
    }

    const duration = track.duration;
    if (isNaN(duration)) return null;
    const remaining = (duration - track.currentTime) / this._playbackRate;
    if (remaining <= 0) return null;
    return ctx.currentTime + remaining;
  }

  private _startMediaSessionAnchor(): void {
    if (typeof Audio === 'undefined') return;
    if (!this._mediaSessionAnchor) {
      this._mediaSessionAnchor = new Audio(getSilentWavUrl());
      this._mediaSessionAnchor.loop = true;
      // Volume stays at default (1) — Chrome/Safari may ignore a zero-volume
      // element for media focus. The WAV content is already silence.
    }
    if (this._mediaSessionAnchor.paused) {
      this._mediaSessionAnchor.play().catch(() => {});
    }
  }

  private _stopMediaSessionAnchor(): void {
    if (this._mediaSessionAnchor && !this._mediaSessionAnchor.paused) {
      this._mediaSessionAnchor.pause();
    }
  }
}
