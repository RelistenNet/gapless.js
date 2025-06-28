import { setup, assign } from 'xstate';

export interface GaplessTrackInfo {
  idx: number;
  currentTime: number;
  duration: number;
  metadata?: Record<string, unknown>;
  isPlaying: boolean;
  isPaused: boolean;
  volume: number;
  trackUrl: string;
  playbackType: 'HTML5' | 'WEBAUDIO';
  webAudioLoadingState: 'NONE' | 'LOADING' | 'LOADED';
}

interface TrackContext {
  trackUrl: string;
  idx: number;
  volume: number;
  webAudioIsDisabled: boolean;
  skipHEAD?: boolean;
  metadata?: Record<string, unknown>;
  onProgress?: (track: GaplessTrackInfo) => void;
  onEnded?: () => void;
  onTrackLoaded?: (trackIndex: number) => void;
  onTrackEnded?: (trackIndex: number) => void;

  loadedHEAD: boolean;
  currentTime: number;
  duration: number;

  audio: HTMLAudioElement | null;
  audioContext: AudioContext | null;
  audioBuffer: AudioBuffer | null;
  bufferSourceNode: AudioBufferSourceNode | null;
  gainNode: GainNode | null;

  webAudioStartedPlayingAt: number;
  webAudioPausedDuration: number;
  webAudioPausedAt: number;

  progressAnimationFrame: number | null;
}

type TrackEvent =
  | { type: 'ACTIVATE' }
  | { type: 'DEACTIVATE' }
  | { type: 'PLAY' }
  | { type: 'PAUSE' }
  | { type: 'ENDED' }
  | { type: 'SEEK'; time: number }
  | { type: 'SET_VOLUME'; volume: number }
  | { type: 'PRELOAD' }
  | { type: 'LOAD_WEBAUDIO' }
  | { type: 'WEBAUDIO_LOADED'; buffer: AudioBuffer }
  | { type: 'WEBAUDIO_ERROR'; error: Error }
  | { type: 'SWITCH_TO_WEBAUDIO' }
  | { type: 'PROGRESS' };

const isBrowser = typeof window !== 'undefined';
const AudioContextClass =
  isBrowser &&
  (window.AudioContext ||
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
const audioContext = AudioContextClass ? new AudioContextClass() : null;

// Helper function to create and start buffer source
const createAndStartBufferSource = (
  context: TrackContext,
  self: { send: (event: TrackEvent) => void },
  startTime: number
): void => {
  if (!context.audioContext || !context.audioBuffer) {
    console.warn('🎯 TRACK: Cannot create buffer source - missing audioContext or audioBuffer');
    return;
  }

  // Ensure gain node exists
  if (!context.gainNode) {
    console.log('🎯 TRACK: Creating missing gain node for buffer source');
    context.gainNode = context.audioContext.createGain();
    context.gainNode.gain.value = context.volume;
  }

  const position = Math.max(0, startTime);
  console.log(`🎯 TRACK: Creating buffer source at ${position.toFixed(2)}s`);

  // Create new buffer source
  context.bufferSourceNode = context.audioContext.createBufferSource();
  context.bufferSourceNode.buffer = context.audioBuffer;
  context.bufferSourceNode.connect(context.gainNode);
  context.bufferSourceNode.onended = () => self.send({ type: 'ENDED' });

  // Connect gain node to destination
  context.gainNode.connect(context.audioContext.destination);

  // Set timing for the start position
  context.webAudioStartedPlayingAt = context.audioContext.currentTime - position;
  context.webAudioPausedDuration = 0;
  context.webAudioPausedAt = 0;

  // Start playback from the specified position
  context.bufferSourceNode.start(0, position);
  console.log(`🎯 TRACK: Buffer source started at ${position.toFixed(2)}s`);
};

export const createTrackMachine = setup({
  types: {
    context: {} as TrackContext,
    events: {} as TrackEvent,
    input: {} as Partial<TrackContext>,
  },
  actions: {
    createAudioElement: assign({
      audio: ({ context, self }) => {
        if (!isBrowser) return null;

        const audio = new Audio();
        audio.controls = false;
        audio.volume = context.volume;
        audio.preload = 'none';
        audio.src = context.trackUrl;

        // Set up ended event handler for HTML5 audio
        audio.onended = () => {
          self.send({ type: 'ENDED' });
        };

        return audio;
      },
      gainNode: ({ context }) => {
        if (!context.audioContext) return null;
        const gainNode = context.audioContext.createGain();
        gainNode.gain.value = context.volume;
        return gainNode;
      },
    }),

    destroyAudioElement: assign({
      audio: ({ context }) => {
        if (context.audio) {
          context.audio.pause();
          context.audio.src = '';
        }
        return null;
      },
      bufferSourceNode: ({ context }) => {
        if (context.bufferSourceNode) {
          try {
            // Remove the onended handler to prevent ENDED event during destroy
            context.bufferSourceNode.onended = null;
            context.bufferSourceNode.stop();
            context.bufferSourceNode.disconnect();
          } catch {
            // Ignore errors when stopping buffer source
          }
        }
        return null;
      },
      progressAnimationFrame: ({ context }) => {
        if (context.progressAnimationFrame !== null) {
          cancelAnimationFrame(context.progressAnimationFrame);
        }
        return null;
      },
    }),

    startPlayback: ({ context, self }) => {
      if (context.audioBuffer && !context.webAudioIsDisabled) {
        self.send({ type: 'SWITCH_TO_WEBAUDIO' });
      } else if (context.audio) {
        context.audio.preload = 'auto';
        context.audio.play();
        if (!context.webAudioIsDisabled) {
          self.send({ type: 'LOAD_WEBAUDIO' });
        }
      }
    },

    createAudioElementIfNeeded: assign({
      audio: ({ context, self }) => {
        // Only create audio element if no audio element exists
        if (!context.audio && isBrowser) {
          console.log('🎯 TRACK: Creating HTML5 audio element');
          const audio = new Audio();
          audio.controls = false;
          audio.volume = context.volume;
          audio.preload = 'none';
          audio.src = context.trackUrl;

          // Set up ended event handler for HTML5 audio
          audio.onended = () => {
            self.send({ type: 'ENDED' });
          };

          return audio;
        }
        return context.audio;
      },
      gainNode: ({ context }) => {
        // Always create gain node if we have audio context and don't have one yet
        if (!context.gainNode && context.audioContext) {
          console.log('🎯 TRACK: Creating gain node');
          const gainNode = context.audioContext.createGain();
          gainNode.gain.value = context.volume;
          return gainNode;
        }
        return context.gainNode;
      },
    }),

    resumeWebAudio: ({ context, self }) => {
      // Use the stored current time from when we paused
      const resumePosition = Math.max(0, context.currentTime || 0);
      console.log(`🎯 TRACK: Resuming WebAudio from ${resumePosition.toFixed(2)}s`);

      // Use the reusable buffer source creation
      createAndStartBufferSource(context, self, resumePosition);
    },

    pausePlayback: ({ context }) => {
      if (context.bufferSourceNode && context.audioContext) {
        // Calculate exact current playback position
        const currentAudioTime = context.audioContext.currentTime;
        const playbackPosition = currentAudioTime - context.webAudioStartedPlayingAt;

        // Store the exact position where we paused
        context.currentTime = Math.max(0, playbackPosition);
        context.webAudioPausedAt = currentAudioTime;

        // Stop and disconnect the current buffer source
        try {
          // Remove the onended handler to prevent ENDED event during pause
          context.bufferSourceNode.onended = null;
          context.bufferSourceNode.stop();
          context.bufferSourceNode.disconnect();
        } catch {
          // Ignore errors when stopping buffer source
        }

        // Clear the buffer source node
        context.bufferSourceNode = null;
      } else if (context.audio) {
        context.audio.pause();
      }
    },

    startProgressTracking: assign({
      progressAnimationFrame: ({ context, self }) => {
        const updateProgress = () => {
          self.send({ type: 'PROGRESS' });
          context.progressAnimationFrame = requestAnimationFrame(updateProgress);
        };
        return requestAnimationFrame(updateProgress);
      },
    }),

    stopProgressTracking: assign({
      progressAnimationFrame: ({ context }) => {
        if (context.progressAnimationFrame !== null) {
          cancelAnimationFrame(context.progressAnimationFrame);
        }
        return null;
      },
    }),

    updateProgress: assign({
      currentTime: ({ context }) => {
        if (context.bufferSourceNode && context.audioContext) {
          // Calculate current time for active WebAudio playback
          const currentTime = context.audioContext.currentTime - context.webAudioStartedPlayingAt;
          return Math.max(0, currentTime);
        } else if (context.audio) {
          return context.audio.currentTime;
        } else if (context.audioBuffer && !context.bufferSourceNode) {
          // WebAudio is available but paused, return stored currentTime
          return context.currentTime;
        }
        return 0;
      },
      duration: ({ context }) => {
        if (context.audioBuffer) {
          return context.audioBuffer.duration;
        } else if (context.audio) {
          return context.audio.duration;
        }
        return 0;
      },
    }),

    checkPreloadNext: ({ context, self }) => {
      if (context.onProgress) {
        const snapshot = self.getSnapshot();
        const isPlaying = snapshot.matches({ playback: 'playing' });
        const isPaused = snapshot.matches({ playback: 'paused' });
        const isWebAudio = snapshot.matches({ audioSource: 'webaudio' });
        const isLoadingWebAudio = snapshot.matches({ audioSource: 'loadingWebAudio' });

        const trackInfo: GaplessTrackInfo = {
          idx: context.idx,
          currentTime: context.currentTime,
          duration: context.duration,
          metadata: context.metadata,
          isPlaying,
          isPaused,
          volume: context.volume,
          trackUrl: context.trackUrl,
          playbackType: isWebAudio ? 'WEBAUDIO' : 'HTML5',
          webAudioLoadingState: isLoadingWebAudio
            ? 'LOADING'
            : context.audioBuffer
              ? 'LOADED'
              : 'NONE',
        };

        context.onProgress(trackInfo);
      }
    },

    seekWebAudio: ({ context, event, self }) => {
      if (event.type !== 'SEEK') return;
      const time = Math.max(0, event.time);
      console.log(`🎯 TRACK: WebAudio seek to ${time.toFixed(2)}s`);

      if (!context.audioBuffer || !context.audioContext) {
        console.warn('🎯 TRACK: WebAudio seek failed - missing audioBuffer or audioContext');
        return;
      }

      // Ensure gain node exists before seeking
      if (!context.gainNode) {
        console.log('🎯 TRACK: Creating missing gain node for WebAudio seek');
        context.gainNode = context.audioContext.createGain();
        context.gainNode.gain.value = context.volume;
      }

      // Check if we're currently playing
      const wasPlaying = !!context.bufferSourceNode;
      console.log(`🎯 TRACK: WebAudio seek - wasPlaying: ${wasPlaying}`);

      // Stop current buffer source if playing
      if (context.bufferSourceNode) {
        try {
          // Remove the onended handler to prevent ENDED event during seek
          context.bufferSourceNode.onended = null;
          context.bufferSourceNode.stop();
          context.bufferSourceNode.disconnect();
          console.log('🎯 TRACK: WebAudio seek - stopped previous buffer source');
        } catch (error) {
          console.warn('🎯 TRACK: WebAudio seek - error stopping buffer source:', error);
        }
        context.bufferSourceNode = null;
      }

      // Update stored position
      context.currentTime = time;
      console.log(`🎯 TRACK: WebAudio seek - updated currentTime to ${time.toFixed(2)}s`);

      if (wasPlaying) {
        // Use the reusable buffer source creation to resume playback
        createAndStartBufferSource(context, self, time);
      } else {
        console.log('🎯 TRACK: WebAudio seek - track was paused, position updated only');
      }
    },

    seekHTML5: ({ context, event }) => {
      if (event.type !== 'SEEK') return;
      const time = Math.max(0, event.time);
      console.log(`🎯 TRACK: HTML5 seek to ${time.toFixed(2)}s`);

      if (context.audio) {
        context.audio.currentTime = time;
        context.currentTime = time;
        console.log(`🎯 TRACK: HTML5 seek - updated currentTime to ${time.toFixed(2)}s`);
      } else {
        console.warn('🎯 TRACK: HTML5 seek failed - no audio element');
      }
    },

    setVolume: ({ context, event }) => {
      if (event.type !== 'SET_VOLUME') return;
      const volume = Math.max(0, Math.min(1, event.volume));
      context.volume = volume;

      if (context.audio) {
        context.audio.volume = volume;
      }
      if (context.gainNode) {
        context.gainNode.gain.value = volume;
      }
    },

    preload: ({ context, self }) => {
      if (context.audio && context.audio.preload !== 'auto') {
        context.audio.preload = 'auto';
      }
      if (!context.audioBuffer && !context.webAudioIsDisabled) {
        self.send({ type: 'LOAD_WEBAUDIO' });
      }
    },

    startLoadingWebAudio: ({ context, self }) => {
      if (!context.trackUrl || !context.audioContext) return;

      fetch(context.trackUrl)
        .then((res) => res.arrayBuffer())
        .then((arrayBuffer) => {
          if (!context.audioContext) throw new Error('No audio context');
          return context.audioContext.decodeAudioData(arrayBuffer);
        })
        .then((buffer) => {
          // Send success event with the loaded buffer
          self.send({ type: 'WEBAUDIO_LOADED', buffer });
        })
        .catch((error) => {
          console.error('Error loading web audio:', error);
          // Send error event with the error details
          self.send({ type: 'WEBAUDIO_ERROR', error });
        });
    },

    storeWebAudioBuffer: assign({
      audioBuffer: ({ event, context }) => {
        if (event.type !== 'WEBAUDIO_LOADED') return null;

        // Notify that this track has finished loading
        if (context.onTrackLoaded) {
          context.onTrackLoaded(context.idx);
        }

        return event.buffer;
      },
    }),

    setupWebAudio: ({ context, self }) => {
      if (!context.audioContext || !context.audioBuffer || !context.gainNode) return;

      const currentTime = context.audio?.currentTime || context.currentTime || 0;
      const wasPlaying = context.audio ? !context.audio.paused : false;

      // Store the current position for later use
      context.currentTime = currentTime;

      // If we're switching during playback, create buffer source and start immediately
      if (wasPlaying) {
        createAndStartBufferSource(context, self, currentTime);
      }

      // Destroy HTML5 audio element since we're now using WebAudio
      if (context.audio) {
        context.audio.pause();
        context.audio.src = '';
        context.audio = null;
      }
    },

    cleanupWebAudio: ({ context }) => {
      if (context.bufferSourceNode) {
        try {
          // Remove the onended handler to prevent ENDED event during cleanup
          context.bufferSourceNode.onended = null;
          context.bufferSourceNode.stop();
          context.bufferSourceNode.disconnect();
        } catch {
          // Ignore errors when stopping buffer source
        }
      }
    },

    handleEnded: ({ context }) => {
      // Stop progress tracking when track ends
      if (context.progressAnimationFrame !== null) {
        cancelAnimationFrame(context.progressAnimationFrame);
        context.progressAnimationFrame = null;
      }

      // Clean up buffer source
      context.bufferSourceNode = null;

      // Notify queue that this track has ended
      if (context.onTrackEnded) {
        context.onTrackEnded(context.idx);
      }

      if (context.onEnded) {
        context.onEnded();
      }
    },

    logWebAudioError: ({ event }) => {
      if (event.type !== 'WEBAUDIO_ERROR') return;
      console.error('WebAudio loading error:', event.error);
    },
  },
  guards: {
    canUseWebAudio: ({ context }) => {
      return !context.webAudioIsDisabled && !!context.audioContext && !context.audioBuffer;
    },

    hasWebAudioBuffer: ({ context }) => {
      return !!context.audioBuffer;
    },

    isUsingWebAudio: ({ context }) => {
      return !!context.audioBuffer && !context.webAudioIsDisabled;
    },
  },
}).createMachine({
  id: 'track',
  type: 'parallel',
  context: ({ input }) => ({
    trackUrl: input?.trackUrl || '',
    idx: input?.idx || 0,
    volume: input?.volume || 1,
    webAudioIsDisabled: input?.webAudioIsDisabled || false,
    skipHEAD: input?.skipHEAD,
    metadata: input?.metadata,
    onProgress: input?.onProgress,
    onEnded: input?.onEnded,
    onTrackLoaded: input?.onTrackLoaded,
    onTrackEnded: input?.onTrackEnded,
    loadedHEAD: false,
    currentTime: 0,
    duration: 0,
    audio: null,
    audioContext: audioContext,
    audioBuffer: null,
    bufferSourceNode: null,
    gainNode: null,
    webAudioStartedPlayingAt: 0,
    webAudioPausedDuration: 0,
    webAudioPausedAt: 0,
    progressAnimationFrame: null,
  }),
  states: {
    audioSource: {
      initial: 'html',
      states: {
        html: {
          on: {
            LOAD_WEBAUDIO: {
              target: 'loadingWebAudio',
              guard: 'canUseWebAudio',
            },
            SWITCH_TO_WEBAUDIO: {
              target: 'webaudio',
              guard: 'hasWebAudioBuffer',
            },
          },
        },
        loadingWebAudio: {
          entry: 'startLoadingWebAudio',
          on: {
            WEBAUDIO_LOADED: {
              target: 'webaudio',
              actions: 'storeWebAudioBuffer',
            },
            WEBAUDIO_ERROR: {
              target: 'html',
              actions: 'logWebAudioError',
            },
          },
        },
        webaudio: {
          entry: 'setupWebAudio',
          on: {
            DEACTIVATE: {
              target: 'html',
              actions: 'cleanupWebAudio',
            },
          },
        },
      },
    },
    playback: {
      initial: 'paused',
      states: {
        paused: {
          on: {
            ACTIVATE: {
              actions: 'createAudioElementIfNeeded',
            },
            PLAY: [
              {
                target: 'playing',
                guard: 'isUsingWebAudio',
                actions: ['resumeWebAudio', 'startProgressTracking'],
              },
              {
                target: 'playing',
                actions: ['createAudioElementIfNeeded', 'startPlayback', 'startProgressTracking'],
              },
            ],
            DEACTIVATE: {
              actions: 'destroyAudioElement',
            },
            SEEK: [
              {
                actions: 'seekWebAudio',
                guard: 'isUsingWebAudio',
              },
              {
                actions: 'seekHTML5',
              },
            ],
          },
        },
        playing: {
          on: {
            PAUSE: {
              target: 'paused',
              actions: ['pausePlayback', 'stopProgressTracking'],
            },
            ENDED: {
              target: 'paused',
              actions: ['handleEnded', 'stopProgressTracking'],
            },
            DEACTIVATE: {
              target: 'paused',
              actions: ['pausePlayback', 'destroyAudioElement', 'stopProgressTracking'],
            },
            SEEK: [
              {
                actions: 'seekWebAudio',
                guard: 'isUsingWebAudio',
              },
              {
                actions: 'seekHTML5',
              },
            ],
            PROGRESS: {
              actions: ['updateProgress', 'checkPreloadNext'],
            },
          },
        },
      },
    },
  },
  on: {
    SET_VOLUME: {
      actions: 'setVolume',
    },
    PRELOAD: {
      actions: 'preload',
    },
  },
});
