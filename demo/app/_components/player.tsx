'use client';

import { useState } from 'react';
import type { TrackInfo } from 'gapless';
import { useGapless, type GaplessPlayer } from './use-gapless';
import { SET_ONE, formatTime, type DemoTrack } from './tracks';
import { NextIcon, PauseIcon, PlayIcon, PreviousIcon } from './icons';
import { StageBadge, type Tone } from './ui';

export function FullShow() {
  return (
    <div className="rounded-2xl p-4 ring-1 ring-zinc-950/10 sm:p-6 dark:bg-zinc-800/40 dark:ring-white/10">
      <div className="mb-4">
        <p className="text-base/7 font-semibold">A full set</p>
        <p className="text-sm/6 text-zinc-600 dark:text-zinc-400">
          Grateful Dead, Cornell University, May 8, 1977 — set one, eleven tracks.
        </p>
      </div>
      <Player tracks={SET_ONE} />
    </div>
  );
}

function stage(info: TrackInfo | undefined, isCurrent: boolean): { tone: Tone; label: string } {
  if (!info) return { tone: 'neutral', label: '—' };
  if (info.webAudioLoadingState === 'ERROR') return { tone: 'bad', label: 'Decode failed' };
  if (isCurrent && info.playbackType === 'WEBAUDIO') return { tone: 'good', label: 'Web Audio' };
  if (info.webAudioLoadingState === 'LOADED') return { tone: 'good', label: 'Decoded' };
  if (info.webAudioLoadingState === 'LOADING') return { tone: 'busy', label: 'Decoding' };
  if (isCurrent && info.isPlaying) return { tone: 'busy', label: 'HTML5' };
  return { tone: 'neutral', label: 'Not loaded' };
}

function Player({ tracks: list }: { tracks: DemoTrack[] }) {
  const player = useGapless('full-show', list, { volume: 0.8 });
  const { current, tracks, lastHandoff } = player;
  const idx = current?.index ?? 0;
  const duration = current?.duration ?? NaN;
  const time = current?.currentTime ?? 0;
  const known = Number.isFinite(duration);
  const playing = player.state === 'playing';
  const next = tracks[idx + 1];

  let hint: string;
  if (player.state === 'idle')
    hint = 'Press play. Audio starts right away over HTML5 while tracks decode in the background.';
  else if (!next) hint = 'Last track in the playlist.';
  else if (next.webAudioLoadingState === 'LOADED')
    hint = `Next track is decoded — skip to the end to hear a gapless transition into “${list[idx + 1].title}”.`;
  else
    hint = `Waiting for “${list[idx + 1].title}” to decode. Transitions are gapless once it shows Decoded.`;

  return (
    <div className="grid gap-x-8 gap-y-5 lg:grid-cols-2">
      <div className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-4">
          <p className="truncate text-lg/7 font-semibold">{list[idx].title}</p>
          <p className="shrink-0 text-sm/6 text-zinc-500 tabular-nums dark:text-zinc-400">
            {idx + 1} / {list.length}
          </p>
        </div>

        <div className="flex items-center gap-3 text-sm/6 text-zinc-500 tabular-nums dark:text-zinc-400">
          <p className="w-10">{formatTime(time)}</p>
          <input
            type="range"
            name="position"
            aria-label="Playback position"
            min={0}
            max={known ? duration : 0}
            step={0.1}
            value={time}
            disabled={!known}
            onChange={(e) => player.seek(Number(e.target.value))}
            className="min-w-0 flex-1 accent-zinc-950 disabled:opacity-50 dark:accent-zinc-200"
          />
          <p className="w-10 text-right">{formatTime(duration)}</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <IconButton label="Previous track" onClick={player.previous}>
            <PreviousIcon />
          </IconButton>
          <button
            type="button"
            onClick={player.toggle}
            aria-label={playing ? 'Pause' : 'Play'}
            className="grid size-11 place-items-center rounded-full bg-zinc-950 text-white hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-950 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {playing ? <PauseIcon className="size-5" /> : <PlayIcon className="size-5" />}
          </button>
          <IconButton label="Next track" onClick={player.next}>
            <NextIcon />
          </IconButton>
          <button
            type="button"
            onClick={() => player.seekNearEnd(5)}
            disabled={!known}
            className="rounded-lg bg-zinc-950/5 px-3 py-2 text-sm/6 font-medium hover:bg-zinc-950/10 disabled:opacity-50 dark:bg-white/10 dark:hover:bg-white/15"
          >
            Skip to 5s before end
          </button>
        </div>

        <div aria-live="polite" className="text-sm/6 text-pretty">
          {lastHandoff ? (
            <p
              className={
                lastHandoff.gapless
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : 'text-amber-700 dark:text-amber-400'
              }
            >
              {lastHandoff.gapless ? (
                <>
                  <span className="font-semibold">Gapless.</span> “{list[lastHandoff.to].title}”
                  started on the exact sample the previous track ended.
                </>
              ) : (
                <>
                  <span className="font-semibold">Not gapless.</span> “{list[lastHandoff.to].title}”
                  wasn’t decoded yet, so it fell back to HTML5.
                </>
              )}
            </p>
          ) : (
            <p className="text-zinc-600 dark:text-zinc-400">{hint}</p>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Slider
            label="Volume"
            value={player.volume}
            min={0}
            max={1}
            step={0.01}
            onChange={player.setVolume}
            display={`${Math.round(player.volume * 100)}%`}
          />
          <Slider
            label="Speed"
            value={player.playbackRate}
            min={0.25}
            max={4}
            step={0.25}
            onChange={player.setPlaybackRate}
            display={`${player.playbackRate.toFixed(2)}×`}
          />
        </div>

        <ol
          role="list"
          className="order-first divide-y divide-zinc-950/5 rounded-xl border border-zinc-950/10 dark:divide-white/5 dark:border-white/10"
        >
          {list.map((t, i) => {
            const active = i === idx && player.state !== 'idle';
            return (
              <li key={t.url}>
                <button
                  type="button"
                  onClick={() => player.gotoTrack(i)}
                  aria-current={active ? 'true' : undefined}
                  className="grid w-full grid-cols-[--spacing(5)_1fr_auto_--spacing(10)] items-center gap-x-3 px-3 py-1.5 text-left text-sm/6 hover:bg-zinc-950/2.5 aria-current:bg-zinc-950/5 dark:hover:bg-white/2.5 dark:aria-current:bg-white/5"
                >
                  <span className="text-zinc-500 tabular-nums dark:text-zinc-400">{i + 1}</span>
                  <span className="truncate font-medium">{t.title}</span>
                  <StageBadge stage={stage(tracks[i], i === idx)} />
                  <span className="text-right text-zinc-500 tabular-nums dark:text-zinc-400">
                    {Number.isFinite(tracks[i]?.duration) ? formatTime(tracks[i].duration) : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>

      <Debug player={player} />
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="grid size-9 place-items-center rounded-full text-zinc-600 hover:bg-zinc-950/5 hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-white"
    >
      {children}
    </button>
  );
}

function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm/6 text-zinc-600 dark:text-zinc-400">
      {props.label}
      <input
        type="range"
        name={props.label.toLowerCase()}
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        className="w-24 accent-zinc-950 dark:accent-zinc-200"
      />
      <span className="w-10 text-zinc-950 tabular-nums dark:text-zinc-100">{props.display}</span>
    </label>
  );
}

function Debug({ player }: { player: GaplessPlayer }) {
  const [verbose, setVerbose] = useState(false);
  const logs = verbose ? player.logs : player.logs.filter((l) => l.level !== 'debug');
  return (
    <details className="text-sm/6 lg:col-span-2">
      <summary className="cursor-pointer text-zinc-500 select-none hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white">
        Debug
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        <p className="font-mono text-xs/5 text-zinc-600 dark:text-zinc-400">
          queue={player.queueState} track={player.current?.machineState ?? '—'} output=
          {player.current?.playbackType ?? '—'} buffer={player.current?.webAudioLoadingState ?? '—'}
        </p>
        <label className="flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
          <input
            type="checkbox"
            name="verbose"
            checked={verbose}
            onChange={(e) => setVerbose(e.target.checked)}
            className="accent-zinc-950 dark:accent-zinc-200"
          />
          Show internal debug messages
        </label>
        <ol
          role="list"
          className="h-56 overflow-auto rounded-lg bg-zinc-950/2.5 p-3 font-mono text-xs/5 dark:bg-white/5"
        >
          {logs.map((l) => (
            <li
              key={l.id}
              className={
                l.level === 'error'
                  ? 'text-rose-600 dark:text-rose-400'
                  : l.level === 'debug'
                    ? 'text-zinc-500'
                    : ''
              }
            >
              <span className="text-zinc-400">{l.time}</span> {l.msg}
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}
