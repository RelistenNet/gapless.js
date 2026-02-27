// ---------------------------------------------------------------------------
// TrackMachine — state-transition tests (xstate v5)
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { createActor } from 'xstate';
import { createTrackMachine } from '../../src/machines/track.machine';
import type { TrackContext } from '../../src/machines/track.machine';

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
    fetchDecodeRef: null,
    ...overrides,
  };
}

function actorAt(ctx: TrackContext, state?: string) {
  const actor = createActor(createTrackMachine(ctx));
  actor.start();
  if (state === 'html5') {
    actor.send({ type: 'PLAY' });
  } else if (state === 'loading') {
    actor.send({ type: 'PRELOAD' });
  } else if (state === 'webaudio') {
    actor.send({ type: 'PRELOAD' });
    actor.send({ type: 'PLAY_WEBAUDIO' });
  }
  return actor;
}

describe('TrackMachine', () => {
  describe('idle state', () => {
    it('transitions idle → html5 on PLAY', () => {
      const a = actorAt(makeCtx());
      a.send({ type: 'PLAY' });
      expect(a.getSnapshot().value).toBe('html5');
      expect(a.getSnapshot().context.isPlaying).toBe(true);
    });

    it('transitions idle → loading on PRELOAD', () => {
      const a = actorAt(makeCtx());
      a.send({ type: 'PRELOAD' });
      expect(a.getSnapshot().value).toBe('loading');
    });

    it('updates resolvedUrl on URL_RESOLVED', () => {
      const a = actorAt(makeCtx());
      a.send({ type: 'URL_RESOLVED', url: 'https://cdn.example.com/track.mp3' });
      expect(a.getSnapshot().context.resolvedUrl).toBe('https://cdn.example.com/track.mp3');
    });

    it('BUFFER_READY in idle updates webAudioLoadingState to LOADED', () => {
      const a = actorAt(makeCtx());
      a.send({ type: 'BUFFER_READY' });
      expect(a.getSnapshot().value).toBe('idle');
      expect(a.getSnapshot().context.webAudioLoadingState).toBe('LOADED');
    });

    it('BUFFER_ERROR in idle updates webAudioLoadingState to ERROR', () => {
      const a = actorAt(makeCtx());
      a.send({ type: 'BUFFER_ERROR' });
      expect(a.getSnapshot().value).toBe('idle');
      expect(a.getSnapshot().context.webAudioLoadingState).toBe('ERROR');
    });

    it('full cycle: html5 → BUFFER_READY → DEACTIVATE → idle → PLAY_WEBAUDIO → webaudio', () => {
      const a = actorAt(makeCtx(), 'html5');
      // Buffer loads while playing HTML5
      a.send({ type: 'BUFFER_READY' });
      expect(a.getSnapshot().value).toBe('html5');
      expect(a.getSnapshot().context.webAudioLoadingState).toBe('LOADED');
      // Track gets deactivated (e.g. user skips away)
      a.send({ type: 'DEACTIVATE' });
      expect(a.getSnapshot().value).toBe('idle');
      expect(a.getSnapshot().context.webAudioLoadingState).toBe('LOADED');
      // Track is re-activated and plays via Web Audio
      a.send({ type: 'PLAY_WEBAUDIO' });
      expect(a.getSnapshot().value).toBe('webaudio');
      expect(a.getSnapshot().context.isPlaying).toBe(true);
      expect(a.getSnapshot().context.playbackType).toBe('WEBAUDIO');
    });
  });

  describe('html5 state', () => {
    it('marks isPlaying false on PAUSE', () => {
      const a = actorAt(makeCtx(), 'html5');
      a.send({ type: 'PAUSE' });
      expect(a.getSnapshot().value).toBe('html5');
      expect(a.getSnapshot().context.isPlaying).toBe(false);
    });

    it('marks isPlaying true on PLAY', () => {
      const a = actorAt(makeCtx(), 'html5');
      a.send({ type: 'PAUSE' });
      a.send({ type: 'PLAY' });
      expect(a.getSnapshot().context.isPlaying).toBe(true);
    });

    // Bug #2 regression: BUFFER_READY in html5 stays in html5
    it('BUFFER_READY in html5 stays in html5 and updates webAudioLoadingState', () => {
      const a = actorAt(makeCtx(), 'html5');
      a.send({ type: 'BUFFER_READY' });
      expect(a.getSnapshot().value).toBe('html5');
      expect(a.getSnapshot().context.webAudioLoadingState).toBe('LOADED');
      expect(a.getSnapshot().context.playbackType).toBe('HTML5');
    });

    it('stays html5 on BUFFER_ERROR but marks loading state as ERROR', () => {
      const a = actorAt(makeCtx(), 'html5');
      a.send({ type: 'BUFFER_ERROR' });
      expect(a.getSnapshot().value).toBe('html5');
      expect(a.getSnapshot().context.webAudioLoadingState).toBe('ERROR');
    });

    it('transitions html5 → idle on HTML5_ENDED', () => {
      const a = actorAt(makeCtx(), 'html5');
      a.send({ type: 'HTML5_ENDED' });
      expect(a.getSnapshot().value).toBe('idle');
      expect(a.getSnapshot().context.isPlaying).toBe(false);
    });

    it('stays in html5 on SEEK', () => {
      const a = actorAt(makeCtx(), 'html5');
      a.send({ type: 'SEEK', time: 45.5 });
      expect(a.getSnapshot().value).toBe('html5');
    });

    it('transitions html5 → idle on DEACTIVATE', () => {
      const a = actorAt(makeCtx(), 'html5');
      a.send({ type: 'DEACTIVATE' });
      expect(a.getSnapshot().value).toBe('idle');
      expect(a.getSnapshot().context.isPlaying).toBe(false);
    });

    it('DEACTIVATE from html5 preserves webAudioLoadingState (LOADED stays LOADED)', () => {
      const a = actorAt(makeCtx(), 'html5');
      a.send({ type: 'BUFFER_READY' });
      expect(a.getSnapshot().context.webAudioLoadingState).toBe('LOADED');
      a.send({ type: 'DEACTIVATE' });
      expect(a.getSnapshot().value).toBe('idle');
      expect(a.getSnapshot().context.webAudioLoadingState).toBe('LOADED');
    });

    it('transitions html5 → webaudio on PLAY_WEBAUDIO', () => {
      const a = actorAt(makeCtx(), 'html5');
      a.send({ type: 'PLAY_WEBAUDIO' });
      expect(a.getSnapshot().value).toBe('webaudio');
      expect(a.getSnapshot().context.isPlaying).toBe(true);
      expect(a.getSnapshot().context.playbackType).toBe('WEBAUDIO');
    });
  });

  describe('loading state', () => {
    it('BUFFER_READY in loading transitions to idle and marks LOADED', () => {
      const a = actorAt(makeCtx(), 'loading');
      a.send({ type: 'BUFFER_READY' });
      expect(a.getSnapshot().value).toBe('idle');
      expect(a.getSnapshot().context.webAudioLoadingState).toBe('LOADED');
    });

    it('transitions loading → idle on BUFFER_ERROR', () => {
      const a = actorAt(makeCtx(), 'loading');
      a.send({ type: 'BUFFER_ERROR' });
      expect(a.getSnapshot().value).toBe('idle');
      expect(a.getSnapshot().context.webAudioLoadingState).toBe('ERROR');
    });

    it('transitions loading → html5 on PLAY', () => {
      const a = actorAt(makeCtx(), 'loading');
      a.send({ type: 'PLAY' });
      expect(a.getSnapshot().value).toBe('html5');
      expect(a.getSnapshot().context.isPlaying).toBe(true);
    });

    // Regression: BUFFER_READY in loading must transition to idle (not stay in loading)
    it('BUFFER_READY in loading transitions to idle so track is not stuck', () => {
      const a = actorAt(makeCtx(), 'loading');
      a.send({ type: 'BUFFER_READY' });
      // Must be idle, not loading — a preloaded track with a decoded buffer
      // should be idle (ready to play), not stuck in the loading state
      expect(a.getSnapshot().value).toBe('idle');
      expect(a.getSnapshot().context.webAudioLoadingState).toBe('LOADED');
      // Can still transition to webaudio when activated
      a.send({ type: 'PLAY_WEBAUDIO' });
      expect(a.getSnapshot().value).toBe('webaudio');
      expect(a.getSnapshot().context.isPlaying).toBe(true);
    });

    it('BUFFER_READY in loading does not set isPlaying or playbackType', () => {
      const a = actorAt(makeCtx(), 'loading');
      a.send({ type: 'BUFFER_READY' });
      expect(a.getSnapshot().value).toBe('idle');
      expect(a.getSnapshot().context.playbackType).toBe('HTML5');
      expect(a.getSnapshot().context.isPlaying).toBe(false);
    });

    it('transitions loading → idle on DEACTIVATE', () => {
      const a = actorAt(makeCtx(), 'loading');
      a.send({ type: 'DEACTIVATE' });
      expect(a.getSnapshot().value).toBe('idle');
      expect(a.getSnapshot().context.isPlaying).toBe(false);
    });

    it('DEACTIVATE from loading preserves in-progress webAudioLoadingState', () => {
      const a = actorAt(makeCtx(), 'loading');
      a.send({ type: 'BUFFER_LOADING' });
      expect(a.getSnapshot().context.webAudioLoadingState).toBe('LOADING');
      a.send({ type: 'DEACTIVATE' });
      expect(a.getSnapshot().value).toBe('idle');
      expect(a.getSnapshot().context.webAudioLoadingState).toBe('LOADING');
    });
  });

  describe('webaudio state', () => {
    it('marks isPlaying false on PAUSE', () => {
      const a = actorAt(makeCtx(), 'webaudio');
      a.send({ type: 'PLAY_WEBAUDIO' }); // set isPlaying true
      a.send({ type: 'PAUSE' });
      expect(a.getSnapshot().context.isPlaying).toBe(false);
    });

    it('marks isPlaying true on PLAY', () => {
      const a = actorAt(makeCtx(), 'webaudio');
      a.send({ type: 'PLAY' });
      expect(a.getSnapshot().context.isPlaying).toBe(true);
    });

    it('PLAY_WEBAUDIO in webaudio keeps isPlaying true', () => {
      const a = actorAt(makeCtx(), 'webaudio');
      expect(a.getSnapshot().context.isPlaying).toBe(true);
      a.send({ type: 'PLAY_WEBAUDIO' });
      expect(a.getSnapshot().value).toBe('webaudio');
      expect(a.getSnapshot().context.isPlaying).toBe(true);
      expect(a.getSnapshot().context.playbackType).toBe('WEBAUDIO');
    });

    it('PLAY_WEBAUDIO regression: full path loading → BUFFER_READY → PLAY_WEBAUDIO', () => {
      const a = actorAt(makeCtx());
      a.send({ type: 'PRELOAD' });
      a.send({ type: 'BUFFER_READY' });
      expect(a.getSnapshot().value).toBe('idle');
      expect(a.getSnapshot().context.isPlaying).toBe(false);
      a.send({ type: 'PLAY_WEBAUDIO' });
      expect(a.getSnapshot().value).toBe('webaudio');
      expect(a.getSnapshot().context.isPlaying).toBe(true);
    });

    it('stays in webaudio on SEEK', () => {
      const a = actorAt(makeCtx(), 'webaudio');
      a.send({ type: 'SEEK', time: 120 });
      expect(a.getSnapshot().value).toBe('webaudio');
    });

    it('transitions webaudio → idle on WEBAUDIO_ENDED', () => {
      const a = actorAt(makeCtx(), 'webaudio');
      a.send({ type: 'PLAY_WEBAUDIO' }); // set isPlaying true
      a.send({ type: 'WEBAUDIO_ENDED' });
      expect(a.getSnapshot().value).toBe('idle');
      expect(a.getSnapshot().context.isPlaying).toBe(false);
    });

    // Bug #3 regression: DEACTIVATE from webaudio → idle
    it('transitions webaudio → idle on DEACTIVATE', () => {
      const a = actorAt(makeCtx(), 'webaudio');
      a.send({ type: 'PLAY_WEBAUDIO' });
      a.send({ type: 'DEACTIVATE' });
      expect(a.getSnapshot().value).toBe('idle');
      expect(a.getSnapshot().context.isPlaying).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Invariant: "Web Audio always wins eventually"
  //
  // Once a track's buffer decodes (BUFFER_READY), webAudioLoadingState must
  // reach 'LOADED' and stay there through any deactivate/reactivate cycle, so
  // the next play() can use Web Audio. We do NOT switch mid-stream — a track
  // playing HTML5 stays on HTML5 until the next play().
  // ---------------------------------------------------------------------------
  describe('invariant: Web Audio always wins eventually', () => {
    it('buffer ready while in html5 → deactivate → re-play uses Web Audio', () => {
      const a = actorAt(makeCtx(), 'html5');
      a.send({ type: 'BUFFER_READY' });
      // Stays in html5 (no mid-stream switch)
      expect(a.getSnapshot().value).toBe('html5');
      expect(a.getSnapshot().context.webAudioLoadingState).toBe('LOADED');
      // Deactivate (user skips away)
      a.send({ type: 'DEACTIVATE' });
      expect(a.getSnapshot().value).toBe('idle');
      // webAudioLoadingState survived the deactivate
      expect(a.getSnapshot().context.webAudioLoadingState).toBe('LOADED');
      // Next play uses Web Audio
      a.send({ type: 'PLAY_WEBAUDIO' });
      expect(a.getSnapshot().value).toBe('webaudio');
    });

    it('buffer ready while in idle (deactivated before decode finished)', () => {
      const a = actorAt(makeCtx(), 'html5');
      a.send({ type: 'BUFFER_LOADING' });
      // Deactivate while still decoding
      a.send({ type: 'DEACTIVATE' });
      expect(a.getSnapshot().value).toBe('idle');
      expect(a.getSnapshot().context.webAudioLoadingState).toBe('LOADING');
      // Decode finishes — idle handles BUFFER_READY
      a.send({ type: 'BUFFER_READY' });
      expect(a.getSnapshot().value).toBe('idle');
      expect(a.getSnapshot().context.webAudioLoadingState).toBe('LOADED');
      // Next play uses Web Audio
      a.send({ type: 'PLAY_WEBAUDIO' });
      expect(a.getSnapshot().value).toBe('webaudio');
    });

    it('buffer ready while in loading (preloaded, not yet played)', () => {
      const a = actorAt(makeCtx(), 'loading');
      a.send({ type: 'BUFFER_READY' });
      expect(a.getSnapshot().value).toBe('idle');
      expect(a.getSnapshot().context.webAudioLoadingState).toBe('LOADED');
      a.send({ type: 'PLAY_WEBAUDIO' });
      expect(a.getSnapshot().value).toBe('webaudio');
    });

    it('buffer ready after loading → deactivate → idle', () => {
      const a = actorAt(makeCtx(), 'loading');
      a.send({ type: 'BUFFER_LOADING' });
      // Deactivate from loading (e.g. activate() reset)
      a.send({ type: 'DEACTIVATE' });
      expect(a.getSnapshot().value).toBe('idle');
      expect(a.getSnapshot().context.webAudioLoadingState).toBe('LOADING');
      // Decode finishes
      a.send({ type: 'BUFFER_READY' });
      expect(a.getSnapshot().context.webAudioLoadingState).toBe('LOADED');
      // Next play uses Web Audio
      a.send({ type: 'PLAY_WEBAUDIO' });
      expect(a.getSnapshot().value).toBe('webaudio');
    });

    it('DEACTIVATE from any playing state always lands in idle', () => {
      // From html5
      const a1 = actorAt(makeCtx(), 'html5');
      a1.send({ type: 'DEACTIVATE' });
      expect(a1.getSnapshot().value).toBe('idle');

      // From webaudio
      const a2 = actorAt(makeCtx(), 'webaudio');
      a2.send({ type: 'DEACTIVATE' });
      expect(a2.getSnapshot().value).toBe('idle');

      // From loading
      const a3 = actorAt(makeCtx(), 'loading');
      a3.send({ type: 'DEACTIVATE' });
      expect(a3.getSnapshot().value).toBe('idle');
    });

    it('webAudioLoadingState is never lost through deactivate cycles', () => {
      const a = actorAt(makeCtx(), 'html5');
      a.send({ type: 'BUFFER_READY' });
      // Deactivate and reactivate multiple times
      a.send({ type: 'DEACTIVATE' });
      expect(a.getSnapshot().context.webAudioLoadingState).toBe('LOADED');
      a.send({ type: 'PLAY' }); // play as html5 again
      a.send({ type: 'DEACTIVATE' });
      expect(a.getSnapshot().context.webAudioLoadingState).toBe('LOADED');
      a.send({ type: 'PLAY' });
      a.send({ type: 'DEACTIVATE' });
      expect(a.getSnapshot().context.webAudioLoadingState).toBe('LOADED');
      // Still available for Web Audio
      a.send({ type: 'PLAY_WEBAUDIO' });
      expect(a.getSnapshot().value).toBe('webaudio');
    });
  });

  // ---------------------------------------------------------------------------
  // START_FETCH event
  // ---------------------------------------------------------------------------
  describe('START_FETCH event', () => {
    it('sets webAudioLoadingState to LOADING and spawns fetchDecodeRef', () => {
      const a = actorAt(makeCtx());
      a.send({ type: 'START_FETCH' });
      const snap = a.getSnapshot();
      expect(snap.context.webAudioLoadingState).toBe('LOADING');
      expect(snap.context.fetchDecodeRef).not.toBeNull();
    });

    it('guard prevents double-spawn when already LOADING', () => {
      const a = actorAt(makeCtx());
      a.send({ type: 'START_FETCH' });
      const ref1 = a.getSnapshot().context.fetchDecodeRef;
      // Send START_FETCH again — guard should prevent it
      a.send({ type: 'START_FETCH' });
      const ref2 = a.getSnapshot().context.fetchDecodeRef;
      expect(ref1).toBe(ref2);
    });

    it('guard prevents spawn when webAudioLoadingState is not NONE', () => {
      const a = actorAt(makeCtx({ webAudioLoadingState: 'LOADED' }));
      a.send({ type: 'START_FETCH' });
      expect(a.getSnapshot().context.fetchDecodeRef).toBeNull();
    });

    it('START_FETCH works from html5 state', () => {
      const a = actorAt(makeCtx(), 'html5');
      a.send({ type: 'START_FETCH' });
      expect(a.getSnapshot().context.webAudioLoadingState).toBe('LOADING');
      expect(a.getSnapshot().context.fetchDecodeRef).not.toBeNull();
      // Still in html5
      expect(a.getSnapshot().value).toBe('html5');
    });

    it('START_FETCH works from loading state', () => {
      const a = actorAt(makeCtx(), 'loading');
      a.send({ type: 'START_FETCH' });
      expect(a.getSnapshot().context.webAudioLoadingState).toBe('LOADING');
      expect(a.getSnapshot().context.fetchDecodeRef).not.toBeNull();
      // Still in loading
      expect(a.getSnapshot().value).toBe('loading');
    });
  });
});
