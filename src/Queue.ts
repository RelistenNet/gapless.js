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
import type { GaplessOptions, AddTrackOptions, TrackInfo, TrackMetadata, PlaybackMethod } from './types';

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

  /** Index of the next track with a pre-scheduled gapless start, or null. */
  private _scheduledNextIndex: number | null = null;

  private _throttledUpdatePositionState = throttle(
    (duration: number, currentTime: number, playbackRate: number) =>
      updateMediaSessionPositionState(duration, currentTime, playbackRate),
    1000,
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
      trackCount: this._tracks.length
    }).provide({
      actions: {
        deactivateCurrent: ({ context }) => {
          this._trackAt(context.currentTrackIndex)?.deactivate();
        },
        deactivateEndedTrack: ({ context }) => {
          this._trackAt(context.currentTrackIndex)?.deactivate();
        },
        activateAndPlayCurrent: ({ context }) => {
          const track = this._trackAt(context.currentTrackIndex);
          if (!track) return;
          track.activate();
          if (this._scheduledNextIndex !== track.index) {
            track.play();
          }
        },
        playOrContinueGapless: ({ context }) => {
          const cur = this._trackAt(context.currentTrackIndex);
          if (!cur) return;
          if (this._scheduledNextIndex !== cur.index) {
            cur.play();
          } else {
            this._scheduledNextIndex = null;
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
        seekCurrentToZero: ({ context }) => {
          this._trackAt(context.currentTrackIndex)?.seek(0);
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

    this._actor.subscribe((snapshot) => {
      updateMediaSessionPlaybackState(snapshot.value === 'playing');
    });

    this._actor.start();

    setupMediaSession({
      onPlay: () => this.play(),
      onPause: () => {
        if (this._actor.getSnapshot().value === 'playing') this.pause();
      },
      onNext: () => this.next(),
      onPrevious: () => this.previous(),
      onSeek: (t) => this.seek(t),
    });
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
      ct.seek(0);
      ct.play();
      return;
    }

    this._actor.send({ type: 'PREVIOUS' });
  }

  gotoTrack(index: number, playImmediately = false): void {
    if (index < 0 || index >= this._tracks.length) return;
    this.onDebug(
      `gotoTrack(${index}, playImmediately=${playImmediately}) queueState=${this._actor.getSnapshot().value} curIdx=${this._actor.getSnapshot().context.currentTrackIndex}`
    );
    this._actor.send({ type: 'GOTO', index, playImmediately });
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
        skipHEAD: options.skipHEAD,
        metadata,
      })
    );
    this._actor.send({ type: 'ADD_TRACK' });
  }

  removeTrack(index: number): void {
    if (index < 0 || index >= this._tracks.length) return;
    this._tracks[index].destroy();
    this._tracks.splice(index, 1);
    for (let i = index; i < this._tracks.length; i++) {
      (this._tracks[i] as unknown as { index: number }).index = i;
    }
    if (this._scheduledNextIndex === index) {
      this._scheduledNextIndex = null;
    } else if (this._scheduledNextIndex !== null && this._scheduledNextIndex > index) {
      this._scheduledNextIndex--;
    }
    this._actor.send({ type: 'REMOVE_TRACK', index });
  }

  resumeAudioContext(): Promise<void> {
    return _resumeAudioContext();
  }

  destroy(): void {
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
  get queueSnapshot(): { state: string; context: { currentTrackIndex: number; trackCount: number } } {
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

  /** Look up a track by index — safe for use inside machine actions. */
  private _trackAt(index: number): Track | undefined {
    return this._tracks[index];
  }

  private get _currentTrack(): Track | undefined {
    return this._tracks[this._actor.getSnapshot().context.currentTrackIndex];
  }

  private _preloadAhead(fromIndex: number): void {
    const cur = this._trackAt(fromIndex);
    if (cur && cur.playbackType === 'HTML5' && cur.isPlaying) {
      const threshold = isNaN(cur.duration) ? 15 : Math.min(cur.duration * 0.2, 15);
      if (cur.currentTime < threshold) {
        this.onDebug(`_preloadAhead: deferring — HTML5 track ${fromIndex} at ${cur.currentTime.toFixed(1)}s (threshold=${threshold.toFixed(1)}s)`);
        return;
      }
    }
    const limit = fromIndex + this._preloadNumTracks + 1;
    this.onDebug(`_preloadAhead(${fromIndex}) limit=${limit} trackCount=${this._tracks.length}`);
    for (let i = fromIndex + 1; i < this._tracks.length && i < limit; i++) {
      const t = this._tracks[i];
      if (!t.isBufferLoaded) {
        this.onDebug(`_preloadAhead: starting preload for track ${i}`);
        t.preload();
        break;
      } else {
        this.onDebug(`_preloadAhead: track ${i} already loaded`);
      }
    }
  }

  private _cancelScheduledGapless(): void {
    if (this._scheduledNextIndex === null) return;
    const track = this._trackAt(this._scheduledNextIndex);
    if (track) {
      track.cancelGaplessStart();
      this.onDebug(`_cancelScheduledGapless: cancelled track ${this._scheduledNextIndex}`);
    }
    this._scheduledNextIndex = null;
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
      this._scheduledNextIndex === nextIndex ||
      !current.isPlaying
    )
      return;

    const endTime = this._computeTrackEndTime(current);
    if (endTime === null) return;

    if (endTime < ctx.currentTime + 0.01) return;

    next.scheduleGaplessStart(endTime);
    this._scheduledNextIndex = nextIndex;
  }

  private _computeTrackEndTime(track: Track): number | null {
    const ctx = getAudioContext();
    if (!ctx || !track.isBufferLoaded) return null;
    const duration = track.duration;
    if (isNaN(duration)) return null;

    if (track.scheduledStartContextTime !== null) {
      return track.scheduledStartContextTime + duration / this._playbackRate;
    }

    const remaining = (duration - track.currentTime) / this._playbackRate;
    if (remaining <= 0) return null;
    return ctx.currentTime + remaining;
  }
}
