// ---------------------------------------------------------------------------
// Fuzz Testing — Navigation Stress Tests
//
// Rapidly and randomly calls Queue methods in various combinations to surface
// crashes, state corruption, or index out-of-bounds bugs.
//
// Uses a seeded PRNG (mulberry32) for reproducible sequences — the seed is
// logged on failure so failing runs can be replayed.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Queue } from '../../src/Queue';
import type { Track } from '../../src/Track';
import { mockFetchSuccess, mockFetchFailure } from '../setup';

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Weighted random picker
// ---------------------------------------------------------------------------

type OpName =
  | 'next'
  | 'previous'
  | 'gotoTrack'
  | 'addTrack'
  | 'removeTrack'
  | 'play'
  | 'pause'
  | 'seek'
  | 'trackEnded'
  | 'togglePlayPause'
  | 'setVolume'
  | 'bigJump'
  | 'networkFail'
  | 'networkRestore';

type Weights = Partial<Record<OpName, number>>;

function pickOp(rand: () => number, weights: Weights): OpName {
  const entries = Object.entries(weights) as [OpName, number][];
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let r = rand() * total;
  for (const [op, w] of entries) {
    r -= w;
    if (r <= 0) return op;
  }
  return entries[entries.length - 1][0];
}

// ---------------------------------------------------------------------------
// Invariant checker
// ---------------------------------------------------------------------------

function checkInvariants(queue: Queue, opDescription: string, seed: number): void {
  const snap = queue.queueSnapshot;
  const tracks = (queue as unknown as { _tracks: { index: number }[] })._tracks;
  const trackCount = tracks.length;
  const label = `[seed=${seed}] after ${opDescription}`;

  // 1. State is one of the valid states
  const validStates = ['idle', 'playing', 'paused', 'ended'];
  expect(
    validStates.includes(snap.state),
    `${label}: Invalid state "${snap.state}"`,
  ).toBe(true);

  // 2. Machine trackCount matches actual tracks length
  expect(
    snap.context.trackCount,
    `${label}: trackCount mismatch machine=${snap.context.trackCount} actual=${trackCount}`,
  ).toBe(trackCount);

  // 3. currentTrackIndex is in bounds (0 <= idx < trackCount, or >= 0 when empty)
  expect(
    snap.context.currentTrackIndex,
    `${label}: currentTrackIndex ${snap.context.currentTrackIndex} < 0`,
  ).toBeGreaterThanOrEqual(0);
  if (trackCount > 0) {
    expect(
      snap.context.currentTrackIndex,
      `${label}: currentTrackIndex ${snap.context.currentTrackIndex} >= trackCount ${trackCount}`,
    ).toBeLessThan(trackCount);
  }

  // 4. Internal _tracks[i].index === i (sequential indices)
  for (let i = 0; i < trackCount; i++) {
    expect(
      tracks[i].index,
      `${label}: _tracks[${i}].index is ${tracks[i].index}, expected ${i}`,
    ).toBe(i);
  }

  // 5. "playing" or "paused" with 0 tracks is invalid
  if (trackCount === 0) {
    expect(
      snap.state === 'playing' || snap.state === 'paused',
      `${label}: state is "${snap.state}" with 0 tracks`,
    ).toBe(false);
  }

  // 6. "ended" state should only occur at or past the last track
  if (snap.state === 'ended' && trackCount > 0) {
    expect(
      snap.context.currentTrackIndex,
      `${label}: ended state but currentTrackIndex ${snap.context.currentTrackIndex} is not last (trackCount=${trackCount})`,
    ).toBeGreaterThanOrEqual(trackCount - 1);
  }

  // 7. volume should always be in [0, 1]
  expect(
    queue.volume,
    `${label}: volume ${queue.volume} out of range`,
  ).toBeGreaterThanOrEqual(0);
  expect(
    queue.volume,
    `${label}: volume ${queue.volume} out of range`,
  ).toBeLessThanOrEqual(1);

  // 8. isPlaying / isPaused should be consistent with state
  if (snap.state === 'playing') {
    expect(queue.isPlaying, `${label}: isPlaying should be true in playing state`).toBe(true);
    expect(queue.isPaused, `${label}: isPaused should be false in playing state`).toBe(false);
  }
  if (snap.state === 'paused') {
    expect(queue.isPaused, `${label}: isPaused should be true in paused state`).toBe(true);
    expect(queue.isPlaying, `${label}: isPlaying should be false in paused state`).toBe(false);
  }

  // 9. currentTrackIndex getter should match machine context
  expect(
    queue.currentTrackIndex,
    `${label}: public currentTrackIndex getter ${queue.currentTrackIndex} != machine ${snap.context.currentTrackIndex}`,
  ).toBe(snap.context.currentTrackIndex);

  // 10. tracks.length should match internal _tracks.length
  expect(
    queue.tracks.length,
    `${label}: public tracks.length ${queue.tracks.length} != internal ${trackCount}`,
  ).toBe(trackCount);

  // 11. _scheduledNextIndex (if set) should be in bounds
  const scheduledIdx = (queue as unknown as { _scheduledNextIndex: number | null })._scheduledNextIndex;
  if (scheduledIdx !== null) {
    expect(
      scheduledIdx,
      `${label}: _scheduledNextIndex ${scheduledIdx} < 0`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      scheduledIdx,
      `${label}: _scheduledNextIndex ${scheduledIdx} >= trackCount ${trackCount}`,
    ).toBeLessThan(trackCount);
  }
}

// ---------------------------------------------------------------------------
// Execute a single random operation
// ---------------------------------------------------------------------------

let trackCounter = 0;

function executeOp(queue: Queue, op: OpName, rand: () => number): string {
  const tracks = (queue as unknown as { _tracks: unknown[] })._tracks;
  const trackCount = tracks.length;

  switch (op) {
    case 'next': {
      queue.next();
      return 'next()';
    }
    case 'previous': {
      queue.previous();
      return 'previous()';
    }
    case 'gotoTrack': {
      if (trackCount === 0) return 'gotoTrack(skip-empty)';
      const idx = Math.floor(rand() * trackCount);
      const playImm = rand() > 0.5;
      queue.gotoTrack(idx, playImm);
      return `gotoTrack(${idx}, ${playImm})`;
    }
    case 'addTrack': {
      trackCounter++;
      queue.addTrack(`fuzz-track-${trackCounter}.mp3`);
      return `addTrack(fuzz-track-${trackCounter}.mp3)`;
    }
    case 'removeTrack': {
      if (trackCount === 0) return 'removeTrack(skip-empty)';
      const idx = Math.floor(rand() * trackCount);
      queue.removeTrack(idx);
      return `removeTrack(${idx})`;
    }
    case 'play': {
      queue.play();
      return 'play()';
    }
    case 'pause': {
      queue.pause();
      return 'pause()';
    }
    case 'seek': {
      const time = rand() * 200;
      queue.seek(time);
      return `seek(${time.toFixed(1)})`;
    }
    case 'trackEnded': {
      if (trackCount === 0) return 'trackEnded(skip-empty)';
      const currentTrack = (queue as unknown as { _tracks: { index: number }[] })._tracks[
        queue.queueSnapshot.context.currentTrackIndex
      ];
      if (currentTrack) {
        queue.onTrackEnded(currentTrack as never);
        return `trackEnded(track=${currentTrack.index})`;
      }
      return 'trackEnded(skip-no-current)';
    }
    case 'togglePlayPause': {
      queue.togglePlayPause();
      return 'togglePlayPause()';
    }
    case 'setVolume': {
      const vol = rand();
      queue.setVolume(vol);
      return `setVolume(${vol.toFixed(2)})`;
    }
    case 'bigJump': {
      if (trackCount === 0) return 'bigJump(skip-empty)';
      // Jump to a random track far from current
      const cur = queue.queueSnapshot.context.currentTrackIndex;
      const offset = Math.floor(rand() * trackCount * 0.7) + Math.floor(trackCount * 0.3);
      const target = (cur + offset) % trackCount;
      const playImm = rand() > 0.3;
      queue.gotoTrack(target, playImm);
      return `bigJump(${cur}->${target}, play=${playImm})`;
    }
    case 'networkFail': {
      mockFetchFailure();
      return 'networkFail()';
    }
    case 'networkRestore': {
      mockFetchSuccess();
      return 'networkRestore()';
    }
  }
}

// ---------------------------------------------------------------------------
// Run a fuzz scenario
// ---------------------------------------------------------------------------

function runFuzzScenario(
  seed: number,
  initialTracks: number,
  numOps: number,
  weights: Weights,
): void {
  trackCounter = 0;
  const rand = mulberry32(seed);
  const urls = Array.from({ length: initialTracks }, (_, i) => `track-${i}.mp3`);
  const queue = new Queue({ tracks: urls, webAudioIsDisabled: true });

  try {
    checkInvariants(queue, 'initial', seed);

    for (let i = 0; i < numOps; i++) {
      const op = pickOp(rand, weights);
      const desc = executeOp(queue, op, rand);
      checkInvariants(queue, `op #${i}: ${desc}`, seed);
    }
  } finally {
    queue.destroy();
  }
}

// ---------------------------------------------------------------------------
// Test seeds
// ---------------------------------------------------------------------------

const SEEDS = [42, 1337, 99999, 314159, 271828];

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('Fuzz: navigation stress tests', () => {
  afterEach(() => {
    trackCounter = 0;
  });

  describe('A: Pure navigation (10 tracks, 500 ops)', () => {
    it.each(SEEDS)('seed %i', (seed) => {
      runFuzzScenario(seed, 10, 500, {
        next: 1,
        previous: 1,
        gotoTrack: 1,
      });
    });
  });

  describe('B: Nav + add/remove (5 tracks, 500 ops)', () => {
    it.each(SEEDS)('seed %i', (seed) => {
      runFuzzScenario(seed, 5, 500, {
        next: 2,
        previous: 2,
        gotoTrack: 2,
        addTrack: 1,
        removeTrack: 1,
      });
    });
  });

  describe('C: Full interleave (8 tracks, 1000 ops)', () => {
    it.each(SEEDS)('seed %i', (seed) => {
      runFuzzScenario(seed, 8, 1000, {
        next: 2,
        previous: 2,
        gotoTrack: 2,
        addTrack: 1,
        removeTrack: 1,
        play: 1,
        pause: 1,
        seek: 1,
        trackEnded: 1,
      });
    });
  });

  describe('D: Single track (1 track, 300 ops)', () => {
    it.each(SEEDS)('seed %i', (seed) => {
      runFuzzScenario(seed, 1, 300, {
        next: 1,
        previous: 1,
        gotoTrack: 1,
        play: 1,
        pause: 1,
        seek: 1,
        trackEnded: 1,
      });
    });
  });

  describe('E: Empty queue start (0 tracks, 300 ops)', () => {
    it.each(SEEDS)('seed %i', (seed) => {
      runFuzzScenario(seed, 0, 300, {
        next: 1,
        previous: 1,
        gotoTrack: 1,
        addTrack: 2,
        removeTrack: 1,
        play: 1,
        pause: 1,
        seek: 1,
        trackEnded: 1,
      });
    });
  });

  describe('F: Rapid back-and-forth (3 tracks, 500 ops)', () => {
    it.each(SEEDS)('seed %i', (seed) => {
      runFuzzScenario(seed, 3, 500, {
        next: 9,
        previous: 9,
        gotoTrack: 1,
        play: 1,
      });
    });
  });

  describe('G: Remove-heavy (20 tracks, 500 ops)', () => {
    it.each(SEEDS)('seed %i', (seed) => {
      runFuzzScenario(seed, 20, 500, {
        next: 1,
        previous: 1,
        gotoTrack: 1,
        addTrack: 1,
        removeTrack: 5,
        play: 1,
      });
    });
  });

  describe('H: Wide traversal (15 tracks, 800 ops)', () => {
    it.each(SEEDS)('seed %i', (seed) => {
      runFuzzScenario(seed, 15, 800, {
        next: 3,
        previous: 3,
        bigJump: 4,
        seek: 3,
        play: 1,
        pause: 1,
        togglePlayPause: 1,
        trackEnded: 1,
      });
    });
  });

  describe('I: Network chaos (15 tracks, 600 ops)', () => {
    it.each(SEEDS)('seed %i', (seed) => {
      runFuzzScenario(seed, 15, 600, {
        next: 2,
        previous: 2,
        gotoTrack: 2,
        bigJump: 1,
        addTrack: 1,
        removeTrack: 1,
        play: 2,
        pause: 1,
        trackEnded: 1,
        networkFail: 2,
        networkRestore: 2,
      });
    });
  });

  describe('J: Seek-heavy (15 tracks, 800 ops)', () => {
    it.each(SEEDS)('seed %i', (seed) => {
      runFuzzScenario(seed, 15, 800, {
        seek: 6,
        next: 2,
        previous: 2,
        bigJump: 2,
        play: 1,
        pause: 1,
        togglePlayPause: 1,
        trackEnded: 1,
      });
    });
  });

  describe('K: Kitchen sink (15 tracks, 1500 ops)', () => {
    it.each(SEEDS)('seed %i', (seed) => {
      runFuzzScenario(seed, 15, 1500, {
        next: 3,
        previous: 3,
        gotoTrack: 2,
        bigJump: 2,
        addTrack: 1,
        removeTrack: 1,
        play: 2,
        pause: 2,
        togglePlayPause: 1,
        seek: 3,
        setVolume: 1,
        trackEnded: 2,
        networkFail: 1,
        networkRestore: 1,
      });
    });
  });

  describe('L: Rapid oscillation across 15 tracks (15 tracks, 1000 ops)', () => {
    it.each(SEEDS)('seed %i', (seed) => {
      runFuzzScenario(seed, 15, 1000, {
        next: 5,
        previous: 5,
        bigJump: 3,
        togglePlayPause: 2,
        seek: 2,
        trackEnded: 1,
      });
    });
  });

  describe('M: Add-during-traversal (5 tracks, 800 ops)', () => {
    it.each(SEEDS)('seed %i', (seed) => {
      runFuzzScenario(seed, 5, 800, {
        next: 3,
        previous: 3,
        bigJump: 2,
        addTrack: 3,
        removeTrack: 1,
        play: 1,
        pause: 1,
        seek: 2,
        networkFail: 1,
        networkRestore: 1,
        trackEnded: 1,
      });
    });
  });

  describe('N: Network flapping with volume (15 tracks, 600 ops)', () => {
    it.each(SEEDS)('seed %i', (seed) => {
      runFuzzScenario(seed, 15, 600, {
        play: 2,
        pause: 1,
        togglePlayPause: 2,
        setVolume: 3,
        seek: 2,
        bigJump: 2,
        networkFail: 3,
        networkRestore: 3,
        trackEnded: 1,
        next: 1,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Targeted regression tests for specific bugs
// ---------------------------------------------------------------------------

/** Helper to access private _tracks array */
function getTracks(queue: Queue): Track[] {
  return (queue as unknown as { _tracks: Track[] })._tracks;
}

/** Helper to access private _scheduledNextIndex */
function getScheduledNextIndex(queue: Queue): number | null {
  return (queue as unknown as { _scheduledNextIndex: number | null })._scheduledNextIndex;
}

describe('Bug regressions', () => {
  // Bug #1: decrementTrackCount didn't clamp currentTrackIndex when removing
  // the current track or a track after it, leaving the index out of bounds.
  describe('removeTrack clamps currentTrackIndex', () => {
    it('removing the last track when it is current clamps index', () => {
      const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'], webAudioIsDisabled: true });
      // Navigate to last track
      q.gotoTrack(2, true);
      expect(q.queueSnapshot.context.currentTrackIndex).toBe(2);

      // Remove the last track (which is current)
      q.removeTrack(2);
      const snap = q.queueSnapshot;
      expect(snap.context.trackCount).toBe(2);
      expect(snap.context.currentTrackIndex).toBeLessThan(2);
      expect(snap.context.currentTrackIndex).toBeGreaterThanOrEqual(0);
      q.destroy();
    });

    it('removing the only track leaves index at 0', () => {
      const q = new Queue({ tracks: ['a.mp3'], webAudioIsDisabled: true });
      q.removeTrack(0);
      const snap = q.queueSnapshot;
      expect(snap.context.trackCount).toBe(0);
      expect(snap.context.currentTrackIndex).toBe(0);
      q.destroy();
    });

    it('removing a track after current does not push index out of bounds', () => {
      const q = new Queue({ tracks: ['a.mp3', 'b.mp3'], webAudioIsDisabled: true });
      q.gotoTrack(1, true);
      expect(q.queueSnapshot.context.currentTrackIndex).toBe(1);

      // Remove track 1 (the current/last track)
      q.removeTrack(1);
      expect(q.queueSnapshot.context.currentTrackIndex).toBe(0);
      expect(q.queueSnapshot.context.trackCount).toBe(1);
      q.destroy();
    });

    it('successive removals of last track keep index in bounds', () => {
      const q = new Queue({
        tracks: ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3'],
        webAudioIsDisabled: true,
      });
      q.gotoTrack(3, true);

      for (let i = 3; i >= 0; i--) {
        const snap = q.queueSnapshot;
        if (snap.context.trackCount > 0) {
          const idx = snap.context.currentTrackIndex;
          expect(idx).toBeLessThan(snap.context.trackCount);
          q.removeTrack(idx);
        }
      }
      expect(q.queueSnapshot.context.trackCount).toBe(0);
      expect(q.queueSnapshot.context.currentTrackIndex).toBe(0);
      q.destroy();
    });
  });

  // Bug #3: onTrackEnded used index comparison instead of object identity,
  // so after removeTrack a different track at the same index could trigger
  // an incorrect advance.
  describe('onTrackEnded uses object identity', () => {
    it('does not advance when a removed track fires onTrackEnded', () => {
      const q = new Queue({
        tracks: ['a.mp3', 'b.mp3', 'c.mp3'],
        webAudioIsDisabled: true,
      });
      q.play();

      // Grab reference to track at index 0
      const trackA = getTracks(q)[0];
      expect(trackA.index).toBe(0);

      // Navigate to track 1, then remove track 0
      q.gotoTrack(1, true);
      q.removeTrack(0);
      // Now _tracks = [B, C], currentTrackIndex = 0 (B)
      const trackB = getTracks(q)[0];
      expect(trackB).not.toBe(trackA);

      const snapBefore = q.queueSnapshot;
      // Simulate old trackA firing onTrackEnded — should be ignored
      q.onTrackEnded(trackA as never);
      const snapAfter = q.queueSnapshot;

      expect(snapAfter.context.currentTrackIndex).toBe(snapBefore.context.currentTrackIndex);
      q.destroy();
    });
  });

  // Bug #5: advanceOnTrackEnd unconditionally incremented without bounds.
  describe('advanceOnTrackEnd stays in bounds', () => {
    it('TRACK_ENDED on last track transitions to ended state', () => {
      const q = new Queue({ tracks: ['a.mp3', 'b.mp3'], webAudioIsDisabled: true });
      q.gotoTrack(1, true);
      expect(q.queueSnapshot.state).toBe('playing');

      // Simulate track ending
      const lastTrack = getTracks(q)[1];
      q.onTrackEnded(lastTrack as never);

      const snap = q.queueSnapshot;
      expect(snap.state).toBe('ended');
      // Index should not exceed trackCount - 1
      expect(snap.context.currentTrackIndex).toBeLessThan(snap.context.trackCount);
      q.destroy();
    });

    it('TRACK_ENDED on middle track advances to next', () => {
      const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'], webAudioIsDisabled: true });
      q.gotoTrack(0, true);
      expect(q.queueSnapshot.state).toBe('playing');

      const firstTrack = getTracks(q)[0];
      q.onTrackEnded(firstTrack as never);

      const snap = q.queueSnapshot;
      expect(snap.state).toBe('playing');
      expect(snap.context.currentTrackIndex).toBe(1);
      q.destroy();
    });
  });

  // Bug #7: _scheduledNextIndex was not adjusted when a track before it
  // was removed, causing gapless scheduling to target the wrong track.
  describe('_scheduledNextIndex adjusts on removal', () => {
    it('decrements when a track before it is removed', () => {
      const q = new Queue({
        tracks: ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3'],
        webAudioIsDisabled: true,
      });

      // Manually set _scheduledNextIndex to 3 (track D)
      (q as unknown as { _scheduledNextIndex: number | null })._scheduledNextIndex = 3;

      // Remove track 0 — indices shift, so track D moves to index 2
      q.removeTrack(0);
      expect(getScheduledNextIndex(q)).toBe(2);
      q.destroy();
    });

    it('nulls out when the scheduled track is removed', () => {
      const q = new Queue({
        tracks: ['a.mp3', 'b.mp3', 'c.mp3'],
        webAudioIsDisabled: true,
      });
      (q as unknown as { _scheduledNextIndex: number | null })._scheduledNextIndex = 1;

      q.removeTrack(1);
      expect(getScheduledNextIndex(q)).toBeNull();
      q.destroy();
    });

    it('stays unchanged when a track after it is removed', () => {
      const q = new Queue({
        tracks: ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3'],
        webAudioIsDisabled: true,
      });
      (q as unknown as { _scheduledNextIndex: number | null })._scheduledNextIndex = 1;

      // Remove track 3 — doesn't affect index 1
      q.removeTrack(3);
      expect(getScheduledNextIndex(q)).toBe(1);
      q.destroy();
    });
  });

  // Bug #9: Removing all tracks while playing/paused left machine in
  // playing/paused state with 0 tracks instead of transitioning to idle.
  describe('removing all tracks transitions to idle', () => {
    it('playing → idle when last track removed', () => {
      const q = new Queue({ tracks: ['a.mp3'], webAudioIsDisabled: true });
      q.play();
      expect(q.queueSnapshot.state).toBe('playing');

      q.removeTrack(0);
      expect(q.queueSnapshot.state).toBe('idle');
      expect(q.queueSnapshot.context.trackCount).toBe(0);
      q.destroy();
    });

    it('paused → idle when last track removed', () => {
      const q = new Queue({ tracks: ['a.mp3'], webAudioIsDisabled: true });
      q.play();
      q.pause();
      expect(q.queueSnapshot.state).toBe('paused');

      q.removeTrack(0);
      expect(q.queueSnapshot.state).toBe('idle');
      expect(q.queueSnapshot.context.trackCount).toBe(0);
      q.destroy();
    });

    it('playing with 3 tracks → idle after removing all', () => {
      const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'], webAudioIsDisabled: true });
      q.play();
      expect(q.queueSnapshot.state).toBe('playing');

      q.removeTrack(0);
      expect(q.queueSnapshot.state).toBe('playing');
      q.removeTrack(0);
      expect(q.queueSnapshot.state).toBe('playing');
      q.removeTrack(0);
      expect(q.queueSnapshot.state).toBe('idle');
      q.destroy();
    });

    it('removing current track while playing continues with next', () => {
      const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'], webAudioIsDisabled: true });
      q.gotoTrack(1, true);
      expect(q.queueSnapshot.state).toBe('playing');
      expect(q.queueSnapshot.context.currentTrackIndex).toBe(1);

      // Remove current track — should continue playing the replacement
      q.removeTrack(1);
      expect(q.queueSnapshot.state).toBe('playing');
      expect(q.queueSnapshot.context.trackCount).toBe(2);
      expect(q.queueSnapshot.context.currentTrackIndex).toBeLessThan(2);
      q.destroy();
    });
  });

  // Bug #10: Adding tracks in "ended" state left the queue stuck — it stayed
  // in ended even though there were now playable tracks after currentTrackIndex.
  describe('addTrack in ended state transitions to paused', () => {
    it('ended → paused when track added', () => {
      const q = new Queue({ tracks: ['a.mp3'], webAudioIsDisabled: true });
      q.play();
      const track = getTracks(q)[0];
      q.onTrackEnded(track as never);
      expect(q.queueSnapshot.state).toBe('ended');

      q.addTrack('b.mp3');
      expect(q.queueSnapshot.state).toBe('paused');
      expect(q.queueSnapshot.context.trackCount).toBe(2);
      q.destroy();
    });

    it('can play after adding track to ended queue', () => {
      const q = new Queue({ tracks: ['a.mp3'], webAudioIsDisabled: true });
      q.play();
      const track = getTracks(q)[0];
      q.onTrackEnded(track as never);
      expect(q.queueSnapshot.state).toBe('ended');

      q.addTrack('b.mp3');
      q.play();
      expect(q.queueSnapshot.state).toBe('playing');
      q.destroy();
    });

    it('multiple adds in ended state all succeed', () => {
      const q = new Queue({ tracks: ['a.mp3'], webAudioIsDisabled: true });
      q.play();
      const track = getTracks(q)[0];
      q.onTrackEnded(track as never);

      q.addTrack('b.mp3');
      q.addTrack('c.mp3');
      q.addTrack('d.mp3');
      expect(q.queueSnapshot.state).toBe('paused');
      expect(q.queueSnapshot.context.trackCount).toBe(4);
      q.destroy();
    });
  });
});
