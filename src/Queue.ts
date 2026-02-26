// ---------------------------------------------------------------------------
// Queue — public API class; orchestrates tracks via QueueMachine
// ---------------------------------------------------------------------------

import { createActor } from 'xstate';
import { getAudioContext, resumeAudioContext as _resumeAudioContext } from './utils/audioContext';
import {
  setupMediaSession,
  updateMediaSessionMetadata,
  updateMediaSessionPlaybackState,
} from './utils/mediaSession';
import { createQueueMachine } from './machines/queue.machine';
import { Track } from './Track';
import type { TrackQueueRef } from './Track';
import type { GaplessOptions, AddTrackOptions, TrackInfo, TrackMetadata } from './types';

/** Maximum number of tracks to preload ahead of the current track. */
const PRELOAD_AHEAD = 2;

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

  readonly webAudioIsDisabled: boolean;

  private _volume: number;

  /** Track indices for which a gapless start has been pre-scheduled. */
  private _scheduledIndices = new Set<number>();

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
      webAudioIsDisabled = false,
      trackMetadata = [],
      volume: initialVolume = 1,
    } = options;

    this._volume = Math.min(1, Math.max(0, initialVolume));
    this.webAudioIsDisabled = webAudioIsDisabled;
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

    this._actor = createActor(
      createQueueMachine({
        currentTrackIndex: 0,
        trackCount: this._tracks.length,
      })
    );

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
    const ct = this._currentTrack;
    if (!ct) return;
    ct.play();
    this._actor.send({ type: 'PLAY' });
    updateMediaSessionMetadata(ct.metadata);
    this._preloadAhead(ct.index);
    this._tryScheduleGapless(ct);
  }

  pause(): void {
    this._actor.send({ type: 'PAUSE' });
    this._cancelScheduledGapless();
    this._currentTrack?.pause();
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

    this._deactivateCurrent();
    this._cancelAllScheduledGapless();
    this._actor.send({ type: 'NEXT' });
    this._activateCurrent(true);

    const cur = this._currentTrack;
    if (cur) {
      this._onStartNewTrack?.(cur.toInfo());
      this._onPlayNextTrack?.(cur.toInfo());
      updateMediaSessionMetadata(cur.metadata);
    }
    this._preloadAhead(this._actor.getSnapshot().context.currentTrackIndex);
  }

  previous(): void {
    const ct = this._currentTrack;
    if (ct && ct.currentTime > 8) {
      ct.seek(0);
      ct.play();
      return;
    }

    this._deactivateCurrent();
    this._cancelAllScheduledGapless();
    this._actor.send({ type: 'PREVIOUS' });
    this._activateCurrent(true);

    const cur = this._currentTrack;
    if (cur) {
      this._onStartNewTrack?.(cur.toInfo());
      this._onPlayPreviousTrack?.(cur.toInfo());
      updateMediaSessionMetadata(cur.metadata);
    }
  }

  gotoTrack(index: number, playImmediately = false): void {
    if (index < 0 || index >= this._tracks.length) return;
    const prevSnap = this._actor.getSnapshot();
    this.onDebug(
      `gotoTrack(${index}, playImmediately=${playImmediately}) queueState=${prevSnap.value} curIdx=${prevSnap.context.currentTrackIndex}`
    );
    this._deactivateCurrent();
    this._cancelAllScheduledGapless();
    this._actor.send({ type: 'GOTO', index, playImmediately });
    const afterSnap = this._actor.getSnapshot();
    this.onDebug(
      `gotoTrack after GOTO → queueState=${afterSnap.value} curIdx=${afterSnap.context.currentTrackIndex}`
    );

    if (playImmediately) {
      this._activateCurrent(true);
      const cur = this._currentTrack;
      if (cur) {
        this.onDebug(
          `gotoTrack activateCurrent done, track=${cur.index} trackState=${cur.playbackType} isPlaying=${cur.isPlaying}`
        );
        this._onStartNewTrack?.(cur.toInfo());
        updateMediaSessionMetadata(cur.metadata);
      }
      this._preloadAhead(index);
    } else {
      this._currentTrack?.seek(0);
    }
  }

  seek(time: number): void {
    this._currentTrack?.seek(time);
    this._cancelAndRescheduleGapless();
  }

  setVolume(volume: number): void {
    const clamped = Math.min(1, Math.max(0, volume));
    this._volume = clamped;
    for (const track of this._tracks) track.setVolume(clamped);
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
    this._scheduledIndices.delete(index);
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
    if (track.index !== snap.context.currentTrackIndex) return;

    this._actor.send({ type: 'TRACK_ENDED' });
    const newSnap = this._actor.getSnapshot();
    this.onDebug(
      `onTrackEnded after TRACK_ENDED → queueState=${newSnap.value} curIdx=${newSnap.context.currentTrackIndex}`
    );

    if (newSnap.value === 'ended') {
      this._onEnded?.();
      return;
    }

    if (newSnap.value === 'playing') {
      const cur = this._currentTrack;
      if (cur) {
        if (!this._scheduledIndices.has(cur.index)) {
          cur.play();
        } else {
          this.onDebug(
            `onTrackEnded: gapless track ${cur.index} — sourceNode=${cur.hasSourceNode} isPlaying=${cur.isPlaying} machineState=${cur.machineState}`
          );
          cur.startProgressLoop();
        }
        this._onStartNewTrack?.(cur.toInfo());
        this._onPlayNextTrack?.(cur.toInfo());
        updateMediaSessionMetadata(cur.metadata);
        this._preloadAhead(cur.index);
      }
    }

    if (newSnap.value === 'paused') {
      const cur = this._currentTrack;
      if (cur) {
        this._onStartNewTrack?.(cur.toInfo());
        updateMediaSessionMetadata(cur.metadata);
      }
    }
  }

  onTrackBufferReady(track: Track): void {
    this._actor.send({ type: 'TRACK_LOADED', index: track.index });
    this._tryScheduleGapless(track);
    this._preloadAhead(this._actor.getSnapshot().context.currentTrackIndex);
  }

  onProgress(info: TrackInfo): void {
    if (info.index !== this._actor.getSnapshot().context.currentTrackIndex) return;
    this._onProgress?.(info);
  }

  onError(error: Error): void {
    this._onError?.(error);
  }

  onPlayBlocked(): void {
    this._onPlayBlocked?.();
  }

  onDebug(msg: string): void {
    this._onDebug?.(msg);
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private get _currentTrack(): Track | undefined {
    return this._tracks[this._actor.getSnapshot().context.currentTrackIndex];
  }

  private _deactivateCurrent(): void {
    this._currentTrack?.deactivate();
  }

  private _activateCurrent(startPlaying: boolean): void {
    const track = this._currentTrack;
    if (!track) return;
    track.activate();
    if (startPlaying && !this._scheduledIndices.has(track.index)) {
      track.play();
    }
  }

  private _preloadAhead(fromIndex: number): void {
    const limit = fromIndex + PRELOAD_AHEAD + 1;
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
    const curIndex = this._actor.getSnapshot().context.currentTrackIndex;
    const nextIndex = curIndex + 1;
    if (nextIndex < this._tracks.length && this._scheduledIndices.has(nextIndex)) {
      this._tracks[nextIndex].cancelGaplessStart();
      this._scheduledIndices.delete(nextIndex);
      this.onDebug(`_cancelScheduledGapless: cancelled track ${nextIndex}`);
    }
  }

  private _cancelAllScheduledGapless(): void {
    for (const idx of this._scheduledIndices) {
      this._tracks[idx]?.cancelGaplessStart();
    }
    this._scheduledIndices.clear();
  }

  private _cancelAndRescheduleGapless(): void {
    this._cancelScheduledGapless();
    const current = this._currentTrack;
    if (current) {
      this._tryScheduleGapless(current);
    }
  }

  private _tryScheduleGapless(_fromTrack: Track): void {
    const ctx = getAudioContext();
    if (!ctx || this.webAudioIsDisabled) return;

    const snap = this._actor.getSnapshot();
    const curIndex = snap.context.currentTrackIndex;
    const nextIndex = curIndex + 1;
    if (nextIndex >= this._tracks.length) return;

    const current = this._tracks[curIndex];
    const next = this._tracks[nextIndex];

    if (
      !current.isBufferLoaded ||
      !next.isBufferLoaded ||
      this._scheduledIndices.has(nextIndex) ||
      !current.isPlaying
    )
      return;

    const endTime = this._computeTrackEndTime(current);
    if (endTime === null) return;

    if (endTime < ctx.currentTime + 0.01) return;

    next.scheduleGaplessStart(endTime);
    this._scheduledIndices.add(nextIndex);
  }

  private _computeTrackEndTime(track: Track): number | null {
    const ctx = getAudioContext();
    if (!ctx || !track.isBufferLoaded) return null;
    const duration = track.duration;
    if (isNaN(duration)) return null;

    if (track.scheduledStartContextTime !== null) {
      return track.scheduledStartContextTime + duration;
    }

    const remaining = duration - track.currentTime;
    if (remaining <= 0) return null;
    return ctx.currentTime + remaining;
  }
}
