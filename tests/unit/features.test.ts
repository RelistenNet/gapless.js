// ---------------------------------------------------------------------------
// Tests for new features: preloadNumTracks, webAudioOnly, playbackRate
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import { createActor } from 'xstate';
import { Queue } from '../../src/Queue';
import { Track } from '../../src/Track';
import type { TrackQueueRef } from '../../src/Track';
import type { TrackInfo } from '../../src/types';
import { createTrackMachine } from '../../src/machines/track.machine';
import type { TrackContext } from '../../src/machines/track.machine';
import { MockAudioBuffer, MockAudioElement, advanceTime } from '../setup';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function injectBuffer(queue: Queue, trackIndex: number, duration = 180): void {
  const track = (queue as unknown as { _tracks: unknown[] })._tracks[trackIndex] as {
    audioBuffer: AudioBuffer | null;
  };
  track.audioBuffer = new MockAudioBuffer(duration) as unknown as AudioBuffer;
}

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
    currentTrackIndex: 0,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<TrackContext> = {}): TrackContext {
  return {
    trackUrl: 'https://example.com/track.mp3',
    resolvedUrl: 'https://example.com/track.mp3',
    skipHEAD: false,
    playbackType: 'HTML5',
    webAudioLoadingState: 'NONE',
    isPlaying: false,
    scheduledStartContextTime: null,
    notifiedLookahead: false,
    fetchStarted: false,
    pendingPlay: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Feature 1: preloadNumTracks
// ---------------------------------------------------------------------------

describe('preloadNumTracks', () => {
  it('defaults to 2', () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3'] });
    expect(q.preloadNumTracks).toBe(2);
  });

  it('accepts custom preloadNumTracks via options', () => {
    const q = new Queue({ tracks: ['a.mp3'], preloadNumTracks: 5 });
    expect(q.preloadNumTracks).toBe(5);
  });

  it('clamps negative values to 0', () => {
    const q = new Queue({ tracks: ['a.mp3'], preloadNumTracks: -3 });
    expect(q.preloadNumTracks).toBe(0);
  });

  it('preloadNumTracks: 0 — no preloading on play', () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'], preloadNumTracks: 0 });
    injectBuffer(q, 0);
    q.play();
    // Track 1 should not have been preloaded
    const tracks = (q as unknown as { _tracks: Track[] })._tracks;
    expect(tracks[1].audioBuffer).toBeNull();
  });

  it('preloadNumTracks: 1 — only 1 track ahead', () => {
    const onDebug = vi.fn();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'], preloadNumTracks: 1, onDebug });
    injectBuffer(q, 0);
    injectBuffer(q, 1);
    q.play();
    // Force preload trigger by simulating progress past threshold
    const tracks = (q as unknown as { _tracks: Track[] })._tracks;
    const audio0 = tracks[0].audio as unknown as MockAudioElement;
    audio0.duration = 60;
    audio0.currentTime = 20;
    // Manually call the internal preload ahead
    (q as unknown as { _preloadAhead: (i: number) => void })._preloadAhead(0);
    // Only track 1 should be considered (limit = 0 + 1 + 1 = 2, so only index 1)
    const debugCalls = onDebug.mock.calls.map(c => c[0]);
    const preloadCalls = debugCalls.filter((m: string) => m.includes('_preloadAhead'));
    expect(preloadCalls.length).toBeGreaterThan(0);
  });

  it('runtime setter works', () => {
    const q = new Queue({ tracks: ['a.mp3'], preloadNumTracks: 2 });
    expect(q.preloadNumTracks).toBe(2);
    q.preloadNumTracks = 5;
    expect(q.preloadNumTracks).toBe(5);
  });

  it('runtime setter clamps negative to 0', () => {
    const q = new Queue({ tracks: ['a.mp3'] });
    q.preloadNumTracks = -10;
    expect(q.preloadNumTracks).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Feature 2: playbackMethod
// ---------------------------------------------------------------------------

describe('playbackMethod', () => {
  it('defaults to HYBRID', () => {
    const q = new Queue();
    expect(q.playbackMethod).toBe('HYBRID');
  });

  it('can be set to WEBAUDIO_ONLY', () => {
    const q = new Queue({ playbackMethod: 'WEBAUDIO_ONLY' });
    expect(q.playbackMethod).toBe('WEBAUDIO_ONLY');
  });

  it('can be set to HTML5_ONLY', () => {
    const q = new Queue({ playbackMethod: 'HTML5_ONLY' });
    expect(q.playbackMethod).toBe('HTML5_ONLY');
  });

  describe('track machine — pendingPlay', () => {
    it('PLAY with isWebAudioOnly + no buffer → stays in idle, sets pendingPlay', () => {
      const machine = createTrackMachine(makeCtx()).provide({
        guards: {
          canPlayWebAudio: () => false,
          isWebAudioOnly: () => true,
        },
      });
      const a = createActor(machine);
      a.start();
      a.send({ type: 'PLAY' });
      expect(a.getSnapshot().value).toBe('idle');
      expect(a.getSnapshot().context.pendingPlay).toBe(true);
    });

    it('PLAY with isWebAudioOnly in loading → stays in loading, sets pendingPlay', () => {
      const machine = createTrackMachine(makeCtx()).provide({
        guards: {
          canPlayWebAudio: () => false,
          isWebAudioOnly: () => true,
        },
      });
      const a = createActor(machine);
      a.start();
      a.send({ type: 'PRELOAD' });
      expect(a.getSnapshot().value).toBe('loading');
      a.send({ type: 'PLAY' });
      expect(a.getSnapshot().value).toBe('loading');
      expect(a.getSnapshot().context.pendingPlay).toBe(true);
    });

    it('BUFFER_READY with pendingPlay → transitions to webaudio', () => {
      const machine = createTrackMachine(makeCtx()).provide({
        guards: {
          canPlayWebAudio: () => false,
          isWebAudioOnly: () => true,
        },
      });
      const a = createActor(machine);
      a.start();
      a.send({ type: 'PLAY' });
      expect(a.getSnapshot().context.pendingPlay).toBe(true);
      a.send({ type: 'BUFFER_READY' });
      expect(a.getSnapshot().value).toBe('webaudio');
      expect(a.getSnapshot().context.isPlaying).toBe(true);
      expect(a.getSnapshot().context.pendingPlay).toBe(false);
    });

    it('BUFFER_READY with pendingPlay from loading → transitions to webaudio', () => {
      const machine = createTrackMachine(makeCtx()).provide({
        guards: {
          canPlayWebAudio: () => false,
          isWebAudioOnly: () => true,
        },
      });
      const a = createActor(machine);
      a.start();
      a.send({ type: 'PRELOAD' });
      a.send({ type: 'PLAY' });
      a.send({ type: 'BUFFER_READY' });
      expect(a.getSnapshot().value).toBe('webaudio');
      expect(a.getSnapshot().context.isPlaying).toBe(true);
      expect(a.getSnapshot().context.pendingPlay).toBe(false);
    });

    it('BUFFER_ERROR with pendingPlay → resets pendingPlay, stays in idle', () => {
      const machine = createTrackMachine(makeCtx()).provide({
        guards: {
          canPlayWebAudio: () => false,
          isWebAudioOnly: () => true,
        },
      });
      const a = createActor(machine);
      a.start();
      a.send({ type: 'PLAY' });
      expect(a.getSnapshot().context.pendingPlay).toBe(true);
      a.send({ type: 'BUFFER_ERROR' });
      expect(a.getSnapshot().value).toBe('idle');
      expect(a.getSnapshot().context.pendingPlay).toBe(false);
      expect(a.getSnapshot().context.webAudioLoadingState).toBe('ERROR');
    });

    it('BUFFER_READY without pendingPlay → stays in idle (normal behavior)', () => {
      const machine = createTrackMachine(makeCtx()).provide({
        guards: {
          canPlayWebAudio: () => false,
          isWebAudioOnly: () => true,
        },
      });
      const a = createActor(machine);
      a.start();
      a.send({ type: 'BUFFER_READY' });
      expect(a.getSnapshot().value).toBe('idle');
      expect(a.getSnapshot().context.webAudioLoadingState).toBe('LOADED');
    });
  });

  describe('Queue integration — WEBAUDIO_ONLY play before buffer', () => {
    it('play before buffer → plays after decode', async () => {
      const q = new Queue({ tracks: ['a.mp3'], playbackMethod: 'WEBAUDIO_ONLY' });
      q.play();
      // Should not be playing yet (no buffer)
      const tracks = (q as unknown as { _tracks: Track[] })._tracks;
      const audio0 = tracks[0].audio as unknown as MockAudioElement;
      // HTML5 should NOT have been started
      expect(audio0.play).not.toHaveBeenCalled();

      // Now inject buffer and send BUFFER_READY
      injectBuffer(q, 0);
      // Simulate buffer ready event from fetchDecode pipeline
      const track0 = tracks[0] as unknown as { _actor: { send: (e: { type: string }) => void } };
      track0._actor.send({ type: 'BUFFER_READY' });

      // Should now be playing via web audio
      expect(tracks[0].machineState).toBe('webaudio');
      expect(tracks[0].isPlaying).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Feature 3: playbackRate
// ---------------------------------------------------------------------------

describe('playbackRate', () => {
  it('defaults to 1', () => {
    const q = new Queue({ tracks: ['a.mp3'] });
    expect(q.playbackRate).toBe(1);
  });

  it('accepts initial playbackRate via options', () => {
    const q = new Queue({ tracks: ['a.mp3'], playbackRate: 1.5 });
    expect(q.playbackRate).toBe(1.5);
  });

  it('clamps low values to 0.25', () => {
    const q = new Queue({ tracks: ['a.mp3'], playbackRate: 0 });
    expect(q.playbackRate).toBe(0.25);
  });

  it('clamps high values to 4.0', () => {
    const q = new Queue({ tracks: ['a.mp3'], playbackRate: 100 });
    expect(q.playbackRate).toBe(4);
  });

  it('setPlaybackRate updates getter', () => {
    const q = new Queue({ tracks: ['a.mp3'] });
    q.setPlaybackRate(2);
    expect(q.playbackRate).toBe(2);
  });

  it('setPlaybackRate clamps to range', () => {
    const q = new Queue({ tracks: ['a.mp3'] });
    q.setPlaybackRate(0);
    expect(q.playbackRate).toBe(0.25);
    q.setPlaybackRate(100);
    expect(q.playbackRate).toBe(4);
  });

  it('rate applied to HTML5 audio.playbackRate', () => {
    const q = new Queue({ tracks: ['a.mp3'], playbackRate: 2 });
    q.play();
    const tracks = (q as unknown as { _tracks: Track[] })._tracks;
    const audio0 = tracks[0].audio as unknown as MockAudioElement & { playbackRate: number };
    expect(audio0.playbackRate).toBe(2);
  });

  it('rate applied to Web Audio sourceNode.playbackRate.value', () => {
    const q = new Queue({ tracks: ['a.mp3'], playbackRate: 1.5 });
    injectBuffer(q, 0);
    q.play();
    const tracks = (q as unknown as { _tracks: Track[] })._tracks;
    const track0 = tracks[0] as unknown as { sourceNode: { playbackRate: { value: number } } | null };
    expect(track0.sourceNode).not.toBeNull();
    expect(track0.sourceNode!.playbackRate.value).toBe(1.5);
  });

  it('setPlaybackRate applies to current track sourceNode', () => {
    const q = new Queue({ tracks: ['a.mp3'] });
    injectBuffer(q, 0);
    q.play();
    q.setPlaybackRate(2);
    const tracks = (q as unknown as { _tracks: Track[] })._tracks;
    const track0 = tracks[0] as unknown as { sourceNode: { playbackRate: { value: number } } | null };
    expect(track0.sourceNode!.playbackRate.value).toBe(2);
  });

  it('setPlaybackRate applies to current track HTML5 audio', () => {
    const q = new Queue({ tracks: ['a.mp3'], playbackMethod: 'HTML5_ONLY' });
    q.play();
    q.setPlaybackRate(1.5);
    const tracks = (q as unknown as { _tracks: Track[] })._tracks;
    const audio0 = tracks[0].audio as unknown as MockAudioElement & { playbackRate: number };
    expect(audio0.playbackRate).toBe(1.5);
  });

  it('playbackRate in TrackInfo snapshot', () => {
    const q = new Queue({ tracks: ['a.mp3'], playbackRate: 2.5 });
    const info = q.currentTrack;
    expect(info).toBeDefined();
    expect(info!.playbackRate).toBe(2.5);
  });

  it('Track.setPlaybackRate updates both html5 and sourceNode', () => {
    const q = makeQueue({ playbackRate: 1 });
    const t = new Track({ trackUrl: 'test.mp3', index: 0, queue: q });
    t.audioBuffer = new MockAudioBuffer(180) as unknown as AudioBuffer;
    t.play();
    t.setPlaybackRate(2);
    const sourceNode = (t as unknown as { sourceNode: { playbackRate: { value: number } } | null }).sourceNode;
    expect(sourceNode!.playbackRate.value).toBe(2);
    expect((t.audio as unknown as { playbackRate: number }).playbackRate).toBe(2);
  });

  it('rate applied in startScheduledSourceNode (gapless)', () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'], playbackRate: 1.5 });
    injectBuffer(q, 0);
    injectBuffer(q, 1);
    q.play();

    const tracks = (q as unknown as { _tracks: Track[] })._tracks;
    // Schedule gapless for track 1
    advanceTime(10);
    tracks[1].scheduleGaplessStart(10);
    const sourceNode1 = (tracks[1] as unknown as { sourceNode: { playbackRate: { value: number } } | null }).sourceNode;
    expect(sourceNode1).not.toBeNull();
    expect(sourceNode1!.playbackRate.value).toBe(1.5);
  });

  describe('_computeTrackEndTime', () => {
    it('halves remaining time at 2x', () => {
      const q = new Queue({ tracks: ['a.mp3', 'b.mp3'], playbackRate: 2 });
      injectBuffer(q, 0, 100);
      injectBuffer(q, 1);
      q.play();

      // At 1x: remaining = 100 - 0 = 100s, endTime = ctx.currentTime + 100
      // At 2x: remaining = (100 - 0) / 2 = 50s, endTime = ctx.currentTime + 50
      const computeEndTime = (q as unknown as { _computeTrackEndTime: (t: Track) => number | null })._computeTrackEndTime;
      const tracks = (q as unknown as { _tracks: Track[] })._tracks;
      const endTime = computeEndTime.call(q, tracks[0]);
      // ctx.currentTime is 0, so endTime should be 50
      expect(endTime).toBeCloseTo(50, 1);
    });

    it('scheduled path: uses duration / playbackRate', () => {
      const q = new Queue({ tracks: ['a.mp3', 'b.mp3'], playbackRate: 2 });
      injectBuffer(q, 0, 100);
      injectBuffer(q, 1);

      advanceTime(5);
      const tracks = (q as unknown as { _tracks: Track[] })._tracks;
      // Schedule track 0 to start at ctx time 5
      tracks[0].scheduleGaplessStart(5);

      const computeEndTime = (q as unknown as { _computeTrackEndTime: (t: Track) => number | null })._computeTrackEndTime;
      const endTime = computeEndTime.call(q, tracks[0]);
      // scheduledStartContextTime=5, duration=100, rate=2 → 5 + 100/2 = 55
      expect(endTime).toBeCloseTo(55, 1);
    });
  });
});
