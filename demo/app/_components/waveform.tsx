'use client';

import type { CSSProperties, MouseEvent } from 'react';
import { CLIP_SECONDS, PEAKS } from './clips';

const TOTAL = CLIP_SECONDS * PEAKS.length;

/**
 * Each clip's waveform in its own panel, with the gap between the two files
 * marked in the space between them. Playhead and click-to-seek work per panel
 * so they stay exact around the space in the middle.
 */
export function Waveform({
  position,
  showPlayhead,
  onSeek,
  marker,
  buffered = [],
  className = 'h-20',
}: {
  /** Seconds into both clips combined. */
  position: number;
  showPlayhead: boolean;
  onSeek: (seconds: number) => void;
  /** The line between the two files, and what to say about it. */
  marker: { label: string; tone: 'good' | 'bad' };
  /** Buffered ranges in combined seconds, drawn brighter than unloaded audio. */
  buffered?: readonly (readonly [number, number])[];
  className?: string;
}) {
  const markerColor =
    marker.tone === 'good'
      ? ['bg-emerald-500', 'text-emerald-600 dark:text-emerald-400']
      : ['bg-rose-500', 'text-rose-600 dark:text-rose-400'];
  const playingClip = Math.min(PEAKS.length - 1, Math.floor(position / CLIP_SECONDS));

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Position across both files"
      aria-valuemin={0}
      aria-valuemax={TOTAL}
      aria-valuenow={Math.round(position)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') onSeek(Math.min(TOTAL - 0.5, position + 2));
        if (e.key === 'ArrowLeft') onSeek(Math.max(0, position - 2));
      }}
      className={`relative grid cursor-pointer grid-cols-2 gap-2 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-zinc-950 dark:focus-visible:outline-white ${className}`}
    >
      {PEAKS.map((peaks, clip) => {
        const start = clip * CLIP_SECONDS;
        const onClick = (e: MouseEvent<HTMLDivElement>) => {
          const rect = e.currentTarget.getBoundingClientRect();
          onSeek(
            start +
              Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * CLIP_SECONDS * 0.999
          );
        };
        return (
          <div key={clip} className="flex rounded-md bg-zinc-950/4 px-1.5 dark:bg-white/4">
            <div
              onClick={onClick}
              className="relative flex flex-1 items-center gap-px"
              style={
                { '--playhead': `${((position - start) / CLIP_SECONDS) * 100}%` } as CSSProperties
              }
            >
              {peaks.map((p, i) => {
                const at = start + ((i + 0.5) / peaks.length) * CLIP_SECONDS;
                return (
                  <div
                    key={i}
                    className={`flex-1 rounded-full ${
                      at <= position
                        ? 'bg-zinc-950 dark:bg-zinc-100'
                        : buffered.some(([from, to]) => at >= from && at <= to)
                          ? 'bg-zinc-950/35 dark:bg-white/40'
                          : 'bg-zinc-950/10 dark:bg-white/10'
                    }`}
                    style={{ height: `${Math.max(6, p * 80)}%` }}
                  />
                );
              })}
              {showPlayhead && clip === playingClip && (
                <div className="pointer-events-none absolute -inset-y-0.5 left-(--playhead) w-px -translate-x-1/2 bg-zinc-950 dark:bg-white" />
              )}
            </div>
          </div>
        );
      })}
      <div
        className={`pointer-events-none absolute -inset-y-2 left-1/2 w-0.5 -translate-x-1/2 rounded-full ${markerColor[0]}`}
      />
      <div
        className={`pointer-events-none absolute -top-5 left-1/2 -translate-x-1/2 font-mono text-xs/5 font-medium whitespace-nowrap ${markerColor[1]}`}
      >
        {marker.label}
      </div>
    </div>
  );
}
