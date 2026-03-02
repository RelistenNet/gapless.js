import { useState } from 'react';
import { useGapless } from './useGapless';
import { NowPlaying } from './components/NowPlaying';
import { Playlist } from './components/Playlist';
import { Status } from './components/Status';
import { MachineDebug } from './components/MachineDebug';
import { EventLog } from './components/EventLog';

function trackUrl(url: string) {
  if (import.meta.env.DEV) return `/proxy?url=${encodeURIComponent(url)}`;
  return url;
}

const BASE =
  'https://audio.relisten.net/archive.org//download/gd1977-05-08.148737.SBD.Betty.Anon.Noel.t-flac2448/';

interface TestPreset {
  label: string;
  description: string;
  tracks: string[];
  titles: string[];
}

const PRESETS: TestPreset[] = [
  {
    label: 'Scarlet > Fire (2 tracks)',
    description: 'Grateful Dead — Cornell 1977-05-08 — Set 2 excerpt — Scarlet Begonias > Fire on the Mountain',
    tracks: [
      trackUrl(BASE + 'gd77-05-08.s2t02.mp3'),
      trackUrl(BASE + 'gd77-05-08.s2t03.mp3'),
    ],
    titles: ['Scarlet Begonias', 'Fire on the Mountain'],
  },
  {
    label: 'Full Set 1 (11 tracks)',
    description: 'Grateful Dead — Cornell 1977-05-08 — Complete Set 1 — New Minglewood Blues through Row Jimmy',
    tracks: [
      trackUrl(BASE + 'gd77-05-08.s1t01.mp3'),
      trackUrl(BASE + 'gd77-05-08.s1t02.mp3'),
      trackUrl(BASE + 'gd77-05-08.s1t03.mp3'),
      trackUrl(BASE + 'gd77-05-08.s1t04.mp3'),
      trackUrl(BASE + 'gd77-05-08.s1t05.mp3'),
      trackUrl(BASE + 'gd77-05-08.s1t06.mp3'),
      trackUrl(BASE + 'gd77-05-08.s1t07.mp3'),
      trackUrl(BASE + 'gd77-05-08.s1t08.mp3'),
      trackUrl(BASE + 'gd77-05-08.s1t09.mp3'),
      trackUrl(BASE + 'gd77-05-08.s1t10.mp3'),
      trackUrl(BASE + 'gd77-05-08.s1t11.mp3'),
    ],
    titles: [
      'New Minglewood Blues',
      'Loser',
      'El Paso',
      'They Love Each Other',
      'Jack Straw',
      'Deal',
      'Lazy Lightning',
      'Supplication',
      'Brown Eyed Women',
      'Mama Tried',
      'Row Jimmy',
    ],
  },
];

function Player({ preset }: { preset: TestPreset }) {
  const gapless = useGapless({ tracks: preset.tracks, titles: preset.titles, volume: 0.8 });

  return (
    <div className="player-layout">
      <div className="player-left">
        <NowPlaying
          state={gapless.state}
          currentTrack={gapless.currentTrack}
          volume={gapless.volume}
          onToggle={gapless.toggle}
          onPrev={gapless.prev}
          onNext={gapless.next}
          onSeek={gapless.seek}
          onSeekToEnd={gapless.seekToEnd}
          onVolumeChange={gapless.setVolume}
          playbackRate={gapless.playbackRate}
          onPlaybackRateChange={gapless.setPlaybackRate}
        />

        <Playlist
          tracks={gapless.tracks}
          currentTrack={gapless.currentTrack}
          onSelect={gapless.gotoTrack}
        />
      </div>

      <div className="player-right">
        <Status
          state={gapless.state}
          currentTrack={gapless.currentTrack}
          tracks={gapless.tracks}
          volume={gapless.volume}
        />

        <MachineDebug
          queueSnapshot={gapless.queueSnapshot}
          currentTrack={gapless.currentTrack}
          tracks={gapless.tracks}
          machineLog={gapless.machineLog}
        />

        <EventLog logs={gapless.logs} />
      </div>
    </div>
  );
}

export function App() {
  const [presetIndex, setPresetIndex] = useState(0);
  const preset = PRESETS[presetIndex];

  return (
    <>
      <h1>gapless.js — React demo</h1>
      <p className="sub">{preset.description} &middot; audio.relisten.net</p>

      <div className="preset-selector">
        {PRESETS.map((p, i) => (
          <button
            key={i}
            className={i === presetIndex ? 'primary' : ''}
            onClick={() => setPresetIndex(i)}
          >
            {p.label}
          </button>
        ))}
      </div>

      <Player key={presetIndex} preset={preset} />
    </>
  );
}
