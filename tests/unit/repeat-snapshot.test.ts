// ---------------------------------------------------------------------------
// Repeat modes, snapshot/restore and onChange.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import { Queue } from '../../src/Queue';
import type { Entry, QueueChange } from '../../src/types';
import { advanceTime, mockFetchSuccess } from '../setup';

const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
const microtasks = () => new Promise<void>((r) => queueMicrotask(r));

const entry = (key: string): Entry => ({ key, url: `${key}.mp3` });

// oxlint-disable-next-line typescript/no-explicit-any
type Internal = any;

function queueOf(keys: string[], opts: ConstructorParameters<typeof Queue>[0] = {}) {
  mockFetchSuccess();
  const q = new Queue(opts);
  q.setEntries(keys.map(entry), { play: false });
  return { q, internal: q as Internal };
}

const endCurrent = (internal: Internal) => internal.onTrackEnded(internal._currentTrack);

describe('repeat off', () => {
  it('ends after the last entry', () => {
    const { q, internal } = queueOf(['a', 'b']);
    q.goto('b', { play: true });
    endCurrent(internal);
    expect(q.queueSnapshot.state).toBe('ended');
  });

  it('next() at the end is a no-op', () => {
    const { q } = queueOf(['a', 'b']);
    q.goto('b', { play: true });
    q.next();
    expect(q.currentKey).toBe('b');
  });
});

describe("repeat 'all'", () => {
  it('wraps to the first entry when the last one ends, and keeps playing', () => {
    const { q, internal } = queueOf(['a', 'b', 'c'], { repeat: 'all' });
    q.goto('c', { play: true });
    endCurrent(internal);
    expect(q.currentKey).toBe('a');
    expect(q.isPlaying).toBe(true);
  });

  it('next() at the end wraps', () => {
    const { q } = queueOf(['a', 'b']);
    q.setRepeat('all');
    q.goto('b', { play: true });
    q.next();
    expect(q.currentKey).toBe('a');
  });

  it('schedules a gapless start for the first entry across the wrap', async () => {
    const { q, internal } = queueOf(['a', 'b', 'c'], { repeat: 'all' });
    q.goto('c', { play: true });
    advanceTime(20);
    await flush();
    expect(internal._scheduledNext?.key).toBe('a');

    // The wrap continues the scheduled track instead of restarting it.
    const a = internal._tracks[0];
    const play = vi.spyOn(a, 'play');
    endCurrent(internal);
    expect(q.currentKey).toBe('a');
    expect(play).not.toHaveBeenCalled();
  });

  it('turning it off at the last entry cancels the wrap schedule', async () => {
    const { q, internal } = queueOf(['a', 'b'], { repeat: 'all' });
    q.goto('b', { play: true });
    advanceTime(20);
    await flush();
    const a = internal._tracks[0];
    expect(internal._scheduledNext).toBe(a);
    const cancel = vi.spyOn(a, 'cancelGaplessStart');
    q.setRepeat('off');
    expect(cancel).toHaveBeenCalled();
    expect(internal._scheduledNext).toBeNull();
    endCurrent(internal);
    expect(q.queueSnapshot.state).toBe('ended');
  });

  it('over a single entry restarts it', () => {
    const { q, internal } = queueOf(['a'], { repeat: 'all' });
    q.play();
    const a = internal._currentTrack;
    const seek = vi.spyOn(a, 'seek');
    endCurrent(internal);
    expect(q.currentKey).toBe('a');
    expect(q.isPlaying).toBe(true);
    expect(seek).toHaveBeenCalledWith(0);
  });
});

describe("repeat 'one'", () => {
  it('restarts the current entry when it ends', () => {
    const { q, internal } = queueOf(['a', 'b'], { repeat: 'one' });
    q.play();
    const a = internal._currentTrack;
    const seek = vi.spyOn(a, 'seek');
    const play = vi.spyOn(a, 'play');
    const starts: string[] = [];
    (internal as { _onStartNewTrack?: unknown })._onStartNewTrack = (i: { key: string }) =>
      starts.push(i.key);
    endCurrent(internal);
    expect(q.currentKey).toBe('a');
    expect(q.isPlaying).toBe(true);
    expect(seek).toHaveBeenCalledWith(0);
    expect(play).toHaveBeenCalled();
    // A restart counts as a new play (scrobbling, listen tracking).
    expect(starts).toEqual(['a']);
  });

  it('never schedules a gapless start', async () => {
    const { q, internal } = queueOf(['a', 'b'], { repeat: 'one' });
    q.play();
    advanceTime(20);
    await flush();
    expect(internal._scheduledNext).toBeNull();
    // …but still preloads the next entry, in case the user skips.
    expect(internal._tracks[1].isBufferLoaded).toBe(true);
  });

  it('turning it on cancels a scheduled start', async () => {
    const { q, internal } = queueOf(['a', 'b']);
    q.play();
    advanceTime(20);
    await flush();
    expect(internal._scheduledNext?.key).toBe('b');
    q.setRepeat('one');
    expect(internal._scheduledNext).toBeNull();
  });

  it('next() still moves on', () => {
    const { q } = queueOf(['a', 'b'], { repeat: 'one' });
    q.play();
    q.next();
    expect(q.currentKey).toBe('b');
  });
});

describe('snapshot / restore', () => {
  it('captures entries, position and repeat without resolved URLs', () => {
    const { q } = queueOf(['a', 'b', 'c']);
    q.setRepeat('all');
    q.goto('b', { startTime: 42 });
    const snap = q.snapshot();
    expect(snap.entries.map((e) => e.key)).toEqual(['a', 'b', 'c']);
    expect(snap.entries[0].url).toBe('a.mp3');
    expect(snap.currentKey).toBe('b');
    expect(snap.currentTime).toBe(42);
    expect(snap.repeat).toBe('all');
  });

  it('round-trips into a fresh queue, paused at the saved position', () => {
    const { q } = queueOf(['a', 'b', 'c']);
    q.setRepeat('one');
    q.goto('c', { startTime: 17 });
    const snap = JSON.parse(JSON.stringify(q.snapshot()));

    const fresh = new Queue();
    fresh.restore(snap);
    expect(fresh.keys).toEqual(['a', 'b', 'c']);
    expect(fresh.currentKey).toBe('c');
    expect(fresh.currentTrack?.currentTime).toBe(17);
    expect(fresh.repeat).toBe('one');
    expect(fresh.isPlaying).toBe(false);
    expect(fresh.snapshot()).toEqual(snap);
  });

  it('moves a surviving current entry to the saved time', () => {
    const { q } = queueOf(['a', 'b']);
    q.goto('a', { startTime: 5 });
    q.restore({ entries: ['a', 'b'].map(entry), currentKey: 'a', currentTime: 30, repeat: 'off' });
    expect(q.currentTrack?.currentTime).toBe(30);
  });

  it('keeps skipHEAD', () => {
    const q = new Queue();
    q.setEntries([{ key: 'a', url: 'a.mp3', skipHEAD: true }, entry('b')]);
    const [a, b] = q.snapshot().entries;
    expect(a.skipHEAD).toBe(true);
    expect(b.skipHEAD).toBeUndefined();
  });
});

describe('onChange', () => {
  it('reports each edit once, after it, with the final state', async () => {
    const { q } = queueOf(['a', 'b', 'c']);
    await microtasks();
    const changes: QueueChange[] = [];
    q.onChange((c) => changes.push(c));

    q.insert([entry('n')], { after: 'current' });
    expect(changes).toHaveLength(0); // batched
    await microtasks();
    expect(changes).toEqual([{ keys: ['a', 'n', 'b', 'c'], currentKey: 'a', repeat: 'off' }]);

    q.setEntries(['x', 'y'].map(entry), { startKey: 'y' });
    await microtasks();
    // No intermediate state where 'x' was current.
    expect(changes.slice(1)).toEqual([{ keys: ['x', 'y'], currentKey: 'y', repeat: 'off' }]);
  });

  it('reports the current entry changing, but not play, pause or seek', async () => {
    const { q, internal } = queueOf(['a', 'b']);
    await microtasks();
    const changes: QueueChange[] = [];
    q.onChange((c) => changes.push(c));

    q.play();
    q.seek(10);
    q.pause();
    await microtasks();
    expect(changes).toHaveLength(0);

    q.play();
    endCurrent(internal);
    await microtasks();
    expect(changes.map((c) => c.currentKey)).toEqual(['b']);

    q.setRepeat('all');
    await microtasks();
    expect(changes.at(-1)?.repeat).toBe('all');
  });

  it('a listener can edit the queue', async () => {
    // The app's use: drop a "Next up" entry once playback moves past it.
    const { q, internal } = queueOf(['a', 'n', 'b']);
    q.play();
    await microtasks();
    let prev = q.currentKey;
    q.onChange((c) => {
      if (prev === 'n' && c.currentKey !== 'n') q.remove('n');
      prev = c.currentKey;
    });
    endCurrent(internal); // a → n
    await microtasks();
    endCurrent(internal); // n → b, listener removes n
    await microtasks();
    await microtasks();
    expect(q.keys).toEqual(['a', 'b']);
    expect(q.currentKey).toBe('b');
    expect(q.isPlaying).toBe(true);
  });

  it('unsubscribes', async () => {
    const { q } = queueOf(['a']);
    const listener = vi.fn();
    const off = q.onChange(listener);
    off();
    q.insert([entry('b')]);
    await microtasks();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('review fixes', () => {
  it("addTrack while the last entry plays under repeat 'all' moves the schedule off the wrap", async () => {
    const { q, internal } = queueOf(['a', 'b'], { repeat: 'all' });
    q.goto('b', { play: true });
    advanceTime(20);
    await flush();
    const a = internal._tracks[0];
    expect(internal._scheduledNext).toBe(a);
    const cancel = vi.spyOn(a, 'cancelGaplessStart');

    q.addTrack('c.mp3', { key: 'c' });
    expect(cancel).toHaveBeenCalled();
    expect(internal._scheduledNext).not.toBe(a);
    await flush();
    expect(internal._scheduledNext?.key).toBe('c');
  });

  it('restore moves to the saved entry when a different current entry survives', () => {
    const { q } = queueOf(['a', 'b']);
    q.goto('a', { startTime: 5 });
    q.restore({ entries: ['a', 'b'].map(entry), currentKey: 'b', currentTime: 30, repeat: 'off' });
    expect(q.currentKey).toBe('b');
    expect(q.currentTrack?.currentTime).toBe(30);
  });

  it('generated keys never collide with keys already in the queue', () => {
    // After a reload the generator starts over, so a restored snapshot can hold
    // exactly the keys it is about to generate. Simulate that by restoring the
    // next few generated keys before generating any.
    const probe = new Queue();
    probe.addTrack('probe.mp3');
    const n = Number(probe.keys[0].replace(/\D+/g, ''));
    const upcoming = [1, 2, 3].map((i) => probe.keys[0].replace(String(n), String(n + i)));

    const q = new Queue();
    q.setEntries(upcoming.map((key) => ({ key, url: `${key}.mp3` })));
    for (let i = 0; i < 5; i++) q.addTrack(`x${i}.mp3`);
    const keys = q.keys;
    expect(keys.slice(0, 3)).toEqual(upcoming);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('rejects duplicate keys instead of corrupting the queue', () => {
    const q = new Queue();
    q.setEntries(['a', 'b'].map(entry));
    expect(() => q.insert([entry('a')])).toThrow(/duplicate key "a"/);
    expect(() => q.insert([entry('n'), entry('n')])).toThrow(/duplicate key "n"/);
    expect(() => q.setEntries(['x', 'x'].map(entry))).toThrow(/duplicate key "x"/);
    expect(() => q.addTrack('a2.mp3', { key: 'b' })).toThrow(/duplicate key "b"/);
    expect(q.keys).toEqual(['a', 'b']);
  });
});

describe('going to an entry without playing, while playing', () => {
  it('setEntries({ play: false }) that drops the current entry pauses on the new one', () => {
    const { q, internal } = queueOf(['a', 'b']);
    q.play();
    q.setEntries(['x', 'y'].map(entry), { startKey: 'y', play: false });
    expect(q.currentKey).toBe('y');
    expect(q.queueSnapshot.state).toBe('paused');
    expect(q.isPlaying).toBe(false);
    // …and play() recovers.
    q.play();
    expect(q.isPlaying).toBe(true);
    expect(internal._currentTrack.isPlaying).toBe(true);
  });

  it('gotoTrack(i, false) pauses on the new track (pre-existing path)', () => {
    const { q, internal } = queueOf(['a', 'b']);
    q.play();
    q.gotoTrack(1, false);
    expect(q.currentKey).toBe('b');
    expect(q.queueSnapshot.state).toBe('paused');
    expect(internal._tracks[0].isPlaying).toBe(false);
    q.play();
    expect(internal._currentTrack.isPlaying).toBe(true);
  });
});
