// ---------------------------------------------------------------------------
// Key-based play order: insert / move / setEntries without interrupting the
// current track, and keeping the gapless schedule consistent.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import { Queue } from '../../src/Queue';
import type { Entry } from '../../src/types';
import { advanceTime, mockFetchSuccess, MockAudioElement } from '../setup';

const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

const entry = (key: string): Entry => ({ key, url: `${key}.mp3` });

// oxlint-disable-next-line typescript/no-explicit-any
type Internal = any;

/** Playing track 'a', 20 s in, with 'b' decoded and its gapless start scheduled. */
async function playingWithScheduledNext(keys = ['a', 'b', 'c']) {
  mockFetchSuccess();
  const q = new Queue();
  q.setEntries(keys.map(entry), { play: false });
  q.play();
  advanceTime(20);
  await flush();
  const internal = q as Internal;
  expect(internal._scheduledNext?.key).toBe('b');
  return { q, internal };
}

function spyCurrent(internal: Internal) {
  const cur = internal._currentTrack;
  return {
    cur,
    play: vi.spyOn(cur, 'play'),
    pause: vi.spyOn(cur, 'pause'),
    deactivate: vi.spyOn(cur, 'deactivate'),
    seek: vi.spyOn(cur, 'seek'),
  };
}

function expectUntouched(spies: ReturnType<typeof spyCurrent>) {
  expect(spies.play).not.toHaveBeenCalled();
  expect(spies.pause).not.toHaveBeenCalled();
  expect(spies.deactivate).not.toHaveBeenCalled();
  expect(spies.seek).not.toHaveBeenCalled();
  expect(spies.cur.isPlaying).toBe(true);
}

describe('setEntries', () => {
  it('starts at startKey', () => {
    const q = new Queue();
    q.setEntries(['a', 'b', 'c'].map(entry), { startKey: 'b' });
    expect(q.currentKey).toBe('b');
    expect(q.keys).toEqual(['a', 'b', 'c']);
  });

  it('keeps the playing track when its key survives, and ignores startKey', async () => {
    const { q, internal } = await playingWithScheduledNext();
    const spies = spyCurrent(internal);
    q.setEntries(['x', 'a', 'b', 'y'].map(entry), { startKey: 'x' });
    expect(q.currentKey).toBe('a');
    expect(q.currentTrackIndex).toBe(1);
    expectUntouched(spies);
  });

  it('reuses Track instances (and their buffers) for surviving keys', async () => {
    const { q, internal } = await playingWithScheduledNext();
    const b = internal._tracks[1];
    expect(b.isBufferLoaded).toBe(true);
    const fetchSpy = vi.mocked(fetch);
    const callsBefore = fetchSpy.mock.calls.length;

    q.setEntries(['a', 'b', 'c', 'd'].map(entry));
    expect(internal._tracks[1]).toBe(b);
    expect(b.isBufferLoaded).toBe(true);
    const refetchedB = fetchSpy.mock.calls
      .slice(callsBefore)
      .some((c) => String(c[0]).includes('b.mp3'));
    expect(refetchedB).toBe(false);
  });

  it('moves to startKey when the playing key is dropped', async () => {
    const { q, internal } = await playingWithScheduledNext();
    const old = internal._currentTrack;
    q.setEntries(['x', 'y'].map(entry), { startKey: 'y' });
    expect(q.currentKey).toBe('y');
    expect(q.isPlaying).toBe(true);
    expect(old.isPlaying).toBe(false);
    expect((old.audio as MockAudioElement).paused).toBe(true);
  });

  it('empties the queue', async () => {
    const { q } = await playingWithScheduledNext();
    q.setEntries([]);
    expect(q.keys).toEqual([]);
    expect(q.queueSnapshot.context.trackCount).toBe(0);
    expect(q.queueSnapshot.state).toBe('idle');
    expect(q.isPlaying).toBe(false);
  });
});

describe('insert', () => {
  it('after current keeps the current track playing', async () => {
    const { q, internal } = await playingWithScheduledNext();
    const spies = spyCurrent(internal);
    q.insert([entry('n1'), entry('n2')], { after: 'current' });
    expect(q.keys).toEqual(['a', 'n1', 'n2', 'b', 'c']);
    expect(q.currentKey).toBe('a');
    expectUntouched(spies);
  });

  it('after current cancels the scheduled start of the old next track', async () => {
    const { q, internal } = await playingWithScheduledNext();
    const b = internal._tracks[1];
    const cancel = vi.spyOn(b, 'cancelGaplessStart');
    q.insert([entry('n1')], { after: 'current' });
    expect(cancel).toHaveBeenCalled();
    // n1 isn't decoded yet, so nothing is scheduled until it is…
    expect(internal._scheduledNext).toBeNull();
    // …and once it is, n1 (not b) gets the gapless start.
    await flush();
    expect(internal._scheduledNext?.key).toBe('n1');
  });

  it('at the end leaves the gapless schedule alone', async () => {
    const { q, internal } = await playingWithScheduledNext();
    const b = internal._tracks[1];
    const cancel = vi.spyOn(b, 'cancelGaplessStart');
    q.insert([entry('z')], { after: 'end' });
    expect(cancel).not.toHaveBeenCalled();
    expect(internal._scheduledNext).toBe(b);
  });

  it('before current shifts the current index, not the current track', async () => {
    const { q, internal } = await playingWithScheduledNext();
    const spies = spyCurrent(internal);
    q.insert([entry('h1'), entry('h2')], { after: 'start' });
    expect(q.currentTrackIndex).toBe(2);
    expect(q.currentKey).toBe('a');
    expect(internal._scheduledNext?.key).toBe('b');
    expectUntouched(spies);
  });

  it('into an empty queue makes the first entry current', () => {
    const q = new Queue();
    q.insert([entry('a'), entry('b')], { after: 'current' });
    expect(q.keys).toEqual(['a', 'b']);
    expect(q.currentKey).toBe('a');
  });

  it('after an unknown key is a no-op', () => {
    const q = new Queue();
    q.setEntries([entry('a')]);
    q.insert([entry('b')], { after: 'nope' });
    expect(q.keys).toEqual(['a']);
  });
});

describe('move', () => {
  it('moving the current track keeps it playing', async () => {
    const { q, internal } = await playingWithScheduledNext();
    const spies = spyCurrent(internal);
    q.move('a', { after: 'c' });
    expect(q.keys).toEqual(['b', 'c', 'a']);
    expect(q.currentKey).toBe('a');
    expect(q.currentTrackIndex).toBe(2);
    expectUntouched(spies);
    // Nothing follows 'a' now.
    expect(internal._scheduledNext).toBeNull();
  });

  it('moving a later track into the next slot reschedules gapless onto it', async () => {
    const { q, internal } = await playingWithScheduledNext(['a', 'b', 'c']);
    q.move('c', { after: 'a' });
    expect(q.keys).toEqual(['a', 'c', 'b']);
    await flush();
    expect(internal._scheduledNext?.key).toBe('c');
  });
});

describe('advancing after an edit', () => {
  it('the track that ends hands off to the new next track', async () => {
    const { q, internal } = await playingWithScheduledNext();
    q.insert([entry('n1')], { after: 'current' });
    await flush();
    q.onTrackEnded(internal._currentTrack);
    expect(q.currentKey).toBe('n1');
    expect(internal._currentTrack.isPlaying).toBe(true);
  });

  it('callbacks from a dropped track are ignored', async () => {
    const { q, internal } = await playingWithScheduledNext();
    const b = internal._tracks[1];
    q.remove('b');
    const send = vi.spyOn(internal._actor, 'send');
    // The dropped track's stale index (1) now belongs to 'c'.
    q.onTrackBufferReady(b);
    q.onPreloadReady(b);
    expect(send).not.toHaveBeenCalled();
  });

  it('remove(key) on the current track advances', async () => {
    const { q } = await playingWithScheduledNext();
    q.remove('a');
    expect(q.currentKey).toBe('b');
    expect(q.isPlaying).toBe(true);
  });
});

describe('large queues', () => {
  it('builds and reorders 400 entries quickly', () => {
    const keys = Array.from({ length: 400 }, (_, i) => `t${i}`);
    const q = new Queue();

    let t0 = performance.now();
    q.setEntries(keys.map(entry), { startKey: 't200' });
    const build = performance.now() - t0;

    // A full shuffle-style reorder keeping the current track.
    const shuffled = [...keys].sort(() => Math.random() - 0.5);
    t0 = performance.now();
    q.setEntries(shuffled.map(entry));
    const reorder = performance.now() - t0;

    t0 = performance.now();
    for (let i = 0; i < 50; i++) q.insert([entry(`n${i}`)], { after: 'current' });
    const inserts = (performance.now() - t0) / 50;

    // oxlint-disable-next-line no-console
    console.info(
      `400 entries: build ${build.toFixed(1)}ms, reorder ${reorder.toFixed(1)}ms, insert ${inserts.toFixed(2)}ms each`
    );
    expect(q.currentKey).toBe('t200');
    expect(q.keys).toHaveLength(450);
    q.destroy();
  });
});
