// ---------------------------------------------------------------------------
// Track — owns one audio track's Web Audio nodes and drives TrackMachine
// ---------------------------------------------------------------------------

import { createActor, fromPromise, assign } from 'xstate';
import { getAudioContext, resumeAudioContext } from './utils/audioContext';
import { createTrackMachine } from './machines/track.machine';
import { fetchDecodeMachine } from './machines/fetchDecode.machine';
import type { TrackContext } from './machines/track.machine';
import type { TrackInfo, TrackMetadata, WebAudioLoadingState, PlaybackType, PlaybackMethod } from './types';

export interface TrackQueueRef {
  onTrackEnded(track: Track): void;
  onTrackBufferReady(track: Track): void;
  onPreloadReady(track: Track): void;
  onProgress(info: TrackInfo): void;
  onError(error: Error): void;
  onPlayBlocked(): void;
  onDebug(msg: string): void;
  readonly volume: number;
  readonly playbackMethod: PlaybackMethod;
  readonly playbackRate: number;
  readonly currentTrackIndex: number;
}

/** How close to the end (in seconds) before we attempt gapless scheduling. */
const GAPLESS_SCHEDULE_LOOKAHEAD = 5;

/** How many seconds into HTML5 playback before we preload the next track. */
const PRELOAD_DELAY = 15;

/**
 * Crossfade duration (seconds) for the mid-stream HTML5 → Web Audio handoff.
 * Both sides of the crossfade run on AudioContext-clock gain ramps
 * (the HTML5 side via a GainNode after MediaElementAudioSourceNode), so
 * the join is sample-accurate. 30 ms is short enough to be inaudible as a
 * fade and long enough to mask any sample-level discontinuity between the
 * two streams.
 */
const CROSSOVER_FADE_SEC = 0.03;


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
  private readonly _playbackMethod: PlaybackMethod;

  private get ctx(): AudioContext | null {
    if (this._playbackMethod === 'HTML5_ONLY') return null;
    const context = getAudioContext();
    if (context && !this.gainNode) {
      this.gainNode = context.createGain();
      this.gainNode.gain.value = this.audio.volume;
      this.gainNode.connect(context.destination);

      // Route the HTML5 element through the AudioContext via a
      // MediaElementAudioSourceNode + dedicated GainNode. With this routing,
      // the HTML5 side has its own AudioContext-clock gain we can ramp
      // sample-accurately during crossover, eliminating the click that an
      // abrupt audio.pause() leaves at the cut point. Volume control moves
      // entirely onto gainNode (master); we set audio.volume = 1 so the
      // browser-side and AudioContext-side gains don't multiply.
      //
      // createMediaElementSource severs the element's default audio output
      // for the rest of its life, so once this runs, all HTML5 playback
      // flows through the AudioContext. CORS: cross-origin audio without
      // Access-Control-Allow-Origin will produce silence through the
      // MediaElementAudioSourceNode path. If the call throws (rare; some
      // legacy implementations or double-attach), fall back to the
      // pre-routing behavior with audio.volume controlling HTML5 directly.
      try {
        this._mediaElementSource = context.createMediaElementSource(this.audio);
        this._html5GainNode = context.createGain();
        this._html5GainNode.gain.value = 1;
        this._mediaElementSource.connect(this._html5GainNode);
        this._html5GainNode.connect(this.gainNode);
        this.audio.volume = 1;
      } catch {
        this._mediaElementSource = null;
        this._html5GainNode = null;
      }
    }
    return context;
  }

  private gainNode: GainNode | null = null;
  private _mediaElementSource: MediaElementAudioSourceNode | null = null;
  private _html5GainNode: GainNode | null = null;
  private sourceNode: AudioBufferSourceNode | null = null;
  audioBuffer: AudioBuffer | null = null;
  /** AudioContext.currentTime at the start of the current playback segment. */
  /**
   * Offset (in seconds) between the decoded buffer's "offset 0" and the music's
   * "offset 0". Some MP3 files include ID3v2 metadata, encoder priming samples,
   * or container padding at the start; HTML5 audio elements skip past these
   * natively (audio.currentTime=0 means music start), but `decodeAudioData` in
   * some browsers includes them in the decoded buffer (buffer offset 0 = file
   * start, music actually starts at offset _bufferStartPaddingSec).
   *
   * Without this shift, calling source.start(when, audio.currentTime) plays
   * `audio.currentTime` seconds AHEAD of what HTML5 was just outputting,
   * sounding like a backward skip at crossover. We compute this once both
   * the buffer and audio.duration are known, and apply it as
   *     source.start(when, trackTime + _bufferStartPaddingSec)
   * everywhere we read from the buffer. User-facing time (currentTime/duration
   * getters) continues to be reported in music-time, not buffer-time.
   */
  private _bufferStartPaddingSec = 0;
  private _bufferAlignmentMeasured = false;

  private _waRefCtxTime = 0;
  /** Track position (seconds) at the start of the current playback segment. */
  private _waRefTrackTime = 0;
  /** Temp storage for crossover offset — read by syncSeekTargetFromCrossover. */
  private _crossoverComputedOffset = 0;
  /** Aborted on reset to remove pending loadedmetadata listeners. */
  private _seekAbort = new AbortController();
  // ---- FSM -----------------------------------------------------------------
  private readonly _actor;

  // ---- Callbacks -----------------------------------------------------------
  private readonly queueRef: TrackQueueRef;
  private rafId: number | null = null;
  private _notifiedPreloadThreshold = false;

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
    // crossOrigin must be set BEFORE src for MediaElementAudioSourceNode to
    // actually expose the element's audio to the AudioContext graph. Without
    // it, even servers that DO send CORS headers result in the
    // MediaElementSource being treated as cross-origin tainted, and the node
    // outputs silence — manifesting as "HTML5 plays fine until WebAudio
    // takes over, then suddenly audible". HTML5_ONLY mode skips this since
    // it doesn't route through AudioContext; setting crossOrigin there
    // would make non-CORS sources fail to load at all.
    if (opts.queue.playbackMethod !== 'HTML5_ONLY') {
      this.audio.crossOrigin = 'anonymous';
    }
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

    this._playbackMethod = opts.queue.playbackMethod;

    const initialContext: TrackContext = {
      trackUrl: this._trackUrl,
      resolvedUrl: this._trackUrl,
      skipHEAD: this.skipHEAD,
      playbackType: 'HTML5',
      webAudioLoadingState: 'NONE',
      isPlaying: false,
      scheduledStartContextTime: null,
      notifiedLookahead: false,
      fetchStarted: false,
      pendingPlay: false,
      seekTarget: 0,
    };
    const machine = createTrackMachine(initialContext).provide({
      guards: {
        canPlayWebAudio: () => !!(this.ctx && this.audioBuffer && this.gainNode),
        isWebAudioOnly: () => this._playbackMethod === 'WEBAUDIO_ONLY',
      },
      actors: {
        fetchDecode: fetchDecodeMachine.provide({
          actors: {
            resolveUrl: fromPromise(async ({ signal }) => {
              const res = await fetch(this._trackUrl, { method: 'HEAD', signal });
              if (res.redirected && res.url) {
                // Cache the resolved URL so the WebAudio GET below uses it
                // directly (avoiding a second redirect round-trip). Do NOT
                // overwrite this.audio.src — the HTML5 element may currently
                // be streaming, and assigning a new src aborts playback,
                // resets audio.currentTime to 0, and reloads from the new
                // URL. The browser already handles the original URL's
                // redirect transparently for HTML5; updating src here causes
                // a perceived jump back to the start mid-playback (which the
                // user then notices later as a "skip" at crossover, since
                // audio.currentTime captured at crossover time reflects the
                // post-reset position rather than the user's actual progress).
                this._resolvedUrl = res.url;
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
              this._maybeComputeBufferAlignment();
            }),
          },
        }),
      },
      actions: {
        triggerFetchForPendingPlay: () => {
          this.preload();
          resumeAudioContext();
        },
        playHtml5: ({ context }: { context: TrackContext }) => this._playHtml5(context.seekTarget),
        startSourceNode: ({ context }: { context: TrackContext }) => {
          this._startSourceNode(context.seekTarget);
        },
        crossoverHtml5ToWebAudio: ({ context }: { context: TrackContext }) => {
          this._crossoverHtml5ToWebAudio(context.isPlaying, context.seekTarget);
        },
        syncSeekTargetFromCrossover: assign({
          seekTarget: () => this._crossoverComputedOffset,
        }),
        startScheduledSourceNode: ({ context }: { context: TrackContext }) => {
          const when = context.scheduledStartContextTime;
          if (when === null || !this.ctx || !this.audioBuffer || !this.gainNode) return;
          this._maybeComputeBufferAlignment();
          this._stopSourceNode();
          this.sourceNode = this.ctx.createBufferSource();
          this.sourceNode.buffer = this.audioBuffer;
          this.sourceNode.playbackRate.value = this.queueRef.playbackRate;
          this.sourceNode.connect(this.gainNode);
          this.sourceNode.onended = this._handleWebAudioEnded;
          this.sourceNode.start(when, this._bufferStartPaddingSec);
          const bufRemaining = this.audioBuffer.duration - this._bufferStartPaddingSec;
          const schedRate = this.sourceNode.playbackRate.value || 1;
          if (bufRemaining > 0) {
            this.sourceNode.stop(when + bufRemaining / schedRate);
          }
          this._waRefCtxTime = when;
          this._waRefTrackTime = 0;
          this.queueRef.onDebug(
            `startScheduledSourceNode track=${this.index} when=${when.toFixed(3)} ctxNow=${this.ctx.currentTime.toFixed(3)} delta=${(when - this.ctx.currentTime).toFixed(3)}s padding=${this._bufferStartPaddingSec.toFixed(3)}s`
          );
        },
        startProgressLoop: () => this.startProgressLoop(),
        pauseHtml5: () => this.audio.pause(),
        freezePausedTime: assign({
          seekTarget: () => {
            const t = this.currentTime;
            return isFinite(t) ? t : 0;
          },
        }),
        stopSourceNode: () => this._stopSourceNode(),
        stopProgressLoop: () => this._stopProgressLoop(),
        reportProgress: () => {
          queueMicrotask(() => this.queueRef.onProgress(this.toInfo()));
        },
        seekHtml5: ({ context }: { context: TrackContext }) => this._seekHtml5(context.seekTarget),
        seekWebAudio: ({ context }: { context: TrackContext }) => this._seekWebAudio(context.seekTarget),
        resetHtml5Element: () => {
          this._seekAbort.abort();
          this._seekAbort = new AbortController();
          this.audio.currentTime = 0;
        },
        resetTiming: () => {
          this._waRefCtxTime = 0;
          this._waRefTrackTime = 0;
        },
        notifyTrackEnded: () => {
          queueMicrotask(() => this.queueRef.onTrackEnded(this));
        },
        notifyBufferReady: () => {
          queueMicrotask(() => this.queueRef.onTrackBufferReady(this));
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
    if (!isFinite(time)) return;
    const clamped = Math.max(0, isNaN(this.duration) ? time : Math.min(time, this.duration));
    this._actor.send({ type: 'SEEK', time: clamped });
  }

  setVolume(v: number): void {
    const vol = Math.min(1, Math.max(0, v));
    if (this._mediaElementSource) {
      this.audio.volume = 1;
    } else {
      this.audio.volume = vol;
    }
    if (this.gainNode) this.gainNode.gain.value = vol;
    this._actor.send({ type: 'SET_VOLUME', volume: vol });
  }

  setPlaybackRate(rate: number): void {
    if (this.ctx && this.sourceNode && this._actor.getSnapshot().context.isPlaying
        && this.ctx.currentTime >= this._waRefCtxTime) {
      const oldRate = this.sourceNode.playbackRate.value;
      this._waRefTrackTime = this._waRefTrackTime + (this.ctx.currentTime - this._waRefCtxTime) * oldRate;
      this._waRefCtxTime = this.ctx.currentTime;
    }
    this.audio.playbackRate = rate;
    if (this.sourceNode) {
      this.sourceNode.playbackRate.value = rate;
      if (this.audioBuffer && this.ctx) {
        const remaining = this.audioBuffer.duration - this._bufferStartPaddingSec - this._waRefTrackTime;
        if (remaining > 0) {
          try {
            this.sourceNode.stop(this._waRefCtxTime + remaining / rate);
          } catch { /* already stopped */ }
        }
      }
    }
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
    this._notifiedPreloadThreshold = false;
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
    this._actor.stop();
  }

  // --------------------------------------------------------------------------
  // Gapless scheduling (called by Queue)
  // --------------------------------------------------------------------------

  scheduleHtml5Mute(when: number): void {
    if (!this._html5GainNode || !this.ctx) return;
    this._html5GainNode.gain.setValueAtTime(1, when - 0.005);
    this._html5GainNode.gain.linearRampToValueAtTime(0, when);
  }

  cancelHtml5Mute(): void {
    if (!this._html5GainNode || !this.ctx) return;
    this._html5GainNode.gain.cancelScheduledValues(this.ctx.currentTime);
    this._html5GainNode.gain.setValueAtTime(1, this.ctx.currentTime);
  }

  cancelGaplessStart(): void {
    const snap = this._actor.getSnapshot();
    if (snap.context.scheduledStartContextTime === null) return;
    this._actor.send({ type: 'CANCEL_GAPLESS' });
  }

  scheduleGaplessStart(when: number): boolean {
    if (!this.ctx || !this.audioBuffer || !this.gainNode) return false;
    const state = this._actor.getSnapshot().value;
    if (state !== 'idle' && state !== 'loading') return false;
    this._actor.send({ type: 'SCHEDULE_GAPLESS', when });
    return true;
  }

  // --------------------------------------------------------------------------
  // Getters
  // --------------------------------------------------------------------------

  get seekTarget(): number {
    return this._actor.getSnapshot().context.seekTarget;
  }

  get currentTime(): number {
    const snap = this._actor.getSnapshot();
    if (snap.value === 'webaudio') {
      if (!snap.context.isPlaying) return snap.context.seekTarget;
      if (!this.ctx) return 0;
      return Math.max(0, this._waRefTrackTime + (this.ctx.currentTime - this._waRefCtxTime) * this.queueRef.playbackRate);
    }
    if ((snap.value === 'idle' || snap.value === 'loading') && snap.context.seekTarget > 0) {
      return snap.context.seekTarget;
    }
    return this.audio.currentTime;
  }

  get duration(): number {
    const snap = this._actor.getSnapshot();
    if (snap.value === 'html5' && !isNaN(this.audio.duration)) {
      return this.audio.duration;
    }
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

  get playbackEndContextTime(): number | null {
    const snap = this._actor.getSnapshot();
    if (snap.value !== 'webaudio' || !snap.context.isPlaying) return null;
    if (!this.sourceNode || !this.audioBuffer) return null;
    const rate = this.sourceNode.playbackRate.value || 1;
    const bufferRemaining =
      this.audioBuffer.duration - this._bufferStartPaddingSec - this._waRefTrackTime;
    return this._waRefCtxTime + bufferRemaining / rate;
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
      playbackRate: this.queueRef.playbackRate,
      machineState: this.machineState,
    };
  }

  // --------------------------------------------------------------------------
  // Private: HTML5 helpers
  // --------------------------------------------------------------------------

  private _playHtml5(seekTarget: number): void {
    if (this.audio.preload !== 'auto') this.audio.preload = 'auto';
    this.audio.playbackRate = this.queueRef.playbackRate;
    if (seekTarget > 0 && Math.abs(this.audio.currentTime - seekTarget) > 0.01) {
      if (this.audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
        this.audio.currentTime = seekTarget;
      } else {
        const target = seekTarget;
        this.audio.addEventListener('loadedmetadata', () => {
          this.audio.currentTime = target;
        }, { once: true, signal: this._seekAbort.signal });
      }
    }
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

  private _seekHtml5(target: number): void {
    if (!isFinite(target)) return;
    if (this.audio.preload !== 'auto') this.audio.preload = 'auto';
    if (this.audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
      this.audio.currentTime = target;
    } else {
      this.audio.addEventListener(
        'loadedmetadata',
        () => {
          this.audio.currentTime = target;
        },
        { once: true, signal: this._seekAbort.signal }
      );
      this.audio.load();
    }
  }

  // --------------------------------------------------------------------------
  // Private: Web Audio helpers
  // --------------------------------------------------------------------------

  /**
   * Mid-stream crossover: switch an actively-playing HTML5 track to Web Audio.
   *
   * Why this exists: we cannot reliably predict when an HTML5 <audio> element
   * will fire 'ended' from within the AudioContext clock. Any prediction is
   * at the mercy of the browser's audio pipeline (buffering stalls, codec
   * padding differences, clock drift between audio.currentTime and
   * ctx.currentTime over long sessions). Scheduling the next gapless track
   * against that prediction is how overlap bugs happen.
   *
   * Instead, as soon as the buffer is decoded, we hand playback off to Web
   * Audio while the track is still mid-song. From that point on, the track
   * and all subsequent gapless transitions live on a single clock
   * (AudioContext.currentTime), so scheduling is sample-accurate by
   * construction — no prediction involved.
   *
   * Ordering: pause the HTML5 element FIRST, then start the source node at
   * the captured offset. Pausing first ensures audio.currentTime is frozen
   * before we read it as the Web Audio start offset, so there's no brief
   * double-audio window at the crossover point.
   */
  private _crossoverHtml5ToWebAudio(wasPlaying: boolean, seekTarget: number): void {
    if (!this.ctx || !this.audioBuffer || !this.gainNode) return;

    const htmlTime = this.audio.currentTime;
    const offset =
      isFinite(seekTarget) && seekTarget > htmlTime
        ? seekTarget
        : htmlTime;
    this._crossoverComputedOffset = isFinite(offset) ? offset : 0;

    if (!wasPlaying) {
      this.audio.pause();
      this.queueRef.onDebug(
        `crossoverHtml5ToWebAudio track=${this.index} offset=${this._crossoverComputedOffset.toFixed(3)} wasPlaying=false`
      );
      return;
    }

    const when = this._startSourceNode(this._crossoverComputedOffset, CROSSOVER_FADE_SEC);

    if (when !== null && this._html5GainNode) {
      this._html5GainNode.gain.cancelScheduledValues(when);
      this._html5GainNode.gain.setValueAtTime(1, when);
      this._html5GainNode.gain.linearRampToValueAtTime(0, when + CROSSOVER_FADE_SEC);
      const ctxRef = this.ctx;
      const html5GainRef = this._html5GainNode;
      const delayMs = (when - this.ctx.currentTime + CROSSOVER_FADE_SEC) * 1000 + 5;
      setTimeout(() => {
        this.audio.pause();
        if (ctxRef && html5GainRef) {
          html5GainRef.gain.cancelScheduledValues(ctxRef.currentTime);
          html5GainRef.gain.setValueAtTime(1, ctxRef.currentTime);
        }
      }, delayMs);
    } else if (!this._html5GainNode) {
      if (when !== null && this.ctx) {
        const delayMs = (when - this.ctx.currentTime) * 1000;
        setTimeout(() => {
          this.audio.volume = 0;
          this.audio.pause();
          this.audio.volume = 1;
        }, Math.max(0, delayMs));
      } else {
        this.audio.volume = 0;
        this.audio.pause();
        this.audio.volume = 1;
      }
    }

    this.queueRef.onDebug(
      `crossoverHtml5ToWebAudio track=${this.index} offset=${this._crossoverComputedOffset.toFixed(3)} wasPlaying=true fade=${CROSSOVER_FADE_SEC}s mediaSource=${!!this._html5GainNode} when=${when?.toFixed(3) ?? 'null'}`
    );
  }

  /**
   * Reverted: alignment-based fixes (duration-delta and buffer-silence
   * scanning) reduced the perceived skip on archive.org files but did not
   * eliminate it, suggesting the residual gap isn't a buffer/timeline
   * alignment problem at all. Leaving _bufferStartPaddingSec at 0 (no shift)
   * until we have a confirmed root cause; the field and call sites are kept
   * so we can re-introduce a fix without churning the source-start code.
   */
  private _maybeComputeBufferAlignment(): void {
    if (!this.audioBuffer) return;
    if (this._bufferAlignmentMeasured) return;
    this._bufferStartPaddingSec = 0;
    this._bufferAlignmentMeasured = true;
    this.queueRef.onDebug(
      `_maybeComputeBufferAlignment track=${this.index} bufferDur=${this.audioBuffer.duration.toFixed(3)}s html5Dur=${isNaN(this.audio.duration) ? 'NaN' : this.audio.duration.toFixed(3) + 's'} (alignment shift disabled — see comment)`
    );
  }

  private _startSourceNode(offset: number, fadeInSec = 0): number | null {
    if (!this.ctx || !this.audioBuffer || !this.gainNode) return null;
    this._maybeComputeBufferAlignment();
    this._stopSourceNode();

    const wasSuspended = this.ctx.state === 'suspended';
    if (wasSuspended) {
      this.ctx.resume();
    }

    this.sourceNode = this.ctx.createBufferSource();
    this.sourceNode.buffer = this.audioBuffer;
    this.sourceNode.playbackRate.value = this.queueRef.playbackRate;

    const lead = wasSuspended
      ? 0.15
      : Math.max(0.02, 2 * ((this.ctx as unknown as { baseLatency?: number }).baseLatency || 0) + 0.01);
    const when = this.ctx.currentTime + lead;

    const rate = this.queueRef.playbackRate;
    const maxOffset = this.audioBuffer.duration - this._bufferStartPaddingSec;
    const effectiveOffset = Math.min(offset + lead * rate, maxOffset);

    if (fadeInSec > 0) {
      const fadeNode = this.ctx.createGain();
      fadeNode.gain.setValueAtTime(0, when);
      fadeNode.gain.linearRampToValueAtTime(1, when + fadeInSec);
      this.sourceNode.connect(fadeNode);
      fadeNode.connect(this.gainNode);
    } else {
      this.sourceNode.connect(this.gainNode);
    }
    this.sourceNode.onended = this._handleWebAudioEnded;

    this._waRefCtxTime = when;
    this._waRefTrackTime = effectiveOffset;
    this.sourceNode.start(when, effectiveOffset + this._bufferStartPaddingSec);

    const bufRemaining = this.audioBuffer.duration - this._bufferStartPaddingSec - effectiveOffset;
    if (bufRemaining > 0) {
      this.sourceNode.stop(when + bufRemaining / rate);
    }
    return when;
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

  private _seekWebAudio(target: number): void {
    const snap = this._actor.getSnapshot();
    const wasPlaying = snap.context.isPlaying;
    this._stopSourceNode();
    if (wasPlaying) {
      this._startSourceNode(target);
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

      const preloadThreshold = isNaN(this.duration) ? PRELOAD_DELAY : Math.min(this.duration * 0.2, PRELOAD_DELAY);
      if (!this._notifiedPreloadThreshold && this.currentTime >= preloadThreshold) {
        this._notifiedPreloadThreshold = true;
        queueMicrotask(() => this.queueRef.onPreloadReady(this));
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
