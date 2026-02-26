import type { TrackInfo } from 'gapless.js';

function fmt(s: number | undefined) {
  if (!s || isNaN(s)) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function badgeInfo(info: TrackInfo) {
  if (info.playbackType === 'WEBAUDIO') return { cls: 'web', label: 'WebAudio' };
  if (info.webAudioLoadingState === 'LOADING') return { cls: 'load', label: 'decoding\u2026' };
  if (info.webAudioLoadingState === 'LOADED') return { cls: 'web', label: 'ready' };
  return { cls: 'h5', label: 'HTML5' };
}

interface PlaylistProps {
  tracks: readonly TrackInfo[];
  currentTrack: TrackInfo | undefined;
  onSelect: (index: number) => void;
}

export function Playlist({ tracks, currentTrack, onSelect }: PlaylistProps) {
  return (
    <section>
      <h2>Playlist</h2>
      <ul className="playlist">
        {tracks.map((track, i) => {
          const { cls, label } = badgeInfo(track);
          const isActive = currentTrack && i === currentTrack.index;
          return (
            <li key={i} className={isActive ? 'active' : ''} onClick={() => onSelect(i)}>
              <span className="idx">{i + 1}</span>
              <span className="title">{track.metadata?.title ?? `Track ${i + 1}`}</span>
              <span className={`badge ${cls}`}>{label}</span>
              <span className="dur">{fmt(track.duration)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
