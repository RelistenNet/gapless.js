// ---------------------------------------------------------------------------
// Closing the tab: the browser tears the AudioContext down mid-waveform,
// which clicks. On pagehide every track's output ramps to silence over a few
// milliseconds (best effort: it only helps if the browser renders a little
// longer), and a page restored from the back/forward cache gets its volume back.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { Queue } from '../../src/Queue';
import type { Track } from '../../src/Track';
import { advanceTime, mockFetchSuccess } from '../setup';

const flush = async (n = 15) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

async function playing(volume = 0.8) {
  mockFetchSuccess();
  const q = new Queue({ volume });
  q.setEntries([
    { key: 'a', url: 'a.mp3' },
    { key: 'b', url: 'b.mp3' },
  ]);
  q.play();
  await flush();
  const [a] = (q as any)._tracks as Track[];
  return { q, a, gain: (a as any).gainNode.gain, now: () => (a as any).ctx.currentTime as number };
}

const pageEvent = (type: string, persisted = false) =>
  window.dispatchEvent(Object.assign(new Event(type), { persisted }));

describe('page lifecycle', () => {
  it('pagehide ramps each track to silence over ~25 ms from its current level', async () => {
    const { gain, now } = await playing();
    advanceTime(3);
    pageEvent('pagehide');
    expect(gain.setValueAtTime.mock.calls.at(-1)).toEqual([0.8, now()]);
    expect(gain.linearRampToValueAtTime.mock.calls.at(-1)).toEqual([
      0,
      expect.closeTo(now() + 0.025, 5),
    ]);
  });

  it('a page restored from the back/forward cache gets its volume back', async () => {
    const { q, gain } = await playing(0.6);
    pageEvent('pagehide', true);
    q.setVolume(0.6); // (any later volume change also lands)
    pageEvent('pageshow', true);
    expect(gain.cancelScheduledValues).toHaveBeenCalled();
    expect(gain.value).toBe(0.6);
  });

  it('a fresh pageshow (not from the cache) changes nothing', async () => {
    const { gain } = await playing();
    const cancels = gain.cancelScheduledValues.mock.calls.length;
    pageEvent('pageshow', false);
    expect(gain.cancelScheduledValues.mock.calls.length).toBe(cancels);
  });

  it('a destroyed queue no longer listens', async () => {
    const { q, gain } = await playing();
    q.destroy();
    const ramps = gain.linearRampToValueAtTime.mock.calls.length;
    pageEvent('pagehide');
    expect(gain.linearRampToValueAtTime.mock.calls.length).toBe(ramps);
  });
});
