# gapless.js — Internals, Architecture & Bug History

## Overview

`gapless.js` is a TypeScript library for **gapless audio playback in the browser**. It targets the Relisten.net use case: long concert recordings split into per-song tracks that must play back-to-back with no audible gap between them.

Version 3 is a full rewrite from a plain JavaScript UMD module to:
- **TypeScript ESM** (+ CJS interop via tsup)
- **`@xstate/fsm`** for explicit, testable state machines
- **Web Audio API** for sample-accurate gapless scheduling
- **HTML5 Audio** as the primary playback engine for the current track (avoids double-download and memory pressure from decoded PCM)
- **110 unit tests** with Vitest + happy-dom

---

## Architecture

### Two-machine design

`@xstate/fsm` supports flat machines only (no parallel or hierarchical states). Two separate machines are used:

**`QueueMachine`** — top-level queue state
```
idle → playing → paused → ended
```
Context: `currentTrackIndex`, `trackCount`, `volume`, `webAudioIsDisabled`

**`TrackMachine`** — per-track audio state
```
idle → html5 → webaudio
     ↘ loading ↗
     → error
```
Context: `playbackType`, `webAudioLoadingState`, `isPlaying`, `pausedAtTrackTime`, etc.

The `Queue` class owns the `QueueMachine` service. Each `Track` class owns its own `TrackMachine` service. Side-effects (playing audio, firing callbacks) all live in `Queue` and `Track` — the machines are pure transition tables.

### Playback strategy

```
Current track:   HTML5 Audio always
                 No double-fetch. No mid-track WebAudio switch.
                 audio.play() for immediate sound on user gesture.

Next track(s):   fetch() + AudioContext.decodeAudioData() in background
                 Decoded PCM buffer held in memory until needed.

Gapless join:    AudioBufferSourceNode.start(when, 0)
                 `when` = AudioContext.currentTime + remaining seconds of current track
                 Sub-millisecond accuracy. Zero gap.
```

### Preloading pipeline

1. `Queue.play()` → `_preloadAhead(currentIndex)` → `Track.preload()` on next track
2. `Track.preload()` starts HEAD request (to resolve redirects), then GET + `decodeAudioData`
3. On decode complete → `onTrackBufferReady` → `_tryScheduleGapless`
4. `_tryScheduleGapless` calculates `endTime` from current track's duration and `AudioContext.currentTime`, calls `Track.scheduleGaplessStart(endTime)`
5. `scheduleGaplessStart` calls `AudioBufferSourceNode.start(endTime, 0)` — the node is pre-armed and will fire at exactly the right moment
6. When the current track ends, `onTrackEnded` sees `_scheduledIndices.has(nextIndex)` → calls `startProgressLoop()` on the already-playing next track

Within the last 25 seconds of a track, the RAF progress loop also calls `onTrackBufferReady` to ensure the next track's buffer starts loading if it hasn't already.

### Pause/resume on WebAudio path

`AudioBufferSourceNode` is one-shot — it cannot be paused and restarted. On pause:
- Record `pausedAtTrackTime = currentTime`
- `sourceNode.stop()` + `disconnect()`
- Set `_webAudioPaused = true`

On resume:
- Create a fresh `AudioBufferSourceNode`
- `sourceNode.start(0, pausedAtTrackTime)`
- `webAudioStartedAt = ctx.currentTime - pausedAtTrackTime`

### `currentTime` formula

```
WebAudio playing:  ctx.currentTime - webAudioStartedAt
WebAudio paused:   pausedAtTrackTime  (frozen)
HTML5:             audio.currentTime
```

### AudioContext lifecycle

The `AudioContext` is **not created at Queue construction time**. Browsers block `new AudioContext()` before a user gesture and log a warning. Instead:

- `getAudioContext()` returns `null` if `resumeAudioContext()` has not yet been called
- `resumeAudioContext()` creates the context (if needed) AND resumes it if suspended
- All WebAudio code paths guard `if (!this.ctx) return` — they fall back to HTML5 silently until the context exists
- `Track.ctx` is a lazy getter that creates the `GainNode` on first access after the context becomes available

Call `queue.resumeAudioContext()` from your first user gesture (button click, keydown) before calling `queue.play()`.

### `previous()` behaviour

- If `currentTime > 8s` → seek to 0 and keep playing (restart current track)
- Otherwise → deactivate current, go to previous track, play

---

## Public API

### Constructor

```ts
import { Queue } from 'gapless.js';

const queue = new Queue({
  tracks: ['url1.mp3', 'url2.mp3'],   // optional; add more later via addTrack()
  trackMetadata: [                      // aligned to tracks[] by index
    { title: 'Song One', artist: 'Band' },
    { title: 'Song Two', artist: 'Band' },
  ],
  volume: 0.8,                          // 0.0–1.0, default 1

  onProgress(info) { ... },            // ~60fps while playing
  onStartNewTrack(info) { ... },       // whenever current track changes
  onPlayNextTrack(info) { ... },       // on forward advance
  onPlayPreviousTrack(info) { ... },   // on backward advance
  onEnded() { ... },                   // last track finished
  onError(err) { ... },                // HTML5 audio error
  onPlayBlocked() { ... },             // autoplay blocked by browser
  onDebug(msg) { ... },                // internal verbose logs (dev only)

  webAudioIsDisabled: false,           // set true to force HTML5-only (no gapless)
});
```

### Methods

```ts
// Must be called from a user gesture before play() on first interaction
queue.resumeAudioContext(): Promise<void>

queue.play(): void
queue.pause(): void
queue.togglePlayPause(): void

queue.next(): void
queue.previous(): void                  // restarts current track if > 8s in
queue.gotoTrack(index, playImmediately?): void

queue.seek(seconds): void
queue.setVolume(0.0–1.0): void

queue.addTrack(url, { metadata?, skipHEAD? }): void
queue.removeTrack(index): void

queue.destroy(): void                   // releases all resources
```

### Getters

```ts
queue.currentTrack: TrackInfo | undefined
queue.currentTrackIndex: number
queue.tracks: readonly TrackInfo[]
queue.isPlaying: boolean
queue.isPaused: boolean
queue.volume: number
queue.webAudioIsDisabled: boolean
```

### `TrackInfo`

Plain data object passed to all callbacks:

```ts
{
  index: number              // zero-based position in queue
  currentTime: number        // seconds
  duration: number           // seconds (NaN until loaded)
  isPlaying: boolean
  isPaused: boolean
  volume: number             // 0.0–1.0
  trackUrl: string           // resolved URL (may differ from original if redirected)
  playbackType: 'HTML5' | 'WEBAUDIO'
  webAudioLoadingState: 'NONE' | 'LOADING' | 'LOADED' | 'ERROR'
  metadata?: TrackMetadata   // { title?, artist?, album?, artwork?, ...extras }
}
```

---

## Development

```bash
pnpm install
pnpm build          # produces dist/index.mjs, dist/cjs/index.cjs, dist/index.d.mts
pnpm test           # vitest run (110 tests, ~500ms)
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
  setup.ts                  Mock AudioContext, GainNode, BufferSourceNode,
                            HTMLAudioElement, fetch. Installed globally via
                            vitest.config.ts setupFiles. Each test gets a
                            fresh MockAudioContext via _setAudioContext().

  unit/
    queue.machine.test.ts   Pure QueueMachine transition tests (no DOM)
    track.machine.test.ts   Pure TrackMachine transition tests (no DOM)
    timing.test.ts          Track currentTime math, scheduleGaplessStart,
                            pause/resume, seek — uses controllable mock clock
    queue.test.ts           Queue class integration tests — full public API,
                            callbacks, preloading, gapless scheduling
```

---

## Bug History

All bugs below were discovered during the v3 rewrite and are covered by regression tests.

---

### 1. `TRACK_ENDED` not handled in `paused` queue state

**Symptom:** When a track ended naturally while the queue was paused (user paused near end, audio buffer drained), the `TRACK_ENDED` event was silently dropped by the machine. The queue stayed on the finished track at index 0. Pressing Play replayed the ended track instead of starting the next one.

**Root cause:** `@xstate/fsm` silently ignores events with no handler in the current state. The `paused` state had no `TRACK_ENDED` handler.

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

- **No parallel states.** `@xstate/fsm` is a flat machine library (~2KB gzip). Complex hierarchical states require a different library. The two-machine design (Queue + Track) works around this.
- **Single AudioContext.** All tracks share one context. This is required for `AudioContext.currentTime` to be a common clock for scheduling.
- **CORS required for WebAudio.** `fetch()` + `decodeAudioData` requires the audio server to send CORS headers. If it doesn't, use the dev server's `/proxy` endpoint locally, or proxy in production. Without CORS, tracks silently fall back to HTML5 (no gapless).
- **One-shot source nodes.** `AudioBufferSourceNode` cannot be restarted. Every play/resume/seek creates a new node. The `AudioBuffer` (PCM data) is retained and reused — only the source node is replaced.
- **Gapless requires buffer before end of current track.** If the next track's buffer is not decoded before the current track ends, the queue falls back to HTML5 `audio.play()` for the next track, which introduces a gap. Preloading starts automatically within the last 25 seconds.
