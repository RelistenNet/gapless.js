# gapless.js v4 — Architecture

## Overview

gapless.js is a browser audio playback library that achieves sample-accurate gapless transitions between tracks. It uses a dual-backend architecture: HTML5 Audio for broad compatibility and Web Audio API for gapless scheduling. State is managed by [xstate v5](https://stately.ai/docs/xstate) finite state machines at both the queue and per-track level.

```
┌──────────────────────────────────────────────────┐
│  Queue (public API)                              │
│  play, pause, next, prev, seek, gotoTrack, ...   │
└──────────────┬───────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────┐
│  QueueMachine (xstate)                           │
│  idle ─► playing ◄─► paused ─► ended             │
│  Manages currentTrackIndex + trackCount          │
└──────────────┬───────────────────────────────────┘
               │
       ┌───────┴───────┐
       ▼               ▼
  ┌─────────┐     ┌─────────┐
  │ Track 0 │     │ Track 1 │  ...
  │ ┌─────┐ │     │ ┌─────┐ │
  │ │ FSM │ │     │ │ FSM │ │   ◄── TrackMachine (per-track)
  │ └─────┘ │     │ └─────┘ │
  │ <audio> │     │ <audio> │
  │ + nodes │     │ + nodes │   ◄── AudioBufferSourceNode, GainNode
  └────┬────┘     └────┬────┘
       └───────┬───────┘
               ▼
  ┌──────────────────────────┐
  │ AudioContext (singleton)  │
  │ Shared clock for gapless │
  └──────────────────────────┘
```

---

## Public API

### Importing

```typescript
import { Queue } from 'gapless.js';
// or
import Queue from 'gapless.js';
```

Exported types:

```typescript
import type {
  GaplessOptions,
  AddTrackOptions,
  TrackInfo,
  TrackMetadata,
  PlaybackType,       // 'HTML5' | 'WEBAUDIO'
  WebAudioLoadingState // 'NONE' | 'LOADING' | 'LOADED' | 'ERROR'
} from 'gapless.js';
```

### Constructor

```typescript
const queue = new Queue({
  tracks: ['https://example.com/a.mp3', 'https://example.com/b.mp3'],
  trackMetadata: [
    { title: 'Track A', artist: 'Artist' },
    { title: 'Track B', artist: 'Artist' },
  ],
  volume: 0.8,
  webAudioIsDisabled: false,

  // Callbacks
  onProgress:          (info: TrackInfo) => {},  // ~60 fps while playing
  onStartNewTrack:     (info: TrackInfo) => {},  // any new track becomes current
  onPlayNextTrack:     (info: TrackInfo) => {},  // advanced forward
  onPlayPreviousTrack: (info: TrackInfo) => {},  // went backward
  onEnded:             () => {},                 // last track finished
  onError:             (error: Error) => {},     // playback error
  onPlayBlocked:       () => {},                 // browser blocked autoplay
  onDebug:             (msg: string) => {},      // internal debug messages
});
```

### Methods

| Method | Description |
|---|---|
| `play()` | Start or resume playback of the current track. |
| `pause()` | Pause the current track. |
| `togglePlayPause()` | Toggle between play and pause. |
| `next()` | Advance to the next track. No-op on the last track. |
| `previous()` | Go to previous track, or restart current if > 8 s in. |
| `gotoTrack(index, playImmediately?)` | Jump to a specific track by index. |
| `seek(time)` | Seek to a position in seconds. |
| `setVolume(volume)` | Set volume (0.0–1.0, clamped). |
| `addTrack(url, options?)` | Append a track to the queue. |
| `removeTrack(index)` | Remove a track by index (reindexes remaining). |
| `resumeAudioContext()` | Create + resume the AudioContext. **Must be called from a user gesture.** |
| `destroy()` | Stop playback and release all resources. |

### Getters

| Getter | Type | Description |
|---|---|---|
| `currentTrack` | `TrackInfo \| undefined` | Snapshot of the current track. |
| `currentTrackIndex` | `number` | Zero-based index of the current track. |
| `tracks` | `readonly TrackInfo[]` | Snapshot array of all tracks. |
| `isPlaying` | `boolean` | Queue is in playing state. |
| `isPaused` | `boolean` | Queue is in paused state. |
| `volume` | `number` | Current volume (0.0–1.0). |

### TrackInfo

All callbacks and getters return `TrackInfo` — a plain data snapshot with no methods:

```typescript
interface TrackInfo {
  index: number;
  currentTime: number;
  duration: number;          // NaN until metadata loaded
  isPlaying: boolean;
  isPaused: boolean;
  volume: number;
  trackUrl: string;
  playbackType: PlaybackType;
  webAudioLoadingState: WebAudioLoadingState;
  metadata?: TrackMetadata;
}
```

### TrackMetadata

```typescript
interface TrackMetadata {
  title?: string;
  artist?: string;
  album?: string;
  artwork?: MediaImage[];  // for Media Session API
  [key: string]: unknown;
}
```

---

## React Integration

gapless.js has no React dependency. Wrap it in a custom hook:

```typescript
import { useRef, useState, useEffect, useCallback } from 'react';
import { Queue } from 'gapless.js';
import type { TrackInfo } from 'gapless.js';

export function useGapless(tracks: string[], metadata: { title: string }[]) {
  const queueRef = useRef<Queue | null>(null);
  const ctxReady = useRef(false);

  const [state, setState] = useState<'idle' | 'playing' | 'paused' | 'ended'>('idle');
  const [currentTrack, setCurrentTrack] = useState<TrackInfo>();
  const [allTracks, setAllTracks] = useState<readonly TrackInfo[]>([]);

  useEffect(() => {
    const q = new Queue({
      tracks,
      trackMetadata: metadata,
      onProgress(info) {
        setCurrentTrack(info);
        setAllTracks(q.tracks);
      },
      onStartNewTrack(info) {
        setCurrentTrack(info);
        setState('playing');
      },
      onEnded() {
        setState('ended');
      },
    });
    queueRef.current = q;
    setAllTracks(q.tracks);

    return () => {
      q.destroy();
      queueRef.current = null;
    };
  }, []);  // stable — create once

  // Wrap user-gesture actions to ensure AudioContext is alive
  const withCtx = useCallback((fn: () => void) => {
    const q = queueRef.current;
    if (!q) return;
    if (ctxReady.current) { fn(); return; }
    q.resumeAudioContext().then(() => {
      ctxReady.current = true;
      fn();
    });
  }, []);

  const play    = useCallback(() => withCtx(() => queueRef.current?.play()), [withCtx]);
  const pause   = useCallback(() => queueRef.current?.pause(), []);
  const toggle  = useCallback(() => withCtx(() => queueRef.current?.togglePlayPause()), [withCtx]);
  const next    = useCallback(() => withCtx(() => queueRef.current?.next()), [withCtx]);
  const prev    = useCallback(() => withCtx(() => queueRef.current?.previous()), [withCtx]);
  const seek    = useCallback((t: number) => queueRef.current?.seek(t), []);
  const goto    = useCallback((i: number) => withCtx(() => {
    queueRef.current?.gotoTrack(i, true);
  }), [withCtx]);

  return { state, currentTrack, tracks: allTracks, play, pause, toggle, next, prev, seek, goto };
}
```

Key points:

- **`resumeAudioContext()` must be called from a user gesture** (click/keydown). The `withCtx` wrapper ensures this happens on the first interaction.
- **`onProgress` fires at ~60 fps** — it's the primary driver for React state updates. Avoid expensive work in this callback.
- **`TrackInfo` is a plain object** — safe to put directly into React state.
- **Create the Queue once** in a `useEffect` or `useRef`. Don't recreate it on re-render. If you need to swap the track list, destroy and recreate (e.g., use a React `key` on the parent component).

---

## State Machines

### QueueMachine

Manages which track is current and whether the queue is playing, paused, or finished.

```
         PLAY
  idle ────────► playing ◄──────► paused
                   │     PAUSE/     │
                   │     TOGGLE     │
                   │                │
            TRACK_ENDED       TRACK_ENDED
           (no next track)   (no next track)
                   │                │
                   └───► ended ◄────┘
                          │
                         PLAY
                          │
                          ▼
                       playing (reset to track 0)
```

- **NEXT / PREVIOUS / GOTO** — change `currentTrackIndex` without changing play/pause state.
- **TRACK_ENDED** — auto-advances. If there's a next track, stays in current state (playing or paused). If no next track, transitions to `ended`.
- **ADD_TRACK / REMOVE_TRACK** — adjust `trackCount` and `currentTrackIndex` from any state.

Context: `{ currentTrackIndex: number, trackCount: number }`

### TrackMachine

Each Track has its own machine managing its playback backend and loading state.

```
           PLAY              PLAY_WEBAUDIO
  idle ──────────► html5 ──────────────────► webaudio
    │                │                          │
    │ PRELOAD        │ DEACTIVATE               │ DEACTIVATE
    ▼                ▼                          │ WEBAUDIO_ENDED
  loading ◄──────  html5                        │
    │                                           ▼
    │ BUFFER_ERROR                            idle
    ▼
  idle
```

**States:**

| State | Meaning |
|---|---|
| `idle` | Constructed, not active. |
| `html5` | HTML5 `<audio>` element is the active output. WebAudio decode may be running in parallel. |
| `loading` | Track is preloading in the background (not currently playing). |
| `webaudio` | An `AudioBufferSourceNode` is the active output. |

**Key transitions:**

- `BUFFER_READY` in `html5` — stays in `html5`, just marks the buffer as loaded. The switchover to `webaudio` only happens via an explicit `PLAY_WEBAUDIO`.
- `BUFFER_READY` in `loading` — stays in `loading`. The track waits for the Queue to decide when to play it.
- `DEACTIVATE` from `webaudio` — goes to `idle` (not `loading`), since the track is being swapped out.

Context: `{ trackUrl, resolvedUrl, skipHEAD, playbackType, webAudioLoadingState, webAudioStartedAt, pausedAtTrackTime, isPlaying }`

---

## How Gapless Playback Works

The core idea: schedule the next track's `AudioBufferSourceNode.start(when)` at the exact `AudioContext.currentTime` when the current track ends. Because all tracks share one `AudioContext`, the clock is monotonic and the transition is sample-accurate.

### Step by step

1. **Preload**: When a track starts playing, the Queue calls `_preloadAhead()` to begin fetching and decoding the next 2 tracks via `fetch()` → `AudioContext.decodeAudioData()`.

2. **Schedule**: When the current track is within 5 seconds of its end and the next track's buffer is decoded, `_tryScheduleGapless()` computes the exact end time:
   ```
   endTime = current.scheduledStartContextTime + current.duration
   // or, for the first track (HTML5-started):
   endTime = ctx.currentTime + remaining
   ```

3. **Start at precise time**: `next.scheduleGaplessStart(endTime)` creates a source node and calls `sourceNode.start(endTime, 0)`. The Web Audio scheduler guarantees the node begins at exactly that sample.

4. **Handoff**: When the current track's source node fires `onended`, the Queue advances `currentTrackIndex`. Since the next track was pre-scheduled, it's already playing — the Queue just starts its progress loop.

### Fallback

If Web Audio is unavailable (`webAudioIsDisabled: true`), decoding fails, or the buffer isn't ready in time, playback falls back to HTML5 Audio. There will be a small gap between tracks in this case.

---

## Internal Architecture

### Track — Dual Backend

Each `Track` instance holds:

- An `HTMLAudioElement` (always created, `preload='none'` initially)
- An optional `AudioBuffer` (decoded when preloaded)
- A `GainNode` for volume control
- A `sourceNode` (`AudioBufferSourceNode`) when actively playing via Web Audio

The `play()` method resolves which backend to use:

1. If in `webaudio` state → create new source node from buffer
2. If buffer is decoded and context exists → switch to Web Audio
3. Otherwise → play via HTML5 `<audio>` element

### AudioContext — Singleton

All tracks share a single `AudioContext` (created lazily on first user gesture via `resumeAudioContext()`). This is essential — `AudioContext.currentTime` must be a shared clock for gapless scheduling to work.

```typescript
import { getAudioContext, resumeAudioContext } from './utils/audioContext';

// Returns null until resumeAudioContext() has been called
const ctx = getAudioContext();

// Must be called from a user gesture handler
await resumeAudioContext();
```

### Media Session

The Queue automatically integrates with the [Media Session API](https://developer.mozilla.org/en-US/docs/Web/API/Media_Session_API) for OS-level playback controls (lock screen, notification shade, media keys). Track metadata (`title`, `artist`, `album`, `artwork`) is forwarded to the OS when tracks change.

### Preloading

- Controlled by `PRELOAD_AHEAD = 2` in Queue.ts.
- When a track starts playing, the next 2 unloaded tracks are fetched and decoded sequentially.
- `onTrackBufferReady` cascades: when track N finishes decoding, track N+1 starts.
- The progress loop provides a second trigger at `GAPLESS_SCHEDULE_LOOKAHEAD = 5` seconds before track end, ensuring gapless scheduling happens even if preloading completed long ago.

---

## File Map

```
src/
  index.ts                    Public exports (Queue + types)
  Queue.ts                    Queue class — public API, orchestrates tracks
  Track.ts                    Track class — dual-backend playback, gapless scheduling
  types.ts                    Shared TypeScript types
  machines/
    queue.machine.ts          QueueMachine (xstate v5)
    track.machine.ts          TrackMachine (xstate v5)
  utils/
    audioContext.ts            Singleton AudioContext manager
    mediaSession.ts            Media Session API integration
```
