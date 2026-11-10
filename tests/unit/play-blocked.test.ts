// ---------------------------------------------------------------------------
// A play() the browser blocks (autoplay policy: HTML5 play() rejects with
// NotAllowedError) leaves nothing downloading: the Web Audio fetch is
// aborted and the element stops buffering. The next play() loads again.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import { Queue } from '../../src/Queue';
import type { Entry } from '../../src/types';
import { MockAudioElement } from '../setup';

const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
const entry = (key: string): Entry => ({ key, url: `${key}.mp3`, skipHEAD: true });

// oxlint-disable-next-line typescript/no-explicit-any
type Internal = any;

/** Every element's play() is refused, as under a blocking autoplay policy. */
function blockAutoplay() {
  class Blocked extends MockAudioElement {
    play = vi.fn(() => Promise.reject(new DOMException('Not allowed', 'NotAllowedError')));
  }
  vi.stubGlobal('Audio', Blocked);
}

/** fetch that never resolves until aborted; records each request's signal. */
function mockFetchHanging() {
  const signals: AbortSignal[] = [];
  const spy = vi.fn((_url: string, init?: RequestInit) => {
    if (init?.signal) signals.push(init.signal);
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('Aborted', 'AbortError'))
      );
    });
  });
  vi.stubGlobal('fetch', spy);
  return { spy, signals };
}

describe('blocked play()', () => {
  it('aborts the Web Audio download and stops the element buffering', async () => {
    blockAutoplay();
    const net = mockFetchHanging();
    const onPlayBlocked = vi.fn();
    const q = new Queue({ onPlayBlocked, preloadNumTracks: 0 });
    q.setEntries([entry('a'), entry('b')], { play: false });

    q.play();
    await flush();

    expect(onPlayBlocked).toHaveBeenCalledTimes(1);
    expect(net.signals.length).toBeGreaterThan(0);
    expect(net.signals.every((s) => s.aborted)).toBe(true);

    const a = (q as Internal)._tracks[0];
    expect(a.machineState).toBe('idle');
    expect(a.isPlaying).toBe(false);
    expect(a.webAudioLoadingState).toBe('NONE');
    expect(q.isPlaying).toBe(false);
    // The element dropped its source (aborting its fetch) and won't refetch on its own.
    expect(a.audio.removeAttribute).toHaveBeenCalledWith('src');
    expect(a.audio.load).toHaveBeenCalled();
    expect(a.audio.preload).toBe('none');
    expect(a.audio.src).toBe('a.mp3');
  });

  it('the app sees a stopped queue inside onPlayBlocked', async () => {
    blockAutoplay();
    mockFetchHanging();
    let playingInCallback: boolean | undefined;
    let trackStateInCallback: string | undefined;
    const q: Queue = new Queue({
      preloadNumTracks: 0,
      onPlayBlocked: () => {
        playingInCallback = q.isPlaying;
        trackStateInCallback = (q as Internal)._tracks[0].machineState;
      },
    });
    q.setEntries([entry('a')], { play: false });
    q.play();
    await flush();
    expect(playingInCallback).toBe(false);
    expect(trackStateInCallback).toBe('idle');
  });

  it('a later play() starts the load again', async () => {
    blockAutoplay();
    const net = mockFetchHanging();
    const q = new Queue({ preloadNumTracks: 0 });
    q.setEntries([entry('a')], { play: false });
    q.play();
    await flush();
    const before = net.spy.mock.calls.length;

    vi.stubGlobal('Audio', MockAudioElement); // the visitor clicked: allowed now
    const a = (q as Internal)._tracks[0];
    a.audio.play = vi.fn(() => Promise.resolve());
    q.play();
    await flush();

    expect(a.audio.play).toHaveBeenCalled();
    expect(net.spy.mock.calls.length).toBeGreaterThan(before);
    expect(net.signals.at(-1)?.aborted).toBe(false);
    expect(a.webAudioLoadingState).toBe('LOADING');
    expect(a.isPlaying).toBe(true);
  });
});
