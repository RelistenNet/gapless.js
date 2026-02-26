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
  }).createMachine({
    id: 'queue',
    initial: 'idle',
    context: initialContext,

    // Global handlers — shared across all states
    on: {
      ADD_TRACK: {
        actions: assign({ trackCount: ({ context }) => context.trackCount + 1 }),
      },
      REMOVE_TRACK: {
        actions: assign({
          trackCount: ({ context }) => Math.max(0, context.trackCount - 1),
          currentTrackIndex: ({ context, event }) => {
            const e = event as { type: 'REMOVE_TRACK'; index: number };
            if (e.index < context.currentTrackIndex) {
              return Math.max(0, context.currentTrackIndex - 1);
            }
            return context.currentTrackIndex;
          },
        }),
      },
    },

    states: {
      // -----------------------------------------------------------------
      // idle
      // -----------------------------------------------------------------
      idle: {
        on: {
          PLAY: { target: 'playing' },
          GOTO: [
            {
              guard: 'playImmediately',
              target: 'playing',
              actions: assign({
                currentTrackIndex: ({ event }) => (event as { type: 'GOTO'; index: number }).index,
              }),
            },
            {
              target: 'paused',
              actions: assign({
                currentTrackIndex: ({ event }) => (event as { type: 'GOTO'; index: number }).index,
              }),
            },
          ],
        },
      },

      // -----------------------------------------------------------------
      // playing
      // -----------------------------------------------------------------
      playing: {
        on: {
          PAUSE: { target: 'paused' },
          TOGGLE: { target: 'paused' },
          NEXT: {
            actions: assign({
              currentTrackIndex: ({ context }) => {
                const next = context.currentTrackIndex + 1;
                return next < context.trackCount ? next : context.currentTrackIndex;
              },
            }),
          },
          PREVIOUS: {
            actions: assign({
              currentTrackIndex: ({ context }) => Math.max(0, context.currentTrackIndex - 1),
            }),
          },
          GOTO: {
            actions: assign({
              currentTrackIndex: ({ event }) => (event as { type: 'GOTO'; index: number }).index,
            }),
          },
          SEEK: {},
          TRACK_ENDED: [
            {
              guard: 'hasNextTrack',
              target: 'playing',
              actions: assign({
                currentTrackIndex: ({ context }) => context.currentTrackIndex + 1,
              }),
            },
            { target: 'ended' },
          ],
          TRACK_LOADED: {},
        },
      },

      // -----------------------------------------------------------------
      // paused
      // -----------------------------------------------------------------
      paused: {
        on: {
          PLAY: { target: 'playing' },
          TOGGLE: { target: 'playing' },
          NEXT: {
            actions: assign({
              currentTrackIndex: ({ context }) => {
                const next = context.currentTrackIndex + 1;
                return next < context.trackCount ? next : context.currentTrackIndex;
              },
            }),
          },
          PREVIOUS: {
            actions: assign({
              currentTrackIndex: ({ context }) => Math.max(0, context.currentTrackIndex - 1),
            }),
          },
          GOTO: [
            {
              guard: 'playImmediately',
              target: 'playing',
              actions: assign({
                currentTrackIndex: ({ event }) => (event as { type: 'GOTO'; index: number }).index,
              }),
            },
            {
              actions: assign({
                currentTrackIndex: ({ event }) => (event as { type: 'GOTO'; index: number }).index,
              }),
            },
          ],
          SEEK: {},
          TRACK_ENDED: [
            {
              guard: 'hasNextTrack',
              target: 'paused',
              actions: assign({
                currentTrackIndex: ({ context }) => context.currentTrackIndex + 1,
              }),
            },
            { target: 'ended' },
          ],
        },
      },

      // -----------------------------------------------------------------
      // ended
      // -----------------------------------------------------------------
      ended: {
        on: {
          PLAY: {
            target: 'playing',
            actions: assign({ currentTrackIndex: () => 0 }),
          },
          GOTO: [
            {
              guard: 'playImmediately',
              target: 'playing',
              actions: assign({
                currentTrackIndex: ({ event }) => (event as { type: 'GOTO'; index: number }).index,
              }),
            },
            {
              target: 'paused',
              actions: assign({
                currentTrackIndex: ({ event }) => (event as { type: 'GOTO'; index: number }).index,
              }),
            },
          ],
        },
      },
    },
  });
}

export type QueueMachine = ReturnType<typeof createQueueMachine>;
