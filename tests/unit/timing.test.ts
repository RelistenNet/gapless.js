// ---------------------------------------------------------------------------
// Timing math tests
//
// Verifies the currentTime formula:
//   Playing:  _waRefTrackTime + (ctx.currentTime - _waRefCtxTime) * playbackRate
//   Paused:   pausedAtTrackTime  (frozen)
//
// These tests exercise the Track class's time-tracking logic directly,
// using the controllable mock clock from setup.ts.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import { advanceTime, MockAudioContext, MockAudioElement, MockAudioBuffer } from '../setup';
import { Track } from '../../src/Track';
import type { TrackQueueRef } from '../../src/Track';

// Minimal queue stub
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

describe('Track currentTime', () => {
  it('returns 0 before play()', () => {
    const t = new Track({ trackUrl: 'test.mp3', index: 0, queue: makeQueue() });
    expect(t.currentTime).toBe(0);
  });

  it('returns html5 currentTime before WebAudio loads', () => {
    const t = new Track({ trackUrl: 'test.mp3', index: 0, queue: makeQueue() });
    // Simulate HTML5 element advancing
    const audioEl = t.audio as unknown as MockAudioElement;
    audioEl.currentTime = 15;
    audioEl.paused = false;
    expect(t.currentTime).toBe(15);
  });

  it('returns frozen time when paused on WebAudio', async () => {
    const ctx = (globalThis as unknown as { _mockAudioContext: MockAudioContext })._mockAudioContext;
    const t = new Track({ trackUrl: 'test.mp3', index: 0, queue: makeQueue() });

    // Inject a mock buffer directly to skip the fetch pipeline
    t.audioBuffer = new MockAudioBuffer(300) as unknown as AudioBuffer;

    // Simulate play from position 30
    advanceTime(30);
    t.play();

    // Advance time by 10 more seconds
    advanceTime(10);
    expect(t.currentTime).toBeCloseTo(10, 1); // playing: ctx.currentTime - startedAt

    // Pause — time should freeze
    t.pause();
    const frozenTime = t.currentTime;
    advanceTime(60); // 60 more seconds pass in the AudioContext
    expect(t.currentTime).toBeCloseTo(frozenTime, 2); // still frozen

    void ctx; // suppress unused warning
  });

  it('resumes from correct position after pause/play on WebAudio', () => {
    const t = new Track({ trackUrl: 'test.mp3', index: 0, queue: makeQueue() });
    t.audioBuffer = new MockAudioBuffer(300) as unknown as AudioBuffer;

    t.play();
    advanceTime(45); // play for 45s
    expect(t.currentTime).toBeCloseTo(45, 1);

    t.pause();
    expect(t.currentTime).toBeCloseTo(45, 1); // frozen at 45

    // Resume — must continue from 45, not reset to 0
    t.play();
    advanceTime(10);
    expect(t.currentTime).toBeCloseTo(55, 1); // 45 + 10
  });

  it('resets correctly after seek', async () => {
    const t = new Track({ trackUrl: 'test.mp3', index: 0, queue: makeQueue() });
    t.audioBuffer = new MockAudioBuffer(300) as unknown as AudioBuffer;

    t.play();
    advanceTime(30);

    t.seek(120);
    // After seek: currentTime should start from 120
    expect(t.currentTime).toBeCloseTo(120, 1);

    advanceTime(10);
    expect(t.currentTime).toBeCloseTo(130, 1);
  });

  it('clamps seek to duration', () => {
    const t = new Track({ trackUrl: 'test.mp3', index: 0, queue: makeQueue() });
    t.audioBuffer = new MockAudioBuffer(180) as unknown as AudioBuffer;
    t.play();
    t.seek(999);
    expect(t.currentTime).toBeCloseTo(180, 0);
  });

  it('clamps seek to 0', () => {
    const t = new Track({ trackUrl: 'test.mp3', index: 0, queue: makeQueue() });
    t.audioBuffer = new MockAudioBuffer(180) as unknown as AudioBuffer;
    t.play();
    advanceTime(30);
    t.seek(-10);
    expect(t.currentTime).toBeCloseTo(0, 1);
  });

  it('reflects playbackRate in WebAudio currentTime', () => {
    const t = new Track({ trackUrl: 'test.mp3', index: 0, queue: makeQueue({ playbackRate: 2 }) });
    t.audioBuffer = new MockAudioBuffer(300) as unknown as AudioBuffer;
    t.play();
    advanceTime(10); // 10 wall-clock seconds at 2x = 20 track seconds
    expect(t.currentTime).toBeCloseTo(20, 1);
  });

  it('reflects playbackRate after seek', () => {
    const t = new Track({ trackUrl: 'test.mp3', index: 0, queue: makeQueue({ playbackRate: 2 }) });
    t.audioBuffer = new MockAudioBuffer(300) as unknown as AudioBuffer;
    t.play();
    t.seek(100);
    advanceTime(5); // 5 wall-clock seconds at 2x = 10 track seconds from seek point
    expect(t.currentTime).toBeCloseTo(110, 1);
  });

  it('reflects playbackRate after pause/resume', () => {
    const t = new Track({ trackUrl: 'test.mp3', index: 0, queue: makeQueue({ playbackRate: 1.5 }) });
    t.audioBuffer = new MockAudioBuffer(300) as unknown as AudioBuffer;
    t.play();
    advanceTime(10); // 10 wall-clock seconds at 1.5x = 15 track seconds
    expect(t.currentTime).toBeCloseTo(15, 1);
    t.pause();
    expect(t.currentTime).toBeCloseTo(15, 1);
    t.play();
    advanceTime(10); // another 10 wall-clock seconds at 1.5x = 15 more
    expect(t.currentTime).toBeCloseTo(30, 1);
  });

  it('reflects playbackRate in scheduleGaplessStart', () => {
    const t = new Track({ trackUrl: 'test.mp3', index: 0, queue: makeQueue({ playbackRate: 2 }) });
    t.audioBuffer = new MockAudioBuffer(300) as unknown as AudioBuffer;
    advanceTime(10);
    t.scheduleGaplessStart(10); // starts at ctx.currentTime = 10
    advanceTime(5); // 5 wall-clock seconds at 2x = 10 track seconds
    expect(t.currentTime).toBeCloseTo(10, 1);
  });

  it('reflects mid-playback rate change', () => {
    const q = makeQueue({ playbackRate: 1 });
    const t = new Track({ trackUrl: 'test.mp3', index: 0, queue: q });
    t.audioBuffer = new MockAudioBuffer(300) as unknown as AudioBuffer;
    t.play();
    advanceTime(10); // 10s at 1x = 10 track seconds
    expect(t.currentTime).toBeCloseTo(10, 1);
    // Change rate to 2x — need to update queueRef and track
    (q as { playbackRate: number }).playbackRate = 2;
    t.setPlaybackRate(2);
    advanceTime(5); // 5 wall-clock seconds at 2x = 10 more track seconds
    expect(t.currentTime).toBeCloseTo(20, 1);
  });
});

describe('Track duration', () => {
  it('returns NaN before metadata loads', () => {
    const t = new Track({ trackUrl: 'test.mp3', index: 0, queue: makeQueue() });
    expect(isNaN(t.duration)).toBe(true);
  });

  it('returns audioBuffer.duration when buffer is loaded', () => {
    const t = new Track({ trackUrl: 'test.mp3', index: 0, queue: makeQueue() });
    t.audioBuffer = new MockAudioBuffer(245.5) as unknown as AudioBuffer;
    expect(t.duration).toBeCloseTo(245.5);
  });

  it('prefers audioBuffer.duration over html5 duration', () => {
    const t = new Track({ trackUrl: 'test.mp3', index: 0, queue: makeQueue() });
    const audio = t.audio as unknown as MockAudioElement;
    audio.duration = 100;
    t.audioBuffer = new MockAudioBuffer(245.5) as unknown as AudioBuffer;
    expect(t.duration).toBeCloseTo(245.5);
  });
});

describe('Track scheduleGaplessStart', () => {
  // Bug: scheduleGaplessStart was sending 'PLAY' instead of 'PLAY_WEBAUDIO',
  // putting the track machine into 'html5' state. This caused currentTime to
  // read from the stale audio element (0) instead of the WebAudio clock, and
  // _isUsingWebAudio to return false, so progress was never reported.

  it('puts track machine into webaudio state (not html5)', () => {
    const t = new Track({ trackUrl: 'test.mp3', index: 0, queue: makeQueue() });
    t.audioBuffer = new MockAudioBuffer(300) as unknown as AudioBuffer;

    advanceTime(10); // ctx.currentTime = 10
    t.scheduleGaplessStart(10); // schedule to start now

    expect(t.playbackType).toBe('WEBAUDIO');
  });

  it('currentTime uses WebAudio clock after scheduleGaplessStart', () => {
    const t = new Track({ trackUrl: 'test.mp3', index: 0, queue: makeQueue() });
    t.audioBuffer = new MockAudioBuffer(300) as unknown as AudioBuffer;

    advanceTime(10);            // ctx.currentTime = 10
    t.scheduleGaplessStart(10); // _waRefCtxTime = 10, _waRefTrackTime = 0
    advanceTime(5);             // ctx.currentTime = 15

    // currentTime = 0 + (15 - 10) * 1 = 5
    expect(t.currentTime).toBeCloseTo(5, 1);
  });

  it('currentTime does NOT read from stale audio.currentTime after scheduleGaplessStart', () => {
    const t = new Track({ trackUrl: 'test.mp3', index: 0, queue: makeQueue() });
    t.audioBuffer = new MockAudioBuffer(300) as unknown as AudioBuffer;

    // Poison the HTML5 element currentTime — should be ignored
    const audioEl = t.audio as unknown as MockAudioElement;
    audioEl.currentTime = 99;

    advanceTime(10);
    t.scheduleGaplessStart(10);
    advanceTime(3);

    expect(t.currentTime).toBeCloseTo(3, 1); // WebAudio clock, not 99
  });

  it('isPlaying is true after scheduleGaplessStart', () => {
    const t = new Track({ trackUrl: 'test.mp3', index: 0, queue: makeQueue() });
    t.audioBuffer = new MockAudioBuffer(300) as unknown as AudioBuffer;

    advanceTime(5);
    t.scheduleGaplessStart(5);

    expect(t.isPlaying).toBe(true);
  });

  it('isPlaying is true after scheduleGaplessStart even when track was in webaudio state from BUFFER_READY', () => {
    // Bug: BUFFER_READY in loading → webaudio did not set isPlaying:true.
    // Then PLAY_WEBAUDIO from scheduleGaplessStart was silently dropped because
    // webaudio state had no PLAY_WEBAUDIO handler. Result: isPlaying stayed
    // false, progress loop exited immediately, UI showed frozen progress.
    const t = new Track({ trackUrl: 'test.mp3', index: 0, queue: makeQueue() });

    // Simulate the preload path: buffer arrives while track is in loading state
    t.preload(); // idle → loading
    // Inject buffer directly to simulate decode completing
    t.audioBuffer = new MockAudioBuffer(300) as unknown as AudioBuffer;
    // Manually send BUFFER_READY to mirror what _startLoad's fetch pipeline does
    // (track machine goes loading → webaudio, isPlaying stays false)
    // We access the service via the public scheduleGaplessStart side-effect:
    // instead, just call scheduleGaplessStart and verify isPlaying ends up true.
    advanceTime(10);
    t.scheduleGaplessStart(10); // sends PLAY_WEBAUDIO — must set isPlaying:true

    expect(t.isPlaying).toBe(true);
    expect(t.playbackType).toBe('WEBAUDIO');
  });

  it('startProgressLoop() triggers onProgress callback', async () => {
    const onProgress = vi.fn();
    const q = makeQueue({ onProgress });
    const t = new Track({ trackUrl: 'test.mp3', index: 0, queue: q });
    t.audioBuffer = new MockAudioBuffer(300) as unknown as AudioBuffer;

    advanceTime(5);
    t.scheduleGaplessStart(5);
    // startProgressLoop is what Queue calls after a gapless transition
    t.startProgressLoop();

    // RAF is mocked to run via setTimeout(cb, 0)
    await new Promise(r => setTimeout(r, 0));

    expect(onProgress).toHaveBeenCalled();
    const info = onProgress.mock.calls[0][0];
    expect(info.playbackType).toBe('WEBAUDIO');
  });
});

describe('Track isPaused', () => {
  it('reflects html5 paused state before buffer loads', () => {
    const t = new Track({ trackUrl: 'test.mp3', index: 0, queue: makeQueue() });
    const audio = t.audio as unknown as MockAudioElement;
    audio.paused = true;
    expect(t.isPaused).toBe(true);
    audio.paused = false;
    expect(t.isPaused).toBe(false);
  });

  it('is true after pause() on webaudio', () => {
    const t = new Track({ trackUrl: 'test.mp3', index: 0, queue: makeQueue() });
    t.audioBuffer = new MockAudioBuffer(180) as unknown as AudioBuffer;
    t.play();
    t.pause();
    expect(t.isPaused).toBe(true);
  });

  it('is false after play()', () => {
    const t = new Track({ trackUrl: 'test.mp3', index: 0, queue: makeQueue() });
    t.audioBuffer = new MockAudioBuffer(180) as unknown as AudioBuffer;
    t.play();
    expect(t.isPaused).toBe(false);
  });
});
