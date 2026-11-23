// ---------------------------------------------------------------------------
// Crossfades: the next track starts `fade` seconds before the current one
// ends, on equal-power ramps on each track's own fade node.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import { Queue } from '../../src/Queue';
import type { Track } from '../../src/Track';
import type { Entry, GaplessOptions } from '../../src/types';
import { advanceTime, mockFetchSuccess, type MockAudioBufferSourceNode } from '../setup';

const flush = async (n = 15) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

type Gain = {
  value: number;
  setValueAtTime: ReturnType<typeof vi.fn>;
  setValueCurveAtTime: ReturnType<typeof vi.fn>;
  cancelScheduledValues: ReturnType<typeof vi.fn>;
};
const fadeGain = (t: Track): Gain => (t as any)._fadeGainNode.gain;
const lastCurve = (t: Track) => {
  const calls = fadeGain(t).setValueCurveAtTime.mock.calls;
  return calls.length ? (calls[calls.length - 1] as [Float32Array, number, number]) : null;
};
const sourcesOf = (t: Track): MockAudioBufferSourceNode[] =>
  ((t as any).ctx.createBufferSource as ReturnType<typeof vi.fn>).mock.results
    .map((r) => r.value as MockAudioBufferSourceNode)
    .filter((s) => s.buffer === t.audioBuffer && s.start.mock.calls.length > 0);

/**
 * Two entries of different files, playing on Web Audio, with the next one
 * decoded. `secondsLeft` puts the current track that close to its end.
 */
async function playing(
  entries: Entry[],
  opts: GaplessOptions = {},
  secondsLeft = 10
): Promise<{ q: Queue; a: Track; b: Track }> {
  mockFetchSuccess();
  const q = new Queue({ preloadNumTracks: 1, ...opts });
  q.setEntries(entries);
  q.play();
  await flush();
  const [a, b] = (q as any)._tracks as Track[];
  expect(a.playbackType).toBe('WEBAUDIO');
  expect(b.isBufferLoaded).toBe(true);
  q.seek(a.duration - secondsLeft);
  await flush(2);
  return { q, a, b };
}

const AB: Entry[] = [
  { key: 'a', url: 'a.mp3' },
  { key: 'b', url: 'b.mp3' },
];

describe('crossfade selection', () => {
  it('is gapless by default', async () => {
    const { a, b } = await playing(AB);
    const end = a.playbackEndContextTime!;
    expect(b.scheduledStartContextTime).toBeCloseTo(end, 5);
    expect(lastCurve(b)).toBeNull();
    expect(lastCurve(a)).toBeNull();
  });

  it('applies the queue default: next starts early and both tracks ramp', async () => {
    const { a, b } = await playing(AB, { crossfade: 4 });
    const end = a.playbackEndContextTime!;
    const start = b.scheduledStartContextTime!;
    expect(start).toBeCloseTo(end - 4, 5);
    expect(sourcesOf(b).at(-1)!.start.mock.calls[0][0]).toBeCloseTo(start, 5);

    const [inCurve, inAt, inDur] = lastCurve(b)!;
    expect([inAt, inDur]).toEqual([start, expect.closeTo(4, 5)]);
    expect(inCurve[0]).toBe(0);
    expect(inCurve[inCurve.length - 1]).toBeCloseTo(1, 5);

    const [outCurve, outAt, outDur] = lastCurve(a)!;
    expect([outAt, outDur]).toEqual([start, expect.closeTo(4, 5)]);
    expect(outCurve[0]).toBeCloseTo(1, 5);
    expect(outCurve[outCurve.length - 1]).toBeCloseTo(0, 5);
    // Equal power: the squares of the two gains sum to 1 midway.
    const mid = Math.floor(inCurve.length / 2);
    expect(inCurve[mid] ** 2 + outCurve[mid] ** 2).toBeCloseTo(1, 5);
  });

  it("an entry's crossfade overrides the default, both ways", async () => {
    const off = await playing([AB[0], { ...AB[1], crossfade: 0 }], { crossfade: 4 });
    expect(off.b.scheduledStartContextTime).toBeCloseTo(off.a.playbackEndContextTime!, 5);
    expect(lastCurve(off.a)).toBeNull();

    const on = await playing([AB[0], { ...AB[1], crossfade: 2 }]);
    expect(on.b.scheduledStartContextTime).toBeCloseTo(on.a.playbackEndContextTime! - 2, 5);
  });

  it('is cut to fit a next entry shorter than the fade', async () => {
    const { a, b } = await playing([AB[0], { ...AB[1], start: 10, end: 11.5 }], { crossfade: 4 });
    expect(b.scheduledStartContextTime).toBeCloseTo(a.playbackEndContextTime! - 1.5, 5);
  });

  it('is shortened to the time left, and dropped when too little is left', async () => {
    const short = await playing(AB, { crossfade: 4 }, 2);
    const end = short.a.playbackEndContextTime!;
    const start = short.b.scheduledStartContextTime!;
    expect(end - start).toBeLessThan(2);
    expect(end - start).toBeGreaterThan(1.9);
    expect(lastCurve(short.a)![1]).toBeCloseTo(start, 5);

    const none = await playing(AB, { crossfade: 4 }, 0.12);
    expect(none.b.scheduledStartContextTime).toBeCloseTo(none.a.playbackEndContextTime!, 5);
  });

  it('does not fade out of a track still on HTML5', async () => {
    mockFetchSuccess();
    const q = new Queue({ crossfade: 4 });
    q.setEntries(AB);
    const [a, b] = (q as any)._tracks as Track[];
    b.audioBuffer = { duration: 180 } as AudioBuffer;
    const win = (q as any)._crossfadeWindow(a, b, 100, 90);
    expect(a.playbackType).toBe('HTML5');
    expect(win).toEqual({ start: 100, fade: 0 });
  });

  it('setCrossfade reschedules a pending transition', async () => {
    const { q, a, b } = await playing(AB);
    q.setCrossfade(3);
    await flush(2);
    expect(b.scheduledStartContextTime).toBeCloseTo(a.playbackEndContextTime! - 3, 5);
    expect(() => q.setCrossfade(-1)).toThrow(/crossfade/);
  });
});

describe('during a crossfade', () => {
  it('volume changes leave the fade ramps alone', async () => {
    const { q, a, b } = await playing(AB, { crossfade: 4 });
    const before = [fadeGain(a).cancelScheduledValues.mock.calls.length, lastCurve(b)];
    q.setVolume(0.3);
    expect(fadeGain(a).cancelScheduledValues.mock.calls.length).toBe(before[0]);
    expect(lastCurve(b)).toBe(before[1]);
    expect((a as any).gainNode.gain.value).toBe(0.3);
  });

  it('pause stops the incoming track and restores the outgoing level', async () => {
    const { q, a, b } = await playing(AB, { crossfade: 4 });
    advanceTime(7); // 1 s into the fade
    const incoming = sourcesOf(b).at(-1)!;
    q.pause();
    expect(incoming.stop).toHaveBeenCalled();
    expect(b.scheduledStartContextTime).toBeNull();
    expect(fadeGain(a).setValueAtTime.mock.calls.at(-1)![0]).toBe(1);
  });

  it('resuming mid-fade fades over the time that is left', async () => {
    const { q, a, b } = await playing(AB, { crossfade: 4 });
    advanceTime(7); // 3 s left
    q.pause();
    q.play();
    await flush(2);
    const end = a.playbackEndContextTime!;
    const start = b.scheduledStartContextTime!;
    expect(end - start).toBeGreaterThan(2.9);
    expect(end - start).toBeLessThan(3);
    expect(lastCurve(a)![1]).toBeCloseTo(start, 5);
  });

  it('the queue moves to the incoming track when the outgoing one ends', async () => {
    const { q, a, b } = await playing(AB, { crossfade: 4 });
    advanceTime(10);
    const started = sourcesOf(b).length;
    sourcesOf(a).at(-1)!.simulateEnded();
    await flush(2);
    expect(q.currentTrack?.key).toBe('b');
    expect(b.isPlaying).toBe(true);
    expect(sourcesOf(b)).toHaveLength(started); // kept playing, not restarted
    expect(q.currentTrack!.currentTime).toBeCloseTo(4, 1);
  });

  it('a track that faded out plays at full level when started again', async () => {
    const { q, a } = await playing(AB, { crossfade: 4 });
    q.gotoTrack(0, true);
    await flush(2);
    expect(fadeGain(a).setValueAtTime.mock.calls.at(-1)![0]).toBe(1);
  });
});

describe('crossfade values', () => {
  it('rejects bad values and keeps good ones in the snapshot', () => {
    expect(() => new Queue({ crossfade: -1 })).toThrow(/crossfade/);
    const q = new Queue({ crossfade: 2 });
    expect(q.crossfade).toBe(2);
    expect(() => q.addTrack('x.mp3', { crossfade: NaN })).toThrow(/crossfade/);
    q.setEntries([
      { key: 'a', url: 'a.mp3', crossfade: 5 },
      { key: 'b', url: 'b.mp3' },
    ]);
    expect(q.snapshot().entries).toEqual([
      { key: 'a', url: 'a.mp3', metadata: {}, crossfade: 5 },
      { key: 'b', url: 'b.mp3', metadata: {} },
    ]);
  });
});
