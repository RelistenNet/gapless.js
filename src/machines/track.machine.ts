// ---------------------------------------------------------------------------
// TrackMachine — per-track audio state (xstate v5)
//
// States:
//   idle        Initial state. Audio nodes not yet initialised.
//   html5       HTML5 Audio is playing. Web Audio fetch+decode may be in progress.
//   loading     Track is preloaded (not yet playing). Decode in progress.
//   webaudio    AudioBufferSourceNode is the active output.
//
// Design invariant — "Web Audio always wins eventually":
//   When a track's buffer finishes decoding (BUFFER_READY), webAudioLoadingState
//   is set to 'LOADED' regardless of what state the machine is in (html5, loading,
//   or idle). We intentionally do NOT switch mid-stream — the track stays in html5
//   until the next play(). But every state handles BUFFER_READY, so the flag is
//   never lost, and the next play() will see the buffer and use Web Audio.
//
//   All DEACTIVATE transitions land in idle (not loading), so a deactivated track
//   with a loaded buffer is always in idle+LOADED — ready for Web Audio on re-play.
//
// Bug fixes in this rewrite:
//   #2: BUFFER_READY in html5 stays in html5 (no longer auto-transitions to webaudio)
//   #3: DEACTIVATE from webaudio → idle (was staying in webaudio)
//   #4: Removed dead error state (webAudioLoadingState: 'ERROR' is sufficient)
// ---------------------------------------------------------------------------

import { setup, assign } from 'xstate';
import type { WebAudioLoadingState, PlaybackType } from '../types';

// ---- Context ---------------------------------------------------------------

export interface TrackContext {
  trackUrl: string;
  resolvedUrl: string;
  skipHEAD: boolean;
  playbackType: PlaybackType;
  webAudioLoadingState: WebAudioLoadingState;
  webAudioStartedAt: number;
  pausedAtTrackTime: number;
  isPlaying: boolean;
}

// ---- Events ----------------------------------------------------------------

export type TrackEvent =
  | { type: 'ACTIVATE' }
  | { type: 'DEACTIVATE' }
  | { type: 'PRELOAD' }
  | { type: 'BUFFER_LOADING' }
  | { type: 'PLAY' }
  | { type: 'PLAY_WEBAUDIO' }
  | { type: 'PAUSE' }
  | { type: 'SEEK'; time: number }
  | { type: 'SET_VOLUME'; volume: number }
  | { type: 'BUFFER_READY' }
  | { type: 'BUFFER_ERROR' }
  | { type: 'HTML5_ENDED' }
  | { type: 'WEBAUDIO_ENDED' }
  | { type: 'URL_RESOLVED'; url: string };

// ---- Machine ---------------------------------------------------------------

export function createTrackMachine(initialContext: TrackContext) {
  return setup({
    types: {
      context: {} as TrackContext,
      events: {} as TrackEvent,
    },
  }).createMachine({
    id: 'track',
    initial: 'idle',
    context: initialContext,

    states: {
      // -----------------------------------------------------------------
      // idle: constructed but not started
      // -----------------------------------------------------------------
      idle: {
        on: {
          HTML5_ENDED: {},
          PLAY: {
            target: 'html5',
            actions: assign({ isPlaying: () => true }),
          },
          PLAY_WEBAUDIO: {
            target: 'webaudio',
            actions: assign({
              isPlaying: () => true,
              webAudioLoadingState: () => 'LOADED' as WebAudioLoadingState,
              playbackType: () => 'WEBAUDIO' as PlaybackType,
            }),
          },
          PRELOAD: { target: 'loading' },
          BUFFER_LOADING: {
            actions: assign({ webAudioLoadingState: () => 'LOADING' as WebAudioLoadingState }),
          },
          BUFFER_READY: {
            actions: assign({ webAudioLoadingState: () => 'LOADED' as WebAudioLoadingState }),
          },
          BUFFER_ERROR: {
            actions: assign({ webAudioLoadingState: () => 'ERROR' as WebAudioLoadingState }),
          },
          URL_RESOLVED: {
            actions: assign({
              resolvedUrl: ({ event }) => (event as { type: 'URL_RESOLVED'; url: string }).url,
            }),
          },
        },
      },

      // -----------------------------------------------------------------
      // html5: HTML5 Audio is playing; WebAudio decode may be in progress
      // -----------------------------------------------------------------
      html5: {
        on: {
          PAUSE: {
            actions: assign({ isPlaying: () => false }),
          },
          PLAY: {
            actions: assign({ isPlaying: () => true }),
          },
          BUFFER_LOADING: {
            actions: assign({ webAudioLoadingState: () => 'LOADING' as WebAudioLoadingState }),
          },
          PLAY_WEBAUDIO: {
            target: 'webaudio',
            actions: assign({
              isPlaying: () => true,
              webAudioLoadingState: () => 'LOADED' as WebAudioLoadingState,
              playbackType: () => 'WEBAUDIO' as PlaybackType,
            }),
          },
          // Bug #2 fix: BUFFER_READY in html5 stays in html5, only updates loading state.
          // The actual switchover to webaudio only happens via explicit PLAY_WEBAUDIO.
          BUFFER_READY: {
            actions: assign({
              webAudioLoadingState: () => 'LOADED' as WebAudioLoadingState,
            }),
          },
          BUFFER_ERROR: {
            actions: assign({
              webAudioLoadingState: () => 'ERROR' as WebAudioLoadingState,
            }),
          },
          SEEK: {
            actions: assign({
              pausedAtTrackTime: ({ event }) => (event as { type: 'SEEK'; time: number }).time,
            }),
          },
          HTML5_ENDED: {
            target: 'idle',
            actions: assign({ isPlaying: () => false }),
          },
          URL_RESOLVED: {
            actions: assign({
              resolvedUrl: ({ event }) => (event as { type: 'URL_RESOLVED'; url: string }).url,
            }),
          },
          DEACTIVATE: {
            target: 'idle',
            actions: assign({ isPlaying: () => false }),
          },
        },
      },

      // -----------------------------------------------------------------
      // loading: preloading in background (not the active track yet)
      // -----------------------------------------------------------------
      loading: {
        on: {
          BUFFER_LOADING: {
            actions: assign({ webAudioLoadingState: () => 'LOADING' as WebAudioLoadingState }),
          },
          BUFFER_READY: {
            target: 'idle',
            actions: assign({
              webAudioLoadingState: () => 'LOADED' as WebAudioLoadingState,
            }),
          },
          BUFFER_ERROR: {
            target: 'idle',
            actions: assign({
              webAudioLoadingState: () => 'ERROR' as WebAudioLoadingState,
            }),
          },
          PLAY: {
            target: 'html5',
            actions: assign({ isPlaying: () => true }),
          },
          PLAY_WEBAUDIO: {
            target: 'webaudio',
            actions: assign({
              isPlaying: () => true,
              webAudioLoadingState: () => 'LOADED' as WebAudioLoadingState,
              playbackType: () => 'WEBAUDIO' as PlaybackType,
            }),
          },
          DEACTIVATE: {
            target: 'idle',
            actions: assign({ isPlaying: () => false }),
          },
          URL_RESOLVED: {
            actions: assign({
              resolvedUrl: ({ event }) => (event as { type: 'URL_RESOLVED'; url: string }).url,
            }),
          },
        },
      },

      // -----------------------------------------------------------------
      // webaudio: AudioBufferSourceNode is driving output
      // -----------------------------------------------------------------
      webaudio: {
        on: {
          PAUSE: {
            actions: assign({ isPlaying: () => false }),
          },
          PLAY: {
            actions: assign({ isPlaying: () => true }),
          },
          PLAY_WEBAUDIO: {
            actions: assign({
              isPlaying: () => true,
              playbackType: () => 'WEBAUDIO' as PlaybackType,
            }),
          },
          SEEK: {
            actions: assign({
              pausedAtTrackTime: ({ event }) => (event as { type: 'SEEK'; time: number }).time,
            }),
          },
          SET_VOLUME: {},
          WEBAUDIO_ENDED: {
            target: 'idle',
            actions: assign({ isPlaying: () => false }),
          },
          // Bug #3 fix: DEACTIVATE from webaudio → idle (was staying in webaudio)
          DEACTIVATE: {
            target: 'idle',
            actions: assign({ isPlaying: () => false }),
          },
        },
      },
    },
  });
}

export type TrackMachine = ReturnType<typeof createTrackMachine>;
