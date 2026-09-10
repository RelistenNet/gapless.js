import { describe, it, expect, vi } from 'vitest';
import { Queue } from '../../src/Queue';
import { mockFetchSuccess, MockAudioElement, MockGainNode, advanceTime } from '../setup';

describe('media key support after crossover', () => {
  it('HTML5 element stays playing after crossover so browser keeps routing media keys', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();
    for (let i = 0; i < 15; i++) await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 50));

    const tracks = (q as any)._tracks;
    expect(tracks[0].machineState).toBe('webaudio');
    expect(tracks[0].isPlaying).toBe(true);

    const audio = tracks[0].audio as MockAudioElement;
    expect(audio.paused).toBe(false);
    expect(audio.pause.mock.calls.length).toBe(0);
  });

  it('html5GainNode is ramped to 0 so the still-playing element is silent', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();
    for (let i = 0; i < 15; i++) await new Promise(r => setTimeout(r, 0));

    const tracks = (q as any)._tracks;
    const ctx = tracks[0].ctx as { createGain: { mock: { results: { value: MockGainNode }[] } } };
    const gainNodes = ctx.createGain.mock.results.map(r => r.value);

    const html5FadeNode = gainNodes.find(g =>
      (g.gain.linearRampToValueAtTime as ReturnType<typeof vi.fn>).mock.calls.some(
        (call) => call[0] === 0
      )
    );
    expect(html5FadeNode).toBeDefined();
  });

  it('HTML5_ENDED in webaudio state does not crash or change track state', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();
    for (let i = 0; i < 15; i++) await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 50));

    const tracks = (q as any)._tracks;
    expect(tracks[0].machineState).toBe('webaudio');

    // Simulate the HTML5 element reaching its natural end while WebAudio is active
    const audio = tracks[0].audio as MockAudioElement;
    audio.onended?.();
    await new Promise(r => setTimeout(r, 0));

    // Should remain in webaudio state, still playing
    expect(tracks[0].machineState).toBe('webaudio');
    expect(tracks[0].isPlaying).toBe(true);
  });

  it('MediaSession play/pause handlers still fire after crossover to webaudio', async () => {
    mockFetchSuccess();
    const progressCalls: any[] = [];
    const q = new Queue({
      tracks: ['a.mp3', 'b.mp3'],
      onProgress: (info) => progressCalls.push(info),
    });
    q.play();
    for (let i = 0; i < 15; i++) await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 50));

    const tracks = (q as any)._tracks;
    expect(tracks[0].machineState).toBe('webaudio');

    // Simulate media key pause (what the MediaSession handler calls)
    q.pause();
    expect(tracks[0].isPlaying).toBe(false);

    // Simulate media key play
    q.play();
    expect(tracks[0].isPlaying).toBe(true);
  });

  it('deactivation resets html5 gain and muted state for reuse', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();
    for (let i = 0; i < 15; i++) await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 50));

    const tracks = (q as any)._tracks;
    expect(tracks[0].machineState).toBe('webaudio');

    const audio = tracks[0].audio as MockAudioElement;

    // Deactivate the track
    tracks[0].deactivate();
    expect(tracks[0].machineState).toBe('idle');
    expect(audio.muted).toBe(false);
  });

  it('fallback path (no MediaElementSource) mutes element instead of pausing', async () => {
    // Make createMediaElementSource throw to trigger fallback path
    const mockCtx = (globalThis as any)._mockAudioContext;
    mockCtx.createMediaElementSource = vi.fn(() => {
      throw new Error('Simulated: double attach');
    });

    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();
    for (let i = 0; i < 15; i++) await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 50));

    const tracks = (q as any)._tracks;
    expect(tracks[0].machineState).toBe('webaudio');

    const audio = tracks[0].audio as MockAudioElement;
    // Element should still be playing (not paused), but muted
    expect(audio.paused).toBe(false);
    expect(audio.muted).toBe(true);
  });
});
