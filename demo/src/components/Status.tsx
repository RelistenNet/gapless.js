import type { TrackInfo } from 'gapless.js';

interface StatusProps {
  state: 'idle' | 'playing' | 'paused' | 'ended';
  currentTrack: TrackInfo | undefined;
  tracks: readonly TrackInfo[];
  volume: number;
}

export function Status({ state, currentTrack, tracks, volume }: StatusProps) {
  const nextTrack = currentTrack ? tracks[currentTrack.index + 1] : undefined;

  return (
    <section>
      <h2>Status</h2>
      <div className="status">
        <span>
          state: <b>{state}</b>
        </span>
        <span>
          track:{' '}
          <b>
            {currentTrack ? `${currentTrack.index + 1}/${tracks.length}` : `0/${tracks.length}`}
          </b>
        </span>
        <span>
          playback: <b>{currentTrack?.playbackType ?? 'N/A'}</b>
        </span>
        <span>
          buffer: <b>{currentTrack?.webAudioLoadingState ?? 'N/A'}</b>
        </span>
        <span>
          next buffer: <b>{nextTrack?.webAudioLoadingState ?? 'N/A'}</b>
        </span>
        <span>
          volume: <b>{Math.round(volume * 100)}%</b>
        </span>
      </div>
    </section>
  );
}
