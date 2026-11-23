// ---------------------------------------------------------------------------
// Decoded buffers are shared by source URL: clips of one file fetch and
// decode it once, and the buffer lives until its last track lets go.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import { Track } from '../../src/Track';
import type { TrackQueueRef } from '../../src/Track';
import { acquireBuffer, hasBuffer, releaseBuffer } from '../../src/utils/bufferCache';
import { mockFetchSuccess } from '../setup';

function makeQueue(): TrackQueueRef {
  return {
    onTrackEnded: vi.fn(),
    onTrackBufferReady: vi.fn(),
    onPreloadReady: vi.fn(),
    onProgress: vi.fn(),
    onError: vi.fn(),
    onPlayBlocked: vi.fn(),
    onDebug: vi.fn(),
    volume: 1,
    playbackMethod: 'HYBRID' as const,
    playbackRate: 1,
    currentKey: null,
    indexOf: () => 0,
  };
}

const flush = async (n = 15) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

const gets = (spy: ReturnType<typeof vi.fn>) =>
  spy.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method !== 'HEAD').length;
const heads = (spy: ReturnType<typeof vi.fn>) =>
  spy.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'HEAD').length;

/** A fetch that hangs until released, and records its abort signal. */
function hangingFetch() {
  const signals: AbortSignal[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const spy = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'HEAD') return { ok: true, redirected: false, url: '' };
    signals.push(init!.signal!);
    await gate;
    return { ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) };
  });
  vi.stubGlobal('fetch', spy);
  return { spy, signals, release };
}

describe('shared decoded buffers', () => {
  it('two clips of one file fetch and decode it once and share the buffer', async () => {
    const spy = mockFetchSuccess();
    const a = new Track({ trackUrl: 'set.mp3', queue: makeQueue(), start: 0, end: 60 });
    const b = new Track({ trackUrl: 'set.mp3', queue: makeQueue(), start: 60, end: 120 });
    a.preload();
    b.preload();
    await flush();
    expect(gets(spy)).toBe(1);
    expect(a.audioBuffer).not.toBeNull();
    expect(b.audioBuffer).toBe(a.audioBuffer);
    expect(a.webAudioLoadingState).toBe('LOADED');
    expect(b.webAudioLoadingState).toBe('LOADED');
  });

  it('a track loading a file another track already has skips HEAD and GET', async () => {
    const spy = mockFetchSuccess();
    const a = new Track({ trackUrl: 'set.mp3', queue: makeQueue() });
    a.preload();
    await flush();
    const [h, g] = [heads(spy), gets(spy)];
    const b = new Track({ trackUrl: 'set.mp3', queue: makeQueue(), start: 30 });
    b.preload();
    await flush();
    expect([heads(spy), gets(spy)]).toEqual([h, g]);
    expect(b.audioBuffer).toBe(a.audioBuffer);
  });

  it('different files load separately', async () => {
    const spy = mockFetchSuccess();
    new Track({ trackUrl: 'a.mp3', queue: makeQueue() }).preload();
    new Track({ trackUrl: 'b.mp3', queue: makeQueue() }).preload();
    await flush();
    expect(gets(spy)).toBe(2);
  });

  it('keeps the buffer until the last track unloads, then loads it fresh', async () => {
    const spy = mockFetchSuccess();
    const a = new Track({ trackUrl: 'set.mp3', queue: makeQueue() });
    const b = new Track({ trackUrl: 'set.mp3', queue: makeQueue() });
    a.preload();
    b.preload();
    await flush();

    expect(a.unload()).toBe(true);
    expect(hasBuffer('set.mp3')).toBe(true);
    a.preload();
    await flush();
    expect(gets(spy)).toBe(1); // b still held it

    a.unload();
    b.unload();
    expect(hasBuffer('set.mp3')).toBe(false);
    a.preload();
    await flush();
    expect(gets(spy)).toBe(2);
  });

  it('a download is aborted only when every track waiting on it lets go', async () => {
    const { signals, release } = hangingFetch();
    const a = new Track({ trackUrl: 'set.mp3', queue: makeQueue() });
    const b = new Track({ trackUrl: 'set.mp3', queue: makeQueue() });
    a.preload();
    b.preload();
    await flush();
    expect(signals).toHaveLength(1);

    a.unload();
    expect(signals[0].aborted).toBe(false);
    release();
    await flush();
    expect(b.webAudioLoadingState).toBe('LOADED');
    expect(a.audioBuffer).toBeNull();
  });

  it('the last track unloading aborts the download', async () => {
    const { signals } = hangingFetch();
    const a = new Track({ trackUrl: 'set.mp3', queue: makeQueue() });
    const b = new Track({ trackUrl: 'set.mp3', queue: makeQueue() });
    a.preload();
    b.preload();
    await flush();
    a.unload();
    b.destroy();
    expect(signals[0].aborted).toBe(true);
    expect(hasBuffer('set.mp3')).toBe(false);
  });

  it('a failed load is retried by the next acquire', async () => {
    const holder = {};
    const signal = new AbortController().signal;
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ duration: 1 });
    await expect(acquireBuffer('x', holder, signal, load)).rejects.toThrow('boom');
    expect(hasBuffer('x')).toBe(false);
    await expect(acquireBuffer('x', holder, signal, load)).resolves.toEqual({ duration: 1 });
    expect(load).toHaveBeenCalledTimes(2);
    releaseBuffer('x', holder);
    expect(hasBuffer('x')).toBe(false);
  });
});
