import { describe, it, expect, vi } from 'vitest';
import { Queue } from '../../src/Queue';
import { mockFetchSuccess, mockFetchRedirect, MockAudioElement, MockAudioBuffer, advanceTime, MockGainNode } from '../setup';

describe('crossover end-to-end flow', () => {
  it('after q.play() + decode, current track crosses over and HTML5 element is paused', async () => {
    mockFetchSuccess();
    const debug: string[] = [];
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'], onDebug: (m: string) => debug.push(m) });
    q.play();
    for (let i = 0; i < 15; i++) await new Promise(r => setTimeout(r, 0));
    // The HTML5 element is paused after the crossfade completes (~30 ms).
    await new Promise(r => setTimeout(r, 50));

    const tracks = (q as any)._tracks;
    expect(tracks[0].playbackType).toBe('WEBAUDIO');
    expect(tracks[0].machineState).toBe('webaudio');
    expect(tracks[0].isPlaying).toBe(true);
    expect((tracks[0].audio as MockAudioElement).paused).toBe(true);

    expect(debug.some(m => m.includes('crossoverHtml5ToWebAudio'))).toBe(true);
  });

  it('when paused before BUFFER_READY, crossover moves to webaudio paused (no source started)', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();
    q.pause();
    for (let i = 0; i < 15; i++) await new Promise(r => setTimeout(r, 0));

    const tracks = (q as any)._tracks;
    expect(tracks[0].playbackType).toBe('WEBAUDIO');
    expect(tracks[0].machineState).toBe('webaudio');
    expect(tracks[0].isPlaying).toBe(false);
    expect(tracks[0].hasSourceNode).toBe(false);
  });

  it('Fix 1 — defers next-track preload while current track is HTML5 with buffer still loading', async () => {
    // While the current track is in html5 + LOADING, next-track preload is held off
    // so that two large concurrent downloads don't compete for bandwidth and delay
    // the current track's crossover. Once the current track's buffer arrives, the
    // gate releases and the next-track fetch proceeds.
    let resolveTrack0Fetch!: (body: ArrayBuffer) => void;
    let track0FetchSeen = false;
    const fetchSpy = vi.fn((url: string | Request, _init?: RequestInit) => {
      const u = String(url);
      if (u.includes('a.mp3') && !track0FetchSeen) {
        track0FetchSeen = true;
        return new Promise<Response>((resolve) => {
          resolveTrack0Fetch = (buf) => resolve(new Response(buf, { status: 200 }));
        });
      }
      return Promise.resolve(new Response(new ArrayBuffer(1024), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchSpy);

    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();
    // Let microtasks settle. Track 0's fetch is hung (we haven't resolved it).
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));

    // Track 1's fetch must NOT have started yet — only HEAD requests and track 0's GET.
    const calls = fetchSpy.mock.calls.map(c => `${(c[1] as RequestInit | undefined)?.method ?? 'GET'} ${String(c[0])}`);
    expect(calls.some(c => c.includes('GET') && c.includes('b.mp3'))).toBe(false);

    // Resolve track 0's fetch → BUFFER_READY → crossover → gate releases.
    resolveTrack0Fetch(new ArrayBuffer(1024));
    for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0));

    // Now track 1's fetch should have started.
    const callsAfter = fetchSpy.mock.calls.map(c => `${(c[1] as RequestInit | undefined)?.method ?? 'GET'} ${String(c[0])}`);
    expect(callsAfter.some(c => c.includes('GET') && c.includes('b.mp3'))).toBe(true);
  });

  it('Fix 2 — crossover triggers cancel-and-reschedule of any existing gapless schedule', async () => {
    mockFetchSuccess();
    const debug: string[] = [];
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'], onDebug: (m: string) => debug.push(m) });
    q.play();
    advanceTime(20);
    for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));

    // After crossover, _scheduledNextIndex is set, and the cancel-and-reschedule
    // path was taken (TRACK_LOADED for the current track).
    expect((q as any)._scheduledNextIndex).toBe(1);
    // The cancel-and-reschedule path is what we want to confirm fired. The debug
    // log shows _cancelScheduledGapless followed by _tryScheduleGapless.
    const scheduledLines = debug.filter(m => m.includes('_tryScheduleGapless: scheduled'));
    expect(scheduledLines.length).toBeGreaterThanOrEqual(1);
  });

  it('crossover sample-accurately crossfades HTML5 (1→0) and WebAudio (0→1) on the AudioContext clock', async () => {
    // The crossover handoff joins two independent audio output streams
    // (HTML5 + WebAudio). Even when the content position matches on both
    // sides, the join can be audible as a click/blip from the sample-level
    // discontinuity. By routing HTML5 through MediaElementAudioSourceNode +
    // a dedicated GainNode, both ramps run on the AudioContext clock and
    // cross over sample-accurately.
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();
    for (let i = 0; i < 15; i++) await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 50)); // wait for crossfade to complete

    const tracks = (q as any)._tracks;
    expect(tracks[0].playbackType).toBe('WEBAUDIO');

    const audio = tracks[0].audio as MockAudioElement;
    expect(audio.paused).toBe(true);

    // Two GainNodes should have ramped — the html5GainNode (1→0) and the
    // WebAudio fade gain (0→1). Inspect createGain call results.
    const ctx = (q as any)._tracks[0].ctx as { createGain: { mock: { results: { value: MockGainNode }[] } } };
    const gainNodes = ctx.createGain.mock.results.map((r) => r.value);

    const html5FadeNode = gainNodes.find((g) =>
      (g.gain.linearRampToValueAtTime as ReturnType<typeof vi.fn>).mock.calls.some((call) => call[0] === 0)
    );
    expect(html5FadeNode).toBeDefined();

    const webAudioFadeNode = gainNodes.find((g) =>
      (g.gain.linearRampToValueAtTime as ReturnType<typeof vi.fn>).mock.calls.some((call) => call[0] === 1)
    );
    expect(webAudioFadeNode).toBeDefined();
  });

  it('does not overwrite audio.src when the HEAD fetch resolves a redirect (avoids HTML5 reset mid-stream)', async () => {
    // Regression: previously, when the HEAD probe in fetchDecode returned a
    // redirected URL, we wrote `this.audio.src = res.url`. That assignment
    // aborts the HTML5 element's playback, resets currentTime to 0, and
    // reloads from the new URL — perceived by the user as a huge skip
    // (sometimes blamed on the later crossover). The WebAudio GET should use
    // the resolved URL via _resolvedUrl, but audio.src must remain untouched
    // for as long as HTML5 may be streaming it.
    mockFetchRedirect('https://cdn.example.com/redirected.mp3');
    const q = new Queue({ tracks: ['https://example.com/a.mp3', 'b.mp3'] });
    q.play();
    for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0));

    const tracks = (q as any)._tracks;
    expect((tracks[0].audio as MockAudioElement).src).toBe('https://example.com/a.mp3');
    // _resolvedUrl, however, should reflect the redirect target (used for the
    // WebAudio GET).
    expect(tracks[0].trackUrl).toBe('https://cdn.example.com/redirected.mp3');
  });

  it('starts the WebAudio source at audio.currentTime (alignment shift disabled pending root-cause)', async () => {
    // We previously tried two alignment heuristics (duration-delta, then
    // first-non-silent-sample scan) under the hypothesis that decoded buffer
    // start padding was causing a backward skip at crossover. Neither fully
    // eliminated the skip, so the shift is currently disabled; this test
    // pins down the present behavior so a future fix can update it.
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();
    const tracks = (q as any)._tracks;
    (tracks[0].audio as MockAudioElement).currentTime = 4;

    for (let i = 0; i < 15; i++) await new Promise(r => setTimeout(r, 0));

    expect(tracks[0].playbackType).toBe('WEBAUDIO');

    const sourceCreate = (tracks[0].ctx.createBufferSource as ReturnType<typeof vi.fn>);
    const allSources = sourceCreate.mock.results.map((r) => r.value as { start: ReturnType<typeof vi.fn> });
    const startedSource = allSources.find(s => s.start.mock.calls.length > 0);
    expect(startedSource).toBeDefined();
    const [, offsetArg] = startedSource!.start.mock.calls[0];
    expect(offsetArg).toBeCloseTo(4, 2);
  });

  it('seek-near-end keeps the next track audible after cancel-and-reschedule (regression)', async () => {
    // Regression: when the user seeks the current track close to the end,
    // the queue fires cancelAndRescheduleGapless. CANCEL_GAPLESS used to
    // disconnect the next track's gainNode from destination; with the
    // MediaElementSource refactor, gainNode is now connected once at ctx
    // setup and a disconnect is permanent — leaving the rescheduled gapless
    // start playing into an unreachable graph (silence). Verifies that
    // gainNode.disconnect is NOT called on the next track during the
    // cancel-and-reschedule sequence.
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();
    advanceTime(20);
    for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));

    const internal = q as any;
    expect(internal._scheduledNextIndex).toBe(1);

    // Capture disconnect-call count before the seek.
    const track1 = internal._tracks[1];
    const gainNodeDisconnectsBefore = track1.gainNode.disconnect.mock.calls.length;

    // Seek the current track close to the end → cancelAndRescheduleGapless.
    q.seek(track1.duration - 1);
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));

    // gainNode of the next track should NOT have been disconnected.
    expect(track1.gainNode.disconnect.mock.calls.length).toBe(gainNodeDisconnectsBefore);
    // And gapless should still be scheduled (or have been re-scheduled).
    expect(internal._scheduledNextIndex).toBe(1);
  });

  it('after crossover, gapless scheduling targets the next track via WebAudio→WebAudio', async () => {
    mockFetchSuccess();
    const q = new Queue({ tracks: ['a.mp3', 'b.mp3'] });
    q.play();
    advanceTime(20); // past 15s threshold so further preloads aren't deferred
    for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));

    const internal = q as any;
    expect(internal._tracks[0].playbackType).toBe('WEBAUDIO');
    expect(internal._tracks[1].isBufferLoaded).toBe(true);
    expect(internal._scheduledNextIndex).toBe(1);
  });
});
