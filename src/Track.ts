// ---------------------------------------------------------------------------
// Track — owns one audio track's Web Audio nodes and drives TrackMachine
// ---------------------------------------------------------------------------

import { createActor } from 'xstate';
import { getAudioContext } from './utils/audioContext';
import { createTrackMachine } from './machines/track.machine';
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
  private loadedHEAD = false;
  private abortController: AbortController | null = null;

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
  scheduledStartContextTime: number | null = null;

  // ---- FSM -----------------------------------------------------------------
  private readonly _actor;

  // ---- Callbacks -----------------------------------------------------------
  private readonly queueRef: TrackQueueRef;
  private rafId: number | null = null;
  private _notifiedLookahead = false;

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
      const s = this._actor.getSnapshot().value;
      this.queueRef.onDebug(
        `audio.onended track=${this.index} machineState=${s} queueIdx=${this.queueRef.currentTrackIndex}`
      );
      if (s === 'html5' || s === 'idle') {
        this._actor.send({ type: 'HTML5_ENDED' });
        this.queueRef.onTrackEnded(this);
      }
    };

    this._webAudioDisabled = opts.queue.webAudioIsDisabled;

    const initialContext: TrackContext = {
      trackUrl: this._trackUrl,
      resolvedUrl: this._trackUrl,
      skipHEAD: this.skipHEAD,
      playbackType: 'HTML5',
      webAudioLoadingState: 'NONE',
      webAudioStartedAt: 0,
      pausedAtTrackTime: 0,
      isPlaying: false,
    };
    this._actor = createActor(createTrackMachine(initialContext));
    this._actor.start();
  }

  // --------------------------------------------------------------------------
  // Public playback controls
  // --------------------------------------------------------------------------

  play(): void {
    const state = this._actor.getSnapshot().value;
    let usedWebAudio = false;

    this.queueRef.onDebug(
      `Track.play() track=${this.index} machineState=${state} hasBuffer=${!!this.audioBuffer} hasCtx=${!!this.ctx} audioPaused=${this.audio.paused}`
    );

    if (state === 'webaudio') {
      usedWebAudio = this._playWebAudio();
    } else if (this.audioBuffer && this.ctx && (state === 'loading' || state === 'idle')) {
      usedWebAudio = this._playWebAudio();
    }

    if (!usedWebAudio) {
      if (state === 'html5' && !this.audio.paused) {
        // Already playing HTML5
      } else {
        this._playHtml5();
      }
    }

    this._actor.send({ type: usedWebAudio ? 'PLAY_WEBAUDIO' : 'PLAY' });
    this.startProgressLoop();
  }

  pause(): void {
    const state = this._actor.getSnapshot().value;
    if (state === 'webaudio') {
      this.pausedAtTrackTime = this.currentTime;
      this._stopSourceNode();
      this._disconnectGain();
    } else {
      this.audio.pause();
    }
    this._actor.send({ type: 'PAUSE' });
    this._stopProgressLoop();
    this.queueRef.onProgress(this.toInfo());
  }

  seek(time: number): void {
    const clamped = Math.max(0, isNaN(this.duration) ? time : Math.min(time, this.duration));
    this.pausedAtTrackTime = clamped;

    if (this._actor.getSnapshot().value === 'webaudio') {
      const snap = this._actor.getSnapshot();
      const wasPlaying = snap.context.isPlaying;
      this._stopSourceNode();
      // Clear stale scheduled start time so _computeTrackEndTime uses the
      // new seek position instead of the original gapless-scheduled time.
      this.scheduledStartContextTime = null;
      if (wasPlaying) {
        this._startSourceNode(clamped);
      }
    } else {
      // Ensure the HTML5 element is loading so seek can succeed
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

    this._actor.send({ type: 'SEEK', time: clamped });
    this.queueRef.onProgress(this.toInfo());
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
    if (this.audioBuffer || !this.ctx) return;
    this._startLoad();
  }

  seekToEnd(secondsFromEnd = 6): void {
    const dur = this.duration;
    if (!isNaN(dur) && dur > secondsFromEnd) {
      this.seek(dur - secondsFromEnd);
    }
  }

  activate(): void {
    const state = this._actor.getSnapshot().value;
    // If the track was in webaudio or loading state (e.g. from gapless scheduling,
    // preload BUFFER_READY, or stuck in loading), reset it so play() can start
    // from a clean state.
    if (state === 'webaudio' || state === 'loading') {
      this._stopSourceNode();
      this._disconnectGain();
      this.scheduledStartContextTime = null;
      this._stopProgressLoop();
      this._actor.send({ type: 'DEACTIVATE' });
    }
    // Always reset playback position — activate means start from the beginning.
    this.webAudioStartedAt = 0;
    this.pausedAtTrackTime = 0;
    this._notifiedLookahead = false;
    // If the HTML5 element finished playing, reset it so play() works again
    if (this.audio.ended || this.audio.currentTime > 0) {
      this.audio.currentTime = 0;
    }
  }

  deactivate(): void {
    this.queueRef.onDebug(
      `Track.deactivate() track=${this.index} machineState=${this._actor.getSnapshot().value} isPlaying=${this.isPlaying}`
    );
    this._stopSourceNode();
    this._disconnectGain();
    this.webAudioStartedAt = 0;
    this.pausedAtTrackTime = 0;
    this.scheduledStartContextTime = null;
    this.audio.pause();
    this.audio.currentTime = 0;
    this._stopProgressLoop();
    this._actor.send({ type: 'DEACTIVATE' });
    this.queueRef.onDebug(
      `Track.deactivate() done track=${this.index} machineState=${this._actor.getSnapshot().value}`
    );
  }

  destroy(): void {
    this.deactivate();
    this.abortController?.abort();
    this.audioBuffer = null;
    this.gainNode?.disconnect();
    this.gainNode = null;
    this._actor.stop();
  }

  // --------------------------------------------------------------------------
  // Gapless scheduling (called by Queue)
  // --------------------------------------------------------------------------

  cancelGaplessStart(): void {
    if (this.scheduledStartContextTime === null) return;
    this._stopSourceNode();
    this._disconnectGain();
    this.scheduledStartContextTime = null;
    this.webAudioStartedAt = 0;
    this.pausedAtTrackTime = 0;
    this._stopProgressLoop();
    this._actor.send({ type: 'DEACTIVATE' });
  }

  scheduleGaplessStart(when: number): void {
    if (!this.ctx || !this.audioBuffer || !this.gainNode) return;

    this.scheduledStartContextTime = when;

    this._stopSourceNode();
    this.sourceNode = this.ctx.createBufferSource();
    this.sourceNode.buffer = this.audioBuffer;
    this.sourceNode.connect(this.gainNode);
    this.gainNode.connect(this.ctx.destination);
    this.sourceNode.onended = this._handleWebAudioEnded;

    this.sourceNode.start(when, 0);
    this.webAudioStartedAt = when;

    this._actor.send({ type: 'PLAY_WEBAUDIO' });
    this.queueRef.onDebug(
      `scheduleGaplessStart track=${this.index} when=${when.toFixed(3)} ctxNow=${this.ctx.currentTime.toFixed(3)} delta=${(when - this.ctx.currentTime).toFixed(3)}s ctxState=${this.ctx.state}`
    );
  }

  // --------------------------------------------------------------------------
  // Getters
  // --------------------------------------------------------------------------

  get currentTime(): number {
    if (this._isUsingWebAudio) {
      const snap = this._actor.getSnapshot();
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
    if (this._isUsingWebAudio) return !this._actor.getSnapshot().context.isPlaying;
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

  // --------------------------------------------------------------------------
  // Private: Web Audio helpers
  // --------------------------------------------------------------------------

  private get _isUsingWebAudio(): boolean {
    return this._actor.getSnapshot().value === 'webaudio';
  }

  private _playWebAudio(): boolean {
    if (!this.ctx || !this.audioBuffer || !this.gainNode) {
      this.queueRef.onDebug(
        `_playWebAudio BAIL track=${this.index} ctx=${!!this.ctx} buf=${!!this.audioBuffer} gain=${!!this.gainNode}`
      );
      return false;
    }
    const snap = this._actor.getSnapshot();
    const resumeFrom = !snap.context.isPlaying ? this.pausedAtTrackTime : 0;
    this._startSourceNode(resumeFrom);
    return true;
  }

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

  private _handleWebAudioEnded = (): void => {
    this.queueRef.onDebug(
      `_handleWebAudioEnded track=${this.index} sourceNode=${!!this.sourceNode} queueIdx=${this.queueRef.currentTrackIndex}`
    );
    if (!this.sourceNode) return;
    this._actor.send({ type: 'WEBAUDIO_ENDED' });
    this._stopProgressLoop();
    this.queueRef.onTrackEnded(this);
  };

  // --------------------------------------------------------------------------
  // Private: fetch + decode pipeline
  // --------------------------------------------------------------------------

  private _startLoad(): void {
    const snap = this._actor.getSnapshot();
    if (!this.ctx || this.audioBuffer || snap.context.webAudioLoadingState !== 'NONE') {
      this.queueRef.onDebug(
        `_startLoad() SKIPPED track=${this.index} hasCtx=${!!this.ctx} hasBuffer=${!!this.audioBuffer} loadingState=${snap.context.webAudioLoadingState}`
      );
      return;
    }
    this.queueRef.onDebug(
      `_startLoad() STARTING track=${this.index} url=${this._resolvedUrl.slice(0, 60)}`
    );

    this._actor.send({ type: 'BUFFER_LOADING' });

    this.abortController = new AbortController();

    const doFetch = (url: string) => {
      fetch(url, { signal: this.abortController!.signal })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
          return res.arrayBuffer();
        })
        .then((buf) => this.ctx!.decodeAudioData(buf))
        .then((audioBuffer) => {
          this.audioBuffer = audioBuffer;
          this._actor.send({ type: 'BUFFER_READY' });
          this.queueRef.onTrackBufferReady(this);
        })
        .catch((err: unknown) => {
          if (err instanceof Error && err.name === 'AbortError') return;
          console.error(`gapless.js: decode failed for track ${this.index}`, err);
          this._actor.send({ type: 'BUFFER_ERROR' });
        });
    };

    if (this.skipHEAD || this.loadedHEAD) {
      doFetch(this._resolvedUrl);
    } else {
      fetch(this._trackUrl, {
        method: 'HEAD',
        signal: this.abortController.signal,
      })
        .then((res) => {
          if (res.redirected && res.url) {
            this._resolvedUrl = res.url;
            this.audio.src = res.url;
            this._actor.send({ type: 'URL_RESOLVED', url: res.url });
          }
          this.loadedHEAD = true;
          doFetch(this._resolvedUrl);
        })
        .catch((err: unknown) => {
          if (err instanceof Error && err.name === 'AbortError') return;
          this.loadedHEAD = true;
          doFetch(this._trackUrl);
        });
    }
  }

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
      if (
        !this._notifiedLookahead &&
        !isNaN(remaining) &&
        remaining <= GAPLESS_SCHEDULE_LOOKAHEAD
      ) {
        this._notifiedLookahead = true;
        this.queueRef.onTrackBufferReady(this);
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
