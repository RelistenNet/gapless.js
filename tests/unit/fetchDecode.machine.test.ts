// ---------------------------------------------------------------------------
// FetchDecodeMachine — state-transition tests (xstate v5)
//
// Since the child machine uses sendParent, we test it by spawning it from a
// minimal parent machine, collecting the events it sends back.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import { createActor, setup, assign, fromPromise, type AnyActorRef } from 'xstate';
import { fetchDecodeMachine } from '../../src/machines/fetchDecode.machine';
import type { FetchDecodeContext } from '../../src/machines/fetchDecode.machine';

/** Minimal parent that spawns the fetchDecode child and collects events. */
function createParentActor(opts: {
  input?: Partial<FetchDecodeContext>;
  resolveUrl?: () => Promise<string | null>;
  fetchAudio?: () => Promise<void>;
  decodeAudio?: () => Promise<void>;
}) {
  const childMachine = fetchDecodeMachine.provide({
    actors: {
      ...(opts.resolveUrl ? { resolveUrl: fromPromise(opts.resolveUrl) } : {}),
      ...(opts.fetchAudio ? { fetchAudio: fromPromise(opts.fetchAudio) } : {}),
      ...(opts.decodeAudio ? { decodeAudio: fromPromise(opts.decodeAudio) } : {}),
    },
  });

  const parentMachine = setup({
    types: {
      context: {} as {
        childRef: AnyActorRef | null;
        receivedEvents: Array<{ type: string; [key: string]: unknown }>;
      },
      events: {} as
        | { type: 'SPAWN' }
        | { type: 'BUFFER_READY' }
        | { type: 'BUFFER_ERROR' }
        | { type: 'URL_RESOLVED'; url: string },
    },
    actors: {
      fetchDecode: childMachine,
    },
  }).createMachine({
    id: 'testParent',
    initial: 'idle',
    context: {
      childRef: null,
      receivedEvents: [],
    },
    states: {
      idle: {
        on: {
          SPAWN: {
            target: 'running',
            actions: assign({
              childRef: ({ spawn }) =>
                spawn('fetchDecode', {
                  id: 'fetchDecode',
                  input: {
                    trackUrl: opts.input?.trackUrl ?? 'https://example.com/track.mp3',
                    resolvedUrl: opts.input?.resolvedUrl ?? 'https://example.com/track.mp3',
                    skipHEAD: opts.input?.skipHEAD ?? false,
                  },
                }),
            }),
          },
        },
      },
      running: {
        on: {
          BUFFER_READY: {
            actions: assign({
              receivedEvents: ({ context }) => [
                ...context.receivedEvents,
                { type: 'BUFFER_READY' },
              ],
            }),
          },
          BUFFER_ERROR: {
            actions: assign({
              receivedEvents: ({ context }) => [
                ...context.receivedEvents,
                { type: 'BUFFER_ERROR' },
              ],
            }),
          },
          URL_RESOLVED: {
            actions: assign({
              receivedEvents: ({ context, event }) => [
                ...context.receivedEvents,
                { type: 'URL_RESOLVED', url: (event as { type: 'URL_RESOLVED'; url: string }).url },
              ],
            }),
          },
        },
      },
    },
  });

  return createActor(parentMachine);
}

describe('FetchDecodeMachine', () => {
  it('skipHEAD skips resolvingUrl and goes to fetching', async () => {
    const fetchAudio = vi.fn(async () => {});
    const decodeAudio = vi.fn(async () => {});

    const parent = createParentActor({
      input: { skipHEAD: true },
      fetchAudio,
      decodeAudio,
    });
    parent.start();
    parent.send({ type: 'SPAWN' });

    await vi.waitFor(() => {
      expect(parent.getSnapshot().context.receivedEvents).toContainEqual({
        type: 'BUFFER_READY',
      });
    });

    expect(fetchAudio).toHaveBeenCalled();
    expect(decodeAudio).toHaveBeenCalled();
  });

  it('full pipeline: resolveUrl → fetch → decode → BUFFER_READY', async () => {
    const resolveUrl = vi.fn(async () => 'https://cdn.example.com/track.mp3');
    const fetchAudio = vi.fn(async () => {});
    const decodeAudio = vi.fn(async () => {});

    const parent = createParentActor({ resolveUrl, fetchAudio, decodeAudio });
    parent.start();
    parent.send({ type: 'SPAWN' });

    await vi.waitFor(() => {
      expect(parent.getSnapshot().context.receivedEvents).toContainEqual({
        type: 'BUFFER_READY',
      });
    });

    expect(resolveUrl).toHaveBeenCalled();
    expect(fetchAudio).toHaveBeenCalled();
    expect(decodeAudio).toHaveBeenCalled();
  });

  it('sends URL_RESOLVED when resolve returns a new URL', async () => {
    const resolveUrl = vi.fn(async () => 'https://cdn.example.com/resolved.mp3');
    const fetchAudio = vi.fn(async () => {});
    const decodeAudio = vi.fn(async () => {});

    const parent = createParentActor({ resolveUrl, fetchAudio, decodeAudio });
    parent.start();
    parent.send({ type: 'SPAWN' });

    await vi.waitFor(() => {
      expect(parent.getSnapshot().context.receivedEvents).toContainEqual({
        type: 'BUFFER_READY',
      });
    });

    expect(parent.getSnapshot().context.receivedEvents).toContainEqual({
      type: 'URL_RESOLVED',
      url: 'https://cdn.example.com/resolved.mp3',
    });
  });

  it('resolveUrl error is non-fatal — continues to fetch and decode', async () => {
    const resolveUrl = vi.fn(async () => {
      throw new Error('HEAD failed');
    });
    const fetchAudio = vi.fn(async () => {});
    const decodeAudio = vi.fn(async () => {});

    const parent = createParentActor({ resolveUrl, fetchAudio, decodeAudio });
    parent.start();
    parent.send({ type: 'SPAWN' });

    await vi.waitFor(() => {
      expect(parent.getSnapshot().context.receivedEvents).toContainEqual({
        type: 'BUFFER_READY',
      });
    });

    // HEAD failure is non-fatal — fetch and decode still run
    expect(fetchAudio).toHaveBeenCalled();
    expect(decodeAudio).toHaveBeenCalled();
    // No URL_RESOLVED event on error
    expect(parent.getSnapshot().context.receivedEvents).not.toContainEqual(
      expect.objectContaining({ type: 'URL_RESOLVED' })
    );
  });

  it('sends BUFFER_ERROR on fetch failure', async () => {
    const resolveUrl = vi.fn(async () => null);
    const fetchAudio = vi.fn(async () => {
      throw new Error('HTTP 404');
    });

    const parent = createParentActor({ resolveUrl, fetchAudio });
    parent.start();
    parent.send({ type: 'SPAWN' });

    await vi.waitFor(() => {
      expect(parent.getSnapshot().context.receivedEvents).toContainEqual({
        type: 'BUFFER_ERROR',
      });
    });
  });

  it('sends BUFFER_ERROR on decode failure', async () => {
    const resolveUrl = vi.fn(async () => null);
    const fetchAudio = vi.fn(async () => {});
    const decodeAudio = vi.fn(async () => {
      throw new Error('decode failed');
    });

    const parent = createParentActor({ resolveUrl, fetchAudio, decodeAudio });
    parent.start();
    parent.send({ type: 'SPAWN' });

    await vi.waitFor(() => {
      expect(parent.getSnapshot().context.receivedEvents).toContainEqual({
        type: 'BUFFER_ERROR',
      });
    });
  });

  it('sends URL_RESOLVED with original URL when resolve returns null', async () => {
    const resolveUrl = vi.fn(async () => null);
    const fetchAudio = vi.fn(async () => {});
    const decodeAudio = vi.fn(async () => {});

    const parent = createParentActor({ resolveUrl, fetchAudio, decodeAudio });
    parent.start();
    parent.send({ type: 'SPAWN' });

    await vi.waitFor(() => {
      expect(parent.getSnapshot().context.receivedEvents).toContainEqual({
        type: 'BUFFER_READY',
      });
    });

    expect(parent.getSnapshot().context.receivedEvents).toContainEqual({
      type: 'URL_RESOLVED',
      url: 'https://example.com/track.mp3',
    });
  });
});
