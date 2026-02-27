// ---------------------------------------------------------------------------
// Vitest global test setup — Web Audio API mocks
//
// Vitest runs in happy-dom which provides a browser-like environment but
// does NOT implement Web Audio API. We provide a minimal, controllable mock
// that lets us test all state machine transitions and timing calculations
// in pure Node.js without a real browser.
// ---------------------------------------------------------------------------

import { vi, beforeEach } from 'vitest';
import { _resetAudioContext, _setAudioContext } from '../src/utils/audioContext';

// ---------------------------------------------------------------------------
// Suppress xstate v5 false-positive warnings
//
// xstate 5.28 warns "Custom actions should not call assign() directly" when
// spawn() creates a child actor inside an assign action — the child's context
// initialiser internally calls assign(), tripping the module-level guard.
// This is a known xstate issue, not a bug in our code.
// ---------------------------------------------------------------------------
const _origWarn = console.warn;
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('Custom actions should not call')) return;
  _origWarn(...args);
};

// ---------------------------------------------------------------------------
// Controllable AudioContext clock
// ---------------------------------------------------------------------------
let _contextTime = 0;

/** Advance the mock AudioContext clock by `seconds`. */
export function advanceTime(seconds: number): void {
  _contextTime += seconds;
}

/** Reset the mock clock to zero. */
export function resetTime(): void {
  _contextTime = 0;
}

// ---------------------------------------------------------------------------
// Mock AudioBufferSourceNode
// ---------------------------------------------------------------------------
export class MockAudioBufferSourceNode {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  playbackRate = { value: 1 };
  private _started = false;
  private _stopped = false;

  connect = vi.fn();
  disconnect = vi.fn();

  start = vi.fn((_when?: number, _offset?: number) => {
    if (this._started) throw new Error('InvalidStateError: already started');
    this._started = true;
  });

  stop = vi.fn(() => {
    if (this._stopped) throw new Error('InvalidStateError: already stopped');
    this._stopped = true;
  });

  /** Test helper: simulate the node reaching its natural end. */
  simulateEnded(): void {
    this.onended?.();
  }
}

// ---------------------------------------------------------------------------
// Mock GainNode
// ---------------------------------------------------------------------------
export class MockGainNode {
  gain = { value: 1 };
  connect = vi.fn();
  disconnect = vi.fn();
}

// ---------------------------------------------------------------------------
// Mock AudioBuffer
// ---------------------------------------------------------------------------
export class MockAudioBuffer {
  constructor(public duration: number, public numberOfChannels = 2, public sampleRate = 44100) {}
  getChannelData = vi.fn(() => new Float32Array(Math.round(this.duration * this.sampleRate)));
}

// ---------------------------------------------------------------------------
// Mock AudioContext
// ---------------------------------------------------------------------------
export class MockAudioContext {
  get currentTime(): number {
    return _contextTime;
  }
  state: AudioContextState = 'running';

  createBufferSource = vi.fn(() => new MockAudioBufferSourceNode());
  createGain = vi.fn(() => new MockGainNode());
  resume = vi.fn(() => Promise.resolve());
  suspend = vi.fn(() => Promise.resolve());
  close = vi.fn(() => Promise.resolve());

  decodeAudioData = vi.fn(
    (_buf: ArrayBuffer, success?: (b: AudioBuffer) => void): Promise<AudioBuffer> => {
      const mockBuffer = new MockAudioBuffer(180) as unknown as AudioBuffer;
      success?.(mockBuffer);
      return Promise.resolve(mockBuffer);
    },
  );
}

// ---------------------------------------------------------------------------
// Mock HTMLAudioElement
// ---------------------------------------------------------------------------
export class MockAudioElement {
  src = '';
  preload = 'none';
  volume = 1;
  controls = false;
  currentTime = 0;
  duration = NaN;
  paused = true;
  readyState = 0;

  ended = false;

  // Event handlers
  onerror: ((e: unknown) => void) | null = null;
  onended: (() => void) | null = null;
  private _listeners: Record<string, Array<{ cb: EventListenerOrEventListenerObject; once: boolean }>> = {};

  play = vi.fn(() => {
    this.paused = false;
    return Promise.resolve();
  });

  pause = vi.fn(() => {
    this.paused = true;
  });

  load = vi.fn();

  addEventListener = vi.fn(
    (type: string, cb: EventListenerOrEventListenerObject, opts?: AddEventListenerOptions) => {
      if (!this._listeners[type]) this._listeners[type] = [];
      this._listeners[type].push({ cb, once: !!opts?.once });
    }
  );

  removeEventListener = vi.fn((type: string, cb: EventListenerOrEventListenerObject) => {
    const arr = this._listeners[type];
    if (arr) this._listeners[type] = arr.filter((l) => l.cb !== cb);
  });

  private _dispatchListeners(type: string): void {
    const arr = this._listeners[type];
    if (!arr) return;
    for (const l of [...arr]) {
      if (typeof l.cb === 'function') l.cb(new Event(type));
      else l.cb.handleEvent(new Event(type));
      if (l.once) this._listeners[type] = this._listeners[type].filter((x) => x !== l);
    }
  }

  /** Test helper: simulate the track ending. */
  simulateEnded(): void {
    this.paused = true;
    this.ended = true;
    this.onended?.();
  }

  /** Test helper: simulate the track loading metadata (sets duration). */
  simulateLoadedMetadata(duration: number): void {
    this.duration = duration;
    this.readyState = 1; // HAVE_METADATA
    this._dispatchListeners('loadedmetadata');
  }
}

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------
export function mockFetchSuccess(arrayBuffer = new ArrayBuffer(1024)) {
  const spy = vi.fn().mockResolvedValue({
    ok: true,
    url: '',
    redirected: false,
    arrayBuffer: () => Promise.resolve(arrayBuffer),
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

export function mockFetchRedirect(finalUrl: string, arrayBuffer = new ArrayBuffer(1024)): void {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, opts?: RequestInit) => {
    if (opts?.method === 'HEAD') {
      return Promise.resolve({ ok: true, url: finalUrl, redirected: true });
    }
    return Promise.resolve({
      ok: true,
      url: finalUrl,
      redirected: false,
      arrayBuffer: () => Promise.resolve(arrayBuffer),
    });
  }));
}

export function mockFetchFailure(): void {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
}

// ---------------------------------------------------------------------------
// Install globals before each test
// ---------------------------------------------------------------------------
beforeEach(() => {
  resetTime();

  // Build a fresh mock AudioContext for this test and inject it directly into
  // the lazy singleton cache. This avoids the `new Ctor()` constructor path
  // entirely (vi.fn().mockImplementation(() => instance) is not newable).
  const mockCtx = new MockAudioContext();
  _setAudioContext(mockCtx as unknown as AudioContext);

  // Expose the mock context so tests can inspect it directly
  (globalThis as unknown as { _mockAudioContext: MockAudioContext })._mockAudioContext = mockCtx;

  vi.stubGlobal('Audio', MockAudioElement);

  // Default: fetch succeeds
  mockFetchSuccess();

  // requestAnimationFrame shim (happy-dom may not have it)
  if (typeof requestAnimationFrame === 'undefined') {
    vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => {
      setTimeout(() => cb(0), 0);
      return 0;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  }
});
