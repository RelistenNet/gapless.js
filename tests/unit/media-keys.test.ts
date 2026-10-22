import { describe, it, expect } from 'vitest';
import { Queue } from '../../src/Queue';
import { mockFetchSuccess, MockAudioElement } from '../setup';

describe('media key support via silent anchor element', () => {
  it('creates a silent looping audio element when playback starts', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();
    await new Promise((r) => setTimeout(r, 0));

    const anchor = (q as any)._mediaSessionAnchor as MockAudioElement;
    expect(anchor).toBeDefined();
    expect(anchor.paused).toBe(false);
    expect(anchor.loop).toBe(true);
    expect(anchor.volume).toBe(1);
  });

  it('pauses the anchor element when playback pauses', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();
    await new Promise((r) => setTimeout(r, 0));

    const anchor = (q as any)._mediaSessionAnchor as MockAudioElement;
    expect(anchor.paused).toBe(false);

    q.pause();
    expect(anchor.paused).toBe(true);
  });

  it('resumes the anchor element when playback resumes', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();
    await new Promise((r) => setTimeout(r, 0));
    q.pause();

    const anchor = (q as any)._mediaSessionAnchor as MockAudioElement;
    expect(anchor.paused).toBe(true);

    q.play();
    expect(anchor.paused).toBe(false);
  });

  it('anchor stays playing after crossover to webaudio', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();
    for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 150));

    const tracks = (q as any)._tracks;
    expect(tracks[0].machineState).toBe('webaudio');
    expect((tracks[0].audio as MockAudioElement).paused).toBe(true);

    const anchor = (q as any)._mediaSessionAnchor as MockAudioElement;
    expect(anchor.paused).toBe(false);
  });

  it('reuses the same anchor element across play/pause cycles', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();
    await new Promise((r) => setTimeout(r, 0));
    const anchor1 = (q as any)._mediaSessionAnchor;

    q.pause();
    q.play();
    const anchor2 = (q as any)._mediaSessionAnchor;

    expect(anchor1).toBe(anchor2);
  });

  it('cleans up anchor on destroy', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();
    await new Promise((r) => setTimeout(r, 0));

    const anchor = (q as any)._mediaSessionAnchor as MockAudioElement;
    expect(anchor.paused).toBe(false);

    q.destroy();
    expect(anchor.paused).toBe(true);
    expect((q as any)._mediaSessionAnchor).toBeNull();
  });
});

describe('media session handlers with several queues on one page', () => {
  function stubMediaSession() {
    const handlers = new Map<string, MediaSessionActionHandler | null>();
    const mediaSession = {
      metadata: null as MediaMetadata | null,
      playbackState: 'none',
      setActionHandler: (action: string, handler: MediaSessionActionHandler | null) => {
        handlers.set(action, handler);
      },
      setPositionState: () => {},
    };
    Object.defineProperty(navigator, 'mediaSession', { value: mediaSession, configurable: true });
    globalThis.MediaMetadata ??= class {
      constructor(init: MediaMetadataInit) {
        Object.assign(this, init);
      }
    } as unknown as typeof MediaMetadata;
    return {
      handlers,
      mediaSession,
      restore: () => Reflect.deleteProperty(navigator, 'mediaSession'),
    };
  }

  it('routes OS controls to the queue that is playing, not the last one created', async () => {
    const { handlers, mediaSession, restore } = stubMediaSession();
    try {
      mockFetchSuccess();
      const a = new Queue({ tracks: ['a.mp3'], trackMetadata: [{ title: 'A' }] });
      const b = new Queue({ tracks: ['b.mp3'], trackMetadata: [{ title: 'B' }] });

      // b was constructed last, so it holds the handlers until a plays.
      a.play();
      await new Promise((r) => setTimeout(r, 0));
      expect(a.isPlaying).toBe(true);
      expect((mediaSession.metadata as unknown as { title: string }).title).toBe('A');

      handlers.get('pause')!({ action: 'pause' });
      expect(a.isPlaying).toBe(false);

      // Once b plays, the controls follow it.
      b.play();
      await new Promise((r) => setTimeout(r, 0));
      handlers.get('pause')!({ action: 'pause' });
      expect(b.isPlaying).toBe(false);

      a.destroy();
      b.destroy();
    } finally {
      restore();
    }
  });
});
