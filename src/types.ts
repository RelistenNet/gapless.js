// ---------------------------------------------------------------------------
// Public types for gapless.js
// ---------------------------------------------------------------------------

export type PlaybackType = 'HTML5' | 'WEBAUDIO';

export type WebAudioLoadingState = 'NONE' | 'LOADING' | 'LOADED' | 'ERROR';

/** Metadata attached to a track (arbitrary user data). */
export interface TrackMetadata {
  title?: string;
  artist?: string;
  album?: string;
  artwork?: MediaImage[];
  [key: string]: unknown;
}

/** Options accepted by the Queue constructor. */
export interface GaplessOptions {
  /** Initial list of track URLs. */
  tracks?: string[];
  /** Called at ~60fps while playing. */
  onProgress?: (info: TrackInfo) => void;
  /** Called when the last track in the queue ends. */
  onEnded?: () => void;
  /** Called when the queue advances to the next track. */
  onPlayNextTrack?: (info: TrackInfo) => void;
  /** Called when the queue goes back to the previous track. */
  onPlayPreviousTrack?: (info: TrackInfo) => void;
  /** Called whenever a new track becomes the current track. */
  onStartNewTrack?: (info: TrackInfo) => void;
  /** Called on HTML5 audio errors. */
  onError?: (error: Error) => void;
  /** Called with internal debug messages. Only use for development. */
  onDebug?: (msg: string) => void;
  /** Called when autoplay is blocked by the browser. */
  onPlayBlocked?: () => void;
  /**
   * Set true to disable Web Audio API entirely and use HTML5 audio only.
   * Gapless playback will not be available in this mode.
   */
  webAudioIsDisabled?: boolean;
  /** Per-track metadata (aligned to the tracks array by index). */
  trackMetadata?: TrackMetadata[];
  /** Initial volume, 0.0–1.0. Defaults to 1. */
  volume?: number;
}

/** Options for dynamically adding a track. */
export interface AddTrackOptions {
  /**
   * Skip the HEAD request used to resolve redirects.
   * Set true when the URL is already a direct, final URL.
   */
  skipHEAD?: boolean;
  metadata?: TrackMetadata;
}

/**
 * A plain-data snapshot of a track's current state.
 * Returned by Queue getters and passed to callbacks.
 * No methods — pure data.
 */
export interface TrackInfo {
  /** Zero-based position of this track in the queue. */
  index: number;
  /** Current playback position in seconds. */
  currentTime: number;
  /** Total duration in seconds (NaN until loaded). */
  duration: number;
  /** True if currently playing. */
  isPlaying: boolean;
  /** True if explicitly paused. */
  isPaused: boolean;
  /** Current volume, 0.0–1.0. */
  volume: number;
  /** The resolved URL of the audio file. */
  trackUrl: string;
  /** Which backend is currently producing sound. */
  playbackType: PlaybackType;
  /** Whether the Web Audio buffer has been decoded. */
  webAudioLoadingState: WebAudioLoadingState;
  /** Arbitrary metadata supplied when the track was added. */
  metadata?: TrackMetadata;
  /** Current xstate machine state for this track (e.g. 'idle', 'html5', 'webaudio'). */
  machineState: string;
}
