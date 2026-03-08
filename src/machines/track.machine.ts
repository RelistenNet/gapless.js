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

import { setup, assign, spawnChild } from 'xstate';
import { fetchDecodeMachine } from './fetchDecode.machine';
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
  fetchStarted: boolean;
  /** True when PLAY was received in webAudioOnly mode before buffer is ready. */
  pendingPlay: boolean;
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
  | { type: 'START_FETCH' }
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
    actors: {
      fetchDecode: fetchDecodeMachine,
    },
    guards: {
      canPlayWebAudio: () => false,
      isWebAudioOnly: () => false,
      canStartFetch: ({ context }) => context.webAudioLoadingState === 'NONE' && !context.fetchStarted,
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
      triggerFetchForPendingPlay: () => {},
      setPendingPlay: assign({ pendingPlay: () => true }),
      clearPendingPlay: assign({ pendingPlay: () => false }),
      setIsPlaying: assign({ isPlaying: () => true }),
      clearIsPlaying: assign({ isPlaying: () => false }),
      setLoadingState: assign({ webAudioLoadingState: () => 'LOADING' as WebAudioLoadingState }),
      setLoadedState: assign({ webAudioLoadingState: () => 'LOADED' as WebAudioLoadingState }),
      setErrorState: assign({ webAudioLoadingState: () => 'ERROR' as WebAudioLoadingState }),
      clearScheduleAndLookahead: assign({ scheduledStartContextTime: () => null, notifiedLookahead: () => false }),
      setPlayingWebAudio: assign({
        isPlaying: () => true,
        webAudioLoadingState: () => 'LOADED' as WebAudioLoadingState,
        playbackType: () => 'WEBAUDIO' as PlaybackType,
      }),
      setScheduledGapless: assign({
        isPlaying: () => true,
        webAudioLoadingState: () => 'LOADED' as WebAudioLoadingState,
        playbackType: () => 'WEBAUDIO' as PlaybackType,
        scheduledStartContextTime: ({ event }) =>
          (event as { type: 'SCHEDULE_GAPLESS'; when: number }).when,
      }),
      clearPlayingAndSchedule: assign({
        isPlaying: () => false,
        scheduledStartContextTime: () => null,
        notifiedLookahead: () => false,
      }),
      setNotifiedLookahead: assign({ notifiedLookahead: () => true }),
      setResolvedUrl: assign({
        resolvedUrl: ({ event }) => (event as { type: 'URL_RESOLVED'; url: string }).url,
      }),
      clearScheduledStart: assign({ scheduledStartContextTime: () => null }),
      setPlayingWebAudioType: assign({
        isPlaying: () => true,
        playbackType: () => 'WEBAUDIO' as PlaybackType,
      }),
    },
  }).createMachine({
    id: 'track',
    initial: 'idle',
    context: initialContext,

    on: {
      START_FETCH: {
        guard: 'canStartFetch',
        actions: [
          assign({
            webAudioLoadingState: () => 'LOADING' as WebAudioLoadingState,
            fetchStarted: () => true,
          }),
          spawnChild('fetchDecode', {
            id: 'fetchDecode',
            input: ({ context }) => ({
              trackUrl: context.trackUrl,
              resolvedUrl: context.resolvedUrl,
              skipHEAD: context.skipHEAD,
            }),
          }),
        ],
      },
    },

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
              'pauseHtml5',
              'resetHtml5Element',
              'resetTiming',
              'stopProgressLoop',
              'clearScheduleAndLookahead',
            ],
          },
          ACTIVATE: {
            actions: [
              'resetTiming',
              'resetHtml5Element',
              'clearScheduleAndLookahead',
            ],
          },
          PLAY: [
            {
              guard: 'canPlayWebAudio',
              target: 'webaudio',
              actions: [
                'setPlayingWebAudio',
                'startSourceNode',
                'startProgressLoop',
              ],
            },
            {
              guard: 'isWebAudioOnly',
              actions: ['setPendingPlay', 'triggerFetchForPendingPlay'],
            },
            {
              target: 'html5',
              actions: ['setIsPlaying', 'playHtml5', 'startProgressLoop'],
            },
          ],
          PLAY_WEBAUDIO: {
            target: 'webaudio',
            actions: [
              'setPlayingWebAudio',
              'startSourceNode',
              'startProgressLoop',
            ],
          },
          SCHEDULE_GAPLESS: {
            target: 'webaudio',
            actions: [
              'setScheduledGapless',
              'startScheduledSourceNode',
            ],
          },
          PRELOAD: { target: 'loading' },
          BUFFER_LOADING: {
            actions: 'setLoadingState',
          },
          BUFFER_READY: [
            {
              guard: ({ context }: { context: TrackContext }) => context.pendingPlay,
              target: 'webaudio',
              actions: ['clearPendingPlay', 'setPlayingWebAudio', 'startSourceNode', 'startProgressLoop'],
            },
            {
              actions: 'setLoadedState',
            },
          ],
          BUFFER_ERROR: {
            actions: ['setErrorState', 'clearPendingPlay'],
          },
          URL_RESOLVED: {
            actions: 'setResolvedUrl',
          },
        },
      },

      // -----------------------------------------------------------------
      // html5: HTML5 Audio is playing; WebAudio decode may be in progress
      // -----------------------------------------------------------------
      html5: {
        on: {
          PAUSE: {
            actions: ['clearIsPlaying', 'pauseHtml5', 'stopProgressLoop', 'reportProgress'],
          },
          PLAY: {
            actions: ['setIsPlaying', 'playHtml5', 'startProgressLoop'],
          },
          BUFFER_LOADING: {
            actions: 'setLoadingState',
          },
          PLAY_WEBAUDIO: {
            target: 'webaudio',
            actions: 'setPlayingWebAudio',
          },
          // Bug #2 fix: BUFFER_READY in html5 stays in html5, only updates loading state.
          // The actual switchover to webaudio only happens via explicit PLAY_WEBAUDIO.
          BUFFER_READY: {
            actions: 'setLoadedState',
          },
          BUFFER_ERROR: {
            actions: 'setErrorState',
          },
          SEEK: {
            actions: [
              'seekHtml5',
              'reportProgress',
            ],
          },
          LOOKAHEAD_REACHED: {
            actions: 'setNotifiedLookahead',
          },
          HTML5_ENDED: {
            target: 'idle',
            actions: ['clearIsPlaying', 'stopProgressLoop', 'notifyTrackEnded'],
          },
          ACTIVATE: {
            target: 'idle',
            actions: [
              'clearPlayingAndSchedule',
              'pauseHtml5',
              'stopProgressLoop',
              'resetTiming',
              'resetHtml5Element',
            ],
          },
          URL_RESOLVED: {
            actions: 'setResolvedUrl',
          },
          DEACTIVATE: {
            target: 'idle',
            actions: ['clearIsPlaying', 'pauseHtml5', 'resetHtml5Element', 'resetTiming', 'stopProgressLoop'],
          },
        },
      },

      // -----------------------------------------------------------------
      // loading: preloading in background (not the active track yet)
      // -----------------------------------------------------------------
      loading: {
        on: {
          BUFFER_LOADING: {
            actions: 'setLoadingState',
          },
          BUFFER_READY: [
            {
              guard: ({ context }: { context: TrackContext }) => context.pendingPlay,
              target: 'webaudio',
              actions: ['clearPendingPlay', 'setPlayingWebAudio', 'startSourceNode', 'startProgressLoop'],
            },
            {
              target: 'idle',
              actions: 'setLoadedState',
            },
          ],
          BUFFER_ERROR: {
            target: 'idle',
            actions: ['setErrorState', 'clearPendingPlay'],
          },
          PLAY: [
            {
              guard: 'canPlayWebAudio',
              target: 'webaudio',
              actions: [
                'setPlayingWebAudio',
                'startSourceNode',
                'startProgressLoop',
              ],
            },
            {
              guard: 'isWebAudioOnly',
              actions: ['setPendingPlay', 'triggerFetchForPendingPlay'],
            },
            {
              target: 'html5',
              actions: ['setIsPlaying', 'playHtml5', 'startProgressLoop'],
            },
          ],
          PLAY_WEBAUDIO: {
            target: 'webaudio',
            actions: [
              'setPlayingWebAudio',
              'startSourceNode',
              'startProgressLoop',
            ],
          },
          SCHEDULE_GAPLESS: {
            target: 'webaudio',
            actions: [
              'setScheduledGapless',
              'startScheduledSourceNode',
            ],
          },
          ACTIVATE: {
            target: 'idle',
            actions: [
              'clearPlayingAndSchedule',
              'resetTiming',
              'resetHtml5Element',
            ],
          },
          DEACTIVATE: {
            target: 'idle',
            actions: ['clearIsPlaying', 'resetTiming'],
          },
          URL_RESOLVED: {
            actions: 'setResolvedUrl',
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
              'clearIsPlaying',
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
              actions: ['setIsPlaying', 'startSourceNode', 'startProgressLoop'],
            },
            {
              actions: 'setIsPlaying',
            },
          ],
          PLAY_WEBAUDIO: {
            actions: 'setPlayingWebAudioType',
          },
          SEEK: {
            actions: [
              'clearScheduledStart',
              'seekWebAudio',
              'reportProgress',
            ],
          },
          SET_VOLUME: {},
          CANCEL_GAPLESS: {
            target: 'idle',
            actions: [
              'clearPlayingAndSchedule',
              'stopSourceNode',
              'disconnectGain',
              'stopProgressLoop',
              'resetTiming',
            ],
          },
          LOOKAHEAD_REACHED: {
            actions: 'setNotifiedLookahead',
          },
          WEBAUDIO_ENDED: {
            target: 'idle',
            actions: ['clearIsPlaying', 'stopProgressLoop', 'notifyTrackEnded'],
          },
          ACTIVATE: {
            target: 'idle',
            actions: [
              'clearPlayingAndSchedule',
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
              'clearPlayingAndSchedule',
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
