// ---------------------------------------------------------------------------
// QueueMachine — top-level queue state (xstate v5)
//
// States:
//   idle     No tracks, or not yet started.
//   playing  A track is actively playing.
//   paused   Explicitly paused by the user.
//   ended    The last track in the queue has finished.
//
// The machine knows *which* entry is current (by reference), never *where* it
// is. Order questions ("what plays after this?") go to the PlayList the queue
// provides, which is also where repeat lives. Indices exist only at the public
// API edge, derived from the queue's array.
//
// Root-level `on:` eliminates the handler duplication that plagued v2.
//
// Named actions (no-op defaults here, real implementations via .provide()):
//   Actions before assign() see the OLD context (e.g. deactivateCurrent
//   sees the old current entry). Actions after assign() see the NEW context
//   (e.g. activateCurrent sees the entry advanced to).
//   Implementations MUST use the ({ context }) parameter, NOT getSnapshot().
// ---------------------------------------------------------------------------

import { setup, assign } from 'xstate';

// ---- Play order ------------------------------------------------------------

/** The queue's play order, as the machine sees it. Implemented by Queue. */
export interface PlayList<T> {
  /** The entry that plays after `entry` (wrapping under repeat 'all'), or null at the end. */
  next(entry: T): T | null;
  /** The entry before `entry`, or null at the start. */
  previous(entry: T): T | null;
  first(): T | null;
  size(): number;
  /** True when the current entry restarts as it ends (repeat 'one', or 'all' over one entry). */
  repeatsCurrent(): boolean;
}

// ---- Context ---------------------------------------------------------------

export interface QueueContext<T> {
  current: T | null;
  list: PlayList<T>;
}

// ---- Events ----------------------------------------------------------------

export type QueueEvent<T> =
  | { type: 'PLAY' }
  | { type: 'PAUSE' }
  | { type: 'TOGGLE' }
  | { type: 'NEXT' }
  | { type: 'PREVIOUS' }
  | { type: 'GOTO'; track: T; playImmediately?: boolean; startTime?: number }
  | { type: 'SEEK'; time: number }
  | { type: 'SET_VOLUME'; volume: number }
  // Sent after the entry has left the list. `successor` is what becomes
  // current if `track` was current (null if the list is now empty).
  | { type: 'REMOVE_TRACK'; track: T; successor: T | null }
  | { type: 'TRACK_ENDED' }
  | { type: 'TRACK_LOADED'; track: T }
  // The list changed (entries added or reordered). The queue says which entry
  // is current now; assign-only, the queue runs the side effects.
  | { type: 'LIST_CHANGED'; current: T | null };

// ---- Machine ---------------------------------------------------------------

export function createQueueMachine<T>(initialContext: QueueContext<T>) {
  type Ctx = QueueContext<T>;
  type Ev = QueueEvent<T>;
  const nextOf = (c: Ctx) => (c.current === null ? null : c.list.next(c.current));
  return setup({
    types: {
      context: {} as Ctx,
      events: {} as Ev,
    },
    guards: {
      hasNextTrack: ({ context }) => nextOf(context) !== null,
      repeatsCurrent: ({ context }) => context.current !== null && context.list.repeatsCurrent(),
      playImmediately: ({ event }) =>
        !!(event as { type: 'GOTO'; playImmediately?: boolean }).playImmediately,
      // REMOVE_TRACK is sent after the entry has left the list.
      willBeEmpty: ({ context }) => context.list.size() === 0,
      isRemovingCurrent: ({ context, event }) =>
        (event as { type: 'REMOVE_TRACK'; track: T }).track === context.current,
      isCurrentTrackLoaded: ({ context, event }) =>
        (event as { type: 'TRACK_LOADED'; track: T }).track === context.current,
      listIsEmpty: ({ context }) => context.list.size() === 0,
      // After LIST_CHANGED: something follows the (new) current entry.
      listHasNextAfterChange: ({ context, event }) => {
        const cur = (event as { type: 'LIST_CHANGED'; current: T | null }).current;
        return cur !== null && context.list.next(cur) !== null;
      },
    },
    actions: {
      // --- named assign actions (avoids mixing inline assign with custom actions) ---
      removeTrack: assign({
        current: ({ context, event }) => {
          const e = event as { type: 'REMOVE_TRACK'; track: T; successor: T | null };
          return e.track === context.current ? e.successor : context.current;
        },
      }),
      gotoTrack: assign({
        current: ({ event }) => (event as { type: 'GOTO'; track: T }).track,
      }),
      advanceToNextTrack: assign({
        current: ({ context }) => nextOf(context) ?? context.current,
      }),
      goToPreviousTrack: assign({
        current: ({ context }) =>
          context.current === null
            ? null
            : (context.list.previous(context.current) ?? context.current),
      }),
      advanceOnTrackEnd: assign({
        current: ({ context }) => nextOf(context) ?? context.current,
      }),
      listChanged: assign({
        current: ({ event }) => (event as { type: 'LIST_CHANGED'; current: T | null }).current,
      }),
      resetToFirstTrack: assign({
        current: ({ context }) => context.list.first(),
      }),
      // --- side-effect actions (no-op defaults, provided by Queue.ts) ---
      deactivateCurrent: () => {},
      deactivateEndedTrack: () => {},
      activateCurrent: () => {},
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
      seekCurrentToStartTime: () => {},
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
      REMOVE_TRACK: {
        actions: 'removeTrack',
      },
      LIST_CHANGED: [
        {
          guard: 'listIsEmpty',
          target: '.idle',
          actions: 'listChanged',
        },
        { actions: 'listChanged' },
      ],
    },

    states: {
      // -----------------------------------------------------------------
      // idle
      // -----------------------------------------------------------------
      idle: {
        on: {
          PLAY: {
            target: 'playing',
            actions: [
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
                'gotoTrack',
                'activateCurrent',
                'seekCurrentToStartTime',
                'playCurrent',
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
                'gotoTrack',
                'seekCurrentToStartTime',
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
          REMOVE_TRACK: [
            {
              guard: 'willBeEmpty',
              target: 'idle',
              actions: ['cancelAllGapless', 'removeTrack'],
            },
            {
              guard: 'isRemovingCurrent',
              actions: [
                'cancelAllGapless',
                'removeTrack',
                'activateCurrent',
                'playCurrent',
                'notifyStartNewTrack',
                'updateMediaSessionMetadata',
                'preloadAhead',
              ],
            },
            {
              actions: ['removeTrack', 'cancelAndRescheduleGapless', 'preloadAhead'],
            },
          ],
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
              'activateCurrent',
              'playCurrent',
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
              'activateCurrent',
              'playCurrent',
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
                'gotoTrack',
                'activateCurrent',
                'seekCurrentToStartTime',
                'playCurrent',
                'notifyStartNewTrack',
                'updateMediaSessionMetadata',
                'preloadAhead',
              ],
            },
            {
              // Going to a track without playing it stops the old one, so the
              // queue is paused on the new one (as from idle or ended). Staying
              // in 'playing' left nothing playing, with no PLAY handler to
              // recover.
              target: 'paused',
              actions: [
                'deactivateCurrent',
                'cancelAllGapless',
                'gotoTrack',
                'seekCurrentToStartTime',
                'preloadAhead',
              ],
            },
          ],
          SEEK: {
            actions: ['seekCurrent', 'cancelAndRescheduleGapless'],
          },
          TRACK_ENDED: [
            {
              // Repeat one: restart the track that just ended.
              guard: 'repeatsCurrent',
              target: 'playing',
              actions: [
                'deactivateEndedTrack',
                'cancelAllGapless',
                'activateCurrent',
                'seekCurrentToStartTime',
                'playCurrent',
                'notifyStartNewTrack',
                'updateMediaSessionMetadata',
                'preloadAhead',
              ],
            },
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
          TRACK_LOADED: [
            {
              // When the *current* track's buffer becomes ready while we are
              // already playing, that's a mid-stream HTML5 → Web Audio
              // crossover. Any existing gapless schedule was based on the old
              // HTML5-clock end-time prediction; cancel and re-schedule using
              // the now-authoritative WebAudio end time.
              guard: 'isCurrentTrackLoaded',
              actions: ['cancelAndRescheduleGapless', 'preloadAhead'],
            },
            {
              actions: ['scheduleGapless', 'preloadAhead'],
            },
          ],
        },
      },

      // -----------------------------------------------------------------
      // paused
      // -----------------------------------------------------------------
      paused: {
        on: {
          REMOVE_TRACK: [
            {
              guard: 'willBeEmpty',
              target: 'idle',
              actions: ['cancelAllGapless', 'removeTrack'],
            },
            {
              guard: 'isRemovingCurrent',
              actions: ['cancelAllGapless', 'removeTrack', 'preloadAhead'],
            },
            {
              actions: ['removeTrack', 'preloadAhead'],
            },
          ],
          PLAY: {
            target: 'playing',
            actions: [
              'playCurrent',
              'updateMediaSessionMetadata',
              'preloadAhead',
              'scheduleGapless',
            ],
          },
          TOGGLE: {
            target: 'playing',
            actions: [
              'playCurrent',
              'updateMediaSessionMetadata',
              'preloadAhead',
              'scheduleGapless',
            ],
          },
          NEXT: {
            actions: [
              'deactivateCurrent',
              'cancelAllGapless',
              'advanceToNextTrack',
              'activateCurrent',
              'playCurrent',
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
              'activateCurrent',
              'playCurrent',
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
                'gotoTrack',
                'activateCurrent',
                'seekCurrentToStartTime',
                'playCurrent',
                'notifyStartNewTrack',
                'updateMediaSessionMetadata',
                'preloadAhead',
              ],
            },
            {
              actions: [
                'deactivateCurrent',
                'cancelAllGapless',
                'gotoTrack',
                'seekCurrentToStartTime',
                'preloadAhead',
              ],
            },
          ],
          SEEK: {
            actions: ['seekCurrent'],
          },
          TRACK_ENDED: [
            {
              guard: 'repeatsCurrent',
              target: 'paused',
              actions: ['deactivateEndedTrack', 'seekCurrentToStartTime', 'notifyStartNewTrack'],
            },
            {
              guard: 'hasNextTrack',
              target: 'paused',
              actions: [
                'deactivateEndedTrack',
                'advanceOnTrackEnd',
                'notifyStartNewTrack',
                'updateMediaSessionMetadata',
                // Like every other move to a new track: preload what's ahead
                // of it, and abort downloads that no longer are.
                'preloadAhead',
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
          // Once something follows the current entry again (an append, an
          // insert, a reorder), the queue is no longer at its end.
          LIST_CHANGED: [
            {
              guard: 'listIsEmpty',
              target: 'idle',
              actions: 'listChanged',
            },
            {
              guard: 'listHasNextAfterChange',
              target: 'paused',
              actions: 'listChanged',
            },
            { actions: 'listChanged' },
          ],
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
                'gotoTrack',
                'activateCurrent',
                'seekCurrentToStartTime',
                'playCurrent',
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
                'gotoTrack',
                'seekCurrentToStartTime',
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
