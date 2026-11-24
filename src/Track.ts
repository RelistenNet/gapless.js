// ---------------------------------------------------------------------------
// Track — owns one audio track's Web Audio nodes and drives TrackMachine
// ---------------------------------------------------------------------------

import { createActor, fromPromise, assign } from 'xstate';
import { getAudioContext, resumeAudioContext } from './utils/audioContext';
import { acquireBuffer, hasBuffer, releaseBuffer } from './utils/bufferCache';
import { createTrackMachine } from './machines/track.machine';
import { fetchDecodeMachine } from './machines/fetchDecode.machine';
import type { TrackContext } from './machines/track.machine';
import type {
  TrackInfo,
  TrackMetadata,
  WebAudioLoadingState,
  PlaybackType,
  PlaybackMethod,
} from './types';

export interface TrackQueueRef {
  onTrackEnded(track: Track): void;
  onTrackBufferReady(track: Track): void;
  onPreloadReady(track: Track): void;
  onProgress(track: Track, info: TrackInfo): void;
  onError(error: Error): void;
  onPlayBlocked(): void;
  onDebug(msg: string): void;
  readonly volume: number;
  readonly playbackMethod: PlaybackMethod;
  readonly playbackRate: number;
  /** Key of the queue's current track (for debug messages). */
  readonly currentKey: string | null;
  /** This track's position in the queue's play order, or -1 if it isn't in it. */
  indexOf(track: Track): number;
  /**
   * Seconds of crossfade into the track after `track`, if it fades in: its
   * transition must be scheduled that much earlier than a gapless one.
   */
  crossfadeAfter?(track: Track): number;
  /**
   * The element's timing may have moved (it resumed after a stall, or
   * reported progress): a transition timed from it may need re-aiming. Fires
   * without the progress loop, which doesn't run in a background tab.
   */
  onTimingChanged?(track: Track): void;
}

/** How close to the end (in seconds) before we attempt gapless scheduling. */
const GAPLESS_SCHEDULE_LOOKAHEAD = 5;

/**
 * How near clipEnd (wall-clock seconds) an HTML5 clip arms its exact mute.
 * Wider than the ~250 ms between timeupdate events, so it always arms.
 */
const CLIP_END_ARM_SEC = 0.6;
/** How far the predicted clip end can move before the armed mute is re-aimed. */
const CLIP_END_DRIFT_SEC = 0.03;

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

let _autoKey = 0;

/** Equal-power crossfade curves: the two gains' squares sum to 1 throughout. */
const CURVE_POINTS = 64;
const FADE_IN_CURVE = Float32Array.from({ length: CURVE_POINTS }, (_, i) =>
  Math.sin(((i / (CURVE_POINTS - 1)) * Math.PI) / 2)
);
const FADE_OUT_CURVE = Float32Array.from({ length: CURVE_POINTS }, (_, i) =>
  Math.cos(((i / (CURVE_POINTS - 1)) * Math.PI) / 2)
);

/**
 * Check a clip range (seconds into the file). Throws on a range that can't
 * play; returns it normalized (start defaults to 0, end to null = file end).
 */
export function normalizeClip(
  start: number | undefined,
  end: number | undefined
): { start: number; end: number | null } {
  const s = start ?? 0;
  if (!Number.isFinite(s) || s < 0) {
    throw new Error(`gapless: clip start must be a finite number >= 0 (got ${start})`);
  }
  if (end === undefined || end === null) return { start: s, end: null };
  if (!Number.isFinite(end) || end <= s) {
    throw new Error(
      `gapless: clip end must be a finite number > start (got start=${s}, end=${end})`
    );
  }
  return { start: s, end };
}

export class Track {
  /** Stable identity across reorders. A track's position belongs to the queue. */
  readonly key: string;
  readonly metadata: TrackMetadata;
  /**
   * Clip range, in seconds into the file. Every time this class reports or
   * accepts (currentTime, duration, seek, seekTarget, _waRefTrackTime) is
   * clip-relative; file time is clipStart + that. The conversion happens only
   * where we talk to the element (audio.currentTime) or the buffer
   * (source.start offset).
   */
  readonly clipStart: number;
  /** End of the clip in file seconds, or null to play to the end of the file. */
  readonly clipEnd: number | null;
  /** Seconds to crossfade into this track, or null to use the queue's default. */
  private _crossfadeIn: number | null;
  private _destroyed = false;
  /** The element was set buffering from the clip start (see primeHtml5). */
  private _primed = false;
  /** When the HTML5 clip-end mute is set for (AudioContext time), or null (see cancelHtml5Mute). */
  private _clipEndMuteAt: number | null = null;

  private _trackUrl: string;
  private _resolvedUrl: string;
  readonly skipHEAD: boolean;
  /** Holds the shared buffer between the machine's fetch and decode steps. */
  private _pendingBuffer: AudioBuffer | null = null;
  /** Bumped by unload(): a fetch or decode that finishes after it is dropped. */
  private _loadGeneration = 0;

  // ---- HTML5 Audio ---------------------------------------------------------
  readonly audio: HTMLAudioElement;

  // ---- Web Audio nodes -----------------------------------------------------
  private readonly _playbackMethod: PlaybackMethod;

  private get ctx(): AudioContext | null {
    // A destroyed track never builds its nodes again (a late call would
    // connect a new GainNode to the destination and re-route the element).
    if (this._playbackMethod === 'HTML5_ONLY' || this._destroyed) return null;
    const context = getAudioContext();
    if (context && !this.gainNode) {
      this.gainNode = context.createGain();
      this.gainNode.gain.value = this.audio.volume;
      this.gainNode.connect(context.destination);
      // Crossfades ramp this node; volume stays on gainNode, so setVolume
      // can't cancel a fade in progress (or a fade pin the volume).
      this._fadeGainNode = context.createGain();
      this._fadeGainNode.connect(this.gainNode);

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
        // Through the fade node, like Web Audio sources: a crossfade can
        // then fade a track that is still streaming.
        this._html5GainNode.connect(this._fadeGainNode);
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
  /** Between Web Audio sources and gainNode; carries crossfade ramps. */
  private _fadeGainNode: GainNode | null = null;
  /** Fade-in length (s) for the scheduled start, 0 for a gapless one. */
  private _scheduledFadeIn = 0;
  /** A crossfade start over HTML5 (see scheduleHtml5Start); timer null once fired. */
  private _html5Start: {
    when: number;
    fadeIn: number;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;
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
    queue: TrackQueueRef;
    key?: string;
    skipHEAD?: boolean;
    metadata?: TrackMetadata;
    /** Seconds into the file to start playing from. */
    start?: number;
    /** Seconds into the file to stop at. */
    end?: number;
    /** Seconds to crossfade into this track from the one before it. */
    crossfade?: number;
  }) {
    if (opts.crossfade !== undefined && !(opts.crossfade >= 0 && isFinite(opts.crossfade))) {
      throw new Error(`gapless: crossfade must be a finite number >= 0 (got ${opts.crossfade})`);
    }
    this._crossfadeIn = opts.crossfade ?? null;
    const clip = normalizeClip(opts.start, opts.end);
    this.clipStart = clip.start;
    this.clipEnd = clip.end;
    // Queue always passes a key; this fallback is for a Track built on its own.
    this.key = opts.key ?? `track-${++_autoKey}`;
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
        new Error(`HTML5 audio error on track ${this.key} (code ${code}): ${msg}`)
      );
    };
    const timingChanged = () => this.queueRef.onTimingChanged?.(this);
    this.audio.addEventListener('playing', timingChanged);
    this.audio.addEventListener('timeupdate', timingChanged);
    this.audio.onended = () => {
      this.queueRef.onDebug(
        `audio.onended track=${this.key} machineState=${this._actor.getSnapshot().value} queueCurrent=${this.queueRef.currentKey}`
      );
      this._actor.send({ type: 'HTML5_ENDED' });
    };
    // The element has no exact stop time, so a clip ending before the file
    // does is ended by polling: the rAF progress loop, plus timeupdate for
    // background tabs (where rAF doesn't run).
    if (this.clipEnd !== null) {
      this.audio.ontimeupdate = () => this._checkHtml5ClipEnd();
      // Stalled to buffer: the element's clock stops and any clip-end mute
      // would land early. Drop it; the next check re-arms it from where the
      // element really is. (In a background tab timeupdate also stops during
      // a stall, so re-aiming on each check alone wouldn't catch this.)
      this.audio.onwaiting = () => {
        if (this._clipEndMuteAt !== null) this.cancelHtml5Mute();
      };
    }

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
              // Another track already loads this file: its buffer is shared
              // by source URL, so the redirect needn't be resolved again.
              if (hasBuffer(this._trackUrl)) return null;
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
            // Fetch and decode, shared by every track playing this file
            // (clips of one recording): the first one loads it, the rest
            // wait on the same promise. See utils/bufferCache.
            fetchAudio: fromPromise(async ({ input, signal }) => {
              const { resolvedUrl } = input as { resolvedUrl: string };
              const generation = this._loadGeneration;
              const decoded = await acquireBuffer(this._trackUrl, this, signal, (sig) =>
                this._fetchAndDecode(resolvedUrl, sig)
              );
              // Unloaded meanwhile (a decode can't be aborted): drop the result.
              if (generation === this._loadGeneration) this._pendingBuffer = decoded;
            }),
            decodeAudio: fromPromise(async () => {
              const buf = this._pendingBuffer;
              this._pendingBuffer = null;
              if (!buf) return;
              this.audioBuffer = buf;
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
          this.sourceNode.connect(this._sourceOutput);
          this.sourceNode.onended = this._handleWebAudioEnded;
          if (this._scheduledFadeIn > 0) {
            this._rampFade(FADE_IN_CURVE, when, this._scheduledFadeIn);
          } else {
            this._resetFade();
          }
          this.sourceNode.start(when, this._bufferStartPaddingSec + this.clipStart);
          const bufRemaining = this._bufferClipLength;
          const schedRate = this.sourceNode.playbackRate.value || 1;
          // Always stop: a clip ends before its file, so an unstopped source
          // would play on past clipEnd. Zero remaining stops it on start.
          this.sourceNode.stop(when + Math.max(0, bufRemaining) / schedRate);
          this._waRefCtxTime = when;
          this._waRefTrackTime = 0;
          this.queueRef.onDebug(
            `startScheduledSourceNode track=${this.key} when=${when.toFixed(3)} ctxNow=${this.ctx.currentTime.toFixed(3)} delta=${(when - this.ctx.currentTime).toFixed(3)}s padding=${this._bufferStartPaddingSec.toFixed(3)}s`
          );
        },
        startProgressLoop: () => this.startProgressLoop(),
        pauseHtml5: () => this.audio.pause(),
        freezePausedTime: assign({
          seekTarget: ({ context }: { context: TrackContext }) => {
            const t = this.currentTime;
            const current = isFinite(t) ? t : 0;
            return Math.max(current, context.seekTarget);
          },
        }),
        stopSourceNode: () => this._stopSourceNode(),
        stopProgressLoop: () => this._stopProgressLoop(),
        reportProgress: () => {
          queueMicrotask(() => this.queueRef.onProgress(this, this.toInfo()));
        },
        seekHtml5: ({ context }: { context: TrackContext }) => this._seekHtml5(context.seekTarget),
        seekWebAudio: ({ context }: { context: TrackContext }) =>
          this._seekWebAudio(context.seekTarget),
        resetHtml5Element: () => {
          this._seekAbort.abort();
          this._seekAbort = new AbortController();
          this.audio.currentTime = this.clipStart;
        },
        releaseHtml5Element: () => this._releaseHtml5Element(),
        dropPendingDecode: () => this._dropPendingDecode(),
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
      `Track.play() track=${this.key} machineState=${this._actor.getSnapshot().value} hasBuffer=${!!this.audioBuffer} hasCtx=${!!this.ctx} audioPaused=${this.audio.paused}`
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
    if (this.gainNode) {
      // Drop a pending fade (fadeOutForUnload) so the new level holds.
      this.gainNode.gain.cancelScheduledValues(0);
      this.gainNode.gain.value = vol;
    }
    this._actor.send({ type: 'SET_VOLUME', volume: vol });
  }

  /**
   * Ramp this track's output to silence over `seconds`, from wherever it is:
   * the page is going away. When the browser then destroys the AudioContext
   * the output is already near zero, instead of being cut mid-waveform (a
   * click). Undone by setVolume().
   */
  fadeOutForUnload(seconds: number): void {
    const gain = this.gainNode?.gain;
    if (!gain || !this.ctx) return;
    const now = this.ctx.currentTime;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(0, now + seconds);
  }

  setPlaybackRate(rate: number): void {
    // A clip-end mute was timed for the old rate; it re-arms near the end.
    if (this._actor.getSnapshot().value === 'html5') this.cancelHtml5Mute();
    if (
      this.ctx &&
      this.sourceNode &&
      this._actor.getSnapshot().context.isPlaying &&
      this.ctx.currentTime >= this._waRefCtxTime
    ) {
      const oldRate = this.sourceNode.playbackRate.value;
      this._waRefTrackTime =
        this._waRefTrackTime + (this.ctx.currentTime - this._waRefCtxTime) * oldRate;
      this._waRefCtxTime = this.ctx.currentTime;
    }
    this.audio.playbackRate = rate;
    if (this.sourceNode) {
      this.sourceNode.playbackRate.value = rate;
      if (this.audioBuffer && this.ctx) {
        const remaining = this._bufferClipLength - this._waRefTrackTime;
        try {
          this.sourceNode.stop(this._waRefCtxTime + Math.max(0, remaining) / rate);
        } catch {
          /* already stopped */
        }
      }
    }
  }

  preload(): void {
    this.queueRef.onDebug(
      `preload() track=${this.key} state=${this._actor.getSnapshot().value} hasBuffer=${!!this.audioBuffer} hasCtx=${!!this.ctx}`
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

  /**
   * Let go of this track's Web Audio data, so a track out of the preload
   * window doesn't hold memory (a decoded hour of audio is hundreds of MB):
   * abort its download, drop a decode in progress when it finishes (decoding
   * can't be aborted), or release its decoded buffer. It loads again from
   * scratch if it comes back into the window. Never while it's playing,
   * scheduled to play, or waiting for its buffer to play. Returns whether
   * anything was let go.
   */
  unload(): boolean {
    const { context } = this._actor.getSnapshot();
    // An element buffering ahead for a crossfade stops too.
    if (this._primed && !context.isPlaying && !context.pendingPlay && !this._html5Start) {
      this._releaseHtml5Element();
    }
    const state = context.webAudioLoadingState;
    if (state !== 'LOADING' && state !== 'LOADED') return false;
    if (context.isPlaying || context.pendingPlay) return false;
    this.queueRef.onDebug(`unload() track=${this.key} state=${state}`);
    this._dropPendingDecode();
    this.audioBuffer = null;
    // A track that ended on Web Audio keeps its finished source node, whose
    // buffer is the decoded audio: let it go too, or the memory stays held.
    this._stopSourceNode();
    this._actor.send({ type: 'UNLOAD' });
    return true;
  }

  activate(): void {
    this._actor.send({ type: 'ACTIVATE' });
  }

  deactivate(): void {
    this.queueRef.onDebug(
      `Track.deactivate() track=${this.key} machineState=${this._actor.getSnapshot().value} isPlaying=${this.isPlaying}`
    );
    this._notifiedPreloadThreshold = false;
    this._actor.send({ type: 'DEACTIVATE' });
    this.queueRef.onDebug(
      `Track.deactivate() done track=${this.key} machineState=${this._actor.getSnapshot().value}`
    );
  }

  destroy(): void {
    if (this._html5Start?.timer) clearTimeout(this._html5Start.timer);
    this._html5Start = null;
    this.deactivate();
    this._releaseHtml5Element(); // stop any download the element still has going
    this._dropPendingDecode();
    this.audioBuffer = null;
    this.gainNode?.disconnect();
    this.gainNode = null;
    this._destroyed = true;
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
    this._clipEndMuteAt = null;
    if (!this._html5GainNode || !this.ctx) return;
    this._html5GainNode.gain.cancelScheduledValues(this.ctx.currentTime);
    this._html5GainNode.gain.setValueAtTime(1, this.ctx.currentTime);
  }

  /** Seconds to crossfade into this track, or null to use the queue's default. */
  get crossfadeIn(): number | null {
    return this._crossfadeIn;
  }

  /** Change the fade into this track (the queue reschedules a pending transition). */
  setCrossfadeIn(seconds: number | null): void {
    this._crossfadeIn = seconds;
  }

  /**
   * Re-aim a fade in progress: from wherever the level is now to `to` by
   * `end` (a playback-rate change moved the end). Linear from the current
   * level, so nothing jumps.
   */
  retimeFade(to: 0 | 1, end: number): void {
    const gain = this._fadeGainNode?.gain;
    if (!gain || !this.ctx) return;
    const now = this.ctx.currentTime;
    const from = gain.value;
    gain.cancelScheduledValues(0);
    gain.setValueAtTime(from, now);
    gain.linearRampToValueAtTime(to, Math.max(end, now + 0.01));
  }

  /** Undo scheduleGaplessStart or scheduleHtml5Start, stopping the track if it began. */
  cancelGaplessStart(): void {
    this._cancelHtml5Start();
    const snap = this._actor.getSnapshot();
    if (snap.context.scheduledStartContextTime === null) return;
    this._scheduledFadeIn = 0;
    this._actor.send({ type: 'CANCEL_GAPLESS' });
  }

  /**
   * Whether this track can fade while streaming over HTML5: its element is
   * routed through the AudioContext (and so through the fade node). Not in
   * HTML5_ONLY mode, nor if routing failed; there only a cut is possible.
   */
  get canFadeHtml5(): boolean {
    return !!this.ctx && !!this._html5GainNode && !!this._fadeGainNode;
  }

  /**
   * For a crossfade into a track that isn't decoded yet: start streaming it
   * over HTML5 at `when` (AudioContext time), fading in over `fadeIn`. A fade
   * needn't be sample-accurate, so a timer starting the element is enough;
   * the fade node holds it silent until `when`. The element is primed now so
   * it can start promptly. If the decode finishes mid-fade, the track crosses
   * over to Web Audio with the fade intact.
   */
  scheduleHtml5Start(when: number, fadeIn: number): boolean {
    if (this._playbackMethod !== 'HYBRID' || !this.canFadeHtml5 || !this.ctx) return false;
    const state = this._actor.getSnapshot().value;
    if (state !== 'idle' && state !== 'loading') return false;
    this._cancelHtml5Start();
    this._rampFade(FADE_IN_CURVE, when, fadeIn);
    this.primeHtml5(); // buffer from the clip start ahead of time (once)
    const delayMs = Math.max(0, (when - this.ctx.currentTime) * 1000);
    this._html5Start = {
      when,
      fadeIn,
      timer: setTimeout(() => {
        if (!this._html5Start) return;
        this._html5Start.timer = null;
        this.queueRef.onDebug(
          `html5 crossfade start track=${this.key} fadeIn=${fadeIn.toFixed(2)}s`
        );
        this.play();
        // play() resets the fade for a fresh start; this one is part of a fade.
        this._rampFade(FADE_IN_CURVE, when, fadeIn);
      }, delayMs),
    };
    return true;
  }

  /**
   * Start the element buffering from the clip start, for a crossfade that
   * may have to stream this track in before it is decoded. Once: a second
   * call before the metadata arrives would reload the element and throw away
   * what it has buffered (on a slow link, the difference between a fade and
   * seconds of silence). Released by unload() and destroy().
   */
  primeHtml5(): void {
    if (this._primed || this._playbackMethod !== 'HYBRID' || !this.canFadeHtml5) return;
    const state = this._actor.getSnapshot().value;
    if (state !== 'idle' && state !== 'loading') return;
    this._primed = true;
    this.queueRef.onDebug(`primeHtml5 track=${this.key}`);
    this._seekHtml5(0);
  }

  /** Whether a start is scheduled (Web Audio or HTML5) and hasn't been cancelled. */
  get hasScheduledStart(): boolean {
    return this.scheduledStartContextTime !== null || this._html5Start !== null;
  }

  private _cancelHtml5Start(): void {
    const pending = this._html5Start;
    if (!pending) return;
    this._html5Start = null;
    if (pending.timer !== null) {
      clearTimeout(pending.timer);
      this._resetFade();
      return;
    }
    // It started: stop it and put it back to the clip start.
    this.deactivate();
    this._resetFade();
  }

  /**
   * The queue reached this track (its predecessor ended). A pending HTML5
   * start turns into the track simply playing on; one whose timer hasn't
   * fired yet (the predecessor ended early) starts now.
   */
  takeOverScheduledStart(): void {
    const pending = this._html5Start;
    if (!pending) return;
    this._html5Start = null;
    if (pending.timer !== null) {
      clearTimeout(pending.timer);
      this._resetFade();
      this.play();
    }
  }

  /**
   * Start this track at `when` on the AudioContext clock: gapless, or fading
   * in over `fadeIn` seconds while the previous track fades out.
   */
  scheduleGaplessStart(when: number, fadeIn = 0): boolean {
    if (!this.ctx || !this.audioBuffer || !this.gainNode) return false;
    const state = this._actor.getSnapshot().value;
    if (state !== 'idle' && state !== 'loading') return false;
    this._scheduledFadeIn = fadeIn;
    this._actor.send({ type: 'SCHEDULE_GAPLESS', when });
    return true;
  }

  /** Fade this (playing) track out over `duration` seconds from `at`, for a crossfade. */
  scheduleFadeOut(at: number, duration: number): void {
    this._rampFade(FADE_OUT_CURVE, at, duration);
  }

  /** Undo scheduleFadeOut: back to full level now. */
  cancelFadeOut(): void {
    this._resetFade();
  }

  /** Where Web Audio sources connect: the fade node (made with gainNode in the ctx getter). */
  private get _sourceOutput(): AudioNode {
    const out = this._fadeGainNode ?? this.gainNode;
    if (!out) throw new Error('gapless: no Web Audio output for this track');
    return out;
  }

  private _rampFade(curve: Float32Array, at: number, duration: number): void {
    const gain = this._fadeGainNode?.gain;
    if (!gain || !this.ctx) return;
    gain.cancelScheduledValues(0);
    // setValueCurveAtTime throws if any other event falls strictly inside the
    // curve, so anchor both at the same time, never in the past.
    const start = Math.max(at, this.ctx.currentTime);
    const left = at + duration - start;
    if (left <= 0) {
      gain.setValueAtTime(curve[curve.length - 1], start);
      return;
    }
    gain.value = curve[0];
    gain.setValueCurveAtTime(curve, start, left);
  }

  private _resetFade(): void {
    const gain = this._fadeGainNode?.gain;
    if (!gain || !this.ctx) return;
    gain.cancelScheduledValues(0);
    gain.setValueAtTime(1, this.ctx.currentTime);
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
      return Math.max(
        0,
        this._waRefTrackTime +
          (this.ctx.currentTime - this._waRefCtxTime) * this.queueRef.playbackRate
      );
    }
    if ((snap.value === 'idle' || snap.value === 'loading') && snap.context.seekTarget > 0) {
      return snap.context.seekTarget;
    }
    // Before the element has seeked to clipStart it reads below it; past
    // clipEnd it can read a frame beyond it until the clip-end check stops it.
    const t = Math.max(0, this.audio.currentTime - this.clipStart);
    const dur = this.duration;
    return isNaN(dur) ? t : Math.min(t, dur);
  }

  /** Clip length in seconds. Known up front for a clip with an end; else NaN until loaded. */
  get duration(): number {
    const file = this._fileDuration;
    if (this.clipEnd === null) return Math.max(0, file - this.clipStart);
    const end = isNaN(file) ? this.clipEnd : Math.min(this.clipEnd, file);
    return Math.max(0, end - this.clipStart);
  }

  /** The whole file's duration, from whichever backend knows it. */
  private get _fileDuration(): number {
    const snap = this._actor.getSnapshot();
    if (snap.value === 'html5' && !isNaN(this.audio.duration)) {
      return this.audio.duration;
    }
    if (this.audioBuffer) return this.audioBuffer.duration;
    return this.audio.duration;
  }

  /** Playable length of the clip within the decoded buffer (music time). */
  private get _bufferClipLength(): number {
    if (!this.audioBuffer) return 0;
    const bufEnd = this.audioBuffer.duration - this._bufferStartPaddingSec;
    const end = this.clipEnd === null ? bufEnd : Math.min(this.clipEnd, bufEnd);
    return Math.max(0, end - this.clipStart);
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

  /** The URL the track was created with, before any redirect was resolved. */
  get sourceUrl(): string {
    return this._trackUrl;
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
    const bufferRemaining = this._bufferClipLength - this._waRefTrackTime;
    return this._waRefCtxTime + bufferRemaining / rate;
  }

  get isBufferLoaded(): boolean {
    return this.audioBuffer !== null;
  }

  toInfo(): TrackInfo {
    return {
      index: this.queueRef.indexOf(this),
      key: this.key,
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
    // A fresh start (play, resume) ends any crossfade this track was in,
    // and any mute left on the element (a clip end, a gapless end).
    this._resetFade();
    this.cancelHtml5Mute();
    if (this.audio.preload !== 'auto') this.audio.preload = 'auto';
    this.audio.playbackRate = this.queueRef.playbackRate;
    const target = this.clipStart + seekTarget;
    if (target > 0 && Math.abs(this.audio.currentTime - target) > 0.01) {
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
      }
    }
    const promise = this.audio.play();
    if (promise) {
      promise.catch((err: unknown) => {
        if (err instanceof Error && err.name === 'NotAllowedError') {
          // First, so the queue (and the app's callback) see a stopped track.
          this._actor.send({ type: 'PLAY_BLOCKED' });
          this.queueRef.onPlayBlocked();
        } else if (err instanceof Error && err.name === 'AbortError') {
          // Browser aborted — element will recover on next play()
        } else {
          this.queueRef.onError(err instanceof Error ? err : new Error(String(err)));
        }
      });
    }
  }

  /**
   * A fetch or decode that finishes from now on is dropped (see unload()),
   * and this track lets go of the shared buffer: the file's last holder out
   * frees it, or aborts its download.
   */
  private _dropPendingDecode(): void {
    this._loadGeneration++;
    this._pendingBuffer = null;
    releaseBuffer(this._trackUrl, this);
  }

  private async _fetchAndDecode(url: string, signal: AbortSignal): Promise<AudioBuffer> {
    // Low priority: this whole-file download is for a later handoff to Web
    // Audio, and mustn't starve the elements playing now or about to.
    const res = await fetch(url, { signal, priority: 'low' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const bytes = await res.arrayBuffer();
    // The shared context, not this.ctx: the load outlives this track when
    // others share it, and this.ctx would rebuild a destroyed track's nodes.
    const ctx = getAudioContext();
    if (!ctx) throw new Error('No AudioContext');
    return ctx.decodeAudioData(bytes);
  }

  /**
   * Stop the element's download without an error event: drop its source
   * (which aborts the fetch) and put it back unloaded, so the next play()
   * starts it fresh.
   */
  private _releaseHtml5Element(): void {
    this._primed = false;
    this.audio.pause();
    this._seekAbort.abort();
    this._seekAbort = new AbortController();
    this.audio.preload = 'none';
    this.audio.removeAttribute('src');
    this.audio.load();
    this.audio.src = this._trackUrl;
  }

  private _seekHtml5(clipTime: number): void {
    if (!isFinite(clipTime)) return;
    this.cancelHtml5Mute(); // a clip-end mute armed for the old position
    const target = this.clipStart + clipTime;
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

    const htmlTime = Math.max(0, this.audio.currentTime - this.clipStart);
    const offset = isFinite(seekTarget) && seekTarget > htmlTime ? seekTarget : htmlTime;
    this._crossoverComputedOffset = isFinite(offset) ? offset : 0;

    if (!wasPlaying) {
      this.audio.pause();
      this.queueRef.onDebug(
        `crossoverHtml5ToWebAudio track=${this.key} offset=${this._crossoverComputedOffset.toFixed(3)} wasPlaying=false`
      );
      return;
    }

    // The element keeps playing through the start lead and the fade, and once
    // the machine is in webaudio nothing polls for the clip end. So a clip
    // whose end falls inside that window must silence the element there.
    const clipEndCtx = this._html5ClipEndContextTime();
    // Not a fresh start: a crossfade this track is in carries on over Web Audio.
    const when = this._startSourceNode(this._crossoverComputedOffset, CROSSOVER_FADE_SEC, false);

    if (when !== null && this._html5GainNode) {
      const now = this.ctx.currentTime;
      const fadeEnd = when + CROSSOVER_FADE_SEC;
      // Without a clip end in the way this is the plain fade: 1 at `when`, 0 at fadeEnd.
      const muteBy = clipEndCtx === null ? fadeEnd : Math.max(now, Math.min(fadeEnd, clipEndCtx));
      const rampFrom = Math.max(now, Math.min(when, muteBy - 0.005));
      this._html5GainNode.gain.cancelScheduledValues(rampFrom);
      this._html5GainNode.gain.setValueAtTime(1, rampFrom);
      this._html5GainNode.gain.linearRampToValueAtTime(0, muteBy);
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
        const stopAt = clipEndCtx === null ? when : Math.min(when, clipEndCtx);
        const delayMs = (stopAt - this.ctx.currentTime) * 1000;
        setTimeout(
          () => {
            this.audio.volume = 0;
            this.audio.pause();
            this.audio.volume = 1;
          },
          Math.max(0, delayMs)
        );
      } else {
        this.audio.volume = 0;
        this.audio.pause();
        this.audio.volume = 1;
      }
    }

    this.queueRef.onDebug(
      `crossoverHtml5ToWebAudio track=${this.key} offset=${this._crossoverComputedOffset.toFixed(3)} wasPlaying=true fade=${CROSSOVER_FADE_SEC}s mediaSource=${!!this._html5GainNode} when=${when?.toFixed(3) ?? 'null'}`
    );
  }

  /** AudioContext time at which the HTML5 element reaches clipEnd, or null without one. */
  private _html5ClipEndContextTime(): number | null {
    if (this.clipEnd === null || !this.ctx) return null;
    const rate = this.audio.playbackRate || 1;
    return this.ctx.currentTime + Math.max(0, this.clipEnd - this.audio.currentTime) / rate;
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
      `_maybeComputeBufferAlignment track=${this.key} bufferDur=${this.audioBuffer.duration.toFixed(3)}s html5Dur=${isNaN(this.audio.duration) ? 'NaN' : this.audio.duration.toFixed(3) + 's'} (alignment shift disabled — see comment)`
    );
  }

  private _startSourceNode(offset: number, fadeInSec = 0, freshStart = true): number | null {
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
      : Math.max(
          0.02,
          2 * ((this.ctx as unknown as { baseLatency?: number }).baseLatency || 0) + 0.01
        );
    const when = this.ctx.currentTime + lead;

    const rate = this.queueRef.playbackRate;
    const maxOffset = this._bufferClipLength;
    const effectiveOffset = Math.min(offset + lead * rate, maxOffset);

    // A fresh start (play, seek, resume) ends any crossfade this track was in.
    if (freshStart) this._resetFade();
    if (fadeInSec > 0) {
      const fadeNode = this.ctx.createGain();
      fadeNode.gain.setValueAtTime(0, when);
      fadeNode.gain.linearRampToValueAtTime(1, when + fadeInSec);
      this.sourceNode.connect(fadeNode);
      fadeNode.connect(this._sourceOutput);
    } else {
      this.sourceNode.connect(this._sourceOutput);
    }
    this.sourceNode.onended = this._handleWebAudioEnded;

    this._waRefCtxTime = when;
    this._waRefTrackTime = effectiveOffset;
    this.sourceNode.start(when, effectiveOffset + this._bufferStartPaddingSec + this.clipStart);

    // Always stop, even with nothing left (a seek to the clip end, or a start
    // within one lead of it): a clip ends before its file, and an unstopped
    // source would play on through the rest of the file.
    const bufRemaining = maxOffset - effectiveOffset;
    this.sourceNode.stop(when + Math.max(0, bufRemaining) / rate);
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
      `_handleWebAudioEnded track=${this.key} sourceNode=${!!this.sourceNode} queueCurrent=${this.queueRef.currentKey}`
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
      this.queueRef.onProgress(this, this.toInfo());
      if (this._checkHtml5ClipEnd()) {
        this.rafId = null;
        return;
      }

      const remaining = this.duration - this.currentTime;
      const snap = this._actor.getSnapshot();
      // Ask for the next transition this many wall-clock seconds before the
      // end (the queue's scheduling horizon is in wall-clock seconds too), and
      // a crossfade's length earlier still. `remaining` is in track time,
      // which passes at the playback rate.
      const lead =
        (GAPLESS_SCHEDULE_LOOKAHEAD + (this.queueRef.crossfadeAfter?.(this) ?? 0)) *
        this.queueRef.playbackRate;
      if (!snap.context.notifiedLookahead && !isNaN(remaining) && remaining <= lead) {
        this._actor.send({ type: 'LOOKAHEAD_REACHED' });
        queueMicrotask(() => this.queueRef.onTrackBufferReady(this));
      }

      const preloadThreshold = isNaN(this.duration)
        ? PRELOAD_DELAY
        : Math.min(this.duration * 0.2, PRELOAD_DELAY);
      if (!this._notifiedPreloadThreshold && this.currentTime >= preloadThreshold) {
        this._notifiedPreloadThreshold = true;
        queueMicrotask(() => this.queueRef.onPreloadReady(this));
      }

      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  /**
   * End an HTML5-playing clip once the element reaches clipEnd. Web Audio
   * needs no check: its source node is stopped at the clip end. Returns
   * whether it ended the track.
   */
  private _checkHtml5ClipEnd(): boolean {
    if (this.clipEnd === null) return false;
    const snap = this._actor.getSnapshot();
    if (snap.value !== 'html5' || !snap.context.isPlaying) return false;
    if (this.audio.currentTime < this.clipEnd) {
      // Polling only notices the end afterwards (by up to a timeupdate,
      // ~250 ms, in a background tab), so once it is near, silence the
      // element exactly at clipEnd on the AudioContext clock. A seek, a
      // fresh start or a rate change puts the gain back (cancelHtml5Mute).
      const left = (this.clipEnd - this.audio.currentTime) / (this.audio.playbackRate || 1);
      if (left < CLIP_END_ARM_SEC && this._html5GainNode && this.ctx) {
        const now = this.ctx.currentTime;
        const at = now + left;
        const armed = this._clipEndMuteAt;
        // Arm once; re-aim when the predicted end moves, as it does when the
        // element stalls to buffer while the AudioContext clock runs on (a
        // mute aimed at the old end would cut off the rest of the clip).
        if (armed === null || Math.abs(at - armed) > CLIP_END_DRIFT_SEC) {
          const gain = this._html5GainNode.gain;
          if (armed !== null) {
            gain.cancelScheduledValues(now);
            gain.setValueAtTime(1, now);
          }
          this._clipEndMuteAt = at;
          gain.setValueAtTime(0, at);
        }
      }
      return false;
    }
    this.queueRef.onDebug(
      `clip end reached on HTML5 track=${this.key} audioTime=${this.audio.currentTime.toFixed(3)} clipEnd=${this.clipEnd}`
    );
    this.audio.pause();
    this._actor.send({ type: 'HTML5_ENDED' });
    return true;
  }

  private _stopProgressLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
}
