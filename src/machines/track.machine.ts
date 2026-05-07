// ---------------------------------------------------------------------------
// TrackMachine — per-track audio state (xstate v5)
//
// States:
//   idle        Initial state. Audio nodes not yet initialised.
//   html5       HTML5 Audio is playing. Web Audio fetch+decode is in progress.
//   loading     Track is preloaded (not yet playing). Decode in progress.
//   webaudio    AudioBufferSourceNode is the active output.
//
// Design invariant — "Web Audio always wins as soon as the buffer is ready":
//   When a track's buffer finishes decoding (BUFFER_READY) while the track is
//   playing via HTML5, we hand playback off to Web Audio mid-stream. The
//   HTML5 element is paused, and an AudioBufferSourceNode is started at the
//   exact offset the HTML5 element was at. From that instant on, the track
//   (and every gapless transition that follows it) lives on one clock
//   (AudioContext.currentTime).
//
//   This is fundamental to gapless correctness: we cannot predict when an
//   HTML5 element will fire 'ended' from the AudioContext clock — the two
//   run on independent clocks with independent jitter (buffering stalls,
//   codec padding differences, long-session drift). Any gapless scheduling
//   that crosses those clocks is a prediction, and predictions are how
//   overlap bugs happen. By moving the current track to Web Audio as soon
//   as we can, all future gapless transitions are WebAudio→WebAudio and
//   sample-accurate by construction.
//
//   DEACTIVATE transitions from every playing state land in idle, so a
//   deactivated track with a loaded buffer is always idle+LOADED — ready
//   for Web Audio on re-play.
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
      crossoverHtml5ToWebAudio: () => {},
      notifyBufferReady: () => {},
      startScheduledSourceNode: () => {},
      startProgressLoop: () => {},
      pauseHtml5: () => {},
      freezePausedTime: () => {},
      stopSourceNode: () => {},
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
      setPlaybackTypeWebAudio: assign({
        playbackType: () => 'WEBAUDIO' as PlaybackType,
      }),
      clearNotifiedLookahead: assign({
        notifiedLookahead: () => false,
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
              // triggerFetchForPendingPlay also kicks off fetch+decode for the
              // CURRENT track, not just the next one. That way BUFFER_READY
              // fires while we're in html5, and crossoverHtml5ToWebAudio can
              // hand the active track over to Web Audio mid-stream. The
              // canStartFetch guard inside START_FETCH makes this a no-op if
              // a fetch is already in flight (e.g. PLAY from loading state).
              actions: ['setIsPlaying', 'playHtml5', 'startProgressLoop', 'triggerFetchForPendingPlay'],
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
              actions: ['clearPendingPlay', 'setPlayingWebAudio', 'startSourceNode', 'startProgressLoop', 'notifyBufferReady'],
            },
            {
              actions: ['setLoadedState', 'notifyBufferReady'],
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
          // Mid-stream crossover to Web Audio. Running `crossoverHtml5ToWebAudio`
          // synchronously captures audio.currentTime, pauses the HTML5 element,
          // and starts a Web Audio source node at that exact offset. After the
          // transition completes we're in webaudio state with isPlaying preserved
          // (true if the track was playing, false if paused), so a subsequent
          // PLAY in webaudio state will resume from pausedAtTrackTime.
          //
          // clearNotifiedLookahead resets the gapless lookahead flag so the
          // webaudio progress loop can re-trigger scheduling with the accurate
          // shared-clock end time, replacing any stale HTML5-clock prediction.
          BUFFER_READY: {
            target: 'webaudio',
            actions: [
              'setLoadedState',
              'crossoverHtml5ToWebAudio',
              'setPlaybackTypeWebAudio',
              'clearNotifiedLookahead',
              'notifyBufferReady',
            ],
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
              actions: ['clearPendingPlay', 'setPlayingWebAudio', 'startSourceNode', 'startProgressLoop', 'notifyBufferReady'],
            },
            {
              target: 'idle',
              actions: ['setLoadedState', 'notifyBufferReady'],
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
              // triggerFetchForPendingPlay also kicks off fetch+decode for the
              // CURRENT track, not just the next one. That way BUFFER_READY
              // fires while we're in html5, and crossoverHtml5ToWebAudio can
              // hand the active track over to Web Audio mid-stream. The
              // canStartFetch guard inside START_FETCH makes this a no-op if
              // a fetch is already in flight (e.g. PLAY from loading state).
              actions: ['setIsPlaying', 'playHtml5', 'startProgressLoop', 'triggerFetchForPendingPlay'],
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
