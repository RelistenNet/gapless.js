// ---------------------------------------------------------------------------
// FetchDecodeMachine — child actor for the fetch + decode pipeline
//
// States:  resolvingUrl → fetching → decoding → done | error
//
// Spawned by TrackMachine via START_FETCH. Sends BUFFER_READY, BUFFER_ERROR,
// and URL_RESOLVED back to the parent — the same events TrackMachine already
// handles. Promise implementations are no-op defaults, provided by Track.ts
// via .provide().
//
// xstate v5 automatically passes an AbortSignal to fromPromise actors, so
// when the parent stops (destroy), in-flight fetches are aborted for free.
// ---------------------------------------------------------------------------

import { setup, assign, sendParent, fromPromise } from 'xstate';

// ---- Context ---------------------------------------------------------------

export interface FetchDecodeContext {
  trackUrl: string;
  resolvedUrl: string;
  skipHEAD: boolean;
}

// ---- Machine ---------------------------------------------------------------

export const fetchDecodeMachine = setup({
  types: {
    context: {} as FetchDecodeContext,
    input: {} as FetchDecodeContext,
  },
  actors: {
    resolveUrl: fromPromise<string | null, { trackUrl: string }>(async () => null),
    fetchAudio: fromPromise<void, { resolvedUrl: string }>(async () => {}),
    decodeAudio: fromPromise<void, void>(async () => {}),
  },
  guards: {
    shouldSkipHEAD: ({ context }) => context.skipHEAD,
  },
}).createMachine({
  id: 'fetchDecode',
  initial: 'resolvingUrl',
  // Note: xstate v5 internally calls assign() when initialising a child
  // actor with a context function, which produces a false-positive
  // "Custom actions should not call assign()" warning when this machine
  // is spawned from a parent. This is harmless and cannot be avoided.
  context: ({ input }) => ({
    trackUrl: input.trackUrl,
    resolvedUrl: input.resolvedUrl,
    skipHEAD: input.skipHEAD,
  }),

  states: {
    // -----------------------------------------------------------------
    // resolvingUrl: HEAD request to resolve redirects
    // -----------------------------------------------------------------
    resolvingUrl: {
      always: {
        guard: 'shouldSkipHEAD',
        target: 'fetching',
      },
      invoke: {
        id: 'resolveUrl',
        src: 'resolveUrl',
        input: ({ context }) => ({ trackUrl: context.trackUrl }),
        onDone: {
          target: 'fetching',
          actions: [
            assign({
              resolvedUrl: ({ event, context }) => event.output ?? context.resolvedUrl,
              skipHEAD: () => true,
            }),
            sendParent(({ event, context }) => {
              const url = event.output;
              return { type: 'URL_RESOLVED' as const, url: url ?? context.resolvedUrl };
            }),
          ],
        },
        onError: {
          // HEAD failed — non-fatal, fall back to original URL
          target: 'fetching',
          actions: assign({ skipHEAD: () => true }),
        },
      },
    },

    // -----------------------------------------------------------------
    // fetching: GET the audio data
    // -----------------------------------------------------------------
    fetching: {
      invoke: {
        id: 'fetchAudio',
        src: 'fetchAudio',
        input: ({ context }) => ({ resolvedUrl: context.resolvedUrl }),
        onDone: 'decoding',
        onError: {
          target: 'error',
          actions: sendParent({ type: 'BUFFER_ERROR' }),
        },
      },
    },

    // -----------------------------------------------------------------
    // decoding: decodeAudioData on the ArrayBuffer
    // -----------------------------------------------------------------
    decoding: {
      invoke: {
        id: 'decodeAudio',
        src: 'decodeAudio',
        input: () => {},
        onDone: {
          target: 'done',
          actions: sendParent({ type: 'BUFFER_READY' }),
        },
        onError: {
          target: 'error',
          actions: sendParent({ type: 'BUFFER_ERROR' }),
        },
      },
    },

    // -----------------------------------------------------------------
    // Terminal states
    // -----------------------------------------------------------------
    done: { type: 'final' },
    error: { type: 'final' },
  },
});

export type FetchDecodeMachine = typeof fetchDecodeMachine;
