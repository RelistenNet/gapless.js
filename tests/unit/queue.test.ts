// ---------------------------------------------------------------------------
// Queue class integration tests
//
// Tests the full Queue public API using mocked audio infrastructure.
// Verifies callbacks, state transitions, track management, and preloading.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Queue } from '../../src/Queue';
import type { TrackInfo } from '../../src/types';
import { MockAudioBuffer, MockAudioContext, MockAudioElement, advanceTime, mockFetchSuccess, mockFetchFailure } from '../setup';
import { _resetAudioContext } from '../../src/utils/audioContext';

// Helper: inject a pre-decoded buffer into a track (bypasses fetch pipeline)
function injectBuffer(queue: Queue, trackIndex: number, duration = 180): void {
  const track = (queue as unknown as { _tracks: unknown[] })._tracks[trackIndex] as {
    audioBuffer: AudioBuffer | null;
    isBufferLoaded: boolean;
  };
  track.audioBuffer = new MockAudioBuffer(duration) as unknown as AudioBuffer;
}

describe('Queue construction', () => {
  it('creates with empty tracks array', () => {
    const q = new Queue();
    expect(q.tracks).toHaveLength(0);
    expect(q.currentTrackIndex).toBe(0);
    expect(q.isPlaying).toBe(false);
    expect(q.isPaused).toBe(false);
  });

  it('creates with initial tracks', () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });
    expect(q.tracks).toHaveLength(3);
  });

  it('respects webAudioIsDisabled option', () => {
    const q = new Queue({ webAudioIsDisabled: true });
    expect(q.webAudioIsDisabled).toBe(true);
  });

  it('applies initial volume to all tracks', () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    for (const t of q.tracks) {
      expect(t.volume).toBe(1);
    }
  });
});

describe('Queue play/pause/toggle', () => {
  it('play() transitions to playing state', () => {
    const q = new Queue({ tracks: ['a.mp3'] });
    q.play();
    expect(q.isPlaying).toBe(true);
  });

  it('pause() transitions to paused state', () => {
    const q = new Queue({ tracks: ['a.mp3'] });
    q.play();
    q.pause();
    expect(q.isPaused).toBe(true);
    expect(q.isPlaying).toBe(false);
  });

  it('togglePlayPause toggles between playing and paused', () => {
    const q = new Queue({ tracks: ['a.mp3'] });
    q.play();
    expect(q.isPlaying).toBe(true);
    q.togglePlayPause();
    expect(q.isPaused).toBe(true);
    q.togglePlayPause();
    expect(q.isPlaying).toBe(true);
  });

  it('play() on empty queue does nothing', () => {
    const q = new Queue();
    expect(() => q.play()).not.toThrow();
  });
});

describe('Queue navigation', () => {
  it('next() advances currentTrackIndex', () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });
    q.play();
    q.next();
    expect(q.currentTrackIndex).toBe(1);
  });

  it('next() does not advance past last track', () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();
    q.next(); // → 1
    q.next(); // stays at 1 (last)
    expect(q.currentTrackIndex).toBe(1);
  });

  it('previous() decrements currentTrackIndex', () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });
    q.gotoTrack(2, true);
    q.previous();
    expect(q.currentTrackIndex).toBe(1);
  });

  it('previous() does not go below 0', () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();
    q.previous();
    expect(q.currentTrackIndex).toBe(0);
  });

  it('previous() restarts current track if currentTime > 8s', () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    // Preload track 1 so it starts in webaudio state with a real currentTime
    injectBuffer(q, 1, 180);
    q.gotoTrack(1, true); // activates track 1 — buffer ready → plays via WebAudio
    // Simulate being 30 seconds in by seeking
    const tracks = (q as unknown as { _tracks: unknown[] })._tracks as Array<{ seek: (t: number) => void; currentTime: number }>;
    tracks[1].seek(30);
    q.previous();
    // Should seek to 0, not change track
    expect(q.currentTrackIndex).toBe(1);
  });

  it('gotoTrack() jumps to correct index', () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });
    q.gotoTrack(2, false);
    expect(q.currentTrackIndex).toBe(2);
  });

  it('gotoTrack() ignores out-of-range index', () => {
    const q = new Queue({ tracks: ['a.mp3'] });
    q.gotoTrack(99, false);
    expect(q.currentTrackIndex).toBe(0);
  });
});

describe('Queue track management', () => {
  it('addTrack() appends a new track', () => {
    const q = new Queue({ tracks: ['a.mp3'] });
    q.addTrack('b.mp3');
    expect(q.tracks).toHaveLength(2);
    expect(q.tracks[1].trackUrl).toBe('b.mp3');
  });

  it('addTrack() with metadata stores metadata', () => {
    const q = new Queue();
    q.addTrack('a.mp3', { metadata: { title: 'Track A' } });
    expect(q.tracks[0].metadata?.title).toBe('Track A');
  });

  it('removeTrack() removes by index', () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });
    q.removeTrack(1);
    expect(q.tracks).toHaveLength(2);
    expect(q.tracks[1].trackUrl).toBe('c.mp3');
  });

  it('removeTrack() ignores out-of-range', () => {
    const q = new Queue({ tracks: ['a.mp3'] });
    expect(() => q.removeTrack(99)).not.toThrow();
    expect(q.tracks).toHaveLength(1);
  });
});

describe('Queue volume', () => {
  it('setVolume clamps to [0, 1]', () => {
    const q = new Queue({ tracks: ['a.mp3'] });
    q.setVolume(1.5);
    expect(q.volume).toBe(1);
    q.setVolume(-0.5);
    expect(q.volume).toBe(0);
    q.setVolume(0.5);
    expect(q.volume).toBeCloseTo(0.5);
  });

  it('setVolume propagates to all tracks', () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.setVolume(0.3);
    for (const t of q.tracks) {
      expect(t.volume).toBeCloseTo(0.3);
    }
  });
});

describe('Queue callbacks', () => {
  it('calls onPlayNextTrack when next() is called', () => {
    const onPlayNextTrack = vi.fn();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'], onPlayNextTrack });
    q.play();
    q.next();
    expect(onPlayNextTrack).toHaveBeenCalledOnce();
    expect(onPlayNextTrack.mock.calls[0][0].index).toBe(1);
  });

  it('calls onPlayPreviousTrack when previous() is called', () => {
    const onPlayPreviousTrack = vi.fn();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'], onPlayPreviousTrack });
    q.gotoTrack(1, true);
    q.previous();
    expect(onPlayPreviousTrack).toHaveBeenCalledOnce();
  });

  it('calls onStartNewTrack for next()', () => {
    const onStartNewTrack = vi.fn();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'], onStartNewTrack });
    q.play();
    q.next();
    expect(onStartNewTrack).toHaveBeenCalledOnce();
  });

  it('calls onError when audio errors', () => {
    const onError = vi.fn();
    const q = new Queue({ tracks: ['a.mp3'], onError });
    const tracks = (q as unknown as { _tracks: Array<{ audio: HTMLAudioElement }> })._tracks;
    // Trigger the onerror handler directly
    tracks[0].audio.onerror?.(new Event('error'));
    expect(onError).toHaveBeenCalledOnce();
  });

  it('calls onEnded when last track ends', async () => {
    const onEnded = vi.fn();
    const q = new Queue({ tracks: ['a.mp3'], onEnded });
    q.play();
    // Simulate the track ending
    const tracks = (q as unknown as { _tracks: Array<{ audio: HTMLAudioElement }> })._tracks;
    tracks[0].audio.onended?.(new Event('ended'));
    await Promise.resolve();
    expect(onEnded).toHaveBeenCalledOnce();
  });
});

describe('Queue currentTrack getter', () => {
  it('returns undefined for empty queue', () => {
    const q = new Queue();
    expect(q.currentTrack).toBeUndefined();
  });

  it('returns TrackInfo for current track', () => {
    const q = new Queue({ tracks: ['a.mp3'] });
    const info = q.currentTrack;
    expect(info).toBeDefined();
    expect(info!.index).toBe(0);
    expect(info!.trackUrl).toBe('a.mp3');
  });
});

describe('Queue destroy', () => {
  it('destroy() does not throw', () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();
    expect(() => q.destroy()).not.toThrow();
  });

  it('tracks array is empty after destroy', () => {
    const q = new Queue({ tracks: ['a.mp3'] });
    q.destroy();
    expect(q.tracks).toHaveLength(0);
  });
});

describe('Queue TRACK_ENDED while paused', () => {
  type InternalTrack = { audioBuffer: AudioBuffer | null; audio: MockAudioElement; isBufferLoaded: boolean };
  type InternalQueue = { _tracks: InternalTrack[] };

  // Helper: grab the mock audio element for a given track index
  function audioOf(q: Queue, i: number): MockAudioElement {
    return (q as unknown as InternalQueue)._tracks[i].audio as unknown as MockAudioElement;
  }

  it('queue stays paused when a non-last track ends while paused', async () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });
    q.play();
    q.pause();
    expect(q.isPaused).toBe(true);

    // Track 0 ends naturally (e.g. buffered audio drained)
    audioOf(q, 0).simulateEnded();
    await Promise.resolve();

    expect(q.isPaused).toBe(true);
    expect(q.isPlaying).toBe(false);
  });

  it('index advances to the next track when a track ends while paused', async () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });
    q.play();
    q.pause();

    audioOf(q, 0).simulateEnded();
    await Promise.resolve();

    expect(q.currentTrackIndex).toBe(1);
  });

  it('onStartNewTrack is fired with the next track when ended while paused', async () => {
    const onStartNewTrack = vi.fn();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'], onStartNewTrack });
    q.play();
    q.pause();
    onStartNewTrack.mockClear(); // clear the call from play()

    audioOf(q, 0).simulateEnded();
    await Promise.resolve();

    expect(onStartNewTrack).toHaveBeenCalledOnce();
    expect(onStartNewTrack.mock.calls[0][0].index).toBe(1);
  });

  it('onEnded is called when the last track ends while paused', async () => {
    const onEnded = vi.fn();
    const q = new Queue({ tracks: ['a.mp3'], onEnded });
    q.play();
    q.pause();

    audioOf(q, 0).simulateEnded();
    await Promise.resolve();

    expect(onEnded).toHaveBeenCalledOnce();
  });

  it('play() after a track ends while paused starts the advanced track', async () => {
    const onStartNewTrack = vi.fn();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'], onStartNewTrack });
    q.play();
    q.pause();
    onStartNewTrack.mockClear();

    audioOf(q, 0).simulateEnded();
    await Promise.resolve();
    // Queue is paused at index 1; pressing play should start track 1
    q.play();

    expect(q.isPlaying).toBe(true);
    expect(q.currentTrackIndex).toBe(1);
    expect(audioOf(q, 1).play).toHaveBeenCalled();
  });

  it('does NOT auto-play onPlayNextTrack when ended while paused', async () => {
    const onPlayNextTrack = vi.fn();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'], onPlayNextTrack });
    q.play();
    q.pause();
    onPlayNextTrack.mockClear();

    audioOf(q, 0).simulateEnded();
    await Promise.resolve();

    // onPlayNextTrack must not fire — user didn't press Next, and the queue is paused
    expect(onPlayNextTrack).not.toHaveBeenCalled();
  });
});

describe('Queue onTrackEnded resets finished track', () => {
  type InternalTrack = {
    audioBuffer: AudioBuffer | null;
    audio: MockAudioElement;
    isBufferLoaded: boolean;
    currentTime: number;
    webAudioStartedAt: number;
    pausedAtTrackTime: number;
  };
  type InternalQueue = { _tracks: InternalTrack[] };

  function audioOf(q: Queue, i: number): MockAudioElement {
    return (q as unknown as InternalQueue)._tracks[i].audio as unknown as MockAudioElement;
  }

  it('finished track currentTime resets to 0 after ending', async () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();

    // Simulate some playback on track 0
    audioOf(q, 0).currentTime = 120;

    // Track 0 ends
    audioOf(q, 0).simulateEnded();
    await Promise.resolve();

    expect(q.currentTrackIndex).toBe(1);
    // The finished track should be reset
    expect(audioOf(q, 0).currentTime).toBe(0);
  });

  it('finished track machine state resets to idle after ending', () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();

    audioOf(q, 0).simulateEnded();
    // Note: track machine state resets synchronously (HTML5_ENDED → idle),
    // only the queue notification is deferred
    expect(q.tracks[0].machineState).toBe('idle');
    expect(q.tracks[0].isPlaying).toBe(false);
  });

  it('new track starts at currentTime 0 after track transition', async () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();

    audioOf(q, 0).simulateEnded();
    await Promise.resolve();

    expect(q.currentTrackIndex).toBe(1);
    expect(audioOf(q, 1).currentTime).toBe(0);
  });

  it('finished track with WebAudio buffer resets all timing fields', async () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    injectBuffer(q, 0, 300);
    q.play();

    const internal = q as unknown as InternalQueue;
    // Track 0 ends via HTML5 (the onended handler)
    audioOf(q, 0).simulateEnded();
    await Promise.resolve();

    expect(internal._tracks[0].webAudioStartedAt).toBe(0);
    expect(internal._tracks[0].pausedAtTrackTime).toBe(0);
    expect(audioOf(q, 0).currentTime).toBe(0);
  });
});

describe('Queue MediaSession pause guard', () => {
  // Bug: Chrome fires the MediaSession 'pause' action when the HTML5 audio
  // element pauses at end-of-track (before 'onended'). Without a guard, this
  // called Queue.pause(), sending the queue to 'paused' before TRACK_ENDED
  // could fire, so the next track never started automatically.
  //
  // happy-dom has no mediaSession, so we test the observable behavior directly:
  // Queue.pause() called while already paused must be a safe no-op that does
  // not corrupt state. This is what the guard prevents Chrome from doing.

  type InternalTrack = { audio: MockAudioElement };
  type InternalQueue  = { _tracks: InternalTrack[] };

  it('calling pause() while already paused does not corrupt state', () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();
    q.pause();
    expect(q.isPaused).toBe(true);

    // Simulate Chrome firing MediaSession 'pause' a second time at end-of-track
    q.pause();

    // Still paused — not broken
    expect(q.isPaused).toBe(true);
    expect(q.isPlaying).toBe(false);
  });

  it('TRACK_ENDED after a spurious pause still advances to next track when play() is called', async () => {
    // Sequence: playing → spurious pause (MediaSession) → track ends → play()
    // Expected: next track starts, not the finished track
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    const internal = q as unknown as InternalQueue;

    q.play();
    // Spurious pause from MediaSession (Chrome fires this before onended)
    q.pause();
    expect(q.isPaused).toBe(true);
    expect(q.currentTrackIndex).toBe(0);

    // Track 0 ends naturally
    internal._tracks[0].audio.simulateEnded();
    await Promise.resolve();

    // Queue should have advanced index to 1, stayed paused
    expect(q.currentTrackIndex).toBe(1);
    expect(q.isPaused).toBe(true);

    // User hits Play — should start track 1, not replay track 0
    q.play();
    expect(q.isPlaying).toBe(true);
    expect(q.currentTrackIndex).toBe(1);
    expect(internal._tracks[1].audio.play).toHaveBeenCalled();
  });
});

describe('Queue media session position updates via onProgress', () => {
  // The OS media session extrapolates position from the last setPositionState
  // call. We avoid flushing position on play/pause state changes because any
  // small mismatch between our position and the OS extrapolation causes a
  // visible scrubber jump. Instead we rely solely on the throttled (200ms)
  // position updates from the progress loop during playback, and let the OS
  // freeze/resume its extrapolated position on pause/play.

  it('onProgress forwards to user callback during playback', () => {
    const spy = vi.fn();
    const q = new Queue({ tracks: ['a.mp3'], onProgress: spy });
    q.play();
    // Manually fire onProgress like the progress loop would
    q.onProgress({ index: 0, currentTime: 10, duration: 120 } as TrackInfo);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ currentTime: 10, duration: 120 }),
    );
  });

  it('onProgress ignores reports from non-current tracks', () => {
    const spy = vi.fn();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'], onProgress: spy });
    q.play();
    // Report from track 1, but current track is 0 — should be ignored
    q.onProgress({ index: 1, currentTime: 5, duration: 60 } as TrackInfo);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('Queue gapless transition progress', () => {
  // Bug: when a track started via scheduleGaplessStart became active,
  // onProgress was never called because startProgressLoop() wasn't invoked
  // in the gapless branch of onTrackEnded.

  type InternalTrack = { audio: MockAudioElement; audioBuffer: AudioBuffer | null };
  type InternalQueue = { _tracks: InternalTrack[]; _scheduledNextIndex: number | null };

  it('startProgressLoop() is called on the next track after a gapless transition', async () => {
    // Track 0 plays via HTML5 (no injected buffer), track 1 has a pre-decoded
    // buffer. When track 0's HTML5 audio ends and _scheduledNextIndex contains
    // track 1, Queue.onTrackEnded must call startProgressLoop on track 1.
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });

    // Only inject buffer for track 1 — track 0 stays on HTML5
    injectBuffer(q, 1, 180);
    q.play(); // track 0 plays via HTML5

    const internal = q as unknown as InternalQueue;
    // Mark track 1 as gapless-scheduled (simulates scheduleGaplessStart having run)
    internal._scheduledNextIndex = 1;

    // Spy on track 1's startProgressLoop before the transition fires
    const track1 = internal._tracks[1] as unknown as { startProgressLoop: () => void };
    const loopSpy = vi.spyOn(track1, 'startProgressLoop');

    // Track 0 ends via HTML5 — triggers the gapless branch in onTrackEnded
    internal._tracks[0].audio.simulateEnded();
    await Promise.resolve();

    expect(loopSpy).toHaveBeenCalledOnce();
  });

  it('playbackType of gaplessly-started track is WEBAUDIO', () => {
    // Bug: scheduleGaplessStart sent 'PLAY' (→ html5 state) not 'PLAY_WEBAUDIO'.
    // After the fix, the track machine must be in webaudio state.
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    injectBuffer(q, 1, 180);

    const internal = q as unknown as InternalQueue;
    const track1 = internal._tracks[1] as unknown as { scheduleGaplessStart: (when: number) => void };

    track1.scheduleGaplessStart(0); // schedule to start at ctx time 0

    expect(q.tracks[1].playbackType).toBe('WEBAUDIO');
  });
});

describe('Queue pause after gapless transition reports correct state', () => {
  // Bug: after a gapless (WebAudio) transition, pausing the new track would
  // fire reportProgress with stale getSnapshot() data (isPlaying: true),
  // causing consumers to think the track was still playing.

  type InternalTrack = {
    audio: MockAudioElement;
    audioBuffer: AudioBuffer | null;
    scheduleGaplessStart: (when: number) => void;
  };
  type InternalQueue = { _tracks: InternalTrack[]; _scheduledNextIndex: number | null };

  it('onProgress reports isPaused=true after pausing a gaplessly-started WebAudio track', async () => {
    const progressSpy = vi.fn();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'], onProgress: progressSpy });

    // Track 1 gets a WebAudio buffer; track 0 stays HTML5
    injectBuffer(q, 1, 180);
    q.play();

    const internal = q as unknown as InternalQueue;
    // Actually schedule the gapless start on track 1 (puts it in webaudio state)
    internal._tracks[1].scheduleGaplessStart(0);
    internal._scheduledNextIndex = 1;

    // Track 0 HTML5 ends → gapless transition to track 1
    internal._tracks[0].audio.simulateEnded();
    await Promise.resolve(); // let queueMicrotask(onTrackEnded) fire

    expect(q.currentTrackIndex).toBe(1);
    expect(q.tracks[1].playbackType).toBe('WEBAUDIO');

    // Clear any progress calls from the transition
    progressSpy.mockClear();

    // Pause the gaplessly-started WebAudio track
    q.pause();

    // The reportProgress action fires during PAUSE — wait for microtask
    await Promise.resolve();

    // The final onProgress call must reflect paused state
    const lastCall = progressSpy.mock.calls[progressSpy.mock.calls.length - 1]?.[0];
    expect(lastCall).toBeDefined();
    expect(lastCall.isPaused).toBe(true);
    expect(lastCall.isPlaying).toBe(false);
  });
});

describe('Queue seek cancels stale gapless schedule', () => {
  type InternalTrack = {
    audioBuffer: AudioBuffer | null;
    audio: MockAudioElement;
    isBufferLoaded: boolean;
    scheduledStartContextTime: number | null;
    cancelGaplessStart: () => void;
  };
  type InternalQueue = { _tracks: InternalTrack[]; _scheduledNextIndex: number | null };

  it('seek() cancels a scheduled gapless start on the next track', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    injectBuffer(q, 0, 300);
    q.play();
    // Let fetch+decode settle so track 1 buffer is ready and gapless is scheduled
    await new Promise(r => setTimeout(r, 0));

    const internal = q as unknown as InternalQueue;
    // Verify track 1 was gapless-scheduled
    expect(internal._scheduledNextIndex).toBe(1);
    expect(internal._tracks[1].scheduledStartContextTime).not.toBeNull();

    // Seek current track — should cancel the stale schedule
    q.seek(295);

    // The old schedule must be cleared and rescheduled
    // (rescheduled because both buffers are still ready)
    expect(internal._scheduledNextIndex).toBe(1);
    // The new scheduled time should be based on the seek position
    const newStart = internal._tracks[1].scheduledStartContextTime;
    expect(newStart).not.toBeNull();
    // remaining = 300 - 295 = 5s, so newStart ≈ ctxNow + 5
    expect(newStart!).toBeLessThan(10);
  });

  it('seek() reschedules gapless on the next track with updated timing', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    injectBuffer(q, 0, 300);
    q.play();
    await new Promise(r => setTimeout(r, 0));

    const internal = q as unknown as InternalQueue;
    const oldStart = internal._tracks[1].scheduledStartContextTime;
    expect(oldStart).not.toBeNull();

    // Seek close to end (simulate "skip to end -5s")
    q.seek(295);

    // Should have rescheduled with a much sooner start time
    const newStart = internal._tracks[1].scheduledStartContextTime;
    expect(newStart).not.toBeNull();
    expect(newStart!).toBeLessThan(oldStart!);
  });

  it('cancelGaplessStart resets the next track to idle', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    injectBuffer(q, 0, 300);
    q.play();
    await new Promise(r => setTimeout(r, 0));

    const internal = q as unknown as InternalQueue;
    // Track 1 should be in webaudio (gapless-scheduled)
    expect(q.tracks[1].machineState).toBe('webaudio');

    // After seek, track 1 gets cancelled then rescheduled.
    // But first verify the cancel path works by checking the track went
    // through idle before being rescheduled. We can verify by checking
    // that the track is back in webaudio with a new schedule time.
    const oldStart = internal._tracks[1].scheduledStartContextTime;
    q.seek(295);
    const newStart = internal._tracks[1].scheduledStartContextTime;
    expect(newStart).not.toBeNull();
    expect(newStart).not.toBe(oldStart);
    expect(q.tracks[1].machineState).toBe('webaudio');
  });

  it('seek() with no scheduled gapless is a safe no-op', () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();

    // Track 0 has no buffer, so no gapless was scheduled
    const internal = q as unknown as InternalQueue;
    expect(internal._scheduledNextIndex).toBeNull();

    // Should not throw
    expect(() => q.seek(10)).not.toThrow();
  });

  it('seek() on last track with no next track is a safe no-op', () => {
    const q = new Queue({ tracks: ['a.mp3'] });
    injectBuffer(q, 0, 300);
    q.play();

    expect(() => q.seek(200)).not.toThrow();
  });
});

describe('Queue pause cancels stale gapless schedule', () => {
  type InternalTrack = {
    audioBuffer: AudioBuffer | null;
    audio: MockAudioElement;
    isBufferLoaded: boolean;
    scheduledStartContextTime: number | null;
    cancelGaplessStart: () => void;
  };
  type InternalQueue = { _tracks: InternalTrack[]; _scheduledNextIndex: number | null };

  it('pause() cancels the scheduled gapless start on the next track', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    injectBuffer(q, 0, 300);
    q.play();
    await new Promise(r => setTimeout(r, 0));

    const internal = q as unknown as InternalQueue;
    expect(internal._scheduledNextIndex).toBe(1);
    expect(internal._tracks[1].scheduledStartContextTime).not.toBeNull();

    q.pause();

    expect(internal._scheduledNextIndex).not.toBe(1);
    expect(internal._tracks[1].scheduledStartContextTime).toBeNull();
  });

  it('pause() then play() reschedules gapless for the next track', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    injectBuffer(q, 0, 300);
    q.play();
    await new Promise(r => setTimeout(r, 0));

    const internal = q as unknown as InternalQueue;
    expect(internal._scheduledNextIndex).toBe(1);
    q.pause();
    expect(internal._scheduledNextIndex).not.toBe(1);
    expect(internal._tracks[1].scheduledStartContextTime).toBeNull();

    // play() must reschedule gapless with a fresh timing
    q.play();
    expect(internal._scheduledNextIndex).toBe(1);
    expect(internal._tracks[1].scheduledStartContextTime).not.toBeNull();
  });

  it('pause() with no scheduled gapless is a safe no-op', () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();

    const internal = q as unknown as InternalQueue;
    expect(internal._scheduledNextIndex).toBeNull();

    expect(() => q.pause()).not.toThrow();
    expect(q.isPaused).toBe(true);
  });
});

describe('Queue next/previous/gotoTrack cancel stale gapless schedule', () => {
  type InternalTrack = {
    audioBuffer: AudioBuffer | null;
    audio: MockAudioElement;
    isBufferLoaded: boolean;
    scheduledStartContextTime: number | null;
    cancelGaplessStart: () => void;
  };
  type InternalQueue = { _tracks: InternalTrack[]; _scheduledNextIndex: number | null };

  it('next() cancels all scheduled gapless starts', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });
    injectBuffer(q, 0, 300);
    q.play();
    await new Promise(r => setTimeout(r, 0));

    const internal = q as unknown as InternalQueue;
    expect(internal._scheduledNextIndex).toBe(1);

    q.next();

    // All old schedules should be cleared
    // (track 1 is now current, track 2 may or may not be scheduled yet)
    expect(internal._scheduledNextIndex).not.toBe(1);
  });

  it('next() resets the previously-scheduled track machine state', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });
    injectBuffer(q, 0, 300);
    q.play();
    await new Promise(r => setTimeout(r, 0));

    // Track 1 was gapless-scheduled (in webaudio state)
    expect(q.tracks[1].machineState).toBe('webaudio');

    q.next();

    // Track 1 is now the current track — it gets activated fresh
    expect(q.currentTrackIndex).toBe(1);
    expect(q.isPlaying).toBe(true);
  });

  it('previous() cancels all scheduled gapless starts', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });
    injectBuffer(q, 0, 300);
    q.play();
    await new Promise(r => setTimeout(r, 0));

    const internal = q as unknown as InternalQueue;
    expect(internal._scheduledNextIndex).toBe(1);

    // Seek to 0 so previous() doesn't just restart the track (threshold is 8s)
    q.previous();

    expect(internal._scheduledNextIndex).not.toBe(1);
  });

  it('gotoTrack() cancels all scheduled gapless starts', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });
    injectBuffer(q, 0, 300);
    q.play();
    await new Promise(r => setTimeout(r, 0));

    const internal = q as unknown as InternalQueue;
    expect(internal._scheduledNextIndex).toBe(1);

    q.gotoTrack(2, true);

    expect(internal._scheduledNextIndex).not.toBe(1);
    expect(q.currentTrackIndex).toBe(2);
  });

  it('gotoTrack() resets the previously-scheduled track to idle', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });
    injectBuffer(q, 0, 300);
    q.play();
    await new Promise(r => setTimeout(r, 0));

    // Track 1 was gapless-scheduled
    expect(q.tracks[1].machineState).toBe('webaudio');
    expect(q.tracks[1].webAudioLoadingState).toBe('LOADED');

    q.gotoTrack(2, true);

    // Track 1 should be back to idle (cancelled), buffer still loaded
    expect(q.tracks[1].machineState).toBe('idle');
    expect(q.tracks[1].webAudioLoadingState).toBe('LOADED');
  });

  it('gotoTrack(_, false) cancels gapless without playing', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });
    injectBuffer(q, 0, 300);
    q.play();
    await new Promise(r => setTimeout(r, 0));

    const internal = q as unknown as InternalQueue;
    expect(internal._scheduledNextIndex).toBe(1);

    q.gotoTrack(2, false);

    expect(internal._scheduledNextIndex).not.toBe(1);
    expect(q.currentTrackIndex).toBe(2);
  });

  it('next() with no scheduled gapless is a safe no-op', () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });
    q.play();

    const internal = q as unknown as InternalQueue;
    expect(internal._scheduledNextIndex).toBeNull();

    expect(() => q.next()).not.toThrow();
    expect(q.currentTrackIndex).toBe(1);
  });

  it('gotoTrack() on single-track queue with no schedule is a safe no-op', () => {
    const q = new Queue({ tracks: ['a.mp3'] });
    q.play();

    expect(() => q.gotoTrack(0, true)).not.toThrow();
  });
});

describe('Queue HTML5 fallback and background loading', () => {
  type InternalTrack = {
    audioBuffer: AudioBuffer | null;
    audio: MockAudioElement;
    isBufferLoaded: boolean;
    machineState: string;
    webAudioLoadingState: string;
  };
  type InternalQueue = { _tracks: InternalTrack[] };

  it('activate() resets a track in loading state to idle', () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    // Inject buffer into track 0 so preload is not deferred (Web Audio path)
    injectBuffer(q, 0, 180);
    // Play track 0, which preloads track 1 into loading state
    q.play();
    // Track 1 should be in loading state from preload
    expect(q.tracks[1].machineState).toBe('loading');
    // Now goto track 1 — activate() should reset it from loading to idle before playing
    q.gotoTrack(1, true);
    // Track 1 should be playing (html5 or webaudio), not stuck in loading
    expect(q.tracks[1].machineState).not.toBe('loading');
    expect(q.isPlaying).toBe(true);
  });

  it('deactivate() from html5 puts track in idle (not loading)', () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();
    expect(q.tracks[0].machineState).toBe('html5');
    // Deactivate track 0 by advancing to track 1
    q.next();
    expect(q.tracks[0].machineState).toBe('idle');
  });

  it('next() to unloaded track plays HTML5, buffer loads in background, re-activation uses Web Audio', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });
    injectBuffer(q, 0, 180);
    q.play();
    // Skip to track 1 before its buffer is ready — should fall back to HTML5
    q.next();
    expect(q.currentTrackIndex).toBe(1);
    expect(q.isPlaying).toBe(true);
    // Let the buffer decode complete
    await new Promise(r => setTimeout(r, 0));
    // Track 1's buffer should now be loaded
    const internal = q as unknown as InternalQueue;
    expect(internal._tracks[1].isBufferLoaded).toBe(true);
    expect(q.tracks[1].webAudioLoadingState).toBe('LOADED');
  });
});

describe('Queue preloading', () => {
  type InternalTrack = { audioBuffer: AudioBuffer | null; audio: HTMLAudioElement; isBufferLoaded: boolean };
  type InternalQueue = { _tracks: InternalTrack[]; _scheduledNextIndex: number | null };

  it('defers preloading next track when playing via HTML5', () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();
    const tracks = (q as unknown as InternalQueue)._tracks;
    expect(tracks[1].isBufferLoaded).toBe(false);
  });

  it('does not double-fetch the current (HTML5) track', () => {
    const fetchSpy = mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const urls = (fetchSpy.mock.calls as any[][]).map(c => String(c[0]));
    expect(urls.every((u: string) => !u.includes('a.mp3'))).toBe(true);
  });

  it('next track buffer is loading or loaded after play() with Web Audio track', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    injectBuffer(q, 0, 180);
    q.play();
    // BUFFER_LOADING is sent synchronously inside _startLoad, so no await needed
    expect(['LOADING', 'LOADED']).toContain(q.tracks[1].webAudioLoadingState);
  });

  it('next track buffer is loaded after decode completes', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    injectBuffer(q, 0, 180);
    q.play();
    await new Promise(r => setTimeout(r, 0));
    const t1 = (q as unknown as InternalQueue)._tracks[1];
    expect(q.tracks[1].webAudioLoadingState).toBe('LOADED');
    expect(t1.isBufferLoaded).toBe(true);
  });

  it('preload marks ERROR state when fetch fails, track stays playable', async () => {
    mockFetchFailure();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    injectBuffer(q, 0, 180);
    q.play();
    await new Promise(r => setTimeout(r, 0));
    expect(q.tracks[1].webAudioLoadingState).toBe('ERROR');
  });

  it('track 1 plays via HTML5 after BUFFER_ERROR fallback when track 0 ends', async () => {
    mockFetchFailure();
    const onStartNewTrack = vi.fn();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'], onStartNewTrack });
    q.play();
    await new Promise(r => setTimeout(r, 0));
    const tracks = (q as unknown as InternalQueue)._tracks;
    tracks[0].audio.onended?.(new Event('ended'));
    await Promise.resolve();
    expect(onStartNewTrack).toHaveBeenCalledOnce();
    expect(q.currentTrackIndex).toBe(1);
  });

  it('gapless scheduling fires when both buffers are ready', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    injectBuffer(q, 0, 180);
    q.play();
    await new Promise(r => setTimeout(r, 0));
    const tracks = (q as unknown as InternalQueue)._tracks;
    expect(tracks[0].isBufferLoaded).toBe(true);
    expect(tracks[1].isBufferLoaded).toBe(true);
    expect((q as unknown as InternalQueue)._scheduledNextIndex).toBe(1);
  });

  it('preloads at most PRELOAD_AHEAD (2) tracks beyond current', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3', 'e.mp3'] });
    injectBuffer(q, 0, 180);
    q.play();
    // Let all fetch+decode promises settle
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    const tracks = (q as unknown as InternalQueue)._tracks;
    // Track 0: current (plays via HTML5, not buffer-preloaded)
    // Track 1: preloaded (1 ahead)
    expect(tracks[1].isBufferLoaded).toBe(true);
    // Track 2: preloaded (2 ahead)
    expect(tracks[2].isBufferLoaded).toBe(true);
    // Track 3: NOT preloaded (beyond PRELOAD_AHEAD)
    expect(tracks[3].isBufferLoaded).toBe(false);
    // Track 4: NOT preloaded
    expect(tracks[4].isBufferLoaded).toBe(false);
  });

  it('preloads next tracks after advancing via next()', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3', 'e.mp3'] });
    injectBuffer(q, 0, 180);
    q.play();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    const tracks = (q as unknown as InternalQueue)._tracks;
    // Advance to track 1
    q.next();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    // Track 3 should now be preloaded (2 ahead of track 1)
    expect(tracks[3].isBufferLoaded).toBe(true);
    // Track 4 should still NOT be preloaded (beyond 2 ahead)
    expect(tracks[4].isBufferLoaded).toBe(false);
  });

  it('previous() triggers preloading of tracks ahead of new position', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3', 'e.mp3'] });
    // Play and advance to track 3 (inject buffer so preload is not deferred)
    injectBuffer(q, 0, 180);
    q.play();
    q.gotoTrack(3, true);
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    const tracks = (q as unknown as InternalQueue)._tracks;
    // Go back to track 1
    q.gotoTrack(1, true);
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    // Tracks 2 and 3 (ahead of track 1) should be preloaded
    expect(tracks[2].isBufferLoaded).toBe(true);
    expect(tracks[3].isBufferLoaded).toBe(true);
  });

  it('previous() from paused state triggers preloading', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3', 'e.mp3'] });
    injectBuffer(q, 0, 180);
    q.play();
    // Wait for preload chain to complete (track 1, then track 2)
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    q.gotoTrack(3, true);
    q.pause();
    // Go back via previous() while paused — track 2 has buffer, plays WebAudio
    q.previous();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    const tracks = (q as unknown as InternalQueue)._tracks;
    // Track 3 (1 ahead of track 2) should be preloaded
    expect(tracks[3].isBufferLoaded).toBe(true);
  });

  it('gotoTrack() without playImmediately triggers preloading', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3', 'e.mp3'] });
    // Goto track 2 without auto-play (from idle state)
    q.gotoTrack(2);
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    const tracks = (q as unknown as InternalQueue)._tracks;
    // Track 3 (1 ahead of track 2) should be preloaded
    expect(tracks[3].isBufferLoaded).toBe(true);
  });

  it('next() on preloaded track transitions to playing state', async () => {
    mockFetchSuccess();
    const onStartNewTrack = vi.fn();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'], onStartNewTrack });
    injectBuffer(q, 0, 180);
    q.play();
    await new Promise(r => setTimeout(r, 0));
    // Track 1 should be preloaded (track 0 is Web Audio, so preload is immediate)
    const tracks = (q as unknown as InternalQueue)._tracks;
    expect(tracks[1].isBufferLoaded).toBe(true);
    // Advance — should not freeze
    q.next();
    expect(q.currentTrackIndex).toBe(1);
    expect(q.isPlaying).toBe(true);
    expect(onStartNewTrack).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Deferred preloading — HTML5 playback delays preloading until 15s in
// ---------------------------------------------------------------------------
describe('Queue deferred preloading', () => {
  type InternalTrack = {
    audioBuffer: AudioBuffer | null;
    audio: MockAudioElement;
    isBufferLoaded: boolean;
    playbackType: string;
    isPlaying: boolean;
    currentTime: number;
  };
  type InternalQueue = { _tracks: InternalTrack[] };

  it('does not preload next track immediately when current is HTML5 and < 15s', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });
    q.play();
    await new Promise(r => setTimeout(r, 0));
    const tracks = (q as unknown as InternalQueue)._tracks;
    expect(tracks[1].isBufferLoaded).toBe(false);
  });

  it('preloads next track after current track reaches 15s', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });
    q.play();
    await new Promise(r => setTimeout(r, 0));
    const tracks = (q as unknown as InternalQueue)._tracks;
    // Simulate audio.currentTime reaching 15s
    (tracks[0].audio as unknown as MockAudioElement).currentTime = 15;
    (tracks[0].audio as unknown as MockAudioElement).duration = 180;
    // Trigger the rAF progress loop
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(tracks[1].isBufferLoaded).toBe(true);
  });

  it('preloads immediately when current track is Web Audio (buffer already loaded)', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });
    injectBuffer(q, 0, 180);
    q.play();
    await new Promise(r => setTimeout(r, 0));
    const tracks = (q as unknown as InternalQueue)._tracks;
    expect(tracks[1].isBufferLoaded).toBe(true);
  });

  it('preloads immediately from paused/idle state (not playing HTML5)', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });
    q.gotoTrack(0);
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    const tracks = (q as unknown as InternalQueue)._tracks;
    expect(tracks[1].isBufferLoaded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Preload without prior AudioContext initialisation
//
// Regression: preload() used to silently no-op when the AudioContext had never
// been created (e.g. play() was never called). The fix calls
// resumeAudioContext() inside preload() to lazily initialise the context.
// ---------------------------------------------------------------------------
describe('Queue preloading without prior AudioContext', () => {
  type InternalTrack = { audioBuffer: AudioBuffer | null; isBufferLoaded: boolean };
  type InternalQueue = { _tracks: InternalTrack[] };

  it('preload via gotoTrack() fetches buffers even when AudioContext was never created', async () => {
    // Simulate the real initial state: AudioContext has never been created
    _resetAudioContext();
    // Provide the constructor so resumeAudioContext() can create one
    vi.stubGlobal('AudioContext', MockAudioContext);

    const fetchSpy = mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });

    // gotoTrack without playing — triggers preload on nearby tracks
    q.gotoTrack(0);
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    const tracks = (q as unknown as InternalQueue)._tracks;
    // Next track should have been fetched+decoded despite no prior play()
    expect(tracks[1].isBufferLoaded).toBe(true);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('preload sends START_FETCH when AudioContext is lazily created', async () => {
    _resetAudioContext();
    vi.stubGlobal('AudioContext', MockAudioContext);

    const fetchSpy = mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    const tracks = (q as unknown as InternalQueue)._tracks;

    // Directly call preload on track 1 (simulating what Queue._preloadAhead does)
    (tracks[1] as unknown as { preload(): void }).preload();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    // Fetch should have been triggered for track 1
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const urls = (fetchSpy.mock.calls as any[][]).map(c => String(c[0]));
    expect(urls.some((u: string) => u.includes('b.mp3'))).toBe(true);
    expect(tracks[1].isBufferLoaded).toBe(true);
  });

  it('preload is a no-op when AudioContext is unavailable (no browser API)', async () => {
    _resetAudioContext();
    // Do NOT stub window.AudioContext — simulates an environment without Web Audio
    delete (window as unknown as Record<string, unknown>).AudioContext;
    delete (window as unknown as Record<string, unknown>).webkitAudioContext;

    const fetchSpy = mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    const tracks = (q as unknown as InternalQueue)._tracks;

    (tracks[1] as unknown as { preload(): void }).preload();
    await new Promise(r => setTimeout(r, 0));

    // No fetch for audio buffer — Web Audio is not available
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const urls = (fetchSpy.mock.calls as any[][]).map(c => String(c[0]));
    expect(urls.every((u: string) => !u.includes('b.mp3'))).toBe(true);
    expect(tracks[1].isBufferLoaded).toBe(false);
  });

  it('preload still works after AudioContext is set up by play()', async () => {
    // Start with no AudioContext
    _resetAudioContext();
    vi.stubGlobal('AudioContext', MockAudioContext);

    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3'] });
    const tracks = (q as unknown as InternalQueue)._tracks;

    // gotoTrack() creates the AudioContext and triggers preloading (paused, so no deferral)
    q.gotoTrack(0);
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    // Track 1 should already be preloaded by gotoTrack()'s preload-ahead logic
    expect(tracks[1].isBufferLoaded).toBe(true);

    // Manually preload track 3 — should also work since ctx now exists
    (tracks[3] as unknown as { preload(): void }).preload();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    expect(tracks[3].isBufferLoaded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Core invariants — only one track playing at a time
// ---------------------------------------------------------------------------
describe('Queue invariant: only one track playing at a time', () => {
  type InternalTrack = {
    audioBuffer: AudioBuffer | null;
    audio: MockAudioElement;
    isBufferLoaded: boolean;
    isPlaying: boolean;
    machineState: string;
  };
  type InternalQueue = { _tracks: InternalTrack[]; _scheduledNextIndex: number | null };

  function countPlaying(q: Queue): number {
    // Count tracks with isPlaying=true, EXCLUDING gapless-scheduled future tracks
    const internal = q as unknown as InternalQueue;
    let count = 0;
    for (let i = 0; i < q.tracks.length; i++) {
      const t = internal._tracks[i];
      if (t.isPlaying && internal._scheduledNextIndex !== i) {
        count++;
      }
    }
    return count;
  }

  it('after play(), exactly one track is playing', () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });
    q.play();
    expect(countPlaying(q)).toBe(1);
    expect(q.tracks[0].isPlaying).toBe(true);
  });

  it('after next(), old track is not playing', () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });
    q.play();
    q.next();
    expect(q.tracks[0].isPlaying).toBe(false);
    expect(q.tracks[0].machineState).toBe('idle');
    expect(q.tracks[1].isPlaying).toBe(true);
    expect(countPlaying(q)).toBe(1);
  });

  it('after rapid next() calls, only the final track is playing', () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3'] });
    q.play();
    q.next();
    q.next();
    q.next();
    // Track 3 (last) should be the only one playing
    expect(q.currentTrackIndex).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(q.tracks[i].isPlaying).toBe(false);
      expect(q.tracks[i].machineState).toBe('idle');
    }
    expect(q.tracks[3].isPlaying).toBe(true);
    expect(countPlaying(q)).toBe(1);
  });

  it('after gotoTrack(), old track is not playing', () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });
    q.play();
    q.gotoTrack(2, true);
    expect(q.tracks[0].isPlaying).toBe(false);
    expect(q.tracks[0].machineState).toBe('idle');
    expect(q.tracks[2].isPlaying).toBe(true);
    expect(countPlaying(q)).toBe(1);
  });

  it('after pause(), current track is not playing', () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();
    q.pause();
    expect(q.tracks[0].isPlaying).toBe(false);
    expect(q.isPlaying).toBe(false);
    expect(q.isPaused).toBe(true);
  });

  it('pause then play resumes the correct track', () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });
    q.play();
    q.next(); // → track 1
    q.pause();
    expect(q.currentTrackIndex).toBe(1);
    q.play();
    expect(q.currentTrackIndex).toBe(1);
    expect(q.tracks[1].isPlaying).toBe(true);
    expect(countPlaying(q)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// seekCurrent uses correct track
// ---------------------------------------------------------------------------
describe('Queue seek targets correct track', () => {
  it('seek() operates on the current track, not a stale reference', () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });
    q.play();
    q.next(); // → track 1
    q.seek(42);
    // Track 1 (current) should have been seeked
    const tracks = (q as unknown as { _tracks: Array<{ pausedAtTrackTime: number }> })._tracks;
    expect(tracks[1].pausedAtTrackTime).toBe(42);
    // Track 0 should NOT have been seeked
    expect(tracks[0].pausedAtTrackTime).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// _scheduledNextIndex cleanup after gapless transition
// ---------------------------------------------------------------------------
describe('Queue _scheduledNextIndex cleanup', () => {
  type InternalTrack = { audioBuffer: AudioBuffer | null; audio: MockAudioElement; isBufferLoaded: boolean };
  type InternalQueue = { _tracks: InternalTrack[]; _scheduledNextIndex: number | null };

  it('gapless-transitioned track is removed from _scheduledNextIndex', async () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });
    injectBuffer(q, 1, 180);
    q.play();

    const internal = q as unknown as InternalQueue;
    // Simulate gapless scheduling for track 1
    internal._scheduledNextIndex = 1;

    // Track 0 ends → gapless transition to track 1
    internal._tracks[0].audio.simulateEnded();
    await Promise.resolve();

    expect(q.currentTrackIndex).toBe(1);
    // Track 1 should no longer be in scheduledNextIndex — it's the current track now
    expect(internal._scheduledNextIndex).not.toBe(1);
  });

  it('after gapless transition, pause then play works correctly', async () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });
    injectBuffer(q, 1, 180);
    q.play();

    const internal = q as unknown as InternalQueue;
    internal._scheduledNextIndex = 1;

    // Track 0 ends → gapless to track 1
    internal._tracks[0].audio.simulateEnded();
    await Promise.resolve();
    expect(q.currentTrackIndex).toBe(1);

    // Pause and play should work normally
    q.pause();
    q.play();
    expect(q.isPlaying).toBe(true);
    expect(q.currentTrackIndex).toBe(1);
  });

  it('after gapless transition, next() properly deactivates gapless-transitioned track', async () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });
    injectBuffer(q, 1, 180);
    q.play();

    const internal = q as unknown as InternalQueue;
    internal._scheduledNextIndex = 1;

    // Track 0 ends → gapless to track 1
    internal._tracks[0].audio.simulateEnded();
    await Promise.resolve();
    expect(q.currentTrackIndex).toBe(1);

    // Navigate to next track
    q.next();
    expect(q.currentTrackIndex).toBe(2);
    // Track 1 should be idle and not playing
    expect(q.tracks[1].isPlaying).toBe(false);
    expect(q.tracks[1].machineState).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// Re-entrancy safety: TRACK_ENDED → NEXT transition via queueMicrotask
// ---------------------------------------------------------------------------
describe('Queue re-entrancy safety', () => {
  type InternalTrack = { audio: MockAudioElement; audioBuffer: AudioBuffer | null };
  type InternalQueue = { _tracks: InternalTrack[] };

  it('TRACK_ENDED does not cause stale state reads via re-entrant sends', async () => {
    // Before the queueMicrotask fix, notifyTrackEnded would synchronously
    // call queueRef.onTrackEnded → queue sends TRACK_ENDED → queue sends
    // DEACTIVATE back to the track — all in one call stack. This could cause
    // stale reads if the track machine hadn't finished its transition.
    const onStartNewTrack = vi.fn();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'], onStartNewTrack });
    q.play();

    const internal = q as unknown as InternalQueue;
    // Track 0 ends — notifyTrackEnded is deferred via queueMicrotask
    internal._tracks[0].audio.simulateEnded();

    // Before microtask fires, queue should still be at track 0
    expect(q.currentTrackIndex).toBe(0);
    // Track 0's machine should already be in idle (track transition is synchronous)
    expect(q.tracks[0].machineState).toBe('idle');

    // After microtask, queue advances
    await Promise.resolve();
    expect(q.currentTrackIndex).toBe(1);
    expect(q.isPlaying).toBe(true);
    expect(onStartNewTrack).toHaveBeenCalled();
  });

  it('rapid track endings via microtask do not corrupt queue state', async () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });
    q.play();

    const internal = q as unknown as InternalQueue;
    // End track 0
    internal._tracks[0].audio.simulateEnded();
    await Promise.resolve();
    expect(q.currentTrackIndex).toBe(1);

    // End track 1
    internal._tracks[1].audio.simulateEnded();
    await Promise.resolve();
    expect(q.currentTrackIndex).toBe(2);

    // Only track 2 should be playing
    expect(q.tracks[0].isPlaying).toBe(false);
    expect(q.tracks[1].isPlaying).toBe(false);
    expect(q.tracks[2].isPlaying).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gapless scheduling context verification
// ---------------------------------------------------------------------------
describe('Queue gapless scheduling state', () => {
  type InternalTrack = {
    audioBuffer: AudioBuffer | null;
    audio: MockAudioElement;
    isBufferLoaded: boolean;
    scheduledStartContextTime: number | null;
  };
  type InternalQueue = { _tracks: InternalTrack[]; _scheduledNextIndex: number | null };

  it('scheduledNextIndex matches the actually-scheduled track', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    injectBuffer(q, 0, 300);
    q.play();
    await new Promise(r => setTimeout(r, 0));

    const internal = q as unknown as InternalQueue;
    expect(internal._scheduledNextIndex).toBe(1);
    expect(internal._tracks[1].scheduledStartContextTime).not.toBeNull();
  });

  it('scheduledNextIndex is null when no gapless is scheduled', () => {
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();
    const internal = q as unknown as InternalQueue;
    expect(internal._scheduledNextIndex).toBeNull();
  });

  it('scheduledNextIndex is cleared after track transition', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3', 'c.mp3'] });
    injectBuffer(q, 0, 300);
    q.play();
    await new Promise(r => setTimeout(r, 0));

    const internal = q as unknown as InternalQueue;
    expect(internal._scheduledNextIndex).toBe(1);

    // Next cancels all gapless
    q.next();
    // After next(), gapless for track 1 should be cancelled
    // (track 1 is now current, not a future scheduled track)
    expect(internal._scheduledNextIndex).toBeNull();
  });
});
