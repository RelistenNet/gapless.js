import Track from './Track';

const PRELOAD_NUM_TRACKS = 2;

const isBrowser: boolean = typeof window !== 'undefined';
const audioContext: AudioContext | null =
  isBrowser && typeof window.AudioContext !== 'undefined' ? new window.AudioContext() : null;

// Define interfaces for props and state
interface QueueProps {
  tracks?: string[];
  onProgress?: (track: Track) => void;
  onEnded?: () => void;
  onPlayNextTrack?: (track: Track | undefined) => void;
  onPlayPreviousTrack?: (track: Track | undefined) => void;
  onStartNewTrack?: (track: Track | undefined) => void;
  webAudioIsDisabled?: boolean;
}

interface QueueState {
  volume: number;
  currentTrackIdx: number;
  webAudioIsDisabled: boolean;
}

interface AddTrackParams {
  trackUrl: string;
  skipHEAD?: boolean;
  metadata?: Record<string, any>;
}

export default class Queue {
  props: Omit<Required<QueueProps>, 'tracks' | 'webAudioIsDisabled'>; // Make callbacks required but omit others handled differently
  state: QueueState;
  tracks: Track[];
  // Track property is just holding the class itself, which is unusual.
  // If it's meant for instantiation elsewhere, it's fine, but often not needed.
  Track: typeof Track;

  constructor(props: QueueProps = {}) {
    const {
      tracks = [],
      onProgress = () => {},
      onEnded = () => {},
      onPlayNextTrack = () => {},
      onPlayPreviousTrack = () => {},
      onStartNewTrack = () => {},
      webAudioIsDisabled = false,
    } = props;

    this.props = {
      onProgress,
      onEnded,
      onPlayNextTrack,
      onPlayPreviousTrack,
      onStartNewTrack,
    };

    this.state = {
      volume: 1,
      currentTrackIdx: 0,
      webAudioIsDisabled,
    };

    this.Track = Track; // Assigning the class itself

    this.tracks = tracks.map(
      (trackUrl: string, idx: number) =>
        new Track({
          trackUrl,
          idx,
          queue: this,
          metadata: {}, // Provide default empty metadata
        })
    );

    // if the browser doesn't support web audio
    // disable it!
    if (!audioContext) {
      this.disableWebAudio();
    }
  }

  addTrack({ trackUrl, skipHEAD, metadata = {} }: AddTrackParams): void {
    this.tracks.push(
      new Track({
        trackUrl,
        skipHEAD,
        metadata,
        idx: this.tracks.length,
        queue: this,
      })
    );
  }

  removeTrack(track: Track): Track[] {
    const index = this.tracks.indexOf(track);
    if (index > -1) {
      return this.tracks.splice(index, 1);
    }
    return [];
  }

  togglePlayPause(): void {
    if (this.currentTrack) this.currentTrack.togglePlayPause();
  }

  play(): void {
    if (this.currentTrack) this.currentTrack.play();
  }

  pause(): void {
    if (this.currentTrack) this.currentTrack.pause();
  }

  playPrevious(): void {
    if (this.currentTrack && this.currentTrack.currentTime > 8) {
      this.currentTrack.seek(0);
      return;
    }

    this.resetCurrentTrack();

    if (--this.state.currentTrackIdx < 0) this.state.currentTrackIdx = 0;

    // No need to reset again here, play() will handle starting the new current track
    // this.resetCurrentTrack();

    this.play(); // This will play the new currentTrack

    if (this.props.onStartNewTrack) this.props.onStartNewTrack(this.currentTrack);
    if (this.props.onPlayPreviousTrack) this.props.onPlayPreviousTrack(this.currentTrack);
  }

  playNext(): void {
    this.resetCurrentTrack(); // Pause and reset the current one

    // Ensure we don't go beyond the last track index
    if (this.state.currentTrackIdx < this.tracks.length - 1) {
      this.state.currentTrackIdx++;
    } else {
      // Optional: handle queue end (e.g., stop, loop, etc.)
      // For now, just stay on the last track or reset index if looping
      // this.state.currentTrackIdx = 0; // Example: loop back to start
      this.props.onEnded(); // Call the main onEnded callback
      return; // Stop execution if at the end and not looping
    }

    // No need to reset again here
    // this.resetCurrentTrack();

    this.play(); // Play the new current track

    if (this.props.onStartNewTrack) this.props.onStartNewTrack(this.currentTrack);
    if (this.props.onPlayNextTrack) this.props.onPlayNextTrack(this.currentTrack);
  }

  resetCurrentTrack(): void {
    if (this.currentTrack) {
      // Check if seek and pause are necessary/safe
      try {
        if (!this.currentTrack.isPaused) {
          this.currentTrack.pause();
        }
        // Only seek if duration is valid
        if (this.currentTrack.duration > 0 && !isNaN(this.currentTrack.duration)) {
          this.currentTrack.seek(0);
        }
      } catch (error) {
        console.error('Error resetting track:', error, this.currentTrack);
      }
    }
  }

  pauseAll(): void {
    // Use forEach for side effects, map is for creating new arrays
    this.tracks.forEach((track: Track) => {
      track.pause();
    });
  }

  cleanUp(): void {
    // Correctly reference 'track' instead of 'player'
    this.tracks.forEach((track: Track) => {
      // Ensure nodes exist before trying to nullify buffer
      if (track.bufferSourceNode && track.bufferSourceNode.buffer) {
        track.bufferSourceNode.buffer = null; // Release buffer reference
      }
      if (track.audioBuffer) {
        track.audioBuffer = null; // Release internal buffer reference
      }
      // Optional: Stop and disconnect nodes if necessary
      try {
        if (track.bufferSourceNode) {
          track.bufferSourceNode.onended = null; // Remove listener
          track.bufferSourceNode.stop();
          track.bufferSourceNode.disconnect();
        }
        if (track.gainNode && audioContext) {
          track.gainNode.disconnect();
        }
        if (track.audio) {
          track.audio.pause();
          track.audio.src = ''; // Release resource
          track.audio.load();
          track.audio.onended = null;
          track.audio.onerror = null;
        }
      } catch (e) {
        console.error('Error during track cleanup:', e, track);
      }
    });
    // Consider clearing the tracks array if the queue itself is being destroyed
    // this.tracks = [];
  }

  gotoTrack(idx: number, playImmediately: boolean = false): void {
    if (idx < 0 || idx >= this.tracks.length) {
      console.warn(`gotoTrack: Index ${idx} out of bounds.`);
      return;
    }
    this.pauseAll(); // Pause potentially playing track
    this.resetCurrentTrack(); // Reset the state of the outgoing track

    this.state.currentTrackIdx = idx;

    // Reset the new current track before playing (if needed, though play should handle it)
    // this.resetCurrentTrack(); // Might be redundant if play() handles starting correctly

    if (playImmediately) {
      this.play();
      if (this.props.onStartNewTrack) this.props.onStartNewTrack(this.currentTrack);
    }
  }

  loadTrack(idx: number, loadHTML5?: boolean): void {
    // only preload if song is within the next PRELOAD_NUM_TRACKS
    if (
      idx < 0 ||
      idx >= this.tracks.length ||
      this.state.currentTrackIdx + PRELOAD_NUM_TRACKS < idx
    )
      return;
    const track = this.tracks[idx];

    if (track) track.preload(loadHTML5);
  }

  setProps(obj: Partial<Omit<Required<QueueProps>, 'tracks' | 'webAudioIsDisabled'>> = {}): void {
    this.props = { ...this.props, ...obj };
  }

  // These seem redundant if the props callbacks are called directly elsewhere
  // Keep if they add logic, otherwise call props directly
  onEnded(): void {
    if (this.props.onEnded) this.props.onEnded();
  }

  onProgress(track: Track): void {
    if (this.props.onProgress) this.props.onProgress(track);
  }

  get currentTrack(): Track | undefined {
    return this.tracks[this.state.currentTrackIdx];
  }

  get nextTrack(): Track | undefined {
    return this.tracks[this.state.currentTrackIdx + 1];
  }

  disableWebAudio(): void {
    this.state.webAudioIsDisabled = true;
    // Potentially update existing tracks if needed
    this.tracks.forEach((track) => {
      if (track.isUsingWebAudio) {
        // Handle transition back to HTML5 if possible/necessary
        console.warn('Web Audio disabled while track was using it. State might be inconsistent.');
      }
    });
  }

  setVolume(nextVolume: number): void {
    const clampedVolume = Math.max(0, Math.min(1, nextVolume)); // Clamp between 0 and 1

    this.state.volume = clampedVolume;

    this.tracks.forEach((track) => track.setVolume(clampedVolume));
  }
}
