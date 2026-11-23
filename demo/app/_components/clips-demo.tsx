'use client';

import type { CSSProperties, MouseEvent } from 'react';
import type { TrackInfo } from 'gapless';
import { useGapless } from './use-gapless';
import { CLIP_SECONDS, CUTS, CUT_SECONDS, PEAKS } from './clips';
import { formatTime } from './tracks';
import { PauseIcon, PlayIcon } from './icons';
import { StageBadge, type Tone } from './ui';

const TOTAL = CUT_SECONDS * CUTS.length;
const CUTS_PER_FILE = CLIP_SECONDS / CUT_SECONDS;

/** Each cut's slice of its file's peaks. */
const CUT_PEAKS = CUTS.map((_, i) => {
  const file = PEAKS[Math.floor(i / CUTS_PER_FILE)];
  const per = file.length / CUTS_PER_FILE;
  const from = (i % CUTS_PER_FILE) * per;
  return file.slice(from, from + per);
});

type Join = 'gapless' | 'gap';

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

export function ClipsDemo() {
  const player = useGapless('clips-demo', CUTS, { volume: 0.8 });
  const { current, tracks } = player;
  const idx = current?.index ?? 0;
  const playing = player.state === 'playing';
  const position =
    player.state === 'idle'
      ? 0
      : player.state === 'ended'
        ? TOTAL
        : idx * CUT_SECONDS + Math.min(current?.currentTime ?? 0, CUT_SECONDS);

  // How each cut (between entry i and i + 1) last sounded.
  const joins: Partial<Record<number, Join>> = Object.fromEntries(
    Object.entries(player.handoffs).map(([from, gapless]) => [from, gapless ? 'gapless' : 'gap'])
  );

  const seekTo = (seconds: number) => {
    const index = Math.min(CUTS.length - 1, Math.floor(seconds / CUT_SECONDS));
    const offset = seconds - index * CUT_SECONDS;
    if (index === idx && player.state !== 'idle' && player.state !== 'ended') {
      player.seek(offset);
      if (!playing) player.toggle();
    } else {
      player.gotoTrack(index, offset);
    }
  };

  // The next cut after the playhead, or the first one from the start.
  const nextCut = Math.min(CUTS.length - 1, player.state === 'playing' ? idx + 1 : 1);
  const jumpToCut = () => seekTo(nextCut * CUT_SECONDS - 1.5);

  const gaps = Object.values(joins).filter((j) => j === 'gap').length;
  const heard = Object.keys(joins).length;

  return (
    <div className="rounded-2xl bg-sky-50/70 p-4 ring-1 ring-sky-600/20 sm:p-6 dark:bg-sky-400/5 dark:ring-sky-400/20">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <button
          type="button"
          onClick={() => (player.state === 'ended' ? seekTo(0) : player.toggle())}
          aria-label={playing ? 'Pause' : 'Play'}
          className="grid size-12 shrink-0 place-items-center rounded-full bg-sky-700 text-white hover:bg-sky-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700 dark:bg-sky-400 dark:text-sky-950 dark:hover:bg-sky-300 dark:focus-visible:outline-sky-300"
        >
          {playing ? <PauseIcon className="size-5" /> : <PlayIcon className="size-5" />}
        </button>
        <div className="min-w-48 flex-1">
          <p className="font-mono text-base/7 font-semibold text-sky-950 dark:text-sky-100">
            {'{ start, end }'}
          </p>
          <p className="text-sm/6 text-zinc-600 dark:text-zinc-400">
            The same two files as above, cut into four entries of {CUT_SECONDS} seconds each.
          </p>
        </div>
        <button
          type="button"
          onClick={jumpToCut}
          className="rounded-lg bg-white px-3 py-1.5 text-sm/6 font-medium text-sky-900 ring-1 ring-sky-600/20 hover:bg-sky-50 dark:bg-sky-400/10 dark:text-sky-200 dark:ring-sky-400/20 dark:hover:bg-sky-400/15"
        >
          Jump to next cut
        </button>
      </div>

      <div className="mt-7">
        <CutsWaveform
          position={position}
          showPlayhead={player.state !== 'idle'}
          onSeek={seekTo}
          joins={joins}
          loaded={tracks.map((t) => t.webAudioLoadingState === 'LOADED')}
        />
        <div className="mt-2 grid grid-cols-4 gap-1">
          {CUTS.map((cut, i) => (
            <div key={i} className="flex min-w-0 flex-col items-center gap-1">
              <p className="font-mono text-xs/5 whitespace-nowrap text-zinc-600 dark:text-zinc-400">
                <span className="max-sm:hidden">{cut.url.split('/').pop()} </span>
                {cut.start}–{cut.end}s
              </p>
              <StageBadge stage={stage(tracks[i], i === idx)} />
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div aria-live="polite" className="min-h-12 min-w-0 flex-1 text-sm/6 sm:min-h-6">
          {heard === 0 ? (
            <p className="text-zinc-600 dark:text-zinc-400">
              Each entry is a range of a file. The queue stops one at its <code>end</code> and
              starts the next at its <code>start</code>, on the same sample.
            </p>
          ) : gaps === 0 ? (
            <p className="text-sky-800 dark:text-sky-300">
              <span className="font-semibold">Gapless.</span> {heard} of {CUTS.length - 1} cuts
              played, each joined on the exact sample.
            </p>
          ) : (
            <p className="text-amber-700 dark:text-amber-400">
              <span className="font-semibold">
                {gaps} {gaps === 1 ? 'cut' : 'cuts'} fell back to HTML5.
              </span>{' '}
              The next entry wasn’t decoded in time. Jump to the cut again.
            </p>
          )}
        </div>
        <p className="font-mono text-sm/6 text-zinc-600 tabular-nums dark:text-zinc-400">
          {formatTime(position)} / {formatTime(TOTAL)}
        </p>
      </div>
    </div>
  );
}

/**
 * One strip for all four entries, tinted per entry, with a tick at each cut
 * colored by how it last sounded. The file boundary is the middle cut.
 */
function CutsWaveform({
  position,
  showPlayhead,
  onSeek,
  joins,
  loaded,
}: {
  /** Seconds into all four entries combined. */
  position: number;
  showPlayhead: boolean;
  onSeek: (seconds: number) => void;
  joins: Partial<Record<number, Join>>;
  loaded: readonly boolean[];
}) {
  const playing = Math.min(CUTS.length - 1, Math.floor(position / CUT_SECONDS));
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Position across all four entries"
      aria-valuemin={0}
      aria-valuemax={TOTAL}
      aria-valuenow={Math.round(position * 10) / 10}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') onSeek(Math.min(TOTAL - 0.25, position + 0.5));
        if (e.key === 'ArrowLeft') onSeek(Math.max(0, position - 0.5));
      }}
      className="relative grid h-20 cursor-pointer grid-cols-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-zinc-950 dark:focus-visible:outline-white"
    >
      {CUT_PEAKS.map((peaks, cut) => {
        const start = cut * CUT_SECONDS;
        const onClick = (e: MouseEvent<HTMLDivElement>) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          onSeek(start + frac * CUT_SECONDS * 0.999);
        };
        const edge =
          cut === 0 ? 'rounded-l-md pl-1.5' : cut === CUTS.length - 1 ? 'rounded-r-md pr-1.5' : '';
        return (
          <div
            key={cut}
            className={`flex px-px ${edge} ${cut % 2 ? 'bg-zinc-950/8 dark:bg-white/8' : 'bg-zinc-950/4 dark:bg-white/4'}`}
          >
            <div
              onClick={onClick}
              className="relative flex flex-1 items-center gap-px"
              style={
                { '--playhead': `${((position - start) / CUT_SECONDS) * 100}%` } as CSSProperties
              }
            >
              {peaks.map((p, i) => {
                const at = start + ((i + 0.5) / peaks.length) * CUT_SECONDS;
                return (
                  <div
                    key={i}
                    className={`flex-1 rounded-full ${
                      at <= position
                        ? 'bg-zinc-950 dark:bg-zinc-100'
                        : loaded[cut]
                          ? 'bg-zinc-950/35 dark:bg-white/40'
                          : 'bg-zinc-950/10 dark:bg-white/10'
                    }`}
                    style={{ height: `${Math.max(6, p * 80)}%` }}
                  />
                );
              })}
              {showPlayhead && cut === playing && (
                <div className="pointer-events-none absolute -inset-y-0.5 left-(--playhead) w-px -translate-x-1/2 bg-zinc-950 dark:bg-white" />
              )}
            </div>
          </div>
        );
      })}
      {CUTS.slice(1).map((_, i) => {
        const join = joins[i];
        const color =
          join === 'gapless'
            ? ['bg-sky-500', 'text-sky-700 dark:text-sky-300']
            : join === 'gap'
              ? ['bg-rose-500', 'text-rose-600 dark:text-rose-400']
              : ['bg-zinc-950/25 dark:bg-white/30', 'text-zinc-500 dark:text-zinc-400'];
        const fileEdge = (i + 1) % CUTS_PER_FILE === 0;
        return (
          <div
            key={i}
            className="pointer-events-none absolute -inset-y-2 -translate-x-1/2"
            style={{ left: `${((i + 1) / CUTS.length) * 100}%` }}
          >
            <div className={`h-full w-0.5 rounded-full ${color[0]}`} />
            <div
              className={`absolute -top-4 left-1/2 -translate-x-1/2 font-mono text-xs/5 font-medium whitespace-nowrap ${color[1]}`}
            >
              {join ?? (fileEdge ? 'next file' : 'cut')}
            </div>
          </div>
        );
      })}
    </div>
  );
}
