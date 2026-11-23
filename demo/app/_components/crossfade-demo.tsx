'use client';

import { useState, type MouseEvent } from 'react';
import type { TrackInfo } from 'gapless';
import { useGapless } from './use-gapless';
import { JAMS, JAM_SECONDS, formatTime } from './tracks';
import { PauseIcon, PlayIcon } from './icons';
import { StageBadge, type Tone } from './ui';

// Up to half a clip: the library caps a fade at half the incoming entry, so
// longer ones would play shorter than drawn.
const FADES = [0, 2, 4, 6] as const;
const INITIAL_FADE = 4;

function stage(info: TrackInfo | undefined, isCurrent: boolean): { tone: Tone; label: string } {
  if (!info) return { tone: 'neutral', label: 'Not loaded' };
  if (info.webAudioLoadingState === 'ERROR') return { tone: 'bad', label: 'Decode failed' };
  if (isCurrent && info.isPlaying && info.playbackType === 'WEBAUDIO')
    return { tone: 'good', label: 'Web Audio' };
  if (info.webAudioLoadingState === 'LOADED') return { tone: 'good', label: 'Decoded' };
  if (info.webAudioLoadingState === 'LOADING') return { tone: 'busy', label: 'Decoding' };
  if (isCurrent && info.isPlaying) return { tone: 'busy', label: 'HTML5' };
  return { tone: 'neutral', label: 'Not loaded' };
}

/** Equal-power gain at fraction `x` of a fade, as the library ramps it. */
const fadeIn = (x: number) => Math.sin((x * Math.PI) / 2);
const fadeOut = (x: number) => Math.cos((x * Math.PI) / 2);

export function CrossfadeDemo() {
  const [fade, setFade] = useState<number>(INITIAL_FADE);
  const player = useGapless('crossfade-demo', JAMS, { volume: 0.8, crossfade: INITIAL_FADE });
  const { current, tracks } = player;
  const idx = current?.index ?? 0;
  const playing = player.state === 'playing';

  // Each lane starts `fade` seconds before the one before it ends.
  const step = JAM_SECONDS - fade;
  const total = step * (JAMS.length - 1) + JAM_SECONDS;
  const position =
    player.state === 'idle'
      ? 0
      : player.state === 'ended'
        ? total
        : idx * step + Math.min(current?.currentTime ?? 0, JAM_SECONDS);

  const chooseFade = (seconds: number) => {
    setFade(seconds);
    player.setCrossfade(seconds);
  };

  const play = (index: number, offset: number) => {
    if (index === idx && player.state !== 'idle' && player.state !== 'ended') {
      player.seek(offset);
      if (!playing) player.toggle();
    } else {
      player.gotoTrack(index, offset);
    }
  };

  // During a fade both lanes play, but the queue's current track is still
  // the outgoing one until it ends: label the pair. Only a real fade: the
  // incoming track is playing ahead of its turn (decoded or streaming).
  // Without one (a track not decoded in time) the transition is a cut.
  const fading =
    playing && !!tracks[idx + 1]?.isPlaying && position >= (idx + 1) * step && fade > 0;
  const fadeStage = (i: number): { tone: Tone; label: string } | null => {
    if (!fading) return null;
    if (i === idx + 1) return { tone: 'good', label: 'Fading in' };
    if (i === idx) return { tone: 'busy', label: 'Fading out' };
    return null;
  };

  // A few seconds before the next transition starts.
  const nextJoin = player.state === 'playing' ? Math.min(idx, JAMS.length - 2) : 0;
  const replayTransition = () => play(nextJoin, Math.max(0, step - 3));

  return (
    <div className="rounded-2xl bg-violet-50/70 p-4 ring-1 ring-violet-600/20 sm:p-6 dark:bg-violet-400/5 dark:ring-violet-400/20">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <button
          type="button"
          onClick={() => (player.state === 'ended' ? play(0, 0) : player.toggle())}
          aria-label={playing ? 'Pause' : 'Play'}
          className="grid size-12 shrink-0 place-items-center rounded-full bg-violet-700 text-white hover:bg-violet-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-700 dark:bg-violet-400 dark:text-violet-950 dark:hover:bg-violet-300 dark:focus-visible:outline-violet-300"
        >
          {playing ? <PauseIcon className="size-5" /> : <PlayIcon className="size-5" />}
        </button>
        <div className="min-w-48 flex-1">
          <p className="font-mono text-base/7 font-semibold text-violet-950 dark:text-violet-100">
            {`{ crossfade: ${fade} }`}
          </p>
          <p className="text-sm/6 text-zinc-600 dark:text-zinc-400">
            {JAM_SECONDS} seconds from three different songs. Pick how they join.
          </p>
        </div>
        <button
          type="button"
          onClick={replayTransition}
          className="rounded-lg bg-white px-3 py-1.5 text-sm/6 font-medium text-violet-900 ring-1 ring-violet-600/20 hover:bg-violet-50 dark:bg-violet-400/10 dark:text-violet-200 dark:ring-violet-400/20 dark:hover:bg-violet-400/15"
        >
          Replay transition
        </button>
      </div>

      <div
        role="radiogroup"
        aria-label="Crossfade length"
        className="mt-5 inline-flex rounded-lg bg-white p-0.5 ring-1 ring-violet-600/20 dark:bg-violet-400/10 dark:ring-violet-400/20"
      >
        {FADES.map((f) => (
          <button
            key={f}
            type="button"
            role="radio"
            aria-checked={fade === f}
            onClick={() => chooseFade(f)}
            className={`rounded-md px-3 py-1 text-sm/6 font-medium ${
              fade === f
                ? 'bg-violet-700 text-white dark:bg-violet-400 dark:text-violet-950'
                : 'text-violet-900 hover:bg-violet-50 dark:text-violet-200 dark:hover:bg-violet-400/15'
            }`}
          >
            {f === 0 ? 'Cut' : `${f}s`}
          </button>
        ))}
      </div>

      <div className="relative mt-5 space-y-1.5">
        {JAMS.map((jam, i) => {
          const left = ((i * step) / total) * 100;
          const width = (JAM_SECONDS / total) * 100;
          const onClick = (e: MouseEvent<HTMLDivElement>) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            play(i, frac * JAM_SECONDS * 0.999);
          };
          return (
            <div key={jam.title} className="relative h-11">
              <div
                role="button"
                tabIndex={0}
                aria-label={`Play ${jam.title}`}
                onClick={onClick}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    play(i, 0);
                  } else if (i === idx && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
                    e.preventDefault();
                    const t = (current?.currentTime ?? 0) + (e.key === 'ArrowRight' ? 1 : -1);
                    play(i, Math.max(0, Math.min(JAM_SECONDS - 0.25, t)));
                  }
                }}
                className="absolute inset-y-0 cursor-pointer overflow-hidden rounded-md bg-violet-600/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-700 dark:bg-violet-300/10 dark:focus-visible:outline-violet-300"
                style={{ left: `${left}%`, width: `${width}%` }}
              >
                <GainCurve
                  fadeInSec={i > 0 ? fade : 0}
                  fadeOutSec={i < JAMS.length - 1 ? fade : 0}
                  active={i === idx && player.state !== 'idle'}
                />
                <div className="pointer-events-none absolute inset-0 flex items-center justify-between gap-2 px-2">
                  <span className="truncate font-mono text-xs/5 text-violet-950 dark:text-violet-100">
                    {jam.title}
                  </span>
                  <span className="max-sm:hidden">
                    <StageBadge stage={fadeStage(i) ?? stage(tracks[i], i === idx)} />
                  </span>
                </div>
              </div>
            </div>
          );
        })}
        {player.state !== 'idle' && (
          <div
            className="pointer-events-none absolute -inset-y-1 w-px -translate-x-1/2 bg-zinc-950 dark:bg-white"
            style={{ left: `${(position / total) * 100}%` }}
          />
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <p aria-live="polite" className="min-w-0 flex-1 text-sm/6 text-zinc-600 dark:text-zinc-400">
          {fade === 0
            ? 'Each song starts on the sample the last one stops: gapless, but an abrupt cut between different songs.'
            : `Each song starts ${fade} seconds before the last one ends, and the two cross on equal-power curves so the level stays even.`}
        </p>
        <p className="font-mono text-sm/6 text-zinc-600 tabular-nums dark:text-zinc-400">
          {/* The current song's own time: the lanes assume each fade happened,
              so a combined time would run backwards after a cut. */}
          {player.state === 'idle' || player.state === 'ended'
            ? `${formatTime(0)} / ${formatTime(JAM_SECONDS)}`
            : `${JAMS[idx].title} ${formatTime(current?.currentTime)} / ${formatTime(JAM_SECONDS)}`}
        </p>
      </div>
    </div>
  );
}

/** The lane's gain over its length: ramps in and out where it overlaps its neighbors. */
function GainCurve({
  fadeInSec,
  fadeOutSec,
  active,
}: {
  fadeInSec: number;
  fadeOutSec: number;
  active: boolean;
}) {
  const N = 24;
  const pts: string[] = [];
  const gainAt = (t: number) => {
    if (fadeInSec > 0 && t < fadeInSec) return fadeIn(t / fadeInSec);
    const fromEnd = JAM_SECONDS - t;
    if (fadeOutSec > 0 && fromEnd < fadeOutSec) return fadeOut(1 - fromEnd / fadeOutSec);
    return 1;
  };
  for (let i = 0; i <= N * 4; i++) {
    const t = (i / (N * 4)) * JAM_SECONDS;
    // Rounded: Math.sin/cos can differ in the last digit between the server
    // and the browser, and full-precision points then fail to hydrate.
    pts.push(`${((t / JAM_SECONDS) * 100).toFixed(2)},${(100 - gainAt(t) * 88).toFixed(2)}`);
  }
  return (
    <svg
      aria-hidden
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="absolute inset-0 size-full"
    >
      <polygon
        points={`0,100 ${pts.join(' ')} 100,100`}
        className={
          active
            ? 'fill-violet-600/35 dark:fill-violet-300/35'
            : 'fill-violet-600/15 dark:fill-violet-300/15'
        }
      />
      <polyline
        points={pts.join(' ')}
        fill="none"
        vectorEffect="non-scaling-stroke"
        strokeWidth={1.5}
        className="stroke-violet-700 dark:stroke-violet-300"
      />
    </svg>
  );
}
