enum PlaybackType {
  html5,
  webaudio,
}

enum PlaybackLoadingState {
  none,
  loading,
  loaded,
}

export interface QueueOptions {
  onProgress?: () => void;
  onEnded?: () => void;
  onPlayNextTrack?: () => void;
  onPlayPreviousTrack?: () => void;
  onStartNewTrack?: () => void;
  webAudioIsDisabled?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug?: ((message: string, ...optionalParams: any[]) => void) | null;
  numberOfTracksToPreload?: number;
}

interface QueueState {
  volume: number;
  currentTrackIndex: number;
  webAudioIsDisabled: boolean;
}

interface QueueProps<TTrack> {
  onProgress?: (track: Track<TTrack>) => void;
  onEnded?: () => void;
  onPlayNextTrack?: (track: Track<TTrack>) => void;
  onPlayPreviousTrack?: (track: Track<TTrack>) => void;
  onStartNewTrack?: (track: Track<TTrack>) => void;
}

declare global {
  interface Window {
    webkitAudioContext: AudioContext;
  }
}

const AudioContext = window.AudioContext || window.webkitAudioContext;

export class Queue<TTrackMetadata> {
  private props: QueueProps<TTrackMetadata>;

  private numberOfTracksToPreload: number;

  public readonly tracks: Track<TTrackMetadata>[] = [];

  public state: QueueState;

  public constructor({ onProgress, onEnded, onPlayNextTrack, onPlayPreviousTrack, onStartNewTrack, webAudioIsDisabled = false, numberOfTracksToPreload = 2 }: QueueOptions = {}) {
    this.props = {
      onProgress,
      onEnded,
      onPlayNextTrack,
      onPlayPreviousTrack,
      onStartNewTrack,
    };

    this.numberOfTracksToPreload = numberOfTracksToPreload;

    this.state = {
      volume: 1,
      currentTrackIndex: 0,
      webAudioIsDisabled,
    };
  }

  public addTrack({ trackUrl, metadata = {} as TTrackMetadata }: { trackUrl: string; metadata: TTrackMetadata }): void {
    this.tracks.push(
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      new Track({
        trackUrl,
        metadata,
        index: this.tracks.length,
        queue: this,
      }),
    );
  }

  public removeTrack(track: Track<TTrackMetadata>): void {
    const index = this.tracks.indexOf(track);
    this.tracks.splice(index, 1);
  }

  public async togglePlayPause(): Promise<void> {
    if (this.currentTrack) {
      await this.currentTrack.togglePlayPause();
    }
  }

  public async play(): Promise<void> {
    if (this.currentTrack) {
      await this.currentTrack.play();
    }
  }

  public pause(): void {
    if (this.currentTrack) {
      this.currentTrack.pause();
    }
  }

  public async playPrevious(): Promise<void> {
    this.resetCurrentTrack();

    this.state.currentTrackIndex = Math.max(this.state.currentTrackIndex - 1, 0);

    this.resetCurrentTrack();

    await this.play();

    if (this.props.onStartNewTrack) {
      this.props.onStartNewTrack(this.currentTrack);
    }

    if (this.props.onPlayPreviousTrack) {
      this.props.onPlayPreviousTrack(this.currentTrack);
    }
  }

  public async playNext(): Promise<void> {
    this.resetCurrentTrack();

    this.state.currentTrackIndex += 1;

    this.resetCurrentTrack();

    await this.play();

    if (this.props.onStartNewTrack) {
      this.props.onStartNewTrack(this.currentTrack);
    }

    if (this.props.onPlayNextTrack) {
      this.props.onPlayNextTrack(this.currentTrack);
    }
  }

  public resetCurrentTrack(): void {
    if (this.currentTrack) {
      this.currentTrack.seek(0);
      this.currentTrack.pause();
    }
  }

  public pauseAll(): void {
    for (const track of this.tracks) {
      track.pause();
    }
  }

  public async gotoTrack(trackIndex: number, playImmediately = false): Promise<void> {
    this.pauseAll();
    this.state.currentTrackIndex = trackIndex;

    this.resetCurrentTrack();

    if (playImmediately) {
      await this.play();

      if (this.props.onStartNewTrack) {
        this.props.onStartNewTrack(this.currentTrack);
      }
    }
  }

  public loadTrack(trackIndex: number, useHtmlAudioPreloading = false): void {
    // only preload if song is within the next 2
    if (this.state.currentTrackIndex + this.numberOfTracksToPreload <= trackIndex) {
      return;
    }

    const track = this.tracks[trackIndex];

    if (track) {
      track.preload(useHtmlAudioPreloading);
    }
  }

  // Internal - Used by the track to notify when it has ended
  public notifyTrackEnded(): void {
    if (this.props.onEnded) {
      this.props.onEnded();
    }
  }

  // Internal - Used by the track to notify when progress has updated
  public notifyTrackProgressUpdated(): void {
    if (this.props.onProgress) {
      this.props.onProgress(this.currentTrack);
    }
  }

  public get currentTrack(): Track<TTrackMetadata> {
    return this.tracks[this.state.currentTrackIndex];
  }

  public get nextTrack(): Track<TTrackMetadata> {
    return this.tracks[this.state.currentTrackIndex + 1];
  }

  public disableWebAudio(): void {
    this.state.webAudioIsDisabled = true;
  }

  public setVolume(volume: number): void {
    if (volume < 0) {
      volume = 0;
    } else if (volume > 1) {
      volume = 1;
    }

    this.state.volume = volume;

    for (const track of this.tracks) {
      track.setVolume(volume);
    }
  }
}

interface TrackOptions<TTrackMetadata> {
  trackUrl: string;
  queue: Queue<TTrackMetadata>;
  index: number;
  metadata: TTrackMetadata;
}

interface LimitedTrackState {
  playbackType: PlaybackType;
  webAudioLoadingState: PlaybackLoadingState;
}

interface TrackState extends LimitedTrackState {
  isPaused: boolean;
  currentTime: number;
  duration: number;
  index: number;
}

export class Track<TTrackMetadata> {
  private playbackType: PlaybackType;

  private webAudioLoadingState: PlaybackLoadingState;

  private loadedHead: boolean;

  private queue: Queue<TTrackMetadata>;

  private audio: HTMLAudioElement;

  private audioContext: AudioContext;

  private gainNode: GainNode;

  private webAudioStartedPlayingAt: number;

  private webAudioPausedAt: number;

  private webAudioPausedDuration: number;

  private audioBuffer: AudioBuffer | null;

  private bufferSourceNode: AudioBufferSourceNode;

  public metadata: TTrackMetadata;

  public index: number;

  public trackUrl: string;

  public constructor({ trackUrl, queue, index, metadata }: TrackOptions<TTrackMetadata>) {
    // playback type state
    this.playbackType = PlaybackType.html5;
    this.webAudioLoadingState = PlaybackLoadingState.none;
    this.loadedHead = false;

    // basic inputs from Queue
    this.index = index;
    this.queue = queue;
    this.trackUrl = trackUrl;
    this.metadata = metadata;

    // this.onEnded = this.onEnded.bind(this);
    // this.onProgress = this.onProgress.bind(this);

    // HTML5 Audio
    this.audio = new Audio();
    this.audio.onerror = (e: Event | string): void => {
      this.debug('audioOnError', e);
    };

    this.audio.onended = (): void => {
      this.notifyTrackEnd();
    };
    this.audio.controls = false;
    this.audio.volume = this.queue.state.volume;
    this.audio.preload = 'none';
    this.audio.src = trackUrl;
    // this.audio.onprogress = () => this.debug(this.index, this.audio.buffered)

    // WebAudio
    this.audioContext = new AudioContext();
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = this.queue.state.volume;
    this.webAudioStartedPlayingAt = 0;
    this.webAudioPausedDuration = 0;
    this.webAudioPausedAt = 0;
    this.audioBuffer = null;

    this.bufferSourceNode = this.audioContext.createBufferSource();
    this.bufferSourceNode.onended = (): void => {
      this.notifyTrackEnd();
    };
  }

  public pause(): void {
    this.debug('pause');
    if (this.isUsingWebAudio) {
      if (this.bufferSourceNode.playbackRate.value === 0) {
        return;
      }

      this.webAudioPausedAt = this.audioContext.currentTime;
      this.bufferSourceNode.playbackRate.value = 0;
      this.gainNode.disconnect(this.audioContext.destination);
    } else {
      this.audio.pause();
    }
  }

  public async play(): Promise<void> {
    this.debug('play');
    if (this.audioBuffer) {
      // if we've already set up the buffer just set playbackRate to 1
      if (this.isUsingWebAudio) {
        if (this.bufferSourceNode.playbackRate.value === 1) {
          return;
        }

        if (this.webAudioPausedAt) {
          this.webAudioPausedDuration += this.audioContext.currentTime - this.webAudioPausedAt;
        }

        // use seek to avoid bug where track wouldn't play properly
        // if paused for longer than length of track
        // TODO: fix bug -- must be related to bufferSourceNode
        this.seek(this.currentTime);
        // was paused, now force play
        this.connectGainNode();
        this.bufferSourceNode.playbackRate.value = 1;

        this.webAudioPausedAt = 0;
      } else {
        // otherwise set the bufferSourceNode buffer and switch to WebAudio
        this.switchToWebAudio();
      }

      // Try to preload the next track
      this.queue.loadTrack(this.index + 1);
    } else {
      this.audio.preload = 'auto';
      await this.audio.play();
      if (!this.queue.state.webAudioIsDisabled) {
        // Fire and forget
        this.loadHEAD()
          .then(() => {
            void this.loadBuffer();
            return true;
          })
          .catch(() => undefined);
      }
    }

    this.onProgress();
  }

  public async togglePlayPause(): Promise<void> {
    if (this.isPaused) {
      await this.play();
    } else {
      this.pause();
    }
  }

  public preload(useHtmlAudioPreloading = false): void {
    this.debug('preload', useHtmlAudioPreloading);
    if (useHtmlAudioPreloading) {
      this.audio.preload = 'auto';
    } else if (!this.audioBuffer && !this.queue.state.webAudioIsDisabled) {
      // Fire and forget
      this.loadHEAD()
        .then(() => {
          void this.loadBuffer();
          return true;
        })
        .catch(() => undefined);
    }
  }

  // TODO: add checks for to > duration or null or negative (duration - to)
  public seek(to = 0): void {
    if (this.isUsingWebAudio) {
      this.seekBufferSourceNode(to);
    } else {
      this.audio.currentTime = to;
    }

    this.onProgress();
  }

  public connectGainNode(): void {
    this.gainNode.connect(this.audioContext.destination);
  }

  public setVolume(volume: number): void {
    this.audio.volume = volume;
    if (this.gainNode) {
      this.gainNode.gain.value = volume;
    }
  }

  // getter helpers
  public get isUsingWebAudio(): boolean {
    return this.playbackType === PlaybackType.webaudio;
  }

  public get isPaused(): boolean {
    if (this.isUsingWebAudio) {
      return this.bufferSourceNode.playbackRate.value === 0;
    }

    return this.audio.paused;
  }

  public get currentTime(): number {
    if (this.isUsingWebAudio) {
      return this.audioContext.currentTime - this.webAudioStartedPlayingAt - this.webAudioPausedDuration;
    }

    return this.audio.currentTime;
  }

  public get duration(): number {
    if (this.isUsingWebAudio && this.audioBuffer) {
      return this.audioBuffer.duration;
    }

    return this.audio.duration;
  }

  public get isActiveTrack(): boolean {
    return this.queue.currentTrack.index === this.index;
  }

  public get isLoaded(): boolean {
    return this.webAudioLoadingState === PlaybackLoadingState.loaded;
  }

  public get state(): LimitedTrackState {
    return {
      playbackType: this.playbackType,
      webAudioLoadingState: this.webAudioLoadingState,
    };
  }

  public get completeState(): TrackState {
    return {
      playbackType: this.playbackType,
      webAudioLoadingState: this.webAudioLoadingState,
      isPaused: this.isPaused,
      currentTime: this.currentTime,
      duration: this.duration,
      index: this.index,
    };
  }

  private async loadHEAD(): Promise<void> {
    if (this.loadedHead) {
      return;
    }

    const { redirected, url } = await fetch(this.trackUrl, {
      method: 'HEAD',
    });

    if (redirected) {
      this.trackUrl = url;
    }

    this.loadedHead = true;
  }

  private async loadBuffer(): Promise<void> {
    try {
      if (this.webAudioLoadingState !== PlaybackLoadingState.none) {
        return;
      }

      this.webAudioLoadingState = PlaybackLoadingState.loading;

      const response = await fetch(this.trackUrl);
      const buffer = await response.arrayBuffer();
      this.audioBuffer = await this.audioContext.decodeAudioData(buffer);

      this.webAudioLoadingState = PlaybackLoadingState.loaded;
      this.bufferSourceNode.buffer = this.audioBuffer;
      this.bufferSourceNode.connect(this.gainNode);

      // try to preload next track
      this.queue.loadTrack(this.index + 1);

      // if we loaded the active track, switch to web audio
      if (this.isActiveTrack) {
        this.switchToWebAudio();
      }
    } catch (ex) {
      this.debug(`Error fetching buffer: ${this.trackUrl}`, ex);
    }
  }

  private switchToWebAudio(): void {
    // if we've switched tracks, don't switch to web audio
    if (!this.isActiveTrack || !this.audioBuffer) {
      return;
    }

    this.debug('switch to web audio', this.currentTime, this.isPaused, this.audio.duration - this.audioBuffer.duration);

    // if currentTime === 0, this is a new track, so play it
    // otherwise we're hitting this mid-track which may
    // happen in the middle of a paused track
    if (this.currentTime && this.isPaused) {
      this.bufferSourceNode.playbackRate.value = 0;
    } else {
      this.bufferSourceNode.playbackRate.value = 1;
    }

    this.connectGainNode();

    this.webAudioStartedPlayingAt = this.audioContext.currentTime - this.currentTime;

    // TODO: slight blip, could be improved
    this.bufferSourceNode.start(0, this.currentTime);
    this.audio.pause();

    this.playbackType = PlaybackType.webaudio;
  }

  private seekBufferSourceNode(to: number): void {
    const wasPaused = this.isPaused;
    this.bufferSourceNode.onended = null;
    this.bufferSourceNode.stop();

    this.bufferSourceNode = this.audioContext.createBufferSource();

    this.bufferSourceNode.buffer = this.audioBuffer;
    this.bufferSourceNode.connect(this.gainNode);
    this.bufferSourceNode.onended = (): void => {
      this.notifyTrackEnd();
    };

    this.webAudioStartedPlayingAt = this.audioContext.currentTime - to;
    this.webAudioPausedDuration = 0;

    this.bufferSourceNode.start(0, to);
    if (wasPaused) {
      this.connectGainNode();
      this.pause();
    }
  }

  // basic event handlers
  private notifyTrackEnd(): void {
    this.debug('onEnded');
    // Fire and forget
    void this.queue.playNext();
    this.queue.notifyTrackEnded();
  }

  private onProgress(): void {
    if (!this.isActiveTrack) {
      return;
    }

    const durationRemainingInSeconds = this.duration - this.currentTime;
    const { nextTrack } = this.queue;

    // if in last 25 seconds and next track hasn't loaded yet, load next track using HtmlAudio
    if (durationRemainingInSeconds <= 25 && nextTrack && !nextTrack.isLoaded) {
      this.queue.loadTrack(this.index + 1, true);
    }

    this.queue.notifyTrackProgressUpdated();

    // if we're paused, we still want to send one final onProgress call
    // and then bow out, hence this being at the end of the function
    if (this.isPaused) {
      return;
    }

    window.requestAnimationFrame((): void => {
      this.onProgress();
    });
  }

  // debug helper
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private debug(message: string, ...optionalParams: any[]): void {
    // eslint-disable-next-line no-console
    console.log(`${this.index}:${message}`, ...optionalParams, this.state);
  }
}
