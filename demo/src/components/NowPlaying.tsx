import type { TrackInfo } from 'gapless';
import { useCallback, useRef } from 'react';

function fmt(s: number | undefined) {
  if (!s || isNaN(s)) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

interface NowPlayingProps {
  state: 'idle' | 'playing' | 'paused' | 'ended';
  currentTrack: TrackInfo | undefined;
  volume: number;
  onToggle: () => void;
  onPrev: () => void;
  onNext: () => void;
  onSeek: (time: number) => void;
  onSeekToEnd: () => void;
  onVolumeChange: (v: number) => void;
  playbackRate: number;
  onPlaybackRateChange: (rate: number) => void;
}

export function NowPlaying({
  state,
  currentTrack,
  volume,
  onToggle,
  onPrev,
  onNext,
  onSeek,
  onSeekToEnd,
  onVolumeChange,
  playbackRate,
  onPlaybackRateChange,
}: NowPlayingProps) {
  const wrapRef = useRef<HTMLDivElement>(null);

  const progress =
    currentTrack && currentTrack.duration
      ? (currentTrack.currentTime / currentTrack.duration) * 100
      : 0;

  const handleProgressClick = useCallback(
    (e: React.MouseEvent) => {
      if (!currentTrack || isNaN(currentTrack.duration)) return;
      const rect = wrapRef.current!.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      onSeek(ratio * currentTrack.duration);
    },
    [currentTrack, onSeek],
  );

  const isPlaying = state === 'playing';

  return (
    <section>
      <h2>Now Playing</h2>
      <div className="track-title">
        {currentTrack?.metadata?.title ?? (currentTrack ? `Track ${currentTrack.index + 1}` : '\u2014')}
      </div>
      <div className="track-time">
        {fmt(currentTrack?.currentTime)} / {fmt(currentTrack?.duration)}
      </div>
      <div className="progress-wrap" ref={wrapRef} onClick={handleProgressClick}>
        <div className="progress-bg">
          <div className="progress-fill" style={{ width: `${progress}%` }} />
        </div>
      </div>
      <div className="controls">
        <button onClick={onPrev}>{'\u25c0\u25c0'} Prev</button>
        <button className="primary" onClick={onToggle}>
          {isPlaying ? '\u23f8 Pause' : '\u25b6 Play'}
        </button>
        <button onClick={onNext}>Next {'\u25b6\u25b6'}</button>
        <button onClick={onSeekToEnd}>Skip to end {'\u2212'}2s</button>
        <label>
          Vol{' '}
          <input
            type="range"
            min="0"
            max="100"
            value={Math.round(volume * 100)}
            onChange={(e) => onVolumeChange(Number(e.target.value) / 100)}
          />
        </label>
        <label>
          {playbackRate.toFixed(2)}x{' '}
          <input
            type="range"
            min="25"
            max="400"
            step="25"
            value={Math.round(playbackRate * 100)}
            onChange={(e) => onPlaybackRateChange(Number(e.target.value) / 100)}
          />
        </label>
      </div>
      <p className="tip">
        To test gapless: click <b>Skip to end {'\u2212'}5s</b> while playing and listen for a
        seamless track transition.
      </p>
    </section>
  );
}
