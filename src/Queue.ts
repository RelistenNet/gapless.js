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
import { Track } from './Track';
import type { TrackQueueRef } from './Track';
import { throttle } from './utils/throttle';
import type {
  GaplessOptions,
  AddTrackOptions,
  Entry,
  Position,
  TrackInfo,
  TrackMetadata,
  PlaybackMethod,
} from './types';

const MAX_SCHEDULE_LOOKAHEAD = 5;

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
  private _preloadNumTracks: number;
  private _playbackRate: number;

  /** Silent looping element that keeps the browser's MediaSession anchor alive. */
  private _mediaSessionAnchor: HTMLAudioElement | null = null;

  /**
   * The track with a pre-scheduled gapless start, or null. Held by reference,
   * not index, so reordering the queue can't make it point at another track.
   */
  private _scheduledNext: Track | null = null;

  /** @internal Index of the scheduled track (debugging and tests). */
  get _scheduledNextIndex(): number | null {
    return this._scheduledNext?.index ?? null;
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
    } = options;

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
          index: i,
          queue: this,
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
    const machine = createQueueMachine({
      currentTrackIndex: 0,
      trackCount: this._tracks.length,
    }).provide({
      actions: {
        deactivateCurrent: ({ context }) => {
          this._trackAt(context.currentTrackIndex)?.deactivate();
        },
        deactivateEndedTrack: ({ context }) => {
          this._trackAt(context.currentTrackIndex)?.deactivate();
        },
        activateCurrent: ({ context }) => {
          this._trackAt(context.currentTrackIndex)?.activate();
        },
        playOrContinueGapless: ({ context }) => {
          const cur = this._trackAt(context.currentTrackIndex);
          if (!cur) return;
          if (this._scheduledNext !== cur) {
            cur.play();
          } else {
            this._scheduledNext = null;
            this.onDebug(
              `onTrackEnded: gapless track ${cur.index} — sourceNode=${cur.hasSourceNode} isPlaying=${cur.isPlaying} machineState=${cur.machineState}`
            );
            cur.startProgressLoop();
          }
        },
        cancelAllGapless: () => this._cancelScheduledGapless(),
        notifyStartNewTrack: ({ context }) => {
          const cur = this._trackAt(context.currentTrackIndex);
          if (cur) this._onStartNewTrack?.(cur.toInfo());
        },
        notifyPlayNextTrack: ({ context }) => {
          const cur = this._trackAt(context.currentTrackIndex);
          if (cur) this._onPlayNextTrack?.(cur.toInfo());
        },
        notifyPlayPreviousTrack: ({ context }) => {
          const cur = this._trackAt(context.currentTrackIndex);
          if (cur) this._onPlayPreviousTrack?.(cur.toInfo());
        },
        notifyEnded: () => this._onEnded?.(),
        updateMediaSessionMetadata: ({ context }) => {
          const cur = this._trackAt(context.currentTrackIndex);
          if (cur) updateMediaSessionMetadata(cur.metadata);
        },
        preloadAhead: ({ context }) => {
          this._preloadAhead(context.currentTrackIndex);
        },
        playCurrent: ({ context }) => {
          this._trackAt(context.currentTrackIndex)?.play();
        },
        pauseCurrent: ({ context }) => {
          this._trackAt(context.currentTrackIndex)?.pause();
        },
        seekCurrent: ({ context, event }) => {
          const e = event as { type: 'SEEK'; time: number };
          this._trackAt(context.currentTrackIndex)?.seek(e.time);
        },
        seekCurrentToStartTime: ({ context, event }) => {
          const e = event as { type: 'GOTO'; startTime?: number };
          this._trackAt(context.currentTrackIndex)?.seek(e.startTime ?? 0);
        },
        scheduleGapless: ({ context }) => {
          this._tryScheduleGapless(context.currentTrackIndex);
        },
        cancelScheduledGapless: () => {
          this._cancelScheduledGapless();
        },
        cancelAndRescheduleGapless: ({ context }) => {
          this._cancelScheduledGapless();
          this._tryScheduleGapless(context.currentTrackIndex);
        },
      },
    });

    this._actor = createActor(machine);

    let wasPlaying = false;
    this._actor.subscribe((snapshot) => {
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
    const snap = this._actor.getSnapshot();
    const nextIndex = snap.context.currentTrackIndex + 1;
    if (nextIndex >= this._tracks.length) return;

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
    if (index < 0 || index >= this._tracks.length) return;
    this.onDebug(
      `gotoTrack(${index}, playImmediately=${playImmediately}, startTime=${startTime}) queueState=${this._actor.getSnapshot().value} curIdx=${this._actor.getSnapshot().context.currentTrackIndex}`
    );
    this._actor.send({ type: 'GOTO', index, playImmediately, startTime });
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
    this._currentTrack?.setPlaybackRate(clamped);
    this._cancelScheduledGapless();
    const snap = this._actor.getSnapshot();
    if (snap.value === 'playing') {
      this._tryScheduleGapless(snap.context.currentTrackIndex);
    }
  }

  addTrack(url: string, options: AddTrackOptions = {}): void {
    const index = this._tracks.length;
    const metadata = options.metadata ?? ({} as TrackMetadata);
    this._tracks.push(
      new Track({
        trackUrl: url,
        index,
        queue: this,
        key: options.key,
        skipHEAD: options.skipHEAD,
        metadata,
      })
    );
    this._actor.send({ type: 'ADD_TRACK' });
  }

  removeTrack(index: number): void {
    if (index < 0 || index >= this._tracks.length) return;
    const removed = this._tracks[index];
    removed.destroy();
    this._tracks.splice(index, 1);
    for (let i = index; i < this._tracks.length; i++) this._tracks[i].index = i;
    if (this._scheduledNext === removed) this._scheduledNext = null;
    this._actor.send({ type: 'REMOVE_TRACK', index });
  }

  // --------------------------------------------------------------------------
  // Key-based API
  // --------------------------------------------------------------------------

  /**
   * Replace the list, reconciling by key. Tracks whose key survives keep their
   * decoded buffers and in-flight preloads. If the current track's key
   * survives it keeps playing, untouched; otherwise playback moves to
   * `startKey` (or the first entry).
   */
  setEntries(
    entries: readonly Entry[],
    opts: { startKey?: string; startTime?: number; play?: boolean } = {}
  ): void {
    const byKey = new Map(this._tracks.map((t) => [t.key, t]));
    const next = entries.map((e) => byKey.get(e.key) ?? this._createTrack(e));
    const kept = new Set(next);
    const cur = this._currentTrack;

    if (cur && kept.has(cur)) {
      for (const t of this._tracks) if (!kept.has(t)) this._dropTrack(t);
      this._applyOrder(next);
      return;
    }

    // The current track is gone (or there wasn't one): rebuild around the new
    // start. Deactivate before dropping so the old track stops cleanly.
    this._cancelScheduledGapless();
    cur?.deactivate();
    for (const t of this._tracks) if (!kept.has(t)) this._dropTrack(t);
    this._tracks = next;
    next.forEach((t, i) => (t.index = i));
    const startIndex = Math.max(0, opts.startKey ? this._indexOfKey(opts.startKey) : 0);
    this._actor.send({ type: 'SYNC', currentTrackIndex: 0, trackCount: next.length });
    if (next.length === 0) return;
    this._actor.send({
      type: 'GOTO',
      index: startIndex,
      playImmediately: opts.play ?? this.isPlaying,
      startTime: opts.startTime,
    });
  }

  /** Insert entries after a key, after the current entry, or at either end. */
  insert(entries: readonly Entry[], position: Position = { after: 'end' }): void {
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
    this._stopMediaSessionAnchor();
    this._mediaSessionAnchor = null;
    for (const track of this._tracks) track.destroy();
    this._tracks = [];
    this._actor.stop();
  }

  // --------------------------------------------------------------------------
  // Getters
  // --------------------------------------------------------------------------

  get currentTrack(): TrackInfo | undefined {
    return this._currentTrack?.toInfo();
  }

  get currentTrackIndex(): number {
    return this._actor.getSnapshot().context.currentTrackIndex;
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
    const snap = this._actor.getSnapshot();
    if (snap.value === 'playing') {
      this._preloadAhead(snap.context.currentTrackIndex);
    }
  }

  get playbackRate(): number {
    return this._playbackRate;
  }

  /** Snapshot of the queue state machine (state name + context). For debugging. */
  get queueSnapshot(): {
    state: string;
    context: { currentTrackIndex: number; trackCount: number };
  } {
    const snap = this._actor.getSnapshot();
    return { state: snap.value as string, context: snap.context };
  }

  // --------------------------------------------------------------------------
  // TrackQueueRef — called by Track instances
  // --------------------------------------------------------------------------

  onTrackEnded(track: Track): void {
    const snap = this._actor.getSnapshot();
    this.onDebug(
      `onTrackEnded track=${track.index} queueState=${snap.value} curIdx=${snap.context.currentTrackIndex}`
    );
    // Compare object identity, not just index — after removeTrack(), a
    // different track may occupy the same index as the ended track.
    if (track !== this._trackAt(snap.context.currentTrackIndex)) return;

    this._actor.send({ type: 'TRACK_ENDED' });
    const newSnap = this._actor.getSnapshot();
    this.onDebug(
      `onTrackEnded after TRACK_ENDED → queueState=${newSnap.value} curIdx=${newSnap.context.currentTrackIndex}`
    );
  }

  onTrackBufferReady(track: Track): void {
    if (!this._owns(track)) return;
    this._actor.send({ type: 'TRACK_LOADED', index: track.index });
  }

  onProgress(info: TrackInfo): void {
    if (info.index !== this._actor.getSnapshot().context.currentTrackIndex) return;
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
    if (!this._owns(track)) return;
    const snap = this._actor.getSnapshot();
    if (track.index !== snap.context.currentTrackIndex) return;
    this._preloadAhead(snap.context.currentTrackIndex);
  }

  onDebug(msg: string): void {
    this._onDebug?.(msg);
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /**
   * Rearrange the play order without changing which track is current. Every
   * key-based edit that keeps the current track goes through here; the
   * machine and the scheduler still think in indices, and this is the one
   * place that keeps them consistent.
   */
  private _applyOrder(next: Track[]): void {
    const cur = this._currentTrack;
    const prevNext = cur ? this._tracks[cur.index + 1] : undefined;
    this._tracks = next;
    next.forEach((t, i) => (t.index = i));
    const curIndex = cur ? next.indexOf(cur) : 0;
    if (curIndex === -1) throw new Error('_applyOrder: current track was dropped');

    const newNext = next[curIndex + 1];
    const nextChanged = newNext !== prevNext;
    if (nextChanged) this._cancelScheduledGapless();

    this._actor.send({ type: 'SYNC', currentTrackIndex: curIndex, trackCount: next.length });
    this.onDebug(
      `_applyOrder: ${next.length} tracks, current=${curIndex} nextChanged=${nextChanged}`
    );

    if (nextChanged && this.isPlaying) {
      this._preloadAhead(curIndex);
      this._tryScheduleGapless(curIndex);
    }
  }

  private _createTrack(e: Entry): Track {
    return new Track({
      trackUrl: e.url,
      index: -1,
      queue: this,
      key: e.key,
      skipHEAD: e.skipHEAD,
      metadata: e.metadata ?? {},
    });
  }

  private _dropTrack(t: Track): void {
    if (this._scheduledNext === t) this._cancelScheduledGapless();
    t.destroy();
    t.index = -1;
  }

  /** True if the track is still in this queue (callbacks from dropped tracks are ignored). */
  private _owns(track: Track): boolean {
    return this._tracks[track.index] === track;
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

  /** Look up a track by index — safe for use inside machine actions. */
  private _trackAt(index: number): Track | undefined {
    return this._tracks[index];
  }

  private get _currentTrack(): Track | undefined {
    return this._tracks[this._actor.getSnapshot().context.currentTrackIndex];
  }

  private _preloadAhead(fromIndex: number): void {
    const cur = this._trackAt(fromIndex);

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
    if (
      cur != null &&
      cur.isPlaying &&
      cur.playbackType === 'HTML5' &&
      cur.webAudioLoadingState === 'LOADING'
    ) {
      this.onDebug(
        `_preloadAhead(${fromIndex}): deferring all — current track buffer still loading`
      );
      return;
    }

    // Speculative-load throttle: the immediate next track is always allowed
    // (it must be ready for gapless scheduling), but tracks beyond that are
    // deferred until the current track has played past min(duration*0.2, 15s)
    // — the point at which we have evidence the user is committing to
    // listening, not skipping.
    const curBelowThreshold =
      cur != null &&
      cur.isPlaying &&
      cur.currentTime < (isNaN(cur.duration) ? 15 : Math.min(cur.duration * 0.2, 15));

    const limit = fromIndex + this._preloadNumTracks + 1;
    this.onDebug(
      `_preloadAhead(${fromIndex}) limit=${limit} trackCount=${this._tracks.length} belowThreshold=${curBelowThreshold}`
    );
    for (let i = fromIndex + 1; i < this._tracks.length && i < limit; i++) {
      const t = this._tracks[i];
      if (i > fromIndex + 1 && curBelowThreshold) {
        this.onDebug(
          `_preloadAhead: deferring track ${i} (current at ${cur.currentTime.toFixed(1)}s, below threshold)`
        );
        return;
      }
      if (!t.isBufferLoaded) {
        this.onDebug(`_preloadAhead: starting preload for track ${i}`);
        t.preload();
        return;
      } else {
        this.onDebug(`_preloadAhead: track ${i} already loaded`);
      }
    }
  }

  private _cancelScheduledGapless(): void {
    const track = this._scheduledNext;
    if (track === null) return;
    track.cancelGaplessStart();
    this.onDebug(`_cancelScheduledGapless: cancelled track ${track.index}`);
    // Cancel any HTML5 gain mute that was scheduled on the current track,
    // but only if it's still in HTML5 state. After crossover the gain node
    // is managed by the crossfade ramp — cancelScheduledValues would wipe it.
    const cur = this._trackAt(this._actor.getSnapshot().context.currentTrackIndex);
    if (cur && cur.playbackType === 'HTML5') cur.cancelHtml5Mute();
    this._scheduledNext = null;
  }

  private _tryScheduleGapless(curIndex: number): void {
    const ctx = getAudioContext();
    if (!ctx || this.playbackMethod === 'HTML5_ONLY') return;

    const nextIndex = curIndex + 1;
    if (nextIndex >= this._tracks.length) return;

    const current = this._tracks[curIndex];
    const next = this._tracks[nextIndex];

    if (
      !current.isBufferLoaded ||
      !next.isBufferLoaded ||
      this._scheduledNext === next ||
      !current.isPlaying
    )
      return;

    const endTime = this._computeTrackEndTime(current);
    if (endTime === null) return;

    if (endTime < ctx.currentTime + 0.01) return;

    const timeUntilEnd = endTime - ctx.currentTime;
    if (current.playbackType === 'HTML5' && timeUntilEnd > MAX_SCHEDULE_LOOKAHEAD) {
      this.onDebug(
        `_tryScheduleGapless: deferring — HTML5 track ${curIndex} has ${timeUntilEnd.toFixed(1)}s remaining (max lookahead=${MAX_SCHEDULE_LOOKAHEAD}s)`
      );
      return;
    }

    if (!next.scheduleGaplessStart(endTime)) {
      this.onDebug(
        `_tryScheduleGapless: track ${nextIndex} rejected SCHEDULE_GAPLESS (state=${next.machineState})`
      );
      return;
    }
    // When scheduling from an HTML5-clock prediction, mute the HTML5 gain
    // at endTime so a stalled/late HTML5 element is silenced rather than
    // overlapping the next track.
    if (current.playbackType === 'HTML5') {
      current.scheduleHtml5Mute(endTime);
    }
    this.onDebug(
      `_tryScheduleGapless: scheduled track ${nextIndex} at endTime=${endTime.toFixed(3)} (in ${(endTime - ctx.currentTime).toFixed(1)}s) curPlaybackType=${current.playbackType}`
    );
    this._scheduledNext = next;
  }

  private _computeTrackEndTime(track: Track): number | null {
    const ctx = getAudioContext();
    if (!ctx || !track.isBufferLoaded) return null;

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
