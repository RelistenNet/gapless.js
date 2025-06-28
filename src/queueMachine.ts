import { setup, assign } from 'xstate';
import { TrackActor, GaplessTrackInfo } from './types';
import { createTrackMachine } from './trackMachine';

interface QueueContext {
  tracks: string[];
  currentTrackIdx: number;
  volume: number;
  webAudioIsDisabled: boolean;
  trackActors: TrackActor[];
  onProgress?: (track: GaplessTrackInfo) => void;
  onEnded?: () => void;
  onPlayNextTrack?: (track: TrackActor) => void;
  onPlayPreviousTrack?: (track: TrackActor) => void;
  onStartNewTrack?: (track: TrackActor) => void;
  trackMetadata?: Array<{ title?: string; artist?: string; album?: string; artwork?: string }>;
}

type QueueEvent =
  | { type: 'PLAY' }
  | { type: 'PAUSE' }
  | { type: 'NEXT' }
  | { type: 'PREVIOUS' }
  | { type: 'GOTO'; index: number; playImmediately?: boolean }
  | { type: 'TRACK_ENDED' }
  | { type: 'TRACK_LOADED'; trackIndex: number }
  | { type: 'SEEK'; time: number }
  | { type: 'SET_VOLUME'; volume: number }
  | { type: 'ADD_TRACK'; trackUrl: string; skipHEAD?: boolean; metadata?: Record<string, unknown> }
  | { type: 'REMOVE_TRACK'; track: TrackActor }
  | { type: 'INTERNAL_UPDATE_MEDIA_SESSION' };

export const createQueueMachine = setup({
  types: {
    context: {} as QueueContext,
    events: {} as QueueEvent,
    input: {} as {
      tracks?: string[];
      onProgress?: (track: GaplessTrackInfo) => void;
      onEnded?: () => void;
      onPlayNextTrack?: (track: TrackActor) => void;
      onPlayPreviousTrack?: (track: TrackActor) => void;
      onStartNewTrack?: (track: TrackActor) => void;
      webAudioIsDisabled?: boolean;
      trackMetadata?: Array<{ title?: string; artist?: string; album?: string; artwork?: string }>;
    },
  },
  actions: {
    activateCurrentTrack: ({ context }) => {
      const currentActor = context.trackActors[context.currentTrackIdx];
      if (currentActor) {
        currentActor.send({ type: 'ACTIVATE' });
      }
    },
    playCurrentTrack: ({ context }) => {
      const currentActor = context.trackActors[context.currentTrackIdx];
      if (currentActor) {
        currentActor.send({ type: 'PLAY' });
      }
    },
    pauseCurrentTrack: ({ context }) => {
      const currentActor = context.trackActors[context.currentTrackIdx];
      if (currentActor) {
        currentActor.send({ type: 'PAUSE' });
      }
    },
    pauseAllTracks: ({ context }) => {
      context.trackActors.forEach((actor) => {
        actor.send({ type: 'PAUSE' });
      });
    },

    seekCurrentTrackToStart: ({ context }) => {
      const currentActor = context.trackActors[context.currentTrackIdx];
      if (currentActor) {
        currentActor.send({ type: 'SEEK', time: 0 });
      }
    },
    seekCurrentTrack: ({ context, event }) => {
      const currentActor = context.trackActors[context.currentTrackIdx];
      if (currentActor && event.type === 'SEEK') {
        console.log(`🎯 QUEUE: Seeking to ${event.time.toFixed(2)}s`);
        currentActor.send({ type: 'SEEK', time: event.time });
      }
    },
    updateCurrentTrackIdx: assign({
      currentTrackIdx: ({ event }) => {
        if (event.type === 'GOTO') {
          return event.index;
        }
        return 0;
      },
    }),

    gotoTrackWithPlayOption: ({ context, event, self }) => {
      if (event.type !== 'GOTO') return;

      // Update track index
      context.trackActors.forEach((actor) => {
        actor.send({ type: 'PAUSE' });
      });

      const currentActor = context.trackActors[event.index];
      if (currentActor) {
        currentActor.send({ type: 'SEEK', time: 0 });
        if (event.playImmediately) {
          currentActor.send({ type: 'ACTIVATE' });
          currentActor.send({ type: 'PLAY' });
          self.send({ type: 'PLAY' });
        }
      }

      if (context.onStartNewTrack) {
        context.onStartNewTrack(currentActor);
      }
    },
    playNext: ({ context, self }) => {
      const currentActor = context.trackActors[context.currentTrackIdx];
      if (currentActor) {
        currentActor.send({ type: 'DEACTIVATE' });
      }

      const nextIdx = context.currentTrackIdx + 1;
      if (nextIdx < context.trackActors.length) {
        self.send({ type: 'GOTO', index: nextIdx });
        self.send({ type: 'PLAY' });
        if (context.onPlayNextTrack) {
          const nextActor = context.trackActors[nextIdx];
          context.onPlayNextTrack(nextActor);
        }
      }
    },

    autoAdvanceToNext: assign({
      currentTrackIdx: ({ context, self }) => {
        console.log('🚀 QUEUE: Auto-advancing to next track');
        const currentActor = context.trackActors[context.currentTrackIdx];
        if (currentActor) {
          console.log(`🚀 QUEUE: Deactivating track ${context.currentTrackIdx}`);
          currentActor.send({ type: 'DEACTIVATE' });
        }

        const nextIdx = context.currentTrackIdx + 1;
        if (nextIdx < context.trackActors.length) {
          const nextActor = context.trackActors[nextIdx];
          if (nextActor) {
            console.log(`🚀 QUEUE: Activating and playing track ${nextIdx}`);
            // Directly activate and play the next track
            nextActor.send({ type: 'ACTIVATE' });
            nextActor.send({ type: 'PLAY' });
          }

          // Load the track after this one for sequential loading
          const trackAfterNext = nextIdx + 1;
          if (trackAfterNext < context.trackActors.length) {
            const trackToLoad = context.trackActors[trackAfterNext];
            if (trackToLoad) {
              console.log(`🚀 QUEUE: Preloading track ${trackAfterNext}`);
              trackToLoad.send({ type: 'PRELOAD' });
            }
          }

          if (context.onPlayNextTrack) {
            context.onPlayNextTrack(nextActor);
          }

          if (context.onStartNewTrack) {
            context.onStartNewTrack(nextActor);
          }

          // Update MediaSession for new track after state changes
          setTimeout(() => {
            self.send({ type: 'INTERNAL_UPDATE_MEDIA_SESSION' });
          }, 50);

          console.log(`🚀 QUEUE: Advanced to track ${nextIdx}`);
          return nextIdx;
        }
        console.log('🚀 QUEUE: No next track available');
        return context.currentTrackIdx;
      },
    }),
    gotoNext: ({ context, self }) => {
      const currentActor = context.trackActors[context.currentTrackIdx];
      if (currentActor) {
        currentActor.send({ type: 'DEACTIVATE' });
      }

      const nextIdx = context.currentTrackIdx + 1;
      if (nextIdx < context.trackActors.length) {
        self.send({ type: 'GOTO', index: nextIdx });
        if (context.onPlayNextTrack) {
          const nextActor = context.trackActors[nextIdx];
          context.onPlayNextTrack(nextActor);
        }
      }
    },
    playPrevious: ({ context, self }) => {
      const currentActor = context.trackActors[context.currentTrackIdx];
      let currentTime = 0;

      if (currentActor) {
        const snapshot = currentActor.getSnapshot();
        if (snapshot.status === 'active') {
          currentTime = snapshot.context?.currentTime || 0;
        }
      }

      if (currentTime > 8) {
        currentActor?.send({ type: 'SEEK', time: 0 });
        return;
      }

      if (currentActor) {
        currentActor.send({ type: 'DEACTIVATE' });
      }

      const prevIdx = Math.max(0, context.currentTrackIdx - 1);
      self.send({ type: 'GOTO', index: prevIdx });
      self.send({ type: 'PLAY' });

      if (context.onPlayPreviousTrack) {
        const prevActor = context.trackActors[prevIdx];
        context.onPlayPreviousTrack(prevActor);
      }
    },
    gotoPrevious: ({ context, self }) => {
      const currentActor = context.trackActors[context.currentTrackIdx];
      let currentTime = 0;

      if (currentActor) {
        const snapshot = currentActor.getSnapshot();
        if (snapshot.status === 'active') {
          currentTime = snapshot.context?.currentTime || 0;
        }
      }

      if (currentTime > 8) {
        currentActor?.send({ type: 'SEEK', time: 0 });
        return;
      }

      if (currentActor) {
        currentActor.send({ type: 'DEACTIVATE' });
      }

      const prevIdx = Math.max(0, context.currentTrackIdx - 1);
      self.send({ type: 'GOTO', index: prevIdx });

      if (context.onPlayPreviousTrack) {
        const prevActor = context.trackActors[prevIdx];
        context.onPlayPreviousTrack(prevActor);
      }
    },
    resetToFirstTrack: assign({
      currentTrackIdx: 0,
    }),
    setVolume: assign({
      volume: ({ event }) => {
        if (event.type === 'SET_VOLUME') {
          return Math.max(0, Math.min(1, event.volume));
        }
        return 1;
      },
    }),
    spawnInitialTracks: assign({
      trackActors: ({ context, spawn, self }) => {
        return context.tracks.map((trackUrl, idx) => {
          return spawn(createTrackMachine, {
            input: {
              trackUrl,
              idx,
              volume: context.volume,
              webAudioIsDisabled: context.webAudioIsDisabled,
              onProgress: context.onProgress,
              onEnded: context.onEnded,
              onTrackLoaded: (trackIndex) => {
                self.send({ type: 'TRACK_LOADED', trackIndex });
              },
              onTrackEnded: () => {
                self.send({ type: 'TRACK_ENDED' });
              },
            },
          });
        });
      },
    }),

    loadCurrentTrack: ({ context }) => {
      const currentActor = context.trackActors[context.currentTrackIdx];
      if (currentActor) {
        // Start loading WebAudio for current track
        currentActor.send({ type: 'PRELOAD' });
      }
    },

    loadNextTrack: ({ context }) => {
      const nextIdx = context.currentTrackIdx + 1;
      if (nextIdx < context.trackActors.length) {
        const nextActor = context.trackActors[nextIdx];
        if (nextActor) {
          // Start loading WebAudio for next track
          nextActor.send({ type: 'PRELOAD' });
        }
      }
    },

    handleTrackLoaded: ({ context, event }) => {
      if (event.type !== 'TRACK_LOADED') return;

      // If the loaded track is the current track, start loading the next one
      if (event.trackIndex === context.currentTrackIdx) {
        const nextIdx = context.currentTrackIdx + 1;
        if (nextIdx < context.trackActors.length) {
          const nextActor = context.trackActors[nextIdx];
          if (nextActor) {
            nextActor.send({ type: 'PRELOAD' });
          }
        }
      }
    },

    addTrack: assign({
      tracks: ({ context, event }) => {
        if (event.type !== 'ADD_TRACK') return context.tracks;
        return [...context.tracks, event.trackUrl];
      },
      trackActors: ({ context, event, spawn }) => {
        if (event.type !== 'ADD_TRACK') return context.trackActors;

        const newTrackActor = spawn(createTrackMachine, {
          input: {
            trackUrl: event.trackUrl,
            idx: context.tracks.length, // Will be the new index after addition
            volume: context.volume,
            webAudioIsDisabled: context.webAudioIsDisabled,
            skipHEAD: event.skipHEAD,
            metadata: event.metadata,
            onProgress: context.onProgress,
            onEnded: context.onEnded,
          },
        });

        return [...context.trackActors, newTrackActor];
      },
    }),
    removeTrack: assign({
      tracks: ({ context, event }) => {
        if (event.type !== 'REMOVE_TRACK') return context.tracks;

        const index = context.trackActors.findIndex((actor) => actor === event.track);
        if (index === -1) return context.tracks;

        const newTracks = [...context.tracks];
        newTracks.splice(index, 1);
        return newTracks;
      },
      trackActors: ({ context, event }) => {
        if (event.type !== 'REMOVE_TRACK') return context.trackActors;

        const index = context.trackActors.findIndex((actor) => actor === event.track);
        if (index === -1) return context.trackActors;

        const newActors = [...context.trackActors];
        newActors.splice(index, 1);

        return newActors;
      },
      currentTrackIdx: ({ context, event }) => {
        if (event.type !== 'REMOVE_TRACK') return context.currentTrackIdx;

        const index = context.trackActors.findIndex((actor) => actor === event.track);
        if (index === -1) return context.currentTrackIdx;

        const newLength = context.trackActors.length - 1;
        if (context.currentTrackIdx >= newLength && context.currentTrackIdx > 0) {
          return newLength - 1;
        }
        return context.currentTrackIdx;
      },
    }),
    notifyStartNewTrack: ({ context }) => {
      if (context.onStartNewTrack) {
        const currentActor = context.trackActors[context.currentTrackIdx];
        context.onStartNewTrack(currentActor);
      }
    },
    notifyEnded: ({ context }) => {
      if (context.onEnded) {
        context.onEnded();
      }
    },

    setupMediaSession: ({ context, self }) => {
      if (typeof window !== 'undefined' && 'mediaSession' in navigator) {
        // Set up action handlers for device controls
        navigator.mediaSession.setActionHandler('play', () => {
          console.log('📱 DEVICE: Play button pressed');
          self.send({ type: 'PLAY' });
        });

        navigator.mediaSession.setActionHandler('pause', () => {
          console.log('📱 DEVICE: Pause button pressed');
          self.send({ type: 'PAUSE' });
        });

        navigator.mediaSession.setActionHandler('previoustrack', () => {
          console.log('📱 DEVICE: Previous track button pressed');
          self.send({ type: 'PREVIOUS' });
        });

        navigator.mediaSession.setActionHandler('nexttrack', () => {
          console.log('📱 DEVICE: Next track button pressed');
          self.send({ type: 'NEXT' });
        });

        // Optional: seek handlers
        navigator.mediaSession.setActionHandler('seekbackward', (details) => {
          console.log('📱 DEVICE: Seek backward', details);
          const currentActor = context.trackActors[context.currentTrackIdx];
          if (currentActor) {
            const snapshot = currentActor.getSnapshot();
            if (snapshot.status === 'active' && snapshot.context) {
              const currentTime = snapshot.context.currentTime || 0;
              const seekTime = Math.max(0, currentTime - (details.seekOffset || 10));
              self.send({ type: 'SEEK', time: seekTime });
            }
          }
        });

        navigator.mediaSession.setActionHandler('seekforward', (details) => {
          console.log('📱 DEVICE: Seek forward', details);
          const currentActor = context.trackActors[context.currentTrackIdx];
          if (currentActor) {
            const snapshot = currentActor.getSnapshot();
            if (snapshot.status === 'active' && snapshot.context) {
              const currentTime = snapshot.context.currentTime || 0;
              const duration = snapshot.context.duration || 0;
              const seekTime = Math.min(duration, currentTime + (details.seekOffset || 10));
              self.send({ type: 'SEEK', time: seekTime });
            }
          }
        });

        navigator.mediaSession.setActionHandler('seekto', (details) => {
          console.log('📱 DEVICE: Seek to position', details);
          if (details.seekTime !== undefined) {
            self.send({ type: 'SEEK', time: details.seekTime });
          }
        });

        console.log('📱 DEVICE: MediaSession API initialized');
      } else {
        console.log('📱 DEVICE: MediaSession API not supported');
      }
    },

    updateMediaSessionMetadata: ({ context }) => {
      if (typeof window !== 'undefined' && 'mediaSession' in navigator) {
        const currentTrackMeta = context.trackMetadata?.[context.currentTrackIdx];
        const defaultTitle = `Track ${context.currentTrackIdx + 1}`;
        
        navigator.mediaSession.metadata = new MediaMetadata({
          title: currentTrackMeta?.title || defaultTitle,
          artist: currentTrackMeta?.artist || 'Unknown Artist',
          album: currentTrackMeta?.album || 'Gapless Playlist',
          artwork: currentTrackMeta?.artwork ? [
            { src: currentTrackMeta.artwork, sizes: '96x96', type: 'image/png' },
            { src: currentTrackMeta.artwork, sizes: '128x128', type: 'image/png' },
            { src: currentTrackMeta.artwork, sizes: '192x192', type: 'image/png' },
            { src: currentTrackMeta.artwork, sizes: '256x256', type: 'image/png' },
            { src: currentTrackMeta.artwork, sizes: '384x384', type: 'image/png' },
            { src: currentTrackMeta.artwork, sizes: '512x512', type: 'image/png' },
          ] : []
        });

        console.log('📱 DEVICE: Updated MediaSession metadata', {
          title: currentTrackMeta?.title || defaultTitle,
          artist: currentTrackMeta?.artist || 'Unknown Artist'
        });
      }
    },

    updateMediaSessionPlaybackState: ({ context }) => {
      if (typeof window !== 'undefined' && 'mediaSession' in navigator) {
        // Get current state from context or derive it
        const isPlaying = context.trackActors.some(actor => {
          const snapshot = actor.getSnapshot();
          return snapshot.status === 'active' && snapshot.matches && snapshot.matches({ playback: 'playing' });
        });
        
        navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
        console.log('📱 DEVICE: Updated playback state to', navigator.mediaSession.playbackState);
      }
    },
  },
  guards: {
    isLastTrack: ({ context }) => {
      return context.currentTrackIdx >= context.trackActors.length - 1;
    },
  },
}).createMachine({
  id: 'queue',
  initial: 'paused',
  entry: ['spawnInitialTracks', 'loadCurrentTrack', 'setupMediaSession', 'updateMediaSessionMetadata'],
  context: ({ input }) => ({
    tracks: input?.tracks || [],
    currentTrackIdx: 0,
    volume: 1,
    webAudioIsDisabled: input?.webAudioIsDisabled ?? false,
    trackActors: [], // Will be populated via spawnInitialTracks action
    onProgress: input?.onProgress,
    onEnded: input?.onEnded,
    onPlayNextTrack: input?.onPlayNextTrack,
    onPlayPreviousTrack: input?.onPlayPreviousTrack,
    onStartNewTrack: input?.onStartNewTrack,
    trackMetadata: input?.trackMetadata || [],
  }),
  states: {
    playing: {
      on: {
        PAUSE: {
          target: 'paused',
          actions: ['pauseCurrentTrack', 'updateMediaSessionPlaybackState'],
        },
        TRACK_ENDED: [
          {
            target: 'ended',
            guard: 'isLastTrack',
            actions: ['notifyEnded'],
          },
          {
            actions: ['autoAdvanceToNext'],
          },
        ],
        NEXT: {
          actions: ['playNext'],
        },
        PREVIOUS: {
          actions: ['playPrevious'],
        },
        GOTO: {
          actions: [
            'pauseAllTracks',
            'updateCurrentTrackIdx',
            'seekCurrentTrackToStart',
            'playCurrentTrack',
            'notifyStartNewTrack',
            'loadCurrentTrack',
            'updateMediaSessionMetadata',
            'updateMediaSessionPlaybackState',
          ],
        },
        SEEK: {
          actions: 'seekCurrentTrack',
        },
        SET_VOLUME: {
          actions: 'setVolume',
        },
        ADD_TRACK: {
          actions: 'addTrack',
        },
        REMOVE_TRACK: {
          actions: 'removeTrack',
        },
        TRACK_LOADED: {
          actions: 'handleTrackLoaded',
        },
      },
    },
    paused: {
      on: {
        PLAY: {
          target: 'playing',
          actions: ['playCurrentTrack', 'updateMediaSessionPlaybackState'],
        },
        NEXT: {
          actions: ['gotoNext'],
        },
        PREVIOUS: {
          actions: ['gotoPrevious'],
        },
        GOTO: {
          actions: [
            'pauseAllTracks',
            'updateCurrentTrackIdx',
            'seekCurrentTrackToStart',
            'loadCurrentTrack',
            'updateMediaSessionMetadata',
          ],
        },
        SEEK: {
          actions: 'seekCurrentTrack',
        },
        SET_VOLUME: {
          actions: 'setVolume',
        },
        ADD_TRACK: {
          actions: 'addTrack',
        },
        REMOVE_TRACK: {
          actions: 'removeTrack',
        },
        TRACK_LOADED: {
          actions: 'handleTrackLoaded',
        },
      },
    },
    ended: {
      on: {
        PLAY: {
          target: 'playing',
          actions: [
            'resetToFirstTrack',
            'activateCurrentTrack',
            'playCurrentTrack',
            'notifyStartNewTrack',
            'updateMediaSessionMetadata',
            'updateMediaSessionPlaybackState',
          ],
        },
        GOTO: {
          target: 'paused',
          actions: [
            'pauseAllTracks',
            'updateCurrentTrackIdx',
            'seekCurrentTrackToStart',
            'playCurrentTrack',
            'notifyStartNewTrack',
            'loadCurrentTrack',
            'updateMediaSessionMetadata',
            'updateMediaSessionPlaybackState',
          ],
        },
        SET_VOLUME: {
          actions: 'setVolume',
        },
        ADD_TRACK: {
          actions: 'addTrack',
        },
        REMOVE_TRACK: {
          actions: 'removeTrack',
        },
        TRACK_LOADED: {
          actions: 'handleTrackLoaded',
        },
      },
    },
  },
  on: {
    INTERNAL_UPDATE_MEDIA_SESSION: {
      actions: ['updateMediaSessionMetadata', 'updateMediaSessionPlaybackState'],
    },
  },
});
