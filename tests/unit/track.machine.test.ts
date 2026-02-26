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
    webAudioStartedAt: 0,
    pausedAtTrackTime: 0,
    isPlaying: false,
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

    it('updates seek time on SEEK', () => {
      const a = actorAt(makeCtx(), 'html5');
      a.send({ type: 'SEEK', time: 45.5 });
      expect(a.getSnapshot().context.pausedAtTrackTime).toBe(45.5);
    });

    it('transitions html5 → loading on DEACTIVATE', () => {
      const a = actorAt(makeCtx(), 'html5');
      a.send({ type: 'DEACTIVATE' });
      expect(a.getSnapshot().value).toBe('loading');
      expect(a.getSnapshot().context.isPlaying).toBe(false);
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
    it('BUFFER_READY in loading stays in loading and marks LOADED', () => {
      const a = actorAt(makeCtx(), 'loading');
      a.send({ type: 'BUFFER_READY' });
      expect(a.getSnapshot().value).toBe('loading');
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

    it('BUFFER_READY in loading does not set isPlaying or playbackType', () => {
      const a = actorAt(makeCtx(), 'loading');
      a.send({ type: 'BUFFER_READY' });
      expect(a.getSnapshot().value).toBe('loading');
      expect(a.getSnapshot().context.playbackType).toBe('HTML5');
      expect(a.getSnapshot().context.isPlaying).toBe(false);
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
      expect(a.getSnapshot().value).toBe('loading');
      expect(a.getSnapshot().context.isPlaying).toBe(false);
      a.send({ type: 'PLAY_WEBAUDIO' });
      expect(a.getSnapshot().value).toBe('webaudio');
      expect(a.getSnapshot().context.isPlaying).toBe(true);
    });

    it('updates seek time on SEEK', () => {
      const a = actorAt(makeCtx(), 'webaudio');
      a.send({ type: 'SEEK', time: 120 });
      expect(a.getSnapshot().context.pausedAtTrackTime).toBe(120);
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
});
