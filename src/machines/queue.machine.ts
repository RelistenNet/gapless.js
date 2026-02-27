// ---------------------------------------------------------------------------
// QueueMachine — top-level queue state (xstate v5)
//
// States:
//   idle     No tracks, or not yet started.
//   playing  A track is actively playing.
//   paused   Explicitly paused by the user.
//   ended    The last track in the queue has finished.
//
// Root-level `on:` eliminates the handler duplication that plagued v2.
//
// Named actions (no-op defaults here, real implementations via .provide()):
//   Actions before assign() see the OLD context (e.g. deactivateCurrent
//   sees the old currentTrackIndex). Actions after assign() see the NEW
//   context (e.g. activateAndPlayCurrent sees the incremented index).
//   Implementations MUST use the ({ context }) parameter, NOT getSnapshot().
// ---------------------------------------------------------------------------

import { setup, assign } from 'xstate';

// ---- Context ---------------------------------------------------------------

export interface QueueContext {
  currentTrackIndex: number;
  trackCount: number;
}

// ---- Events ----------------------------------------------------------------

export type QueueEvent =
  | { type: 'PLAY' }
  | { type: 'PAUSE' }
  | { type: 'TOGGLE' }
  | { type: 'NEXT' }
  | { type: 'PREVIOUS' }
  | { type: 'GOTO'; index: number; playImmediately?: boolean }
  | { type: 'SEEK'; time: number }
  | { type: 'SET_VOLUME'; volume: number }
  | { type: 'ADD_TRACK' }
  | { type: 'REMOVE_TRACK'; index: number }
  | { type: 'TRACK_ENDED' }
  | { type: 'TRACK_LOADED'; index: number };

// ---- Machine ---------------------------------------------------------------

export function createQueueMachine(initialContext: QueueContext) {
  return setup({
    types: {
      context: {} as QueueContext,
      events: {} as QueueEvent,
    },
    guards: {
      hasNextTrack: ({ context }) => context.currentTrackIndex + 1 < context.trackCount,
      playImmediately: ({ event }) =>
        !!(event as { type: 'GOTO'; playImmediately?: boolean }).playImmediately,
    },
    actions: {
      // --- named assign actions (avoids mixing inline assign with custom actions) ---
      incrementTrackCount: assign({
        trackCount: ({ context }) => context.trackCount + 1,
      }),
      decrementTrackCount: assign({
        trackCount: ({ context }) => Math.max(0, context.trackCount - 1),
        currentTrackIndex: ({ context, event }) => {
          const e = event as { type: 'REMOVE_TRACK'; index: number };
          if (e.index < context.currentTrackIndex) {
            return Math.max(0, context.currentTrackIndex - 1);
          }
          return context.currentTrackIndex;
        },
      }),
      gotoTrackIndex: assign({
        currentTrackIndex: ({ event }) =>
          (event as { type: 'GOTO'; index: number }).index,
      }),
      advanceToNextTrack: assign({
        currentTrackIndex: ({ context }) => {
          const next = context.currentTrackIndex + 1;
          return next < context.trackCount ? next : context.currentTrackIndex;
        },
      }),
      goToPreviousTrack: assign({
        currentTrackIndex: ({ context }) => Math.max(0, context.currentTrackIndex - 1),
      }),
      advanceOnTrackEnd: assign({
        currentTrackIndex: ({ context }) => context.currentTrackIndex + 1,
      }),
      resetToFirstTrack: assign({
        currentTrackIndex: () => 0,
      }),
      // --- side-effect actions (no-op defaults, provided by Queue.ts) ---
      deactivateCurrent: () => {},
      deactivateEndedTrack: () => {},
      activateAndPlayCurrent: () => {},
      playOrContinueGapless: () => {},
      cancelAllGapless: () => {},
      notifyStartNewTrack: () => {},
      notifyPlayNextTrack: () => {},
      notifyPlayPreviousTrack: () => {},
      notifyEnded: () => {},
      updateMediaSessionMetadata: () => {},
      preloadAhead: () => {},
      playCurrent: () => {},
      pauseCurrent: () => {},
      seekCurrent: () => {},
      seekCurrentToZero: () => {},
      scheduleGapless: () => {},
      cancelScheduledGapless: () => {},
      cancelAndRescheduleGapless: () => {},
    },
  }).createMachine({
    id: 'queue',
    initial: 'idle',
    context: initialContext,

    // Global handlers — shared across all states
    on: {
      ADD_TRACK: {
        actions: 'incrementTrackCount',
      },
      REMOVE_TRACK: {
        actions: 'decrementTrackCount',
      },
    },

    states: {
      // -----------------------------------------------------------------
      // idle
      // -----------------------------------------------------------------
      idle: {
        on: {
          PLAY: {
            target: 'playing',
            actions: ['playCurrent', 'updateMediaSessionMetadata', 'preloadAhead', 'scheduleGapless'],
          },
          GOTO: [
            {
              guard: 'playImmediately',
              target: 'playing',
              actions: [
                'deactivateCurrent',
                'cancelAllGapless',
                'gotoTrackIndex',
                'activateAndPlayCurrent',
                'notifyStartNewTrack',
                'updateMediaSessionMetadata',
                'preloadAhead',
              ],
            },
            {
              target: 'paused',
              actions: [
                'deactivateCurrent',
                'cancelAllGapless',
                'gotoTrackIndex',
                'seekCurrentToZero',
                'preloadAhead',
              ],
            },
          ],
          TRACK_LOADED: {
            actions: ['preloadAhead'],
          },
        },
      },

      // -----------------------------------------------------------------
      // playing
      // -----------------------------------------------------------------
      playing: {
        on: {
          PAUSE: {
            target: 'paused',
            actions: ['cancelScheduledGapless', 'pauseCurrent'],
          },
          TOGGLE: {
            target: 'paused',
            actions: ['cancelScheduledGapless', 'pauseCurrent'],
          },
          NEXT: {
            actions: [
              'deactivateCurrent',
              'cancelAllGapless',
              'advanceToNextTrack',
              'activateAndPlayCurrent',
              'notifyStartNewTrack',
              'notifyPlayNextTrack',
              'updateMediaSessionMetadata',
              'preloadAhead',
            ],
          },
          PREVIOUS: {
            actions: [
              'deactivateCurrent',
              'cancelAllGapless',
              'goToPreviousTrack',
              'activateAndPlayCurrent',
              'notifyStartNewTrack',
              'notifyPlayPreviousTrack',
              'updateMediaSessionMetadata',
              'preloadAhead',
            ],
          },
          GOTO: [
            {
              guard: 'playImmediately',
              actions: [
                'deactivateCurrent',
                'cancelAllGapless',
                'gotoTrackIndex',
                'activateAndPlayCurrent',
                'notifyStartNewTrack',
                'updateMediaSessionMetadata',
                'preloadAhead',
              ],
            },
            {
              actions: [
                'deactivateCurrent',
                'cancelAllGapless',
                'gotoTrackIndex',
                'seekCurrentToZero',
                'preloadAhead',
              ],
            },
          ],
          SEEK: {
            actions: ['seekCurrent', 'cancelAndRescheduleGapless'],
          },
          TRACK_ENDED: [
            {
              guard: 'hasNextTrack',
              target: 'playing',
              actions: [
                'deactivateEndedTrack',
                'advanceOnTrackEnd',
                'playOrContinueGapless',
                'notifyStartNewTrack',
                'notifyPlayNextTrack',
                'updateMediaSessionMetadata',
                'preloadAhead',
              ],
            },
            {
              target: 'ended',
              actions: ['deactivateEndedTrack', 'notifyEnded'],
            },
          ],
          TRACK_LOADED: {
            actions: ['scheduleGapless', 'preloadAhead'],
          },
        },
      },

      // -----------------------------------------------------------------
      // paused
      // -----------------------------------------------------------------
      paused: {
        on: {
          PLAY: {
            target: 'playing',
            actions: ['playCurrent', 'updateMediaSessionMetadata', 'preloadAhead', 'scheduleGapless'],
          },
          TOGGLE: {
            target: 'playing',
            actions: ['playCurrent', 'updateMediaSessionMetadata', 'preloadAhead', 'scheduleGapless'],
          },
          NEXT: {
            actions: [
              'deactivateCurrent',
              'cancelAllGapless',
              'advanceToNextTrack',
              'activateAndPlayCurrent',
              'notifyStartNewTrack',
              'notifyPlayNextTrack',
              'updateMediaSessionMetadata',
              'preloadAhead',
            ],
          },
          PREVIOUS: {
            actions: [
              'deactivateCurrent',
              'cancelAllGapless',
              'goToPreviousTrack',
              'activateAndPlayCurrent',
              'notifyStartNewTrack',
              'notifyPlayPreviousTrack',
              'updateMediaSessionMetadata',
              'preloadAhead',
            ],
          },
          GOTO: [
            {
              guard: 'playImmediately',
              target: 'playing',
              actions: [
                'deactivateCurrent',
                'cancelAllGapless',
                'gotoTrackIndex',
                'activateAndPlayCurrent',
                'notifyStartNewTrack',
                'updateMediaSessionMetadata',
                'preloadAhead',
              ],
            },
            {
              actions: [
                'deactivateCurrent',
                'cancelAllGapless',
                'gotoTrackIndex',
                'seekCurrentToZero',
                'preloadAhead',
              ],
            },
          ],
          SEEK: {
            actions: ['seekCurrent'],
          },
          TRACK_ENDED: [
            {
              guard: 'hasNextTrack',
              target: 'paused',
              actions: [
                'deactivateEndedTrack',
                'advanceOnTrackEnd',
                'notifyStartNewTrack',
                'updateMediaSessionMetadata',
              ],
            },
            {
              target: 'ended',
              actions: ['deactivateEndedTrack', 'notifyEnded'],
            },
          ],
          TRACK_LOADED: {
            actions: ['preloadAhead'],
          },
        },
      },

      // -----------------------------------------------------------------
      // ended
      // -----------------------------------------------------------------
      ended: {
        on: {
          PLAY: {
            target: 'playing',
            actions: [
              'resetToFirstTrack',
              'playCurrent',
              'updateMediaSessionMetadata',
              'preloadAhead',
              'scheduleGapless',
            ],
          },
          GOTO: [
            {
              guard: 'playImmediately',
              target: 'playing',
              actions: [
                'deactivateCurrent',
                'cancelAllGapless',
                'gotoTrackIndex',
                'activateAndPlayCurrent',
                'notifyStartNewTrack',
                'updateMediaSessionMetadata',
                'preloadAhead',
              ],
            },
            {
              target: 'paused',
              actions: [
                'deactivateCurrent',
                'cancelAllGapless',
                'gotoTrackIndex',
                'seekCurrentToZero',
                'preloadAhead',
              ],
            },
          ],
        },
      },
    },
  });
}

export type QueueMachine = ReturnType<typeof createQueueMachine>;
