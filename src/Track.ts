// ---------------------------------------------------------------------------
// Track — owns one audio track's Web Audio nodes and drives TrackMachine
// ---------------------------------------------------------------------------

import { createActor, fromPromise } from 'xstate';
import { getAudioContext, resumeAudioContext } from './utils/audioContext';
import { createTrackMachine } from './machines/track.machine';
import { fetchDecodeMachine } from './machines/fetchDecode.machine';
import type { TrackContext } from './machines/track.machine';
import type { TrackInfo, TrackMetadata, WebAudioLoadingState, PlaybackType } from './types';

export interface TrackQueueRef {
  onTrackEnded(track: Track): void;
  onTrackBufferReady(track: Track): void;
  onProgress(info: TrackInfo): void;
  onError(error: Error): void;
  onPlayBlocked(): void;
  onDebug(msg: string): void;
  readonly volume: number;
  readonly webAudioIsDisabled: boolean;
  readonly currentTrackIndex: number;
}

/** How close to the end (in seconds) before we attempt gapless scheduling. */
const GAPLESS_SCHEDULE_LOOKAHEAD = 5;

export class Track {
  readonly index: number;
  readonly metadata: TrackMetadata;

  private _trackUrl: string;
  private _resolvedUrl: string;
  private readonly skipHEAD: boolean;
  /** Temporary holder between fetch and decode steps (unserializable — stays on Track class). */
  private _pendingArrayBuffer: ArrayBuffer | null = null;

  // ---- HTML5 Audio ---------------------------------------------------------
  readonly audio: HTMLAudioElement;

  // ---- Web Audio nodes -----------------------------------------------------
  private readonly _webAudioDisabled: boolean;

  private get ctx(): AudioContext | null {
    if (this._webAudioDisabled) return null;
    const context = getAudioContext();
    if (context && !this.gainNode) {
      this.gainNode = context.createGain();
      this.gainNode.gain.value = this.audio.volume;
    }
    return context;
  }

  private gainNode: GainNode | null = null;
  private sourceNode: AudioBufferSourceNode | null = null;
  audioBuffer: AudioBuffer | null = null;
  /** AudioContext.currentTime when the current source node was started. */
  private webAudioStartedAt = 0;
  /** Track-time (seconds) frozen at the moment of the most recent pause. */
  private pausedAtTrackTime = 0;
  // ---- FSM -----------------------------------------------------------------
  private readonly _actor;

  // ---- Callbacks -----------------------------------------------------------
  private readonly queueRef: TrackQueueRef;
  private rafId: number | null = null;

  constructor(opts: {
    trackUrl: string;
    index: number;
    queue: TrackQueueRef;
    skipHEAD?: boolean;
    metadata?: TrackMetadata;
  }) {
    this.index = opts.index;
    this._trackUrl = opts.trackUrl;
    this._resolvedUrl = opts.trackUrl;
    this.skipHEAD = opts.skipHEAD ?? false;
    this.metadata = opts.metadata ?? {};
    this.queueRef = opts.queue;

    // HTML5 Audio
    this.audio = new Audio();
    this.audio.preload = 'none';
    this.audio.src = this._trackUrl;
    this.audio.volume = opts.queue.volume;
    this.audio.controls = false;
    this.audio.onerror = () => {
      const code = this.audio.error?.code;
      if (code === 1) return;
      const msg = this.audio.error?.message ?? 'unknown';
      this.queueRef.onError(
        new Error(`HTML5 audio error on track ${this.index} (code ${code}): ${msg}`)
      );
    };
    this.audio.onended = () => {
      this.queueRef.onDebug(
        `audio.onended track=${this.index} machineState=${this._actor.getSnapshot().value} queueIdx=${this.queueRef.currentTrackIndex}`
      );
      this._actor.send({ type: 'HTML5_ENDED' });
    };

    this._webAudioDisabled = opts.queue.webAudioIsDisabled;

    const initialContext: TrackContext = {
      trackUrl: this._trackUrl,
      resolvedUrl: this._trackUrl,
      skipHEAD: this.skipHEAD,
      playbackType: 'HTML5',
      webAudioLoadingState: 'NONE',
      isPlaying: false,
      scheduledStartContextTime: null,
      notifiedLookahead: false,
      fetchDecodeRef: null,
    };
    const machine = createTrackMachine(initialContext).provide({
      guards: {
        canPlayWebAudio: () => !!(this.ctx && this.audioBuffer && this.gainNode),
      },
      actors: {
        fetchDecode: fetchDecodeMachine.provide({
          actors: {
            resolveUrl: fromPromise(async ({ signal }) => {
              const res = await fetch(this._trackUrl, { method: 'HEAD', signal });
              if (res.redirected && res.url) {
                this._resolvedUrl = res.url;
                this.audio.src = res.url;
                return res.url;
              }
              return null;
            }),
            fetchAudio: fromPromise(async ({ input, signal }) => {
              const { resolvedUrl } = input as { resolvedUrl: string };
              const res = await fetch(resolvedUrl, { signal });
              if (!res.ok) throw new Error(`HTTP ${res.status} for ${resolvedUrl}`);
              this._pendingArrayBuffer = await res.arrayBuffer();
            }),
            decodeAudio: fromPromise(async () => {
              const buf = this._pendingArrayBuffer;
              this._pendingArrayBuffer = null;
              if (!buf || !this.ctx) throw new Error('No ArrayBuffer or AudioContext');
              this.audioBuffer = await this.ctx.decodeAudioData(buf);
              queueMicrotask(() => this.queueRef.onTrackBufferReady(this));
            }),
          },
        }),
      },
      actions: {
        playHtml5: () => this._playHtml5(),
        startSourceNode: () => {
          this._startSourceNode(this.pausedAtTrackTime);
        },
        startScheduledSourceNode: ({ context }: { context: TrackContext }) => {
          const when = context.scheduledStartContextTime;
          if (when === null || !this.ctx || !this.audioBuffer || !this.gainNode) return;
          this._stopSourceNode();
          this.sourceNode = this.ctx.createBufferSource();
          this.sourceNode.buffer = this.audioBuffer;
          this.sourceNode.connect(this.gainNode);
          this.gainNode.connect(this.ctx.destination);
          this.sourceNode.onended = this._handleWebAudioEnded;
          this.sourceNode.start(when, 0);
          this.webAudioStartedAt = when;
          this.queueRef.onDebug(
            `startScheduledSourceNode track=${this.index} when=${when.toFixed(3)} ctxNow=${this.ctx.currentTime.toFixed(3)} delta=${(when - this.ctx.currentTime).toFixed(3)}s`
          );
        },
        startProgressLoop: () => this.startProgressLoop(),
        pauseHtml5: () => this.audio.pause(),
        freezePausedTime: () => {
          this.pausedAtTrackTime = this.currentTime;
        },
        stopSourceNode: () => this._stopSourceNode(),
        disconnectGain: () => this._disconnectGain(),
        stopProgressLoop: () => this._stopProgressLoop(),
        reportProgress: () => {
          queueMicrotask(() => this.queueRef.onProgress(this.toInfo()));
        },
        seekHtml5: () => this._seekHtml5(),
        seekWebAudio: () => this._seekWebAudio(),
        resetHtml5Element: () => {
          this.audio.currentTime = 0;
        },
        resetTiming: () => {
          this.webAudioStartedAt = 0;
          this.pausedAtTrackTime = 0;
        },
        notifyTrackEnded: () => {
          queueMicrotask(() => this.queueRef.onTrackEnded(this));
        },
      },
    });
    this._actor = createActor(machine);
    this._actor.start();
  }

  // --------------------------------------------------------------------------
  // Public playback controls
  // --------------------------------------------------------------------------

  play(): void {
    this.queueRef.onDebug(
      `Track.play() track=${this.index} machineState=${this._actor.getSnapshot().value} hasBuffer=${!!this.audioBuffer} hasCtx=${!!this.ctx} audioPaused=${this.audio.paused}`
    );
    this._actor.send({ type: 'PLAY' });
  }

  pause(): void {
    this._actor.send({ type: 'PAUSE' });
  }

  seek(time: number): void {
    const clamped = Math.max(0, isNaN(this.duration) ? time : Math.min(time, this.duration));
    this.pausedAtTrackTime = clamped;
    this._actor.send({ type: 'SEEK', time: clamped });
  }

  setVolume(v: number): void {
    const vol = Math.min(1, Math.max(0, v));
    this.audio.volume = vol;
    if (this.gainNode) this.gainNode.gain.value = vol;
    this._actor.send({ type: 'SET_VOLUME', volume: vol });
  }

  preload(): void {
    this.queueRef.onDebug(
      `preload() track=${this.index} state=${this._actor.getSnapshot().value} hasBuffer=${!!this.audioBuffer} hasCtx=${!!this.ctx}`
    );
    if (this._actor.getSnapshot().value === 'idle') {
      this._actor.send({ type: 'PRELOAD' });
    }
    if (this.audioBuffer) return;
    resumeAudioContext();
    if (!this.ctx) return;
    this._actor.send({ type: 'START_FETCH' });
  }

  seekToEnd(secondsFromEnd = 6): void {
    const dur = this.duration;
    if (!isNaN(dur) && dur > secondsFromEnd) {
      this.seek(dur - secondsFromEnd);
    }
  }

  activate(): void {
    this._actor.send({ type: 'ACTIVATE' });
  }

  deactivate(): void {
    this.queueRef.onDebug(
      `Track.deactivate() track=${this.index} machineState=${this._actor.getSnapshot().value} isPlaying=${this.isPlaying}`
    );
    this._actor.send({ type: 'DEACTIVATE' });
    this.queueRef.onDebug(
      `Track.deactivate() done track=${this.index} machineState=${this._actor.getSnapshot().value}`
    );
  }

  destroy(): void {
    this.deactivate();
    this._pendingArrayBuffer = null;
    this.audioBuffer = null;
    this.gainNode?.disconnect();
    this.gainNode = null;
    this._actor.stop(); // Stops spawned fetchDecode child actor, aborting in-flight fetches
  }

  // --------------------------------------------------------------------------
  // Gapless scheduling (called by Queue)
  // --------------------------------------------------------------------------

  cancelGaplessStart(): void {
    const snap = this._actor.getSnapshot();
    if (snap.context.scheduledStartContextTime === null) return;
    this._actor.send({ type: 'CANCEL_GAPLESS' });
  }

  scheduleGaplessStart(when: number): void {
    if (!this.ctx || !this.audioBuffer || !this.gainNode) return;
    this._actor.send({ type: 'SCHEDULE_GAPLESS', when });
  }

  // --------------------------------------------------------------------------
  // Getters
  // --------------------------------------------------------------------------

  get currentTime(): number {
    const snap = this._actor.getSnapshot();
    if (snap.value === 'webaudio') {
      if (!snap.context.isPlaying) return this.pausedAtTrackTime;
      if (!this.ctx) return 0;
      return Math.max(0, this.ctx.currentTime - this.webAudioStartedAt);
    }
    return this.audio.currentTime;
  }

  get duration(): number {
    if (this.audioBuffer) return this.audioBuffer.duration;
    return this.audio.duration;
  }

  get isPaused(): boolean {
    const snap = this._actor.getSnapshot();
    if (snap.value === 'webaudio') return !snap.context.isPlaying;
    return this.audio.paused;
  }

  get isPlaying(): boolean {
    return this._actor.getSnapshot().context.isPlaying;
  }

  get trackUrl(): string {
    return this._resolvedUrl;
  }

  get playbackType(): PlaybackType {
    return this._actor.getSnapshot().context.playbackType;
  }

  get webAudioLoadingState(): WebAudioLoadingState {
    return this._actor.getSnapshot().context.webAudioLoadingState;
  }

  get hasSourceNode(): boolean {
    return this.sourceNode !== null;
  }

  get machineState(): string {
    return this._actor.getSnapshot().value as string;
  }

  get scheduledStartContextTime(): number | null {
    return this._actor.getSnapshot().context.scheduledStartContextTime;
  }

  get isBufferLoaded(): boolean {
    return this.audioBuffer !== null;
  }

  toInfo(): TrackInfo {
    return {
      index: this.index,
      currentTime: this.currentTime,
      duration: this.duration,
      isPlaying: this.isPlaying,
      isPaused: this.isPaused,
      volume: this.gainNode?.gain.value ?? this.audio.volume,
      trackUrl: this.trackUrl,
      playbackType: this.playbackType,
      webAudioLoadingState: this.webAudioLoadingState,
      metadata: this.metadata,
      machineState: this.machineState,
    };
  }

  // --------------------------------------------------------------------------
  // Private: HTML5 helpers
  // --------------------------------------------------------------------------

  private _playHtml5(): void {
    if (this.audio.preload !== 'auto') this.audio.preload = 'auto';
    const promise = this.audio.play();
    if (promise) {
      promise.catch((err: unknown) => {
        if (err instanceof Error && err.name === 'NotAllowedError') {
          this.queueRef.onPlayBlocked();
        } else if (err instanceof Error && err.name === 'AbortError') {
          // Browser aborted — element will recover on next play()
        } else {
          this.queueRef.onError(err instanceof Error ? err : new Error(String(err)));
        }
      });
    }
  }

  private _seekHtml5(): void {
    const clamped = this.pausedAtTrackTime;
    if (this.audio.preload !== 'auto') this.audio.preload = 'auto';
    if (this.audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
      this.audio.currentTime = clamped;
    } else {
      this.audio.addEventListener(
        'loadedmetadata',
        () => {
          this.audio.currentTime = clamped;
        },
        { once: true }
      );
      this.audio.load();
    }
  }

  // --------------------------------------------------------------------------
  // Private: Web Audio helpers
  // --------------------------------------------------------------------------

  private _startSourceNode(offset: number): void {
    if (!this.ctx || !this.audioBuffer || !this.gainNode) return;
    this._stopSourceNode();

    // Ensure the AudioContext is running (it may have been suspended after
    // the previous track's source was disconnected).
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    this.sourceNode = this.ctx.createBufferSource();
    this.sourceNode.buffer = this.audioBuffer;
    this.sourceNode.connect(this.gainNode);
    this.gainNode.connect(this.ctx.destination);
    this.sourceNode.onended = this._handleWebAudioEnded;

    this.webAudioStartedAt = this.ctx.currentTime - offset;
    this.sourceNode.start(0, offset);
  }

  private _stopSourceNode(): void {
    if (!this.sourceNode) return;
    this.sourceNode.onended = null;
    try {
      this.sourceNode.stop();
    } catch {
      /* already stopped */
    }
    try {
      this.sourceNode.disconnect();
    } catch {
      /* already disconnected */
    }
    this.sourceNode = null;
  }

  private _disconnectGain(): void {
    if (!this.gainNode || !this.ctx) return;
    try {
      this.gainNode.disconnect(this.ctx.destination);
    } catch {
      /* already disconnected */
    }
  }

  private _seekWebAudio(): void {
    const snap = this._actor.getSnapshot();
    const wasPlaying = snap.context.isPlaying;
    const clamped = this.pausedAtTrackTime;
    this._stopSourceNode();
    if (wasPlaying) {
      this._startSourceNode(clamped);
    }
  }

  private _handleWebAudioEnded = (): void => {
    this.queueRef.onDebug(
      `_handleWebAudioEnded track=${this.index} sourceNode=${!!this.sourceNode} queueIdx=${this.queueRef.currentTrackIndex}`
    );
    if (!this.sourceNode) return;
    this._actor.send({ type: 'WEBAUDIO_ENDED' });
  };

  // --------------------------------------------------------------------------
  // Private: progress loop (requestAnimationFrame)
  // --------------------------------------------------------------------------

  startProgressLoop(): void {
    if (this.rafId !== null) return;
    const loop = () => {
      if (this.isPaused || !this.isPlaying) {
        this.rafId = null;
        return;
      }
      this.queueRef.onProgress(this.toInfo());

      const remaining = this.duration - this.currentTime;
      const snap = this._actor.getSnapshot();
      if (
        !snap.context.notifiedLookahead &&
        !isNaN(remaining) &&
        remaining <= GAPLESS_SCHEDULE_LOOKAHEAD
      ) {
        this._actor.send({ type: 'LOOKAHEAD_REACHED' });
        queueMicrotask(() => this.queueRef.onTrackBufferReady(this));
      }

      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private _stopProgressLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
}
