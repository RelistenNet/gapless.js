// ---------------------------------------------------------------------------
// Clipped tracks: play [start, end) of a file. Times the API reports are
// clip-relative; the element and buffer are addressed in file time.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import { Queue } from '../../src/Queue';
import { Track } from '../../src/Track';
import type { TrackQueueRef } from '../../src/Track';
import {
  advanceTime,
  mockFetchSuccess,
  MockAudioBuffer,
  MockAudioElement,
  type MockAudioBufferSourceNode,
} from '../setup';

function makeQueue(overrides: Partial<TrackQueueRef> = {}): TrackQueueRef {
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
    ...overrides,
  };
}

const flush = async (n = 15) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Source nodes this track started (the mock context is shared by all tracks). */
function startedSources(track: Track): MockAudioBufferSourceNode[] {
  const create = (track as any).ctx.createBufferSource as ReturnType<typeof vi.fn>;
  return create.mock.results
    .map((r) => r.value as MockAudioBufferSourceNode)
    .filter((s) => s.buffer === track.audioBuffer && s.start.mock.calls.length > 0);
}

// happy-dom has no HTMLMediaElement.HAVE_METADATA, so Track always defers an
// element seek to 'loadedmetadata'; fire it after the call that seeks.
const loadMetadata = (t: Track) =>
  (t.audio as unknown as MockAudioElement).simulateLoadedMetadata(180);

describe('clip duration', () => {
  it('is end - start, known before anything loads', () => {
    const t = new Track({ trackUrl: 'a.mp3', queue: makeQueue(), start: 30, end: 75 });
    expect(t.duration).toBe(45);
  });

  it('with only a start, is file duration - start once known', () => {
    const t = new Track({ trackUrl: 'a.mp3', queue: makeQueue(), start: 30 });
    expect(t.duration).toBeNaN();
    t.audioBuffer = new MockAudioBuffer(180) as unknown as AudioBuffer;
    expect(t.duration).toBe(150);
  });

  it('an end past the file is cut to the file', () => {
    const t = new Track({ trackUrl: 'a.mp3', queue: makeQueue(), start: 170, end: 500 });
    t.audioBuffer = new MockAudioBuffer(180) as unknown as AudioBuffer;
    expect(t.duration).toBe(10);
  });
});

describe('clip on Web Audio', () => {
  it('starts the source at clipStart and stops it at clipEnd', () => {
    const t = new Track({ trackUrl: 'a.mp3', queue: makeQueue(), start: 30, end: 75 });
    t.audioBuffer = new MockAudioBuffer(180) as unknown as AudioBuffer;
    t.play();
    const [src] = startedSources(t);
    const [when, offset] = src.start.mock.calls[0] as [number, number];
    expect(offset).toBeCloseTo(30, 1);
    const [stopAt] = src.stop.mock.calls[0] as unknown as [number];
    // Stops 45 s of music after it starts (less the lead already consumed).
    expect(stopAt - when).toBeCloseTo(45, 1);
    expect(t.playbackEndContextTime! - when).toBeCloseTo(45, 1);
  });

  it('reports clip-relative currentTime and seeks in clip time', () => {
    const t = new Track({ trackUrl: 'a.mp3', queue: makeQueue(), start: 30, end: 75 });
    t.audioBuffer = new MockAudioBuffer(180) as unknown as AudioBuffer;
    t.play();
    advanceTime(10);
    expect(t.currentTime).toBeCloseTo(10, 1);

    t.seek(20);
    const sources = startedSources(t);
    const [, offset] = sources[sources.length - 1].start.mock.calls[0];
    expect(offset).toBeCloseTo(50, 1);

    t.seek(999);
    expect(t.seekTarget).toBe(45); // clamped to the clip
  });
});

describe('clip on HTML5', () => {
  it('seeks the element to clipStart on play and reports relative time', () => {
    const t = new Track({ trackUrl: 'a.mp3', queue: makeQueue(), start: 30, end: 75 });
    const el = t.audio as unknown as MockAudioElement;
    t.play();
    loadMetadata(t);
    expect(el.currentTime).toBe(30);
    el.currentTime = 42;
    expect(t.currentTime).toBeCloseTo(12, 5);
  });

  it('seeks the element in file time', () => {
    const t = new Track({ trackUrl: 'a.mp3', queue: makeQueue(), start: 30, end: 75 });
    const el = t.audio as unknown as MockAudioElement;
    t.play();
    loadMetadata(t);
    t.seek(10);
    loadMetadata(t);
    expect(el.currentTime).toBe(40);
  });

  it('ends the track when the element reaches clipEnd', async () => {
    const queue = makeQueue();
    const t = new Track({ trackUrl: 'a.mp3', queue, start: 30, end: 75 });
    const el = t.audio as unknown as MockAudioElement;
    el.simulateLoadedMetadata(180);
    t.play();
    expect(t.machineState).toBe('html5');

    el.currentTime = 74.9;
    (el as any).ontimeupdate();
    expect(t.machineState).toBe('html5');

    el.currentTime = 75.02;
    (el as any).ontimeupdate();
    await flush(1);
    expect(el.pause).toHaveBeenCalled();
    expect(t.machineState).toBe('idle');
    expect(queue.onTrackEnded).toHaveBeenCalledWith(t);
  });

  it('hands off to Web Audio at the clip-relative position', async () => {
    mockFetchSuccess();
    const q = new Queue();
    q.addTrack('a.mp3', { start: 30, end: 75 });
    q.play();
    const t = (q as any)._tracks[0] as Track;
    (t.audio as unknown as MockAudioElement).currentTime = 34;
    await flush();

    expect(t.playbackType).toBe('WEBAUDIO');
    const [, offset] = startedSources(t)[0].start.mock.calls[0];
    expect(offset).toBeCloseTo(34, 1);
    expect(offset).toBeGreaterThanOrEqual(34);
    expect(t.currentTime).toBeCloseTo(4, 1);
  });
});

describe('clips in the queue', () => {
  it('schedules the next clip gaplessly at the current clip end', async () => {
    mockFetchSuccess();
    const q = new Queue({ preloadNumTracks: 1 });
    q.setEntries([
      { key: 'a', url: 'set.mp3', start: 30, end: 75 },
      { key: 'b', url: 'set.mp3', start: 120, end: 150 },
    ]);
    q.play();
    await flush();
    const [a, b] = (q as any)._tracks as Track[];
    expect(a.playbackType).toBe('WEBAUDIO');

    // b decoded and was scheduled at a's end; seeking reschedules it.
    q.seek(42); // 3 s before the clip end
    await flush();

    const endAt = a.playbackEndContextTime!;
    expect(endAt).toBeCloseTo(3, 1);
    expect(b.scheduledStartContextTime).toBeCloseTo(endAt, 5);
    const sources = startedSources(b);
    const [when, offset] = sources[sources.length - 1].start.mock.calls[0];
    expect(when).toBeCloseTo(endAt, 5);
    expect(offset).toBe(120);
  });

  it('snapshot keeps start and end, and restore brings them back', () => {
    const q = new Queue();
    q.setEntries([
      { key: 'a', url: 'set.mp3', start: 30, end: 75 },
      { key: 'b', url: 'set.mp3', start: 120 },
      { key: 'c', url: 'other.mp3' },
    ]);
    const snap = q.snapshot();
    expect(snap.entries).toEqual([
      { key: 'a', url: 'set.mp3', metadata: {}, start: 30, end: 75 },
      { key: 'b', url: 'set.mp3', metadata: {}, start: 120 },
      { key: 'c', url: 'other.mp3', metadata: {} },
    ]);

    const q2 = new Queue();
    q2.restore(snap);
    const [a, b] = (q2 as any)._tracks as Track[];
    expect([a.clipStart, a.clipEnd, b.clipStart, b.clipEnd]).toEqual([30, 75, 120, null]);
  });

  it('rejects a bad range without changing the queue', () => {
    const q = new Queue();
    q.setEntries([{ key: 'a', url: 'a.mp3' }]);
    expect(() => q.addTrack('b.mp3', { start: 10, end: 10 })).toThrow(/clip end/);
    expect(() => q.insert([{ key: 'b', url: 'b.mp3', start: -1 }])).toThrow(/clip start/);
    expect(() =>
      q.setEntries([
        { key: 'x', url: 'x.mp3' },
        { key: 'y', url: 'y.mp3', start: 5, end: 2 },
      ])
    ).toThrow(/clip end/);
    expect(q.snapshot().entries.map((e) => e.key)).toEqual(['a']);
  });
});
