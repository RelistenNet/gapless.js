'use client';

import type { TrackInfo } from 'gapless';
import { useGapless } from './use-gapless';
import { CLIPS, CLIP_SECONDS } from './clips';
import { Waveform } from './waveform';
import { formatTime } from './tracks';
import { PauseIcon, PlayIcon } from './icons';
import { StageBadge, type Tone } from './ui';

const TOTAL = CLIP_SECONDS * CLIPS.length;

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

export function GaplessDemo() {
  const player = useGapless('gapless-demo', CLIPS, { volume: 0.8 });
  const { current, tracks, lastHandoff } = player;
  const idx = current?.index ?? 0;
  const position =
    player.state === 'idle'
      ? 0
      : player.state === 'ended'
        ? TOTAL
        : idx * CLIP_SECONDS + (current?.currentTime ?? 0);
  const playing = player.state === 'playing';

  const seekTo = (seconds: number) => {
    const index = Math.min(CLIPS.length - 1, Math.floor(seconds / CLIP_SECONDS));
    const offset = seconds - index * CLIP_SECONDS;
    player.clearHandoff();
    if (index === idx && player.state !== 'idle' && player.state !== 'ended') {
      player.seek(offset);
      if (!playing) player.toggle();
    } else {
      player.gotoTrack(index, offset);
    }
  };

  return (
    <div className="rounded-2xl bg-emerald-50/70 p-4 ring-1 ring-emerald-600/20 sm:p-6 dark:bg-emerald-400/5 dark:ring-emerald-400/20">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <button
          type="button"
          onClick={() => (player.state === 'ended' ? seekTo(0) : player.toggle())}
          aria-label={playing ? 'Pause' : 'Play'}
          className="grid size-12 shrink-0 place-items-center rounded-full bg-emerald-700 text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 dark:bg-emerald-400 dark:text-emerald-950 dark:hover:bg-emerald-300 dark:focus-visible:outline-emerald-300"
        >
          {playing ? <PauseIcon className="size-5" /> : <PlayIcon className="size-5" />}
        </button>
        <div className="min-w-48 flex-1">
          <p className="font-mono text-base/7 font-semibold text-emerald-950 dark:text-emerald-100">
            gapless.js
          </p>
          <p className="text-sm/6 text-zinc-600 dark:text-zinc-400">
            Starts instantly over HTML5 Audio, then hands off to a decoded Web Audio buffer.
          </p>
        </div>
        <button
          type="button"
          onClick={() => seekTo(CLIP_SECONDS - 3)}
          className="rounded-lg bg-white px-3 py-1.5 text-sm/6 font-medium text-emerald-900 ring-1 ring-emerald-600/20 hover:bg-emerald-50 dark:bg-emerald-400/10 dark:text-emerald-200 dark:ring-emerald-400/20 dark:hover:bg-emerald-400/15"
        >
          Replay transition
        </button>
      </div>

      <div className="mt-7">
        <Waveform
          position={position}
          showPlayhead={player.state !== 'idle'}
          onSeek={seekTo}
          buffered={tracks.flatMap((t, i) =>
            t.webAudioLoadingState === 'LOADED'
              ? [[i * CLIP_SECONDS, (i + 1) * CLIP_SECONDS] as const]
              : []
          )}
          marker={{
            label: !lastHandoff ? 'gap' : lastHandoff.gapless ? 'no gap' : 'gap',
            tone: lastHandoff && !lastHandoff.gapless ? 'bad' : 'good',
          }}
        />

        <div className="mt-3 grid grid-cols-2 gap-1">
          {CLIPS.map((clip, i) => (
            <div
              key={clip.url}
              className={`flex items-center gap-2 ${i === 1 ? 'justify-end' : ''}`}
            >
              <p className="font-mono text-xs/5 whitespace-nowrap text-zinc-600 max-sm:hidden dark:text-zinc-400">
                {clip.title}
              </p>
              <StageBadge stage={stage(tracks[i], i === idx)} />
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        {/* Reserve two lines on narrow screens so the result never shifts layout. */}
        <div aria-live="polite" className="min-h-12 min-w-0 flex-1 text-sm/6 sm:min-h-6">
          {lastHandoff ? (
            lastHandoff.gapless ? (
              <p className="text-emerald-700 dark:text-emerald-400">
                <span className="font-semibold">Gapless.</span> part-2.wav started on the exact
                sample part-1.wav ended.
              </p>
            ) : (
              <p className="text-amber-700 dark:text-amber-400">
                <span className="font-semibold">Not gapless.</span> part-2.wav wasn’t decoded in
                time, so it fell back to HTML5. Replay the transition.
              </p>
            )
          ) : (
            <p className="text-zinc-600 dark:text-zinc-400">
              The next file is scheduled on the AudioContext clock to start on the exact sample the
              first one ends.
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
