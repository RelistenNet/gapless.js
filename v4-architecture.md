# gapless.js v4 — Architecture

## Overview

gapless.js is a browser audio playback library that achieves sample-accurate gapless transitions between tracks. It uses a dual-backend architecture: HTML5 Audio for broad compatibility and Web Audio API for gapless scheduling. State is managed by [xstate v5](https://stately.ai/docs/xstate) finite state machines at both the queue and per-track level, with a child actor for the fetch/decode pipeline.

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
  │ └──┬──┘ │     │ └──┬──┘ │
  │    │    │     │    │    │
  │ ┌──▼──┐ │     │ ┌──▼──┐ │
  │ │fetch│ │     │ │fetch│ │   ◄── FetchDecodeMachine (child actor)
  │ │decode│ │     │ │decode│ │
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
import { Queue } from 'gapless';
// or
import Queue from 'gapless';
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
} from 'gapless';
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
import { Queue } from 'gapless';
import type { TrackInfo } from 'gapless';

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
- `START_FETCH` — global event (handled in any state). When `webAudioLoadingState` is `NONE` and no fetch is in progress, spawns a `FetchDecodeMachine` child actor and sets `webAudioLoadingState` to `LOADING`.

Context: `{ trackUrl, resolvedUrl, skipHEAD, playbackType, webAudioLoadingState, webAudioStartedAt, pausedAtTrackTime, isPlaying, fetchDecodeRef }`

### FetchDecodeMachine

Child actor spawned by TrackMachine when `START_FETCH` fires. Manages the async fetch-and-decode pipeline as a series of invoked promises.

```
  resolvingUrl ──► fetching ──► decoding ──► done
       │               │            │
       │ (HEAD fails)  │            │
       └──► fetching   └──► error   └──► error
```

**States:**

| State | Meaning |
|---|---|
| `resolvingUrl` | HEAD request to resolve redirects. Skipped if `skipHEAD` is true. |
| `fetching` | GET request for the audio data. |
| `decoding` | `AudioContext.decodeAudioData()` on the ArrayBuffer. |
| `done` | Buffer decoded successfully (final). |
| `error` | Fetch or decode failed (final). |

**Parent communication via `sendParent`:**

| Event | When |
|---|---|
| `URL_RESOLVED` | HEAD request resolved a redirect URL. |
| `BUFFER_READY` | Decode succeeded — PCM buffer is available. |
| `BUFFER_ERROR` | Fetch or decode failed. |

xstate v5 automatically passes an `AbortSignal` to `fromPromise` actors, so when the parent stops (e.g., `destroy()`), in-flight fetches are aborted for free.

Context: `{ trackUrl, resolvedUrl, skipHEAD }`

Promise implementations (`resolveUrl`, `fetchAudio`, `decodeAudio`) are no-op defaults in the machine definition — `Track.ts` provides real implementations via `.provide()` at spawn time.

---

## How Gapless Playback Works

The core idea: schedule the next track's `AudioBufferSourceNode.start(when)` at the exact `AudioContext.currentTime` when the current track ends. Because all tracks share one `AudioContext`, the clock is monotonic and the transition is sample-accurate.

### Step by step

1. **Preload**: When a track starts playing, the Queue calls `_preloadAhead()` to begin fetching and decoding the next 2 tracks. Each track spawns a `FetchDecodeMachine` child actor which runs: resolve URL → fetch → decode.

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

### Fetch/Decode Pipeline

The fetch/decode pipeline is modeled as a `FetchDecodeMachine` child actor, spawned by the TrackMachine via `START_FETCH`. The pipeline runs through: HEAD request (resolve redirects) → GET (fetch audio data) → `decodeAudioData()` (decode to PCM). Each step is an invoked promise, and xstate v5 provides automatic abort-on-destroy via `AbortSignal`.

This replaces the previous approach of manual `AbortController` and `_startLoad()` method — all pipeline state is now managed declaratively by the machine.

### AudioContext — Singleton

All tracks share a single `AudioContext` (created lazily on first user gesture via `resumeAudioContext()`). This is essential — `AudioContext.currentTime` must be a shared clock for gapless scheduling to work.

```typescript
import { getAudioContext, resumeAudioContext } from './utils/audioContext';

// Returns null until resumeAudioContext() has been called
const ctx = getAudioContext();

// Must be called from a user gesture handler
await resumeAudioContext();
```

The `AudioContext` is **not created at Queue construction time**. Browsers block `new AudioContext()` before a user gesture and log a warning. `getAudioContext()` returns `null` until `resumeAudioContext()` has been called. All WebAudio code paths guard `if (!this.ctx) return` and silently fall back to HTML5 until the context exists.

### Media Session

The Queue automatically integrates with the [Media Session API](https://developer.mozilla.org/en-US/docs/Web/API/Media_Session_API) for OS-level playback controls (lock screen, notification shade, media keys). Track metadata (`title`, `artist`, `album`, `artwork`) is forwarded to the OS when tracks change.

### Preloading

- Controlled by `PRELOAD_AHEAD = 2` in Queue.ts.
- When a track starts playing, the next 2 unloaded tracks are fetched and decoded sequentially.
- `onTrackBufferReady` cascades: when track N finishes decoding, track N+1 starts.
- The progress loop provides a second trigger at `GAPLESS_SCHEDULE_LOOKAHEAD = 5` seconds before track end, ensuring gapless scheduling happens even if preloading completed long ago.

### Pause/Resume on WebAudio Path

`AudioBufferSourceNode` is one-shot — it cannot be paused and restarted. On pause:
- Record `pausedAtTrackTime = currentTime`
- `sourceNode.stop()` + `disconnect()`
- Set `_webAudioPaused = true`

On resume:
- Create a fresh `AudioBufferSourceNode`
- `sourceNode.start(0, pausedAtTrackTime)`
- `webAudioStartedAt = ctx.currentTime - pausedAtTrackTime`

### `currentTime` Formula

```
WebAudio playing:  ctx.currentTime - webAudioStartedAt
WebAudio paused:   pausedAtTrackTime  (frozen)
HTML5:             audio.currentTime
```

### `previous()` Behaviour

- If `currentTime > 8s` → seek to 0 and keep playing (restart current track)
- Otherwise → deactivate current, go to previous track, play

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
    fetchDecode.machine.ts    FetchDecodeMachine (child actor — fetch/decode pipeline)
  utils/
    audioContext.ts            Singleton AudioContext manager
    mediaSession.ts            Media Session API integration
```

---

## Development

```bash
pnpm install
pnpm build          # produces dist/index.mjs, dist/cjs/index.cjs, dist/index.d.mts
pnpm test           # vitest run (182 tests, ~500ms)
pnpm test:watch     # vitest watch mode
pnpm dev            # node dev-server.mjs → http://localhost:8765
```

### Dev server (`dev-server.mjs`)

Serves three things on port 8765:

| Path | Purpose |
|---|---|
| `/` | Static files from project root (`index.html` + `dist/`) |
| `/proxy?url=<encoded>` | CORS proxy — required for `fetch()` + `decodeAudioData` on cross-origin audio (e.g. `audio.relisten.net` has no CORS headers) |
| `/esr` | SSE hot-reload — browser reloads when `dist/*.mjs` or `index.html` changes |

Workflow: `pnpm dev` (server) in one terminal, `pnpm build` (or `pnpm build --watch`) in another. The browser reloads automatically after each build.

### Test structure

```
tests/
  setup.ts                        Mock AudioContext, GainNode, BufferSourceNode,
                                  HTMLAudioElement, fetch. Installed globally via
                                  vitest.config.ts setupFiles. Each test gets a
                                  fresh MockAudioContext via _setAudioContext().

  unit/
    queue.machine.test.ts         Pure QueueMachine transition tests (no DOM)
    track.machine.test.ts         Pure TrackMachine transition tests (no DOM)
    fetchDecode.machine.test.ts   FetchDecodeMachine transition + sendParent tests
    timing.test.ts                Track currentTime math, scheduleGaplessStart,
                                  pause/resume, seek — uses controllable mock clock
    queue.test.ts                 Queue class integration tests — full public API,
                                  callbacks, preloading, gapless scheduling
```

---

## Bug History

All bugs below were discovered during the v3→v4 development and are covered by regression tests.

---

### 1. `TRACK_ENDED` not handled in `paused` queue state

**Symptom:** When a track ended naturally while the queue was paused (user paused near end, audio buffer drained), the `TRACK_ENDED` event was silently dropped by the machine. The queue stayed on the finished track at index 0. Pressing Play replayed the ended track instead of starting the next one.

**Root cause:** The `paused` state had no `TRACK_ENDED` handler, so the event was silently ignored.

**Fix:** `TRACK_ENDED` in `paused` → advance `currentTrackIndex`, stay `paused`. Last track → go to `ended`. `Queue.onTrackEnded` fires `onStartNewTrack` (UI update) but does NOT call `play()` — user explicitly paused and must press Play.

**Tests:** `queue.machine.test.ts` — "TRACK_ENDED in paused stays paused and advances index", "does not auto-play", "on last track goes to ended". `queue.test.ts` — 6 integration tests in "Queue TRACK_ENDED while paused".

---

### 2. Spurious `pause()` from MediaSession on natural track end

**Symptom:** The queue transitioned to `paused` state at the exact moment a track ended naturally, before `onended` fired. The next track never auto-started.

**Root cause:** Chrome fires the MediaSession `pause` action when the HTML5 audio element reaches end-of-track (before `ended`). The unguarded `onPause: () => this.pause()` handler called `Queue.pause()` unconditionally, sending `'PAUSE'` to the queue machine. When `onended` subsequently fired, `TRACK_ENDED` was handled correctly by the `paused` state — but the queue stayed paused instead of playing.

**Fix:** Guard the MediaSession `pause` handler: `onPause: () => { if (this._service.state.value === 'playing') this.pause(); }`. Natural end-of-track arrives while the queue is transitioning from `playing` (Chrome fires it before `onended`), so the guard correctly ignores it.

**Tests:** `queue.test.ts` — "calling pause() while already paused does not corrupt state", "TRACK_ENDED after a spurious pause still advances to next track".

---

### 3. `resumeAudioContext().then()` race causing spurious pause on Play button

**Symptom:** On some page loads, clicking the Play button immediately paused instead of playing. Required a second click to actually start playback.

**Root cause:** The test page called `resumeAudioContext().then(() => queue.play())` on startup AND `resumeAudioContext().then(() => queue.togglePlayPause())` on button click. `resumeAudioContext()` always returns a `Promise` (even when the context is already running), so `then()` always runs in a microtask. If the startup and button-click promises were both queued, the startup `.then()` ran first (setting queue to `playing`), then the button `.then()` ran and called `togglePlayPause()` — which saw `playing` and called `pause()`.

**Fix (test page):** Track whether the AudioContext has been unlocked. After the first gesture, call queue methods synchronously — no `await`, no microtask gap. Removed the startup auto-play attempt entirely (browser policy blocks it without a gesture anyway).

---

### 4. `AudioContext` created before user gesture

**Symptom:** Browser console warning: *"An AudioContext was prevented from starting automatically. It must be created or resumed after a user gesture on the page."*

**Root cause:** `getAudioContext()` called `new AudioContext()` lazily on first access. This happened at `Queue` construction time (via `Track` constructors), before any user gesture.

**Fix:** Split responsibilities:
- `getAudioContext()` returns `null` if `resumeAudioContext()` has never been called (no `new AudioContext()`)
- `resumeAudioContext()` creates the context on first call (must be from a user gesture), then resumes it if suspended
- `Track.ctx` is a lazy getter — checks `getAudioContext()` each time and creates the `GainNode` on first non-null access
- All WebAudio code paths already guard `if (!this.ctx) return`, so they silently fall back to HTML5 until the context exists

---

### 5. `scheduleGaplessStart` sent wrong machine event (`'PLAY'` instead of `'PLAY_WEBAUDIO'`)

**Symptom:** After a gapless transition, the next track played audio correctly (WebAudio source node was running) but `Track.currentTime` returned 0 and never advanced. Progress bar frozen.

**Root cause:** `scheduleGaplessStart` sent `this.service.send('PLAY')` instead of `'PLAY_WEBAUDIO'`. The `'PLAY'` event transitions the machine to `html5` state. In `html5` state, `_isUsingWebAudio` returns false, so `currentTime` read from `audio.currentTime` (the HTML5 element, which was at 0 since it was never used for this track).

**Fix:** `scheduleGaplessStart` sends `'PLAY_WEBAUDIO'`.

**Tests:** `timing.test.ts` — "puts track machine into webaudio state (not html5)", "currentTime uses WebAudio clock after scheduleGaplessStart", "currentTime does NOT read from stale audio.currentTime".

---

### 6. `scheduleGaplessStart` never started the progress loop

**Symptom:** Companion to bug #5. Even after fixing the machine state, `onProgress` was never called for gapless-started tracks. The "Now Playing" title and timestamp stayed frozen on the previous track.

**Root cause:** `scheduleGaplessStart` armed the WebAudio node and updated machine state, but did not call `_startProgressLoop()`. Separately, `Queue.onTrackEnded`'s gapless branch (when `_scheduledIndices.has(cur.index)`) called `cur.play()` for non-scheduled tracks but had no equivalent for scheduled ones.

**Fix:** `Queue.onTrackEnded` gapless branch calls `cur.startProgressLoop()` (renamed from private `_startProgressLoop` to allow Queue to call it). The progress loop then drives `onProgress` as normal.

**Tests:** `queue.test.ts` — "startProgressLoop() is called on the next track after a gapless transition". `timing.test.ts` — "startProgressLoop() triggers onProgress callback".

---

### 7. `PLAY_WEBAUDIO` silently dropped in `webaudio` machine state → `isPlaying` never true

**Symptom:** After a gapless transition where the next track's buffer had already finished decoding (fast network / short track), `onProgress` still never fired even with the progress loop fix in place. The loop started but exited immediately.

**Root cause:** The progress loop exits when `!this.isPlaying`. `isPlaying` is `this.service.state.context.isPlaying`. The sequence was:

1. Track preloads: `idle` → `loading` (via `PRELOAD`)
2. Buffer decode completes: `loading` → `webaudio` (via `BUFFER_READY`) — `isPlaying` stays `false` (track is decoded but not yet audible)
3. `scheduleGaplessStart` fires: sends `'PLAY_WEBAUDIO'` — but the machine is already in `webaudio` state and had **no `PLAY_WEBAUDIO` handler**. Event silently dropped. `isPlaying` remains `false`.
4. `startProgressLoop` runs: checks `!this.isPlaying` → `true` → exits immediately. No progress.

**Fix:** Add `PLAY_WEBAUDIO` handler in `webaudio` state that sets `isPlaying: true`. This correctly represents the moment `scheduleGaplessStart` arms the node and it will imminently produce sound.

**Tests:** `track.machine.test.ts` — "PLAY_WEBAUDIO in webaudio sets isPlaying true (gapless path)", "PLAY_WEBAUDIO was silently dropped in webaudio state before fix (regression guard)". `timing.test.ts` — "isPlaying is true after scheduleGaplessStart even when track was in webaudio state from BUFFER_READY".

---

## Known Constraints

- **Single AudioContext.** All tracks share one context. This is required for `AudioContext.currentTime` to be a common clock for scheduling.
- **CORS required for WebAudio.** `fetch()` + `decodeAudioData` requires the audio server to send CORS headers. If it doesn't, use the dev server's `/proxy` endpoint locally, or proxy in production. Without CORS, tracks silently fall back to HTML5 (no gapless).
- **One-shot source nodes.** `AudioBufferSourceNode` cannot be restarted. Every play/resume/seek creates a new node. The `AudioBuffer` (PCM data) is retained and reused — only the source node is replaced.
- **Gapless requires buffer before end of current track.** If the next track's buffer is not decoded before the current track ends, the queue falls back to HTML5 `audio.play()` for the next track, which introduces a gap. Preloading starts automatically within the last 25 seconds.
