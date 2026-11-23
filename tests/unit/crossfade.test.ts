// ---------------------------------------------------------------------------
// Crossfades: the next track starts `fade` seconds before the current one
// ends, on equal-power ramps on each track's own fade node.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Queue as RealQueue } from '../../src/Queue';
import type { Track } from '../../src/Track';
import type { Entry, GaplessOptions } from '../../src/types';
import {
  advanceTime,
  mockFetchSuccess,
  MockAudioElement,
  type MockAudioBufferSourceNode,
} from '../setup';

// Every queue a test makes is destroyed after it, so its timers and progress
// loops can't run on into the next test's mocks.
const queues: RealQueue[] = [];
class Queue extends RealQueue {
  constructor(...args: ConstructorParameters<typeof RealQueue>) {
    super(...args);
    queues.push(this);
  }
}
afterEach(() => {
  for (const q of queues.splice(0)) q.destroy();
});

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
/** Whether a source was stopped on the spot (stop() with no time), not just scheduled to stop. */
const stoppedNow = (s: MockAudioBufferSourceNode) => s.stop.mock.calls.some((c) => c.length === 0);
/** Whether the fade node's latest automation is a reset to full level (not a fade curve). */
const endsAtFull = (t: Track) => {
  const g = fadeGain(t);
  const order = (fn: ReturnType<typeof vi.fn>, keep: (c: unknown[]) => boolean) =>
    Math.max(0, ...fn.mock.calls.map((c, i) => (keep(c) ? fn.mock.invocationCallOrder[i] : 0)));
  return order(g.setValueAtTime, (c) => c[0] === 1) > order(g.setValueCurveAtTime, () => true);
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
    // At most half the incoming clip overlaps, so it plays on after the handoff.
    expect(b.scheduledStartContextTime).toBeCloseTo(a.playbackEndContextTime! - 0.75, 5);
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

  it('fades out of a track still on HTML5, but not in HTML5_ONLY mode', async () => {
    mockFetchSuccess();
    const q = new Queue({ crossfade: 4 });
    q.setEntries(AB);
    const [a, b] = (q as any)._tracks as Track[];
    expect(a.playbackType).toBe('HTML5');
    expect((q as any)._crossfadeWindow(a, b, 100, 90)).toEqual({ start: 96, fade: 4 });

    const html5Only = new Queue({ crossfade: 4, playbackMethod: 'HTML5_ONLY' });
    html5Only.setEntries(AB);
    const [c, d] = (html5Only as any)._tracks as Track[];
    expect((html5Only as any)._crossfadeWindow(c, d, 100, 90)).toEqual({ start: 100, fade: 0 });
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
    expect(endsAtFull(a)).toBe(false); // fading out
    q.pause();
    expect(stoppedNow(incoming)).toBe(true);
    expect(b.scheduledStartContextTime).toBeNull();
    expect(endsAtFull(a)).toBe(true);
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

  it('a faded-out track still decoded plays at full level when started again', async () => {
    // Under repeat 'all' with two entries, a is also b's next, so it stays
    // decoded: going back starts it straight on Web Audio, a fresh start.
    const { q, a } = await playing(AB, { crossfade: 4, repeat: 'all' });
    advanceTime(10);
    sourcesOf(a).at(-1)!.simulateEnded();
    await flush(2);
    expect(q.currentTrack?.key).toBe('b');
    expect(a.isBufferLoaded).toBe(true);
    const g = fadeGain(a);
    g.setValueAtTime.mockClear();
    g.setValueCurveAtTime.mockClear();
    q.previous();
    await flush(2);
    expect(q.currentTrack?.key).toBe('a');
    expect(a.playbackType).toBe('WEBAUDIO');
    expect(g.setValueAtTime.mock.calls.some((c) => c[0] === 1)).toBe(true);
  });

  it('a track that faded out plays at full level when started again', async () => {
    // The fade completes (a faded to silence and ended), then we go back to
    // it: nothing is cancelled, so only the fresh start can restore its level.
    const { q, a } = await playing(AB, { crossfade: 4 });
    advanceTime(10);
    sourcesOf(a).at(-1)!.simulateEnded();
    await flush(2);
    expect(q.currentTrack?.key).toBe('b');
    expect(endsAtFull(a)).toBe(false); // left faded out
    const g = fadeGain(a);
    const resetsBefore = g.setValueAtTime.mock.calls.filter((c) => c[0] === 1).length;
    q.previous();
    await flush(2);
    expect(q.currentTrack?.key).toBe('a');
    expect(a.isPlaying).toBe(true);
    // Back at full level now; the only fade after that is its next fade-out,
    // due at its own end.
    expect(g.setValueAtTime.mock.calls.filter((c) => c[0] === 1).length).toBeGreaterThan(
      resetsBefore
    );
    const now = (a as any).ctx.currentTime;
    if (!endsAtFull(a)) expect(lastCurve(a)![1]).toBeGreaterThan(now + 100);
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

describe('rescheduling during a crossfade', () => {
  it('reaching the lookahead mid-fade leaves the incoming track alone', async () => {
    // Regression: at 5 s left the current track reports TRACK_LOADED again,
    // and cancel-and-reschedule restarted the incoming track from its start,
    // 3 s into an 8 s fade.
    const { q, a, b } = await playing(AB, { crossfade: 8 });
    advanceTime(5); // 3 s into the fade, 5 s left
    const incoming = sourcesOf(b).at(-1)!;
    const started = sourcesOf(b).length;
    q.onTrackBufferReady(a);
    await flush(2);
    expect(incoming.stop.mock.calls.filter((c) => c.length === 0)).toHaveLength(0);
    expect(sourcesOf(b)).toHaveLength(started);
  });

  it('a seek mid-fade still reschedules', async () => {
    const { q, a, b } = await playing(AB, { crossfade: 8 });
    advanceTime(5);
    const incoming = sourcesOf(b).at(-1)!;
    q.seek(a.duration - 20);
    await flush(2);
    expect(stoppedNow(incoming)).toBe(true);
    expect(b.scheduledStartContextTime).toBeCloseTo(a.playbackEndContextTime! - 8, 5);
  });
});

describe('scheduling lead for long fades', () => {
  it('a fade longer than the 5 s lookahead is scheduled in time, at full length', async () => {
    // Regression: with the next track already decoded when the current one
    // started, nothing scheduled it until 5 s before the end, so every fade
    // was cut to about 5 s. (The lookahead now also leads by the fade.)
    mockFetchSuccess();
    const q = new Queue({ crossfade: 8, preloadNumTracks: 2 });
    q.setEntries([{ key: 'x', url: 'x.mp3' }, ...AB]);
    q.play();
    await flush();
    const [x, a, b] = (q as any)._tracks as Track[];
    // x runs into a (a fades in), with b already decoded.
    q.seek(x.duration - 10);
    await flush(2);
    advanceTime(10);
    sourcesOf(x).at(-1)!.simulateEnded();
    await flush(2);
    expect(q.currentTrack?.key).toBe('a');
    expect(a.playbackType).toBe('WEBAUDIO');
    expect(b.isBufferLoaded).toBe(true);
    // Scheduled at the handoff, with the full fade (not cut to the 5 s lookahead).
    expect(b.scheduledStartContextTime).toBeCloseTo(a.playbackEndContextTime! - 8, 5);
  });
});

// ---------------------------------------------------------------------------
// Crossfades with a track still streaming over HTML5 (not decoded yet): the
// common case for a short clip of a long file.
// ---------------------------------------------------------------------------

/** Fetch that never answers for URLs containing any of `hang`: those stay undecoded. */
function fetchHanging(...hang: string[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') return Promise.resolve({ ok: true, redirected: false, url: '' });
      if (hang.some((h) => String(url).includes(h))) return new Promise(() => {});
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
    })
  );
}

const el = (t: Track) => t.audio as unknown as MockAudioElement;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Put a track playing over HTML5 `left` seconds before the end of a 180 s file. */
function nearEndOnHtml5(t: Track, left: number) {
  el(t).simulateLoadedMetadata(180);
  el(t).currentTime = 180 - left;
}

describe('crossfades over HTML5', () => {
  it('streaming → decoded: the outgoing element fades on its fade node', async () => {
    fetchHanging('a.mp3');
    const q = new Queue({ crossfade: 4 });
    q.setEntries(AB);
    q.play();
    await flush();
    const [a, b] = (q as any)._tracks as Track[];
    b.preload();
    await flush();
    expect(a.playbackType).toBe('HTML5');
    expect(b.isBufferLoaded).toBe(true);

    // The element plays through the fade node, so it can be faded.
    expect((a as any)._html5GainNode.connect).toHaveBeenCalledWith((a as any)._fadeGainNode);
    nearEndOnHtml5(a, 8);
    q.onTrackBufferReady(a); // what the lookahead does
    await flush(2);
    const end = (a as any).ctx.currentTime + 8;
    expect(b.scheduledStartContextTime).toBeCloseTo(end - 4, 5);
    expect(lastCurve(b)![2]).toBeCloseTo(4, 5);
    const [out, at, dur] = lastCurve(a)!;
    expect(out[0]).toBeCloseTo(1, 5);
    expect([at, dur]).toEqual([expect.closeTo(end - 4, 5), expect.closeTo(4, 5)]);
  });

  it('decoded → streaming: the incoming track starts over HTML5 on a timer, fading in', async () => {
    fetchHanging('b.mp3');
    const { q, a, b } = await playingUndecodedNext();
    // 4.05 s left: the fade starts 50 ms from now.
    advanceTime(a.playbackEndContextTime! - 4.05 - (a as any).ctx.currentTime);
    q.onTrackBufferReady(a);
    await flush(2);
    expect(b.hasScheduledStart).toBe(true);
    expect(b.isPlaying).toBe(false);
    const [inCurve, at, dur] = lastCurve(b)!;
    expect(inCurve[0]).toBe(0);
    expect(dur).toBeCloseTo(4, 1);

    const curves = fadeGain(b).setValueCurveAtTime.mock.calls.length;
    await sleep(80);
    expect(b.machineState).toBe('html5');
    expect(b.isPlaying).toBe(true);
    expect(el(b).play).toHaveBeenCalledTimes(1);
    // play() reset the fade for a fresh start; the fade-in was put back after it.
    expect(fadeGain(b).setValueCurveAtTime.mock.calls.length).toBe(curves + 1);
    expect(endsAtFull(b)).toBe(false);
    expect(lastCurve(b)![1]).toBe(at);
    expect(lastCurve(a)![1]).toBeCloseTo(at, 5);
  });

  it('at the handoff the streaming track plays on, not restarted', async () => {
    fetchHanging('b.mp3');
    const { q, a, b } = await playingUndecodedNext();
    advanceTime(a.playbackEndContextTime! - 4.05 - (a as any).ctx.currentTime);
    q.onTrackBufferReady(a);
    await flush(2);
    await sleep(80);
    advanceTime(4.05);
    sourcesOf(a).at(-1)!.simulateEnded();
    await flush(2);
    expect(q.currentTrack?.key).toBe('b');
    expect(b.isPlaying).toBe(true);
    expect(el(b).play).toHaveBeenCalledTimes(1);
    expect(b.hasScheduledStart).toBe(false);
  });

  it('if the outgoing track ends before the timer, the incoming one starts at once', async () => {
    fetchHanging('b.mp3');
    const { q, a, b } = await playingUndecodedNext();
    advanceTime(a.playbackEndContextTime! - 8 - (a as any).ctx.currentTime); // fade due in 4 s
    q.onTrackBufferReady(a);
    await flush(2);
    expect(b.hasScheduledStart).toBe(true);
    expect(b.isPlaying).toBe(false);
    sourcesOf(a).at(-1)!.simulateEnded(); // well before the fade was due
    await flush(2);
    expect(q.currentTrack?.key).toBe('b');
    expect(b.isPlaying).toBe(true);
    expect(endsAtFull(b)).toBe(true);
  });

  it('pause mid-fade stops the streaming incoming track', async () => {
    fetchHanging('b.mp3');
    const { q, a, b } = await playingUndecodedNext();
    advanceTime(a.playbackEndContextTime! - 4.05 - (a as any).ctx.currentTime);
    q.onTrackBufferReady(a);
    await flush(2);
    await sleep(80);
    expect(b.isPlaying).toBe(true);
    q.pause();
    expect(b.isPlaying).toBe(false);
    expect(el(b).paused).toBe(true);
    expect(b.hasScheduledStart).toBe(false);
  });

  it('the incoming decode finishing mid-fade keeps the fade and the schedule', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'HEAD') return { ok: true, redirected: false, url: '' };
        if (String(url).includes('b.mp3')) await gate;
        return { ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) };
      })
    );
    const { q, a, b } = await playingUndecodedNext();
    advanceTime(a.playbackEndContextTime! - 4.05 - (a as any).ctx.currentTime);
    q.onTrackBufferReady(a);
    await flush(2);
    await sleep(80);
    expect(b.machineState).toBe('html5');
    const resets = fadeGain(b).setValueAtTime.mock.calls.length;
    const playCalls = el(b).play.mock.calls.length;

    release();
    await flush();
    expect(b.playbackType).toBe('WEBAUDIO'); // crossed over mid-fade
    expect(fadeGain(b).setValueAtTime.mock.calls.length).toBe(resets); // fade not reset
    expect(b.isPlaying).toBe(true);
    expect(el(b).play.mock.calls.length).toBe(playCalls);
    expect(b.hasScheduledStart).toBe(true);
  });
});

/** a decoded and playing on Web Audio; b (the next) still loading. */
async function playingUndecodedNext() {
  const q = new Queue({ crossfade: 4 });
  q.setEntries(AB);
  q.play();
  await flush();
  const [a, b] = (q as any)._tracks as Track[];
  expect(a.playbackType).toBe('WEBAUDIO');
  expect(b.isBufferLoaded).toBe(false);
  return { q, a, b };
}

describe('the transition after a crossfade', () => {
  it('is scheduled at the handoff, even if the track used up its lookahead while fading in', async () => {
    // Regression: a track that started early (fading in) can spend its one
    // lookahead notice while still incoming, when the queue ignores it. After
    // the handoff nothing asked for its next transition, so it ended in a cut.
    mockFetchSuccess();
    const q = new Queue({ crossfade: 4, preloadNumTracks: 2 });
    q.setEntries([...AB, { key: 'c', url: 'c.mp3' }]);
    q.play();
    await flush();
    const [a, b, c] = (q as any)._tracks as Track[];
    b.preload();
    c.preload();
    await flush();
    expect(c.isBufferLoaded).toBe(true);
    // b fades in over a's last 4 s, then a ends.
    advanceTime(a.playbackEndContextTime! - 8 - (a as any).ctx.currentTime);
    q.onTrackBufferReady(a);
    await flush(2);
    (b as any)._actor.send({ type: 'LOOKAHEAD_REACHED' }); // spent while incoming
    advanceTime(8);
    sourcesOf(a).at(-1)!.simulateEnded();
    await flush(2);
    expect(q.currentTrack?.key).toBe('b');
    expect(c.hasScheduledStart).toBe(true);
  });
});

describe('codex review: edge cases', () => {
  it('removing the incoming entry cancels the outgoing fade', async () => {
    const { q, a } = await playing(AB, { crossfade: 4 });
    expect(lastCurve(a)).not.toBeNull();
    const resets = fadeGain(a).cancelScheduledValues.mock.calls.length;
    q.removeTrack(1);
    expect(fadeGain(a).cancelScheduledValues.mock.calls.length).toBeGreaterThan(resets);
    expect(endsAtFull(a)).toBe(true);
    expect((q as any)._scheduledNext).toBeNull();
  });

  it('an incoming clip keeps playing time after the handoff', async () => {
    const { a, b } = await playing([AB[0], { ...AB[1], start: 10, end: 11.5 }], { crossfade: 4 });
    const fade = a.playbackEndContextTime! - b.scheduledStartContextTime!;
    expect(fade).toBeLessThanOrEqual(0.75 + 1e-9);
  });

  it('an incoming entry that already ended by the handoff ends the queue, not hangs it', async () => {
    const onEnded = vi.fn();
    const { q, a, b } = await playing([AB[0], { ...AB[1], start: 10, end: 11.5 }], {
      crossfade: 4,
      onEnded,
    });
    advanceTime(10);
    sourcesOf(b).at(-1)!.simulateEnded(); // the incoming one reports first
    sourcesOf(a).at(-1)!.simulateEnded();
    await flush(4);
    expect(onEnded).toHaveBeenCalled();
    expect(q.isPlaying).toBe(false);
  });

  it('a seek to the same spot mid-fade keeps the outgoing fade', async () => {
    const { q, a } = await playing(AB, { crossfade: 4 });
    advanceTime(7); // 1 s into the fade
    const curves = fadeGain(a).setValueCurveAtTime.mock.calls.length;
    q.seek(a.currentTime);
    await flush(2);
    // The seek restarted a's source (resetting its fade): the fade-out is redone.
    expect(fadeGain(a).setValueCurveAtTime.mock.calls.length).toBeGreaterThan(curves);
  });

  it('at a slow playback rate a streaming crossfade is still scheduled', async () => {
    fetchHanging('b.mp3');
    const { q, a, b } = await playingUndecodedNext();
    q.setPlaybackRate(0.5);
    await flush(2);
    const ctxNow = () => (a as any).ctx.currentTime;
    advanceTime(a.playbackEndContextTime! - 13 - ctxNow()); // 13 wall s left
    await flush();
    advanceTime(5); // 8 wall s left: inside 5 + 4
    await flush();
    expect(b.hasScheduledStart).toBe(true);
  });

  it('setCrossfade schedules a transition when none was', async () => {
    fetchHanging('b.mp3');
    const q = new Queue();
    q.setEntries(AB);
    q.play();
    await flush();
    const [a, b] = (q as any)._tracks as Track[];
    advanceTime(a.playbackEndContextTime! - 4.5 - (a as any).ctx.currentTime);
    await flush(); // lookahead spent: nothing to do without a fade, b not decoded
    expect(b.hasScheduledStart).toBe(false);
    q.setCrossfade(4);
    await flush(2);
    expect(b.hasScheduledStart).toBe(true);
  });
});

describe('a deferred transition is retried', () => {
  it('shortening a pending streaming fade still fades, once the new window comes', async () => {
    // Codex: an 8 s fade schedules at 13 s left; setCrossfade(2) at 12 s left
    // cancels it and defers the replacement (horizon 7.5 s), but the lookahead
    // was spent, so nothing ever retried and the fade became a cut.
    fetchHanging('b.mp3');
    const q = new Queue({ crossfade: 8 });
    q.setEntries(AB);
    q.play();
    await flush();
    const [a, b] = (q as any)._tracks as Track[];
    const left = (s: number) =>
      advanceTime(a.playbackEndContextTime! - s - (a as any).ctx.currentTime);
    left(13);
    await flush(); // lookahead (13 s) fires and schedules the streaming start
    expect(b.hasScheduledStart).toBe(true);

    vi.useFakeTimers();
    try {
      left(12);
      q.setCrossfade(2);
      expect(b.hasScheduledStart).toBe(false); // deferred: not near yet
      left(7.4);
      vi.advanceTimersByTime(4700);
      expect(b.hasScheduledStart).toBe(true);
      expect(lastCurve(b)![2]).toBeCloseTo(2, 5);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('review: speed changes, entry edits, destroyed tracks', () => {
  it('changing speed mid-fade keeps both tracks going and retimes the fades', async () => {
    const { q, a, b } = await playing(AB, { crossfade: 4 });
    advanceTime(8); // 2 s into the fade
    const incoming = sourcesOf(b).at(-1)!;
    const started = sourcesOf(b).length;
    q.setPlaybackRate(1.25);
    await flush(2);
    expect(sourcesOf(b)).toHaveLength(started); // not restarted
    expect(stoppedNow(incoming)).toBe(false);
    expect(incoming.playbackRate.value).toBe(1.25);
    const end = a.playbackEndContextTime!;
    const outRamp = (a as any)._fadeGainNode.gain.linearRampToValueAtTime.mock.calls.at(-1);
    const inRamp = (b as any)._fadeGainNode.gain.linearRampToValueAtTime.mock.calls.at(-1);
    expect(outRamp).toEqual([0, expect.closeTo(end, 5)]);
    expect(inRamp).toEqual([1, expect.closeTo(end, 5)]);
  });

  it('changing speed before the fade starts just reschedules it', async () => {
    const { q, a, b } = await playing(AB, { crossfade: 4 });
    q.setPlaybackRate(2);
    await flush(2);
    expect(b.scheduledStartContextTime).toBeCloseTo(a.playbackEndContextTime! - 4, 5);
  });

  it('setEntries applies a new crossfade to an entry already in the queue', async () => {
    const { q, a, b } = await playing(AB);
    expect(b.scheduledStartContextTime).toBeCloseTo(a.playbackEndContextTime!, 5);
    q.setEntries([AB[0], { ...AB[1], crossfade: 4 }]);
    await flush(2);
    expect(b.scheduledStartContextTime).toBeCloseTo(a.playbackEndContextTime! - 4, 5);
    expect(q.snapshot().entries[1].crossfade).toBe(4);
  });

  it('setEntries with a new clip range rebuilds an entry that is not playing', async () => {
    const q = new Queue();
    q.setEntries(AB);
    const before = (q as any)._tracks[1];
    q.setEntries([AB[0], { ...AB[1], start: 30, end: 40 }]);
    const after = (q as any)._tracks[1] as Track;
    expect(after).not.toBe(before);
    expect([after.clipStart, after.clipEnd]).toEqual([30, 40]);
    expect(q.snapshot().entries[1]).toMatchObject({ start: 30, end: 40 });
  });

  it('the playing entry keeps its range when setEntries changes it', async () => {
    const { q, a } = await playing(AB);
    q.setEntries([{ ...AB[0], start: 5 }, AB[1]]);
    expect((q as any)._tracks[0]).toBe(a);
    expect(a.isPlaying).toBe(true);
    expect(a.clipStart).toBe(0);
  });

  it('removing the current track does not rebuild audio nodes on it', async () => {
    const { q, a } = await playing(AB, { crossfade: 4 });
    const ctx = (a as any).ctx;
    const mediaSources = ctx.createMediaElementSource.mock.calls.length;
    q.removeTrack(0);
    await flush(2);
    expect((a as any).gainNode).toBeNull();
    expect(ctx.createMediaElementSource.mock.calls.length).toBe(mediaSources);
  });
});
