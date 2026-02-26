# gapless.js

Gapless audio playback for the web. Takes an array of audio tracks and uses HTML5 audio with the Web Audio API to enable seamless, gapless transitions between tracks.

Built for [Relisten.net](https://relisten.net).

**[Live Demo](https://gapless.saewitz.com)**

## Install

```bash
pnpm install gapless.js
```

## Quick Start

```javascript
import Queue from 'gapless.js';

const player = new Queue({
  tracks: [
    'https://example.com/track1.mp3',
    'https://example.com/track2.mp3',
    'https://example.com/track3.mp3',
  ],
  onProgress: (track) => {
    console.log(`${track.currentTime} / ${track.duration}`);
  },
  onEnded: () => {
    console.log('Queue finished');
  },
});

player.play();
```

## API

### Constructor Options (`GaplessOptions`)

```typescript
const player = new Queue({
  tracks: [],              // Initial list of track URLs
  onProgress: (info) => {},     // Called at ~60fps while playing
  onEnded: () => {},            // Called when the last track ends
  onPlayNextTrack: (info) => {},    // Called when advancing to next track
  onPlayPreviousTrack: (info) => {},// Called when going to previous track
  onStartNewTrack: (info) => {},    // Called whenever a new track becomes current
  onError: (error) => {},       // Called on audio errors
  onPlayBlocked: () => {},      // Called when autoplay is blocked by the browser
  onDebug: (msg) => {},         // Internal debug messages (development only)
  webAudioIsDisabled: false,    // Disable Web Audio API (disables gapless playback)
  trackMetadata: [],            // Per-track metadata (aligned by index)
  volume: 1,                    // Initial volume, 0.0–1.0
});
```

### Methods

| Method | Description |
|--------|-------------|
| `play()` | Start or resume playback |
| `pause()` | Pause playback |
| `togglePlayPause()` | Toggle between play and pause |
| `next()` | Advance to the next track |
| `previous()` | Go to previous track (restarts current track if > 8s in) |
| `gotoTrack(index, playImmediately?)` | Jump to a track by index |
| `seek(time)` | Seek to a position in seconds |
| `setVolume(volume)` | Set volume (0.0–1.0) |
| `addTrack(url, options?)` | Add a track to the end of the queue |
| `removeTrack(index)` | Remove a track by index |
| `resumeAudioContext()` | Resume the AudioContext (for browsers that require user gesture) |
| `destroy()` | Clean up all resources |

### Getters

| Getter | Type | Description |
|--------|------|-------------|
| `currentTrack` | `TrackInfo \| undefined` | Snapshot of the current track |
| `currentTrackIndex` | `number` | Index of the current track |
| `tracks` | `readonly TrackInfo[]` | Snapshot of all tracks |
| `isPlaying` | `boolean` | Whether the queue is playing |
| `isPaused` | `boolean` | Whether the queue is paused |
| `volume` | `number` | Current volume |

### `TrackInfo`

All callbacks and getters return `TrackInfo` objects — plain data snapshots with no methods:

```typescript
interface TrackInfo {
  index: number;                    // Position in the queue
  currentTime: number;              // Playback position in seconds
  duration: number;                 // Total duration (NaN until loaded)
  isPlaying: boolean;
  isPaused: boolean;
  volume: number;
  trackUrl: string;                 // Resolved audio URL
  playbackType: 'HTML5' | 'WEBAUDIO';
  webAudioLoadingState: 'NONE' | 'LOADING' | 'LOADED' | 'ERROR';
  metadata?: TrackMetadata;
  machineState: string;             // Internal state machine state
}
```

### `AddTrackOptions`

```typescript
player.addTrack('https://example.com/track.mp3', {
  skipHEAD: true,       // Skip HEAD request for URL resolution
  metadata: {
    title: 'Track Title',
    artist: 'Artist',
    album: 'Album',
    artwork: [{ src: 'https://example.com/art.jpg', sizes: '512x512', type: 'image/jpeg' }],
  },
});
```

### `TrackMetadata`

Metadata is used for the [Media Session API](https://developer.mozilla.org/en-US/docs/Web/API/Media_Session_API) (lock screen controls, browser media UI) and can contain arbitrary additional fields:

```typescript
interface TrackMetadata {
  title?: string;
  artist?: string;
  album?: string;
  artwork?: MediaImage[];
  [key: string]: unknown;
}
```

## Migration from v3

v4 is a complete rewrite. The public API has changed:

| v3 | v4 |
|----|-----|
| `import GaplessQueue from 'gapless.js'` | `import Queue from 'gapless.js'` (or `import { Queue }`) |
| `player.playNext()` | `player.next()` |
| `player.playPrevious()` | `player.previous()` |
| `player.resetCurrentTrack()` | `player.seek(0)` |
| `player.disableWebAudio()` | Pass `webAudioIsDisabled: true` in constructor |
| `player.nextTrack` | `player.tracks[player.currentTrackIndex + 1]` |
| `track.completeState` | Callbacks now receive `TrackInfo` objects |
| Callbacks receive Track instances | Callbacks receive plain `TrackInfo` data snapshots |

### Key differences

- **State machines**: Internally uses [XState](https://xstate.js.org/) for queue and track state management. XState is bundled — no extra dependency needed.
- **ESM only**: Published as ES module only. No CommonJS build.
- **TrackInfo**: All callbacks and getters return plain data objects (`TrackInfo`) instead of Track class instances.
- **Media Session**: Built-in support for the Media Session API via `trackMetadata`.
- **Volume**: Volume is now set via `setVolume(n)` and readable via the `volume` getter.

## License

MIT
