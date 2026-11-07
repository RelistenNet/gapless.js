// ---------------------------------------------------------------------------
// In-flight downloads for tracks that leave the preload window are aborted,
// so they don't compete with the new next track for bandwidth.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import { Queue } from '../../src/Queue';
import type { Entry } from '../../src/types';
import { advanceTime } from '../setup';

const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
const entry = (key: string): Entry => ({ key, url: `${key}.mp3`, skipHEAD: true });

// oxlint-disable-next-line typescript/no-explicit-any
type Internal = any;

/**
 * fetch mock: URLs in `hang` never resolve (until aborted); everything else
 * resolves immediately. Records each GET's AbortSignal by file name.
 */
function mockFetchHanging(hang: string[]) {
  const signals = new Map<string, AbortSignal>();
  const spy = vi.fn((url: string, init?: RequestInit) => {
    const name = String(url).replace(/\.mp3$/, '');
    if (init?.signal) signals.set(name, init.signal);
    if (hang.includes(name)) {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError'))
        );
      });
    }
    return Promise.resolve({
      ok: true,
      url: '',
      redirected: false,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(1024)),
    });
  });
  vi.stubGlobal('fetch', spy);
  return { spy, signals, fetched: () => spy.mock.calls.map((c) => String(c[0])) };
}

/**
 * Playing 'a' and 20 s in, past the speculative-preload threshold, so the
 * whole window downloads; URLs in `hang` stay mid-download.
 */
async function playingWithNextDownloading(keys: string[], hang: string[], preloadNumTracks = 1) {
  const net = mockFetchHanging(hang);
  const q = new Queue({ preloadNumTracks });
  q.setEntries(keys.map(entry), { play: false });
  q.play();
  await flush(); // 'a' decodes and crosses over to Web Audio…
  advanceTime(20); // …then plays past the threshold…
  q.preloadNumTracks = preloadNumTracks; // …and the window is preloaded again.
  await flush();
  return { q, internal: q as Internal, ...net };
}

describe('cancelling displaced preloads', () => {
  it('a reorder that moves the downloading next track out of the window aborts it', async () => {
    const { q, internal, signals, fetched } = await playingWithNextDownloading(
      ['a', 'b', 'c', 'd'],
      ['b']
    );
    expect(signals.get('b')?.aborted).toBe(false);
    expect(internal._tracks[1].webAudioLoadingState).toBe('LOADING');

    q.setEntries(['a', 'c', 'd', 'b'].map(entry)); // shuffle mid-track
    await flush();

    expect(signals.get('b')?.aborted).toBe(true);
    const b = internal._tracks[3];
    expect(b.key).toBe('b');
    expect(b.webAudioLoadingState).toBe('NONE');
    // The new next track is fetched, decoded and gets the gapless start.
    expect(fetched()).toContain('c.mp3');
    expect(internal._scheduledNext?.key).toBe('c');
  });

  it('a move that keeps "next" but pushes a downloading track out of the window aborts it', async () => {
    const { q, internal, signals } = await playingWithNextDownloading(
      ['a', 'b', 'c', 'd'],
      ['c'],
      2
    );
    expect(internal._tracks[2].webAudioLoadingState).toBe('LOADING');
    q.move('c', { after: 'd' }); // next is still 'b'
    await flush();
    expect(signals.get('c')?.aborted).toBe(true);
  });

  it('a cancelled track can be preloaded again when it comes back into the window', async () => {
    const { q, internal, signals } = await playingWithNextDownloading(['a', 'b', 'c'], ['b']);
    q.move('b', { after: 'c' });
    await flush();
    expect(signals.get('b')?.aborted).toBe(true);

    q.move('b', { after: 'a' });
    await flush();
    expect(signals.get('b')?.aborted).toBe(false); // a fresh request
    expect(internal._tracks[1].webAudioLoadingState).toBe('LOADING');
  });

  it('keeps decoded buffers for displaced tracks', async () => {
    const { q, internal } = await playingWithNextDownloading(['a', 'b', 'c'], []);
    const b = internal._tracks[1];
    expect(b.isBufferLoaded).toBe(true);
    q.move('b', { after: 'c' });
    await flush();
    expect(b.isBufferLoaded).toBe(true);
    expect(b.webAudioLoadingState).toBe('LOADED');
  });

  it('never cancels the current track', async () => {
    const { q, internal, signals } = await playingWithNextDownloading(['a', 'b'], ['a']);
    expect(internal._currentTrack.webAudioLoadingState).toBe('LOADING');
    q.setEntries(['b', 'a'].map(entry));
    q.insert([entry('x')], { after: 'start' });
    await flush();
    expect(signals.get('a')?.aborted).toBe(false);
    expect(internal._currentTrack.key).toBe('a');
  });

  it('a track ending while paused moves the window too', async () => {
    // The queue machine's paused TRACK_ENDED branch didn't run preloadAhead.
    const { q, internal, signals } = await playingWithNextDownloading(['a', 'b', 'c'], ['c']);
    q.pause();
    internal.onTrackEnded(internal._currentTrack); // a → b, still paused
    await flush();
    expect(q.currentKey).toBe('b');
    expect(q.isPaused).toBe(true);
    expect(signals.has('c')).toBe(true); // c, now next, starts downloading
    expect(internal._tracks[2].webAudioLoadingState).toBe('LOADING');
  });

  it('a goto far away aborts preloads that are no longer ahead', async () => {
    const { q, signals } = await playingWithNextDownloading(['a', 'b', 'c', 'd', 'e'], ['b']);
    q.goto('d', { play: true });
    await flush();
    expect(signals.get('b')?.aborted).toBe(true);
  });
});
