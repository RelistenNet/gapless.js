// ---------------------------------------------------------------------------
// QueueMachine — state-transition tests (xstate v5)
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { createActor } from 'xstate';
import { createQueueMachine } from '../../src/machines/queue.machine';
import type { QueueContext } from '../../src/machines/queue.machine';

function makeCtx(overrides: Partial<QueueContext> = {}): QueueContext {
  return {
    currentTrackIndex: 0,
    trackCount: 3,
    ...overrides,
  };
}

function actorFrom(ctx: QueueContext, initialState?: string) {
  const actor = createActor(createQueueMachine(ctx));
  actor.start();
  // Drive to the desired initial state
  if (initialState === 'playing') {
    actor.send({ type: 'PLAY' });
  } else if (initialState === 'paused') {
    actor.send({ type: 'PLAY' });
    actor.send({ type: 'PAUSE' });
  } else if (initialState === 'ended') {
    // Drive to ended by ending all tracks
    for (let i = ctx.currentTrackIndex; i < ctx.trackCount - 1; i++) {
      actor.send({ type: 'PLAY' });
      actor.send({ type: 'TRACK_ENDED' });
    }
    // Now on last track — one more TRACK_ENDED
    if (actor.getSnapshot().value !== 'ended') {
      actor.send({ type: 'PLAY' });
      actor.send({ type: 'TRACK_ENDED' });
    }
  }
  return actor;
}

describe('QueueMachine', () => {
  describe('idle state', () => {
    it('transitions idle → playing on PLAY', () => {
      const a = actorFrom(makeCtx());
      a.send({ type: 'PLAY' });
      expect(a.getSnapshot().value).toBe('playing');
    });

    it('stays in idle on ADD_TRACK and increments trackCount', () => {
      const a = actorFrom(makeCtx({ trackCount: 2 }));
      a.send({ type: 'ADD_TRACK' });
      expect(a.getSnapshot().value).toBe('idle');
      expect(a.getSnapshot().context.trackCount).toBe(3);
    });

    it('transitions idle → paused on GOTO without playImmediately', () => {
      const a = actorFrom(makeCtx());
      a.send({ type: 'GOTO', index: 2 });
      expect(a.getSnapshot().value).toBe('paused');
      expect(a.getSnapshot().context.currentTrackIndex).toBe(2);
    });

    // Bug #1 regression: GOTO with playImmediately from idle → playing
    it('transitions idle → playing on GOTO with playImmediately=true', () => {
      const a = actorFrom(makeCtx());
      a.send({ type: 'GOTO', index: 1, playImmediately: true });
      expect(a.getSnapshot().value).toBe('playing');
      expect(a.getSnapshot().context.currentTrackIndex).toBe(1);
    });
  });

  describe('playing state', () => {
    it('transitions playing → paused on PAUSE', () => {
      const a = actorFrom(makeCtx(), 'playing');
      a.send({ type: 'PAUSE' });
      expect(a.getSnapshot().value).toBe('paused');
    });

    it('transitions playing → paused on TOGGLE', () => {
      const a = actorFrom(makeCtx(), 'playing');
      a.send({ type: 'TOGGLE' });
      expect(a.getSnapshot().value).toBe('paused');
    });

    it('advances index on NEXT (stays playing)', () => {
      const a = actorFrom(makeCtx({ currentTrackIndex: 0, trackCount: 3 }), 'playing');
      a.send({ type: 'NEXT' });
      expect(a.getSnapshot().value).toBe('playing');
      expect(a.getSnapshot().context.currentTrackIndex).toBe(1);
    });

    it('does not advance past last track on NEXT', () => {
      const a = actorFrom(makeCtx({ currentTrackIndex: 2, trackCount: 3 }), 'playing');
      a.send({ type: 'NEXT' });
      expect(a.getSnapshot().context.currentTrackIndex).toBe(2);
    });

    it('decrements index on PREVIOUS', () => {
      const a = actorFrom(makeCtx({ currentTrackIndex: 2 }), 'playing');
      a.send({ type: 'PREVIOUS' });
      expect(a.getSnapshot().context.currentTrackIndex).toBe(1);
    });

    it('does not go below 0 on PREVIOUS', () => {
      const a = actorFrom(makeCtx({ currentTrackIndex: 0 }), 'playing');
      a.send({ type: 'PREVIOUS' });
      expect(a.getSnapshot().context.currentTrackIndex).toBe(0);
    });

    it('transitions playing → ended when last track ends', () => {
      const a = actorFrom(makeCtx({ currentTrackIndex: 2, trackCount: 3 }), 'playing');
      a.send({ type: 'TRACK_ENDED' });
      expect(a.getSnapshot().value).toBe('ended');
    });

    it('advances to next track on TRACK_ENDED when not last', () => {
      const a = actorFrom(makeCtx({ currentTrackIndex: 0, trackCount: 3 }), 'playing');
      a.send({ type: 'TRACK_ENDED' });
      expect(a.getSnapshot().value).toBe('playing');
      expect(a.getSnapshot().context.currentTrackIndex).toBe(1);
    });

    it('jumps to GOTO index', () => {
      const a = actorFrom(makeCtx(), 'playing');
      a.send({ type: 'GOTO', index: 2 });
      expect(a.getSnapshot().value).toBe('playing');
      expect(a.getSnapshot().context.currentTrackIndex).toBe(2);
    });

    it('adjusts currentTrackIndex when a track before current is removed', () => {
      const a = actorFrom(makeCtx({ currentTrackIndex: 2, trackCount: 4 }), 'playing');
      a.send({ type: 'REMOVE_TRACK', index: 1 });
      expect(a.getSnapshot().context.currentTrackIndex).toBe(1);
      expect(a.getSnapshot().context.trackCount).toBe(3);
    });

    it('does not adjust index when a track after current is removed', () => {
      const a = actorFrom(makeCtx({ currentTrackIndex: 1, trackCount: 4 }), 'playing');
      a.send({ type: 'REMOVE_TRACK', index: 3 });
      expect(a.getSnapshot().context.currentTrackIndex).toBe(1);
      expect(a.getSnapshot().context.trackCount).toBe(3);
    });
  });

  describe('paused state', () => {
    it('transitions paused → playing on PLAY', () => {
      const a = actorFrom(makeCtx(), 'paused');
      a.send({ type: 'PLAY' });
      expect(a.getSnapshot().value).toBe('playing');
    });

    it('transitions paused → playing on TOGGLE', () => {
      const a = actorFrom(makeCtx(), 'paused');
      a.send({ type: 'TOGGLE' });
      expect(a.getSnapshot().value).toBe('playing');
    });

    it('TRACK_ENDED in paused stays paused and advances index (not last track)', () => {
      const a = actorFrom(makeCtx({ currentTrackIndex: 0, trackCount: 3 }), 'paused');
      a.send({ type: 'TRACK_ENDED' });
      expect(a.getSnapshot().value).toBe('paused');
      expect(a.getSnapshot().context.currentTrackIndex).toBe(1);
    });

    it('TRACK_ENDED in paused does not auto-play', () => {
      const a = actorFrom(makeCtx({ currentTrackIndex: 0, trackCount: 3 }), 'paused');
      a.send({ type: 'TRACK_ENDED' });
      expect(a.getSnapshot().value).not.toBe('playing');
    });

    it('TRACK_ENDED in paused on last track goes to ended', () => {
      const a = actorFrom(makeCtx({ currentTrackIndex: 2, trackCount: 3 }), 'paused');
      a.send({ type: 'TRACK_ENDED' });
      expect(a.getSnapshot().value).toBe('ended');
    });

    it('after TRACK_ENDED while paused, PLAY starts (index already advanced)', () => {
      const a = actorFrom(makeCtx({ currentTrackIndex: 0, trackCount: 3 }), 'paused');
      a.send({ type: 'TRACK_ENDED' });
      expect(a.getSnapshot().context.currentTrackIndex).toBe(1);
      a.send({ type: 'PLAY' });
      expect(a.getSnapshot().value).toBe('playing');
    });

    // Bug #1 regression: GOTO with playImmediately from paused → playing
    it('transitions paused → playing on GOTO with playImmediately=true', () => {
      const a = actorFrom(makeCtx(), 'paused');
      a.send({ type: 'GOTO', index: 2, playImmediately: true });
      expect(a.getSnapshot().value).toBe('playing');
      expect(a.getSnapshot().context.currentTrackIndex).toBe(2);
    });
  });

  describe('ended state', () => {
    it('restarts from track 0 on PLAY', () => {
      const a = actorFrom(makeCtx({ currentTrackIndex: 0, trackCount: 1 }));
      a.send({ type: 'PLAY' });
      a.send({ type: 'TRACK_ENDED' });
      expect(a.getSnapshot().value).toBe('ended');
      a.send({ type: 'PLAY' });
      expect(a.getSnapshot().value).toBe('playing');
      expect(a.getSnapshot().context.currentTrackIndex).toBe(0);
    });

    it('transitions ended → paused on GOTO without playImmediately', () => {
      const a = actorFrom(makeCtx({ currentTrackIndex: 0, trackCount: 1 }));
      a.send({ type: 'PLAY' });
      a.send({ type: 'TRACK_ENDED' });
      a.send({ type: 'GOTO', index: 0 });
      expect(a.getSnapshot().value).toBe('paused');
    });

    // Bug #5 regression: REMOVE_TRACK should work in ended state (via root-level handler)
    it('REMOVE_TRACK works in ended state', () => {
      const a = actorFrom(makeCtx({ currentTrackIndex: 0, trackCount: 1 }));
      a.send({ type: 'PLAY' });
      a.send({ type: 'TRACK_ENDED' });
      expect(a.getSnapshot().value).toBe('ended');
      a.send({ type: 'ADD_TRACK' }); // trackCount → 2
      a.send({ type: 'REMOVE_TRACK', index: 1 });
      expect(a.getSnapshot().context.trackCount).toBe(1);
    });
  });
});
