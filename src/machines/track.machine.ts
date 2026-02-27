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
  isPlaying: boolean;
  scheduledStartContextTime: number | null;
  notifiedLookahead: boolean;
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
  | { type: 'URL_RESOLVED'; url: string }
  | { type: 'SCHEDULE_GAPLESS'; when: number }
  | { type: 'CANCEL_GAPLESS' }
  | { type: 'LOOKAHEAD_REACHED' };

// ---- Machine ---------------------------------------------------------------

export function createTrackMachine(initialContext: TrackContext) {
  return setup({
    types: {
      context: {} as TrackContext,
      events: {} as TrackEvent,
    },
    guards: {
      canPlayWebAudio: () => false,
    },
    actions: {
      playHtml5: () => {},
      startSourceNode: () => {},
      startScheduledSourceNode: () => {},
      startProgressLoop: () => {},
      pauseHtml5: () => {},
      freezePausedTime: () => {},
      stopSourceNode: () => {},
      disconnectGain: () => {},
      stopProgressLoop: () => {},
      reportProgress: () => {},
      seekHtml5: () => {},
      seekWebAudio: () => {},
      resetHtml5Element: () => {},
      resetTiming: () => {},
      notifyTrackEnded: () => {},
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
          HTML5_ENDED: {
            actions: ['notifyTrackEnded'],
          },
          DEACTIVATE: {
            actions: [
              'resetHtml5Element',
              'resetTiming',
              'stopProgressLoop',
              assign({ scheduledStartContextTime: () => null, notifiedLookahead: () => false }),
            ],
          },
          ACTIVATE: {
            actions: [
              'resetTiming',
              'resetHtml5Element',
              assign({ scheduledStartContextTime: () => null, notifiedLookahead: () => false }),
            ],
          },
          PLAY: [
            {
              guard: 'canPlayWebAudio',
              target: 'webaudio',
              actions: [
                assign({
                  isPlaying: () => true,
                  webAudioLoadingState: () => 'LOADED' as WebAudioLoadingState,
                  playbackType: () => 'WEBAUDIO' as PlaybackType,
                }),
                'startSourceNode',
                'startProgressLoop',
              ],
            },
            {
              target: 'html5',
              actions: [assign({ isPlaying: () => true }), 'playHtml5', 'startProgressLoop'],
            },
          ],
          PLAY_WEBAUDIO: {
            target: 'webaudio',
            actions: [
              assign({
                isPlaying: () => true,
                webAudioLoadingState: () => 'LOADED' as WebAudioLoadingState,
                playbackType: () => 'WEBAUDIO' as PlaybackType,
              }),
              'startSourceNode',
              'startProgressLoop',
            ],
          },
          SCHEDULE_GAPLESS: {
            target: 'webaudio',
            actions: [
              assign({
                isPlaying: () => true,
                webAudioLoadingState: () => 'LOADED' as WebAudioLoadingState,
                playbackType: () => 'WEBAUDIO' as PlaybackType,
                scheduledStartContextTime: ({ event }) =>
                  (event as { type: 'SCHEDULE_GAPLESS'; when: number }).when,
              }),
              'startScheduledSourceNode',
            ],
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
            actions: [assign({ isPlaying: () => false }), 'pauseHtml5', 'stopProgressLoop', 'reportProgress'],
          },
          PLAY: {
            actions: [assign({ isPlaying: () => true }), 'playHtml5', 'startProgressLoop'],
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
            actions: [
              'seekHtml5',
              'reportProgress',
            ],
          },
          LOOKAHEAD_REACHED: {
            actions: assign({ notifiedLookahead: () => true }),
          },
          HTML5_ENDED: {
            target: 'idle',
            actions: [assign({ isPlaying: () => false }), 'stopProgressLoop', 'notifyTrackEnded'],
          },
          ACTIVATE: {
            target: 'idle',
            actions: [
              assign({
                isPlaying: () => false,
                scheduledStartContextTime: () => null,
                notifiedLookahead: () => false,
              }),
              'pauseHtml5',
              'stopProgressLoop',
              'resetTiming',
              'resetHtml5Element',
            ],
          },
          URL_RESOLVED: {
            actions: assign({
              resolvedUrl: ({ event }) => (event as { type: 'URL_RESOLVED'; url: string }).url,
            }),
          },
          DEACTIVATE: {
            target: 'idle',
            actions: [assign({ isPlaying: () => false }), 'pauseHtml5', 'resetHtml5Element', 'resetTiming', 'stopProgressLoop'],
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
          PLAY: [
            {
              guard: 'canPlayWebAudio',
              target: 'webaudio',
              actions: [
                assign({
                  isPlaying: () => true,
                  webAudioLoadingState: () => 'LOADED' as WebAudioLoadingState,
                  playbackType: () => 'WEBAUDIO' as PlaybackType,
                }),
                'startSourceNode',
                'startProgressLoop',
              ],
            },
            {
              target: 'html5',
              actions: [assign({ isPlaying: () => true }), 'playHtml5', 'startProgressLoop'],
            },
          ],
          PLAY_WEBAUDIO: {
            target: 'webaudio',
            actions: [
              assign({
                isPlaying: () => true,
                webAudioLoadingState: () => 'LOADED' as WebAudioLoadingState,
                playbackType: () => 'WEBAUDIO' as PlaybackType,
              }),
              'startSourceNode',
              'startProgressLoop',
            ],
          },
          SCHEDULE_GAPLESS: {
            target: 'webaudio',
            actions: [
              assign({
                isPlaying: () => true,
                webAudioLoadingState: () => 'LOADED' as WebAudioLoadingState,
                playbackType: () => 'WEBAUDIO' as PlaybackType,
                scheduledStartContextTime: ({ event }) =>
                  (event as { type: 'SCHEDULE_GAPLESS'; when: number }).when,
              }),
              'startScheduledSourceNode',
            ],
          },
          ACTIVATE: {
            target: 'idle',
            actions: [
              assign({
                isPlaying: () => false,
                scheduledStartContextTime: () => null,
                notifiedLookahead: () => false,
              }),
              'resetTiming',
              'resetHtml5Element',
            ],
          },
          DEACTIVATE: {
            target: 'idle',
            actions: [assign({ isPlaying: () => false }), 'resetTiming'],
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
            actions: [
              assign({ isPlaying: () => false }),
              'freezePausedTime',
              'stopSourceNode',
              'disconnectGain',
              'stopProgressLoop',
              'reportProgress',
            ],
          },
          PLAY: [
            {
              guard: 'canPlayWebAudio',
              actions: [assign({ isPlaying: () => true }), 'startSourceNode', 'startProgressLoop'],
            },
            {
              actions: assign({ isPlaying: () => true }),
            },
          ],
          PLAY_WEBAUDIO: {
            actions: assign({
              isPlaying: () => true,
              playbackType: () => 'WEBAUDIO' as PlaybackType,
            }),
          },
          SEEK: {
            actions: [
              assign({ scheduledStartContextTime: () => null }),
              'seekWebAudio',
              'reportProgress',
            ],
          },
          SET_VOLUME: {},
          CANCEL_GAPLESS: {
            target: 'idle',
            actions: [
              assign({
                isPlaying: () => false,
                scheduledStartContextTime: () => null,
                notifiedLookahead: () => false,
              }),
              'stopSourceNode',
              'disconnectGain',
              'stopProgressLoop',
              'resetTiming',
            ],
          },
          LOOKAHEAD_REACHED: {
            actions: assign({ notifiedLookahead: () => true }),
          },
          WEBAUDIO_ENDED: {
            target: 'idle',
            actions: [assign({ isPlaying: () => false }), 'stopProgressLoop', 'notifyTrackEnded'],
          },
          ACTIVATE: {
            target: 'idle',
            actions: [
              assign({
                isPlaying: () => false,
                scheduledStartContextTime: () => null,
                notifiedLookahead: () => false,
              }),
              'stopSourceNode',
              'disconnectGain',
              'stopProgressLoop',
              'resetTiming',
              'resetHtml5Element',
            ],
          },
          // Bug #3 fix: DEACTIVATE from webaudio → idle (was staying in webaudio)
          DEACTIVATE: {
            target: 'idle',
            actions: [
              assign({
                isPlaying: () => false,
                scheduledStartContextTime: () => null,
                notifiedLookahead: () => false,
              }),
              'stopSourceNode',
              'disconnectGain',
              'resetTiming',
              'resetHtml5Element',
              'stopProgressLoop',
            ],
          },
        },
      },
    },
  });
}

export type TrackMachine = ReturnType<typeof createTrackMachine>;
