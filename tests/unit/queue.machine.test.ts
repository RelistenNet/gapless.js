// ---------------------------------------------------------------------------
// QueueMachine — state-transition tests (xstate v5)
//
// The machine is generic over its entries and asks a PlayList about order, so
// these tests use plain strings and a small array-backed list.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { createActor } from 'xstate';
import { createQueueMachine } from '../../src/machines/queue.machine';
import type { PlayList } from '../../src/machines/queue.machine';
import type { RepeatMode } from '../../src/types';

type TestList = PlayList<string> & { items: string[]; repeat: RepeatMode };

function makeList(items: string[], repeat: RepeatMode = 'off'): TestList {
  const list: TestList = {
    items: [...items],
    repeat,
    next(t) {
      const i = list.items.indexOf(t);
      if (i === -1) return null;
      if (i + 1 < list.items.length) return list.items[i + 1];
      return list.repeat === 'all' && list.items.length > 1 ? list.items[0] : null;
    },
    previous: (t) => list.items[list.items.indexOf(t) - 1] ?? null,
    first: () => list.items[0] ?? null,
    size: () => list.items.length,
    repeatsCurrent: () =>
      list.repeat === 'one' || (list.repeat === 'all' && list.items.length === 1),
  };
  return list;
}

function actorFrom(
  opts: {
    items?: string[];
    current?: string;
    state?: 'playing' | 'paused';
    repeat?: RepeatMode;
  } = {}
) {
  const list = makeList(opts.items ?? ['a', 'b', 'c'], opts.repeat);
  const actor = createActor(
    createQueueMachine<string>({ current: opts.current ?? list.first(), list })
  );
  actor.start();
  if (opts.state === 'playing') {
    actor.send({ type: 'PLAY' });
  } else if (opts.state === 'paused') {
    actor.send({ type: 'PLAY' });
    actor.send({ type: 'PAUSE' });
  }
  return {
    actor,
    list,
    state: () => actor.getSnapshot().value,
    current: () => actor.getSnapshot().context.current,
  };
}

describe('QueueMachine', () => {
  describe('idle state', () => {
    it('transitions idle → playing on PLAY', () => {
      const m = actorFrom();
      m.actor.send({ type: 'PLAY' });
      expect(m.state()).toBe('playing');
    });

    it('stays in idle on LIST_CHANGED', () => {
      const m = actorFrom({ items: ['a', 'b'] });
      m.list.items.push('c');
      m.actor.send({ type: 'LIST_CHANGED', current: 'a' });
      expect(m.state()).toBe('idle');
      expect(m.current()).toBe('a');
    });

    it('transitions idle → paused on GOTO without playImmediately', () => {
      const m = actorFrom();
      m.actor.send({ type: 'GOTO', track: 'c' });
      expect(m.state()).toBe('paused');
      expect(m.current()).toBe('c');
    });

    // Bug #1 regression: GOTO with playImmediately from idle → playing
    it('transitions idle → playing on GOTO with playImmediately=true', () => {
      const m = actorFrom();
      m.actor.send({ type: 'GOTO', track: 'b', playImmediately: true });
      expect(m.state()).toBe('playing');
      expect(m.current()).toBe('b');
    });
  });

  describe('playing state', () => {
    it('transitions playing → paused on PAUSE', () => {
      const m = actorFrom({ state: 'playing' });
      m.actor.send({ type: 'PAUSE' });
      expect(m.state()).toBe('paused');
    });

    it('transitions playing → paused on TOGGLE', () => {
      const m = actorFrom({ state: 'playing' });
      m.actor.send({ type: 'TOGGLE' });
      expect(m.state()).toBe('paused');
    });

    it('advances on NEXT (stays playing)', () => {
      const m = actorFrom({ state: 'playing' });
      m.actor.send({ type: 'NEXT' });
      expect(m.state()).toBe('playing');
      expect(m.current()).toBe('b');
    });

    it('does not advance past the last entry on NEXT', () => {
      const m = actorFrom({ current: 'c', state: 'playing' });
      m.actor.send({ type: 'NEXT' });
      expect(m.current()).toBe('c');
    });

    it('goes back on PREVIOUS', () => {
      const m = actorFrom({ current: 'c', state: 'playing' });
      m.actor.send({ type: 'PREVIOUS' });
      expect(m.current()).toBe('b');
    });

    it('stays on the first entry on PREVIOUS', () => {
      const m = actorFrom({ state: 'playing' });
      m.actor.send({ type: 'PREVIOUS' });
      expect(m.current()).toBe('a');
    });

    it('transitions playing → ended when the last entry ends', () => {
      const m = actorFrom({ current: 'c', state: 'playing' });
      m.actor.send({ type: 'TRACK_ENDED' });
      expect(m.state()).toBe('ended');
    });

    it('advances to the next entry on TRACK_ENDED when not last', () => {
      const m = actorFrom({ state: 'playing' });
      m.actor.send({ type: 'TRACK_ENDED' });
      expect(m.state()).toBe('playing');
      expect(m.current()).toBe('b');
    });

    it('jumps on GOTO and keeps playing with playImmediately', () => {
      const m = actorFrom({ state: 'playing' });
      m.actor.send({ type: 'GOTO', track: 'c', playImmediately: true });
      expect(m.state()).toBe('playing');
      expect(m.current()).toBe('c');
    });

    it('jumps on GOTO and pauses without playImmediately', () => {
      // The old entry is deactivated and the new one isn't started, so the
      // queue is paused, not 'playing' with nothing playing.
      const m = actorFrom({ state: 'playing' });
      m.actor.send({ type: 'GOTO', track: 'c' });
      expect(m.state()).toBe('paused');
      expect(m.current()).toBe('c');
    });

    it('keeps the current entry when another one is removed', () => {
      const m = actorFrom({ items: ['a', 'b', 'c', 'd'], current: 'c', state: 'playing' });
      m.list.items.splice(1, 1); // remove 'b'
      m.actor.send({ type: 'REMOVE_TRACK', track: 'b', successor: 'c' });
      expect(m.current()).toBe('c');
      expect(m.state()).toBe('playing');
    });

    it('moves to the successor when the current entry is removed', () => {
      const m = actorFrom({ current: 'b', state: 'playing' });
      m.list.items.splice(1, 1); // remove 'b'
      m.actor.send({ type: 'REMOVE_TRACK', track: 'b', successor: 'c' });
      expect(m.current()).toBe('c');
      expect(m.state()).toBe('playing');
    });

    it('goes idle when the last entry is removed', () => {
      const m = actorFrom({ items: ['a'], state: 'playing' });
      m.list.items.length = 0;
      m.actor.send({ type: 'REMOVE_TRACK', track: 'a', successor: null });
      expect(m.state()).toBe('idle');
      expect(m.current()).toBeNull();
    });
  });

  describe('paused state', () => {
    it('transitions paused → playing on PLAY', () => {
      const m = actorFrom({ state: 'paused' });
      m.actor.send({ type: 'PLAY' });
      expect(m.state()).toBe('playing');
    });

    it('transitions paused → playing on TOGGLE', () => {
      const m = actorFrom({ state: 'paused' });
      m.actor.send({ type: 'TOGGLE' });
      expect(m.state()).toBe('playing');
    });

    it('TRACK_ENDED in paused stays paused and advances (not last)', () => {
      const m = actorFrom({ state: 'paused' });
      m.actor.send({ type: 'TRACK_ENDED' });
      expect(m.state()).toBe('paused');
      expect(m.current()).toBe('b');
    });

    it('TRACK_ENDED in paused on the last entry goes to ended', () => {
      const m = actorFrom({ current: 'c', state: 'paused' });
      m.actor.send({ type: 'TRACK_ENDED' });
      expect(m.state()).toBe('ended');
    });

    it('after TRACK_ENDED while paused, PLAY starts the advanced entry', () => {
      const m = actorFrom({ state: 'paused' });
      m.actor.send({ type: 'TRACK_ENDED' });
      expect(m.current()).toBe('b');
      m.actor.send({ type: 'PLAY' });
      expect(m.state()).toBe('playing');
    });

    // Bug #1 regression: GOTO with playImmediately from paused → playing
    it('transitions paused → playing on GOTO with playImmediately=true', () => {
      const m = actorFrom({ state: 'paused' });
      m.actor.send({ type: 'GOTO', track: 'c', playImmediately: true });
      expect(m.state()).toBe('playing');
      expect(m.current()).toBe('c');
    });
  });

  describe('ended state', () => {
    function ended() {
      const m = actorFrom({ items: ['a'] });
      m.actor.send({ type: 'PLAY' });
      m.actor.send({ type: 'TRACK_ENDED' });
      expect(m.state()).toBe('ended');
      return m;
    }

    it('restarts from the first entry on PLAY', () => {
      const m = ended();
      m.actor.send({ type: 'PLAY' });
      expect(m.state()).toBe('playing');
      expect(m.current()).toBe('a');
    });

    it('transitions ended → paused on GOTO without playImmediately', () => {
      const m = ended();
      m.actor.send({ type: 'GOTO', track: 'a' });
      expect(m.state()).toBe('paused');
    });

    it('LIST_CHANGED that puts something after the current entry leaves ended', () => {
      const m = ended();
      m.list.items.push('b');
      m.actor.send({ type: 'LIST_CHANGED', current: 'a' });
      expect(m.state()).toBe('paused');
      expect(m.current()).toBe('a');
    });

    it('LIST_CHANGED with nothing after the current entry stays ended', () => {
      const m = ended();
      m.list.items.unshift('z');
      m.actor.send({ type: 'LIST_CHANGED', current: 'a' });
      expect(m.state()).toBe('ended');
    });

    // Bug #5 regression: REMOVE_TRACK should work in ended state (via root-level handler)
    it('REMOVE_TRACK works in ended state', () => {
      const m = ended();
      m.list.items.push('b');
      m.actor.send({ type: 'LIST_CHANGED', current: 'a' });
      m.list.items.splice(1, 1);
      m.actor.send({ type: 'REMOVE_TRACK', track: 'b', successor: null });
      expect(m.current()).toBe('a');
    });
  });

  describe('LIST_CHANGED', () => {
    it('emptying the list goes idle from any state', () => {
      for (const state of ['playing', 'paused'] as const) {
        const m = actorFrom({ state });
        m.list.items.length = 0;
        m.actor.send({ type: 'LIST_CHANGED', current: null });
        expect(m.state()).toBe('idle');
        expect(m.current()).toBeNull();
      }
    });

    it('takes the current entry from the event, not from a position', () => {
      const m = actorFrom({ current: 'b', state: 'playing' });
      m.list.items.reverse(); // ['c', 'b', 'a']
      m.actor.send({ type: 'LIST_CHANGED', current: 'b' });
      expect(m.current()).toBe('b');
      expect(m.state()).toBe('playing');
      m.actor.send({ type: 'NEXT' });
      expect(m.current()).toBe('a'); // follows the new order
    });
  });

  describe('repeat (asked of the list)', () => {
    it("'all' wraps on TRACK_ENDED and on NEXT", () => {
      const m = actorFrom({ current: 'c', state: 'playing', repeat: 'all' });
      m.actor.send({ type: 'TRACK_ENDED' });
      expect(m.state()).toBe('playing');
      expect(m.current()).toBe('a');

      m.actor.send({ type: 'GOTO', track: 'c', playImmediately: true });
      m.actor.send({ type: 'NEXT' });
      expect(m.current()).toBe('a');
    });

    it("'one' restarts the current entry on TRACK_ENDED", () => {
      const m = actorFrom({ current: 'b', state: 'playing', repeat: 'one' });
      m.actor.send({ type: 'TRACK_ENDED' });
      expect(m.state()).toBe('playing');
      expect(m.current()).toBe('b');
    });

    it('a repeat change takes effect without telling the machine', () => {
      const m = actorFrom({ current: 'c', state: 'playing' });
      m.list.repeat = 'all';
      m.actor.send({ type: 'TRACK_ENDED' });
      expect(m.current()).toBe('a');
    });
  });
});
