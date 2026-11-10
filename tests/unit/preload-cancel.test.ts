// ---------------------------------------------------------------------------
// Tracks that leave the preload window are unloaded: in-flight downloads are
// aborted, so they don't compete with the new next track for bandwidth, and
// decoded buffers are released, so they don't hold memory.
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

  it('releases the decoded buffer of a track moved out of the window', async () => {
    const { q, internal } = await playingWithNextDownloading(['a', 'b', 'c'], []);
    const b = internal._tracks[1];
    expect(b.isBufferLoaded).toBe(true);
    q.move('b', { after: 'c' });
    await flush();
    expect(b.isBufferLoaded).toBe(false);
    expect(b.webAudioLoadingState).toBe('NONE');
    expect(internal._tracks[1].key).toBe('c'); // c, now next, loads instead
    expect(internal._tracks[1].webAudioLoadingState).toBe('LOADED');

    q.move('b', { after: 'a' }); // back in the window: loads again
    await flush();
    expect(b.isBufferLoaded).toBe(true);
    expect(b.webAudioLoadingState).toBe('LOADED');
  });

  it('drops a decode in progress when its track leaves the window', async () => {
    const { q, internal } = await playingWithNextDownloading(['a', 'b', 'c'], ['c']);
    // Hold b's decode open: decoding can't be aborted.
    const ctx = (globalThis as Internal)._mockAudioContext;
    let finish: (buf: AudioBuffer) => void = () => {};
    ctx.decodeAudioData.mockImplementationOnce(
      () => new Promise<AudioBuffer>((resolve) => (finish = resolve))
    );
    q.move('b', { after: 'c' });
    q.move('b', { after: 'a' }); // b unloads (it was LOADED), then starts again…
    await flush();
    const b = internal._tracks[1];
    expect(b.key).toBe('b');
    expect(b.webAudioLoadingState).toBe('LOADING'); // …and is decoding

    q.move('b', { after: 'c' }); // out of the window mid-decode
    await flush();
    expect(b.webAudioLoadingState).toBe('NONE');
    finish({ duration: 180 } as AudioBuffer); // the decode lands late
    await flush();
    expect(b.isBufferLoaded).toBe(false);
    expect(b.webAudioLoadingState).toBe('NONE');
  });

  it('releases the track that just played once the queue moves on', async () => {
    const { q, internal } = await playingWithNextDownloading(['a', 'b', 'c'], []);
    const a = internal._tracks[0];
    expect(a.isBufferLoaded).toBe(true);
    q.pause();
    internal.onTrackEnded(a); // a → b
    await flush();
    expect(q.currentKey).toBe('b');
    expect(a.isBufferLoaded).toBe(false);
    expect(internal._tracks[1].isBufferLoaded).toBe(true); // b, current, keeps its buffer
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

describe('replaying an unloaded track', () => {
  it('plays it through HTML5 again, and reports HTML5', async () => {
    const q = new Queue({ preloadNumTracks: 0 });
    q.setEntries([entry('a')], { play: false });
    q.play();
    await flush(); // a decodes and crosses over to Web Audio
    const a = (q as Internal)._tracks[0];
    expect(a.playbackType).toBe('WEBAUDIO');

    q.pause();
    a.deactivate();
    expect(a.unload()).toBe(true); // buffer released, as when it leaves the window
    a.activate();

    mockFetchHanging(['a']); // the fresh download stays in flight
    q.play();
    await flush();
    expect(a.machineState).toBe('html5');
    expect(a.playbackType).toBe('HTML5');
    expect(a.webAudioLoadingState).toBe('LOADING');
  });
});

describe('a track that finished on Web Audio', () => {
  it('lets go of its finished source node, which holds the decoded buffer, once unloaded', async () => {
    const q = new Queue({ preloadNumTracks: 0 });
    q.setEntries([entry('a'), entry('b')], { play: false });
    q.play();
    await flush(); // a decodes and plays on Web Audio
    const a = (q as Internal)._tracks[0];
    const node = a.sourceNode;
    expect(a.playbackType).toBe('WEBAUDIO');
    expect(node?.buffer).toBeTruthy();

    // a ends; the queue moves on to b and unloads a, now outside the window.
    node.simulateEnded();
    await flush();
    expect(a.webAudioLoadingState).toBe('NONE');
    expect(a.isBufferLoaded).toBe(false);
    expect(a.sourceNode).toBeNull(); // the node's buffer is the decoded audio
    expect(node.disconnect).toHaveBeenCalled();
  });
});
