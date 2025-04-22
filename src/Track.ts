import Queue from './Queue';

const isBrowser: boolean = typeof window !== 'undefined';
const audioContext: AudioContext | null =
  isBrowser && (window.AudioContext || (window as any).webkitAudioContext)
    ? new (window.AudioContext || (window as any).webkitAudioContext)()
    : null;

// Use Enums for better type safety
enum GaplessPlaybackType {
  HTML5 = 'HTML5',
  WEBAUDIO = 'WEBAUDIO',
}

enum GaplessPlaybackLoadingState {
  NONE = 'NONE',
  LOADING = 'LOADING',
  LOADED = 'LOADED',
}

interface TrackProps {
  trackUrl: string;
  skipHEAD?: boolean;
  queue: Queue;
  idx: number;
  metadata?: Record<string, any>;
}

interface TrackState {
  playbackType: GaplessPlaybackType;
  webAudioLoadingState: GaplessPlaybackLoadingState;
}

interface TrackCompleteState extends TrackState {
  isPaused: boolean;
  currentTime: number;
  duration: number;
  idx: number;
  id?: any; // Assuming metadata.trackId can be any type
}

export default class Track {
  // Playback state
  playbackType: GaplessPlaybackType;
  webAudioLoadingState: GaplessPlaybackLoadingState;
  loadedHEAD: boolean;

  // Basic info
  idx: number;
  queue: Queue;
  trackUrl: string;
  skipHEAD?: boolean;
  metadata: Record<string, any>;

  // HTML5 Audio
  audio: HTMLAudioElement;

  // WebAudio API elements (nullable)
  audioContext: AudioContext | null;
  gainNode: GainNode | null;
  bufferSourceNode: AudioBufferSourceNode | null;
  audioBuffer: AudioBuffer | null;

  // WebAudio timing state
  webAudioStartedPlayingAt: number; // Time from audioContext.currentTime when playback started
  webAudioPausedDuration: number; // Total duration spent paused
  webAudioPausedAt: number; // Timestamp (audioContext.currentTime) when paused

  // Bound methods for event listeners
  private boundOnEnded: (from?: string | Event) => void;
  private boundOnProgress: () => void;
  private boundAudioOnError: (e: Event | string) => void;

  private progressFrameId: number | null = null; // Store requestAnimationFrame ID

  constructor({ trackUrl, skipHEAD, queue, idx, metadata = {} }: TrackProps) {
    // playback type state
    this.playbackType = GaplessPlaybackType.HTML5;
    this.webAudioLoadingState = GaplessPlaybackLoadingState.NONE;
    this.loadedHEAD = false;

    // basic inputs from Queue
    this.idx = idx;
    this.queue = queue;
    this.trackUrl = trackUrl;
    this.skipHEAD = skipHEAD;
    this.metadata = metadata;

    // Bind methods to ensure 'this' context
    this.boundOnEnded = (from?: string | Event) => this.onEnded(from);
    this.boundOnProgress = () => this.onProgress();
    this.boundAudioOnError = (e: Event | string) => this.audioOnError(e);

    // HTML5 Audio
    this.audio = new Audio();
    this.audio.onerror = this.boundAudioOnError;
    this.audio.onended = () => this.boundOnEnded('HTML5'); // Use bound method
    this.audio.controls = false;
    this.audio.volume = queue.state.volume;
    this.audio.preload = 'none'; // Explicitly 'none' initially
    this.audio.src = trackUrl;
    // this.audio.onprogress = () => this.debug(this.idx, this.audio.buffered)

    // WebAudio Initialization (only if supported and not disabled)
    this.audioContext = queue.state.webAudioIsDisabled ? null : audioContext;
    this.gainNode = null;
    this.bufferSourceNode = null;
    this.audioBuffer = null;
    this.webAudioStartedPlayingAt = 0;
    this.webAudioPausedDuration = 0;
    this.webAudioPausedAt = 0;

    if (this.audioContext) {
      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = queue.state.volume;
      // Don't create bufferSourceNode until needed
    }
  }

  // private functions
  private loadHEAD(cb: () => void): void {
    if (this.loadedHEAD || this.skipHEAD) {
      cb();
      return;
    }

    const options: RequestInit = {
      method: 'HEAD',
    };

    fetch(this.trackUrl, options)
      .then((res) => {
        if (res.redirected && res.url) {
          this.trackUrl = res.url;
          // If URL changed, might need to update HTMLAudioElement src?
          // Only if not already playing/loaded via HTML5.
          if (this.audio.src !== this.trackUrl && this.audio.readyState === 0) {
            this.audio.src = this.trackUrl;
          }
        }
        this.loadedHEAD = true;
        cb();
      })
      .catch((err) => {
        console.error(`HEAD request failed for track ${this.idx}:`, err);
        // Decide how to proceed, maybe try loading directly?
        cb(); // Or maybe call an error handler
      });
  }

  private loadBuffer(cb?: (buffer: AudioBuffer) => void): void {
    if (
      !this.audioContext ||
      this.webAudioLoadingState !== GaplessPlaybackLoadingState.NONE ||
      this.queue.state.webAudioIsDisabled
    ) {
      return;
    }

    this.webAudioLoadingState = GaplessPlaybackLoadingState.LOADING;
    this.debug('starting download');

    fetch(this.trackUrl)
      .then((res) => {
        if (!res.ok) {
          throw new Error(`HTTP error! status: ${res.status}`);
        }
        return res.arrayBuffer();
      })
      .then((arrayBuffer) =>
        this.audioContext!.decodeAudioData(
          // Use non-null assertion as we checked audioContext
          arrayBuffer,
          (buffer) => {
            this.debug('finished decoding track');

            this.webAudioLoadingState = GaplessPlaybackLoadingState.LOADED;
            this.audioBuffer = buffer;

            // Create and connect the source node *now* that we have the buffer
            // Don't connect gainNode to destination until play()
            // this.bufferSourceNode = this.createBufferSourceNode(); // Moved node creation

            // try to preload next track (WebAudio buffer)
            this.queue.loadTrack(this.idx + 1);

            // if we loaded the active track, switch to web audio if it was playing HTML5
            if (
              this.isActiveTrack &&
              this.playbackType === GaplessPlaybackType.HTML5 &&
              !this.isPaused
            ) {
              this.switchToWebAudio();
            } else if (
              this.isActiveTrack &&
              this.playbackType === GaplessPlaybackType.HTML5 &&
              this.isPaused
            ) {
              // If it was paused HTML5, just mark ready for WebAudio, don't auto-play
              this.playbackType = GaplessPlaybackType.WEBAUDIO;
              this.debug('WebAudio ready for paused track');
            } else if (!this.isActiveTrack) {
              // If it's not the active track, just mark ready
              this.playbackType = GaplessPlaybackType.WEBAUDIO;
              this.debug('WebAudio ready for inactive track');
            }

            cb?.(buffer);
          },
          (err) => {
            console.error(`Error decoding audio data for track ${this.idx}:`, err);
            this.webAudioLoadingState = GaplessPlaybackLoadingState.NONE; // Reset state on decode error
          }
        )
      )
      .catch((e) => {
        this.debug('caught fetch/decode error', e);
        this.webAudioLoadingState = GaplessPlaybackLoadingState.NONE; // Reset state on fetch error
      });
  }

  private createBufferSourceNode(): AudioBufferSourceNode | null {
    if (!this.audioContext || !this.audioBuffer || !this.gainNode) return null;

    const node = this.audioContext.createBufferSource();
    node.buffer = this.audioBuffer;
    node.connect(this.gainNode); // Connect source to gain
    node.onended = () => this.boundOnEnded('webaudio_auto'); // Use bound method
    return node;
  }

  private switchToWebAudio(forcePause: boolean = false): void {
    // Ensure WebAudio is ready and we are the active track (unless forced)
    if (
      !this.audioContext ||
      !this.audioBuffer ||
      !this.gainNode ||
      this.webAudioLoadingState !== GaplessPlaybackLoadingState.LOADED
    ) {
      this.debug('Cannot switch to WebAudio: not ready.');
      return;
    }
    if (!this.isActiveTrack && !forcePause) {
      this.debug('Cannot switch to WebAudio: not active track.');
      return;
    }

    const wasPaused = this.audio.paused; // State *before* switching
    const currentTime = this.audio.currentTime; // Time *before* switching

    this.debug(
      'Attempting switch to web audio',
      `currentTime: ${currentTime}`,
      `wasPaused: ${wasPaused}`,
      `HTML5 duration: ${this.audio.duration}`,
      `WebAudio duration: ${this.audioBuffer.duration}`
    );

    // Stop HTML5 audio
    this.audio.pause();

    // Disconnect previous WebAudio node if exists
    this.stopAndDisconnectSourceNode();

    // Create and configure the new source node
    this.bufferSourceNode = this.createBufferSourceNode();
    if (!this.bufferSourceNode) {
      this.debug('Failed to create buffer source node for switch');
      // Revert? Or stay paused?
      this.playbackType = GaplessPlaybackType.HTML5; // Revert type
      return;
    }

    // Connect gain to destination *before* starting
    this.connectGainNode();

    // Calculate start time for WebAudio context
    this.webAudioStartedPlayingAt = this.audioContext.currentTime - currentTime;
    this.webAudioPausedDuration = 0; // Reset pause duration
    this.webAudioPausedAt = 0; // Reset pause timestamp

    // Start the buffer source
    try {
      this.bufferSourceNode.start(0, currentTime);
      this.debug(
        `WebAudio started at context time ${this.audioContext.currentTime}, track time ${currentTime}`
      );
    } catch (e) {
      console.error('Error starting buffer source node:', e);
      this.playbackType = GaplessPlaybackType.HTML5; // Revert type on error
      this.disconnectGainNode(); // Disconnect gain if start failed
      return;
    }

    // Handle initial pause state
    if (wasPaused || forcePause) {
      this.pauseWebAudio(); // Use dedicated pause logic
      this.debug('Switched to WebAudio (Paused)');
    } else {
      // Ensure playback rate is 1 if it wasn't paused
      this.bufferSourceNode.playbackRate.value = 1;
      this.debug('Switched to WebAudio (Playing)');
    }

    this.playbackType = GaplessPlaybackType.WEBAUDIO;
  }

  // public-ish functions
  pause(): void {
    this.debug('pause command received');
    if (this.isUsingWebAudio) {
      this.pauseWebAudio();
    } else {
      this.audio.pause();
      this.cancelProgressFrame(); // Stop progress updates
    }
  }

  private pauseWebAudio(): void {
    if (!this.audioContext || !this.bufferSourceNode || this.isPaused) {
      // Already paused or not ready
      return;
    }
    this.webAudioPausedAt = this.audioContext.currentTime;
    // Instead of setting playbackRate to 0, which can cause issues,
    // we disconnect the gain node. Reconnect on play.
    this.disconnectGainNode();
    // We keep the onended listener active even when paused via disconnect.
    // Setting playbackRate to 0 might be needed for specific effects, but disconnect is safer for pausing.
    // this.bufferSourceNode.playbackRate.value = 0; // Avoid if possible
    this.debug(`WebAudio paused at ${this.webAudioPausedAt}`);
    this.cancelProgressFrame(); // Stop progress updates
  }

  play(): void {
    this.debug('play command received');

    // --- Web Audio Path ---
    if (this.audioBuffer && this.audioContext && !this.queue.state.webAudioIsDisabled) {
      // If already using WebAudio and it's ready
      if (this.isUsingWebAudio) {
        this.playWebAudio();
      }
      // If HTML5 is playing/paused but WebAudio buffer is ready, switch
      else if (this.webAudioLoadingState === GaplessPlaybackLoadingState.LOADED) {
        this.debug('WebAudio buffer ready, switching from HTML5...');
        this.switchToWebAudio(); // This will handle starting playback
        this.requestProgressFrame(); // Start progress updates after switch
      }
      // If WebAudio is loading, play HTML5 for now and switch when ready
      else if (this.webAudioLoadingState === GaplessPlaybackLoadingState.LOADING) {
        this.debug('WebAudio loading, playing HTML5 temporarily...');
        this.playHtml5Audio();
      }
      // If WebAudio hasn't started loading, start loading and play HTML5
      else {
        this.debug('WebAudio not loaded, starting load and playing HTML5...');
        this.preload(); // Start WebAudio load
        this.playHtml5Audio();
      }
    }
    // --- HTML5 Audio Path ---
    else {
      this.playHtml5Audio();
    }

    // Try to preload the next track (can be HTML5 or WebAudio)
    this.queue.loadTrack(this.idx + 1);
  }

  private playWebAudio(): void {
    if (!this.audioContext || !this.bufferSourceNode || !this.isPaused) {
      // Already playing or not ready
      return;
    }

    if (this.webAudioPausedAt > 0) {
      const pauseDuration = this.audioContext.currentTime - this.webAudioPausedAt;
      this.webAudioPausedDuration += pauseDuration;
      this.debug(
        `Resuming WebAudio after ${pauseDuration.toFixed(2)}s pause. Total paused: ${this.webAudioPausedDuration.toFixed(2)}s`
      );
    }

    // Reconnect the gain node to the destination to resume sound
    this.connectGainNode();
    // Ensure playback rate is 1 (might not be necessary if using disconnect method)
    // this.bufferSourceNode.playbackRate.value = 1;

    // Reset pause timestamp
    this.webAudioPausedAt = 0;

    this.debug('WebAudio playing');
    this.requestProgressFrame(); // Start progress updates
  }

  private playHtml5Audio(): void {
    if (!this.audio.paused) return; // Already playing

    // Ensure preload is 'auto' before playing
    if (this.audio.preload !== 'auto') {
      this.audio.preload = 'auto';
    }

    const playPromise = this.audio.play();
    if (playPromise !== undefined) {
      playPromise
        .then((_) => {
          // Playback started successfully
          this.debug('HTML5 playing');
          this.requestProgressFrame(); // Start progress updates
          // If WebAudio isn't disabled and hasn't loaded/started loading, trigger load
          if (
            !this.queue.state.webAudioIsDisabled &&
            this.webAudioLoadingState === GaplessPlaybackLoadingState.NONE
          ) {
            this.preload(); // Start WebAudio load in background
          }
        })
        .catch((error) => {
          console.error(`Error playing HTML5 audio for track ${this.idx}:`, error);
          // Handle playback error (e.g., user interaction needed)
          this.boundAudioOnError(`Playback error: ${error.message}`);
        });
    } else {
      // Fallback for older browsers where play() doesn't return a promise
      // Assume playback starts, though errors might not be catchable here.
      this.debug('HTML5 playing (no promise)');
      this.requestProgressFrame();
      if (
        !this.queue.state.webAudioIsDisabled &&
        this.webAudioLoadingState === GaplessPlaybackLoadingState.NONE
      ) {
        this.preload();
      }
    }
  }

  togglePlayPause(): void {
    if (this.isPaused) {
      this.play();
    } else {
      this.pause();
    }
  }

  preload(loadHTML5: boolean = false): void {
    this.debug(`preload called, loadHTML5: ${loadHTML5}`);
    // Preload HTML5 if requested and not already loading/loaded
    if (loadHTML5 && this.audio.preload !== 'auto' && this.audio.readyState < 2) {
      // readyState < HAVE_CURRENT_DATA
      this.debug('preloading HTML5');
      this.audio.preload = 'auto';
      // Note: 'auto' is just a hint, browser decides how much to load.
      // Calling load() might be more explicit if needed: this.audio.load();
    }

    // Preload WebAudio if enabled and not already loading/loaded
    if (
      !this.queue.state.webAudioIsDisabled &&
      this.webAudioLoadingState === GaplessPlaybackLoadingState.NONE
    ) {
      this.debug('preloading WebAudio buffer');
      if (this.skipHEAD) {
        this.loadBuffer();
      } else {
        // Ensure HEAD request completes before loading buffer
        this.loadHEAD(() => this.loadBuffer());
      }
    }
  }

  // TODO: add checks for to > duration or null or negative (duration - to)
  seek(to: number = 0): void {
    const currentDuration = this.duration;
    if (isNaN(currentDuration) || currentDuration <= 0) {
      this.debug('Cannot seek: duration unknown or invalid.');
      return;
    }
    // Clamp seek time to valid range [0, duration]
    const seekTime = Math.max(0, Math.min(to, currentDuration));
    this.debug(`seek command to: ${seekTime} (original: ${to})`);

    if (this.isUsingWebAudio && this.audioContext) {
      this.seekBufferSourceNode(seekTime);
    } else {
      // Check if HTML5 audio is ready to seek
      if (this.audio.readyState >= this.audio.HAVE_METADATA) {
        // HAVE_METADATA or higher
        this.audio.currentTime = seekTime;
      } else {
        this.debug('Cannot seek HTML5: not ready.');
        // Optionally, queue the seek until readyState changes
      }
    }

    // Update progress immediately after seek
    this.onProgress(); // Call directly to update state
  }

  private seekBufferSourceNode(to: number): void {
    if (!this.audioContext || !this.audioBuffer || !this.gainNode) {
      this.debug('Cannot seek WebAudio: context, buffer, or gain node missing.');
      return;
    }

    const wasPaused = this.isPaused; // Check state *before* stopping
    this.debug(`Seeking WebAudio to ${to}. Was paused: ${wasPaused}`);

    // Stop the current node
    this.stopAndDisconnectSourceNode();

    // Create a new source node
    this.bufferSourceNode = this.createBufferSourceNode();
    if (!this.bufferSourceNode) {
      this.debug('Failed to create buffer source node for seek');
      return;
    }

    // Update timing references *before* starting the new node
    this.webAudioStartedPlayingAt = this.audioContext.currentTime - to;
    this.webAudioPausedDuration = 0; // Reset pause duration on seek
    this.webAudioPausedAt = 0; // Reset pause timestamp

    // Start the new node at the desired offset
    try {
      this.bufferSourceNode.start(0, to);
      this.debug(
        `WebAudio started after seek at context time ${this.audioContext.currentTime}, track time ${to}`
      );
    } catch (e) {
      console.error('Error starting buffer source node after seek:', e);
      this.disconnectGainNode(); // Disconnect gain if start failed
      return;
    }

    // Re-apply paused state if necessary
    if (wasPaused) {
      this.pauseWebAudio(); // Use dedicated pause logic
      this.debug('Re-applied paused state after seek.');
    } else {
      // Ensure gain is connected if it wasn't paused
      this.connectGainNode();
      this.debug('Resumed playing state after seek.');
      this.requestProgressFrame(); // Ensure progress updates resume if it was playing
    }
  }

  private stopAndDisconnectSourceNode(): void {
    if (this.bufferSourceNode) {
      try {
        this.bufferSourceNode.onended = null; // Remove listener before stopping
        this.bufferSourceNode.stop();
        this.bufferSourceNode.disconnect(); // Disconnect from gain node
        this.debug('Stopped and disconnected previous source node.');
      } catch (e: any) {
        // Ignore errors like "invalid state" if node already stopped
        if (e.name !== 'InvalidStateError') {
          console.error('Error stopping buffer source node:', e);
        }
      }
      this.bufferSourceNode = null;
    }
  }

  private connectGainNode(): void {
    // Connects gain node to audio context destination if not already connected
    if (this.gainNode && this.audioContext) {
      try {
        // Check connection state if possible (not standard API)
        // As a simple approach, just connect. Redundant connections are usually harmless.
        this.gainNode.connect(this.audioContext.destination);
        // this.debug("Gain node connected to destination.");
      } catch (e) {
        console.error('Error connecting gain node:', e);
      }
    }
  }

  private disconnectGainNode(): void {
    // Disconnects gain node from audio context destination
    if (this.gainNode && this.audioContext) {
      try {
        this.gainNode.disconnect(this.audioContext.destination);
        // this.debug("Gain node disconnected from destination.");
      } catch (e) {
        // Ignore errors if already disconnected
        // console.error("Error disconnecting gain node:", e);
      }
    }
  }

  // basic event handlers
  private audioOnError = (e: Event | string): void => {
    let errorDetails = e;
    if (typeof e !== 'string' && e.target) {
      const mediaError = (e.target as HTMLAudioElement).error;
      errorDetails = `HTML5 Audio Error: code=${mediaError?.code}, message=${mediaError?.message}`;
    }
    this.debug('audioOnError', errorDetails);
    // Potentially trigger a queue-level error handler
    // this.queue.handleError(this, errorDetails);
  };

  private onEnded(from?: string | Event): void {
    this.debug(
      'onEnded triggered',
      `from: ${typeof from === 'string' ? from : 'event'}`,
      `isActive: ${this.isActiveTrack}`
    );

    // Prevent multiple triggers if event fires close together
    if (this.bufferSourceNode) {
      this.bufferSourceNode.onended = null; // Clear listener immediately
    }
    this.audio.onended = null; // Clear listener

    this.cancelProgressFrame(); // Stop progress updates

    // Only trigger next track if this track *was* the active one when it ended
    if (this.isActiveTrack) {
      this.queue.playNext(); // Let the queue handle playing the next track
      // The queue's onEnded prop should be called by playNext or the queue itself
      // this.queue.onEnded(); // Avoid calling this directly here, let queue manage its state
    } else {
      this.debug('onEnded ignored for inactive track');
      // Reset state for this inactive track if needed
      this.resetStateAfterEnded();
    }
  }

  private resetStateAfterEnded(): void {
    // Reset timing for WebAudio
    this.webAudioStartedPlayingAt = 0;
    this.webAudioPausedDuration = 0;
    this.webAudioPausedAt = 0;
    // Consider resetting bufferSourceNode if WebAudio was used
    this.stopAndDisconnectSourceNode();
    // Reset HTML5 time
    if (this.audio.readyState > 0) {
      this.audio.currentTime = 0;
    }
    // Re-attach listeners if needed for future plays
    this.audio.onended = () => this.boundOnEnded('HTML5');
    if (this.bufferSourceNode && this.audioContext) {
      // Re-create node only when play is called next time
    }
  }

  private onProgress(): void {
    // This function runs inside requestAnimationFrame, avoid heavy computation

    // Ensure the track is still the active one and is playing
    if (!this.isActiveTrack || this.isPaused) {
      this.cancelProgressFrame(); // Stop updates if paused or changed track
      return;
    }

    // --- Calculations (keep efficient) ---
    const currentTime = this.currentTime;
    const duration = this.duration;

    // Check for valid numbers before proceeding
    if (isNaN(currentTime) || isNaN(duration) || duration <= 0) {
      this.requestProgressFrame(); // Continue trying
      return;
    }

    // --- Preloading Logic ---
    const isWithinLastTwentyFiveSeconds = duration - currentTime <= 25;
    const nextTrack = this.queue.nextTrack;

    if (isWithinLastTwentyFiveSeconds && nextTrack && !nextTrack.isLoaded) {
      // Only preload HTML5 here for faster availability, WebAudio preload is handled elsewhere
      this.queue.loadTrack(this.idx + 1, true);
    }

    // --- Callbacks ---
    // Call queue's progress handler (throttle this if it causes performance issues)
    this.queue.onProgress(this);

    // --- Schedule Next Frame ---
    this.requestProgressFrame();
  }

  private requestProgressFrame(): void {
    // Ensure only one frame is scheduled
    this.cancelProgressFrame();
    this.progressFrameId = window.requestAnimationFrame(this.boundOnProgress);
  }

  private cancelProgressFrame(): void {
    if (this.progressFrameId !== null) {
      window.cancelAnimationFrame(this.progressFrameId);
      this.progressFrameId = null;
    }
  }

  setVolume(nextVolume: number): void {
    const clampedVolume = Math.max(0, Math.min(1, nextVolume));
    this.audio.volume = clampedVolume;
    if (this.gainNode) {
      // Use setValueAtTime for smoother transitions if needed, but direct set is often fine
      this.gainNode.gain.value = clampedVolume;
    }
  }

  // getter helpers
  get isUsingWebAudio(): boolean {
    return (
      this.playbackType === GaplessPlaybackType.WEBAUDIO && !this.queue.state.webAudioIsDisabled
    );
  }

  get isPaused(): boolean {
    if (this.isUsingWebAudio && this.audioContext) {
      // Check if gain node is disconnected (our pause method) OR if pausedAt is set
      // Checking connection state directly isn't reliable across browsers.
      // Rely on our webAudioPausedAt flag.
      return this.webAudioPausedAt > 0;
      // Alternative check (less reliable if using disconnect):
      // return this.bufferSourceNode ? this.bufferSourceNode.playbackRate.value === 0 : true;
    } else {
      return this.audio.paused;
    }
  }

  get currentTime(): number {
    if (this.isUsingWebAudio && this.audioContext) {
      if (this.webAudioPausedAt > 0) {
        // If paused, time is frozen at the point it was paused
        return this.webAudioStartedPlayingAt > 0
          ? this.webAudioPausedAt - this.webAudioStartedPlayingAt - this.webAudioPausedDuration
          : 0;
      } else if (this.webAudioStartedPlayingAt > 0) {
        // If playing, calculate current time
        return (
          this.audioContext.currentTime -
          this.webAudioStartedPlayingAt -
          this.webAudioPausedDuration
        );
      } else {
        // If not started yet (e.g., just loaded, before play)
        return 0;
      }
    } else {
      return this.audio.currentTime;
    }
  }

  get duration(): number {
    if (this.isUsingWebAudio && this.audioBuffer) {
      return this.audioBuffer.duration;
    } else {
      // Return NaN if duration is not available (consistent with HTMLMediaElement)
      return this.audio.duration;
    }
  }

  get isActiveTrack(): boolean {
    return this.queue.currentTrack === this;
  }

  get isLoaded(): boolean {
    // Consider loaded if either WebAudio buffer is ready OR HTML5 has enough data
    if (this.webAudioLoadingState === GaplessPlaybackLoadingState.LOADED) {
      return true;
    }
    // HTML5 readyState >= HAVE_FUTURE_DATA indicates enough data for smooth playback
    if (this.audio.readyState >= this.audio.HAVE_FUTURE_DATA) {
      return true;
    }
    return false;
  }

  get state(): TrackState {
    return {
      playbackType: this.playbackType,
      webAudioLoadingState: this.webAudioLoadingState,
    };
  }

  get completeState(): TrackCompleteState {
    return {
      playbackType: this.playbackType,
      webAudioLoadingState: this.webAudioLoadingState,
      isPaused: this.isPaused,
      currentTime: this.currentTime,
      duration: this.duration,
      idx: this.idx,
      id: this.metadata?.trackId, // Access safely
    };
  }

  // debug helper
  debug(first: string, ...args: any[]): void {
    console.debug(
      `[Track ${this.idx} | ${this.playbackType} | ${this.webAudioLoadingState}] ${first}`,
      ...args,
      this.completeState
    );
  }

  // just a helper to quick jump to the end of a track for testing
  seekToEnd(secondsFromEnd: number = 6): void {
    const targetDuration = this.duration;
    if (!isNaN(targetDuration) && targetDuration > secondsFromEnd) {
      this.seek(targetDuration - secondsFromEnd);
    } else {
      this.debug(`Cannot seekToEnd: duration invalid or too short (${targetDuration})`);
    }
  }
}
