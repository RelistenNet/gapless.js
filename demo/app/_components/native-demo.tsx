'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { CLIPS, CLIP_SECONDS } from './clips';
import { formatTime } from './tracks';
import { PauseIcon, PlayIcon } from './icons';
import { Waveform } from './waveform';
import { claimPlayback, registerPlayer } from './exclusive-playback';

interface NativeSnapshot {
  started: boolean;
  playing: boolean;
  /** Seconds into the combined 24s. */
  position: number;
  /** Silence measured between the two files, in ms. */
  gapMs: number | null;
  /** What each element has buffered, in combined seconds. */
  buffered: [number, number][];
}

const INITIAL: NativeSnapshot = {
  started: false,
  playing: false,
  position: 0,
  gapMs: null,
  buffered: [],
};

// Passes audio through untouched and reports every run of digital silence
// longer than 32 samples, in seconds. The clips are cut mid-music, so the only
// such run is the one between the two files.
const GAP_METER = `
registerProcessor('gap-meter', class extends AudioWorkletProcessor {
  run = 0;
  process([input], [output]) {
    for (let c = 0; c < output.length; c++) if (input[c]) output[c].set(input[c]);
    const ch = input[0];
    if (!ch) { this.run += 128; return true; }
    for (let i = 0; i < ch.length; i++) {
      if (Math.abs(ch[i]) < 1e-6) this.run++;
      else { if (this.run > 32) this.port.postMessage(this.run / sampleRate); this.run = 0; }
    }
    return true;
  }
});`;

/**
 * What most players do without gapless.js: one <audio> element per file, and
 * when the first fires `ended`, call play() on the next. Part 2 is preloaded,
 * so this is the best case. Both elements feed a silence meter, which is the
 * only reason Web Audio is involved here.
 */
class NativeStore {
  private els: HTMLAudioElement[] = [];
  private index = 0;
  private ctx: AudioContext | null = null;
  /** Between part 1 ending and the meter reporting the silence that followed. */
  private measuring = false;
  private raf = 0;
  private listeners = new Set<() => void>();
  private snapshot = INITIAL;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => INITIAL;

  connect(): () => void {
    const els = CLIPS.map((c) => {
      const el = new Audio(c.url);
      el.preload = 'auto';
      el.volume = 0.8;
      return el;
    });
    this.els = els;
    const [a, b] = els;

    const onEnded = () => {
      this.measuring = true;
      this.index = 1;
      b.currentTime = 0;
      b.play();
    };
    const onPlayState = () => {
      const playing = els.some((el) => !el.paused && !el.ended);
      if (playing) this.loop();
      this.set({ playing, started: this.snapshot.started || playing });
    };
    a.addEventListener('ended', onEnded);
    const onProgress = () => {
      this.set({
        buffered: els.flatMap((el, i) =>
          Array.from({ length: el.buffered.length }, (_, r): [number, number] => [
            i * CLIP_SECONDS + el.buffered.start(r),
            i * CLIP_SECONDS + el.buffered.end(r),
          ])
        ),
      });
    };
    for (const el of els) {
      el.addEventListener('progress', onProgress);
      el.addEventListener('loadeddata', onProgress);
      el.addEventListener('canplaythrough', onProgress);
      el.addEventListener('play', onPlayState);
      el.addEventListener('pause', onPlayState);
      el.addEventListener('ended', onPlayState);
    }
    const unregister = registerPlayer('native', () => this.pause());

    return () => {
      cancelAnimationFrame(this.raf);
      unregister();
      for (const el of els) {
        el.pause();
        el.removeAttribute('src');
        el.load();
      }
      this.ctx?.close();
      this.ctx = null;
    };
  }

  /**
   * Create the AudioContext and route both elements through the gap meter.
   * Deferred to the first play or seek, so the page doesn't start a context
   * (and trip Chrome's autoplay warning) before anyone interacts with it.
   */
  private startAudio() {
    if (this.ctx) return void this.ctx.resume();
    const ctx = new AudioContext();
    this.ctx = ctx;
    const els = this.els;
    const url = URL.createObjectURL(new Blob([GAP_METER], { type: 'text/javascript' }));
    ctx.audioWorklet
      .addModule(url)
      .then(() => {
        if (ctx.state === 'closed') return;
        const meter = new AudioWorkletNode(ctx, 'gap-meter', { outputChannelCount: [2] });
        meter.port.onmessage = (e: MessageEvent<number>) => {
          if (!this.measuring) return;
          this.measuring = false;
          this.set({ gapMs: Math.round(e.data * 1000) });
        };
        for (const el of els) ctx.createMediaElementSource(el).connect(meter);
        meter.connect(ctx.destination);
      })
      .finally(() => URL.revokeObjectURL(url));
  }

  private loop = () => {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      const el = this.els[this.index];
      if (!el) return;
      this.set({ position: this.index * CLIP_SECONDS + el.currentTime });
      if (!el.paused || this.measuring) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  };

  private set(patch: Partial<NativeSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  private pause() {
    for (const el of this.els) el.pause();
  }

  seek = (seconds: number) => {
    if (!this.els.length) return;
    claimPlayback('native');
    this.startAudio();
    const index = Math.min(this.els.length - 1, Math.floor(seconds / CLIP_SECONDS));
    this.pause();
    this.index = index;
    this.measuring = false;
    if (index === 0) this.set({ gapMs: null });
    for (const [i, el] of this.els.entries()) if (i !== index) el.currentTime = 0;
    this.els[index].currentTime = seconds - index * CLIP_SECONDS;
    this.els[index].play();
  };

  toggle = () => {
    const el = this.els[this.index];
    if (!el) return;
    if (this.snapshot.playing) return this.pause();
    if (el.ended) return this.seek(0);
    claimPlayback('native');
    this.startAudio();
    el.play();
  };
}

export function NativeDemo() {
  const [store] = useState(() => new NativeStore());
  useEffect(() => store.connect(), [store]);
  const { started, playing, position, gapMs, buffered } = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot
  );

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-4 rounded-2xl bg-amber-50/70 p-4 ring-1 ring-amber-600/20 sm:px-6 dark:bg-amber-400/5 dark:ring-amber-400/20">
      <button
        type="button"
        onClick={store.toggle}
        aria-label={playing ? 'Pause plain audio' : 'Play plain audio'}
        className="grid size-10 shrink-0 place-items-center rounded-full bg-amber-500/15 text-amber-900 hover:bg-amber-500/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 dark:bg-amber-400/15 dark:text-amber-200 dark:hover:bg-amber-400/25 dark:focus-visible:outline-amber-300"
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      {/* Fixed width and one-line copy in both states, so the result never shifts layout. */}
      <div className="min-w-0 flex-1 sm:w-60 sm:flex-none">
        <p className="font-mono text-base/7 font-semibold text-amber-950 dark:text-amber-100">
          Plain &lt;audio&gt;
        </p>
        <p aria-live="polite" className="truncate text-sm/6 text-zinc-600 dark:text-zinc-400">
          {gapMs === null ? (
            'play() the next file on ended'
          ) : (
            <span className="text-rose-700 dark:text-rose-400">
              <span className="font-semibold">{gapMs} ms</span> of silence between tracks
            </span>
          )}
        </p>
      </div>
      <div className="flex min-w-0 basis-full items-center gap-4 pt-4 sm:basis-0 sm:flex-1 sm:pt-0">
        <Waveform
          className="h-10 min-w-0 flex-1"
          position={position}
          showPlayhead={started}
          onSeek={store.seek}
          buffered={buffered}
          marker={{ label: gapMs === null ? 'gap' : `${gapMs} ms gap`, tone: 'bad' }}
        />
        <button
          type="button"
          onClick={() => store.seek(CLIP_SECONDS - 3)}
          className="shrink-0 rounded-lg px-2.5 py-1 text-sm/6 font-medium text-amber-900 ring-1 ring-amber-600/20 hover:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-400/20 dark:hover:bg-amber-400/10"
        >
          Replay transition
        </button>
        <p className="font-mono text-sm/6 text-zinc-600 tabular-nums max-sm:hidden dark:text-zinc-400">
          {formatTime(position)}
        </p>
      </div>
    </div>
  );
}
