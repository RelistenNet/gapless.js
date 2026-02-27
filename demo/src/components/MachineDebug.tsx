import type { TrackInfo } from 'gapless';
import type { QueueSnapshot, MachineLogEntry } from '../useGapless';

export function MachineDebug({
  queueSnapshot,
  currentTrack,
  tracks,
  machineLog,
}: {
  queueSnapshot: QueueSnapshot;
  currentTrack: TrackInfo | undefined;
  tracks: readonly TrackInfo[];
  machineLog: MachineLogEntry[];
}) {
  const currentTrackDebug = currentTrack
    ? {
        machineState: currentTrack.machineState,
        playbackType: currentTrack.playbackType,
        webAudioLoadingState: currentTrack.webAudioLoadingState,
        isPlaying: currentTrack.isPlaying,
      }
    : null;

  const tracksSummary = tracks.map((t, i) => `${i}: ${t.machineState}`).join(', ');

  return (
    <section>
      <h2>State Machines</h2>
      <div className="debug-grid">
        <div>
          <div className="debug-label">Queue</div>
          <pre className="debug-pre">{JSON.stringify(queueSnapshot, null, 2)}</pre>
        </div>
        <div>
          <div className="debug-label">Current Track</div>
          <pre className="debug-pre">
            {currentTrackDebug ? JSON.stringify(currentTrackDebug, null, 2) : '(none)'}
          </pre>
        </div>
      </div>
      <div className="debug-label">All Tracks</div>
      <pre className="debug-pre">{tracksSummary || '(empty)'}</pre>
      <div className="debug-label">Transition Log ({machineLog.length})</div>
      <pre className="debug-pre debug-log">
        {machineLog.length === 0
          ? '(no events yet)'
          : machineLog.map((e) => `${e.time} ${e.msg}`).join('\n')}
      </pre>
    </section>
  );
}
