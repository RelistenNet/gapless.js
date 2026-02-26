// ---------------------------------------------------------------------------
// Singleton AudioContext manager
//
// A single AudioContext is shared across all Track instances. This is
// essential: all AudioBufferSourceNodes must share the same context so that
// audioContext.currentTime is a common monotonic clock, enabling
// sample-accurate scheduling of back-to-back tracks.
// ---------------------------------------------------------------------------

const isBrowser = typeof window !== 'undefined';

let _audioContext: AudioContext | null | undefined = undefined;

function createAudioContext(): AudioContext | null {
  if (!isBrowser) return null;
  const Ctor =
    (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  return new Ctor();
}

/**
 * Return the shared AudioContext if it has already been created, otherwise null.
 *
 * Does NOT create the context — call resumeAudioContext() from a user-gesture
 * handler to create and resume it. This prevents the browser warning:
 * "An AudioContext was prevented from starting automatically."
 */
export function getAudioContext(): AudioContext | null {
  // undefined  = never initialised (return null without creating)
  // null       = explicitly disabled or unavailable
  // AudioContext = ready to use
  if (_audioContext === undefined) return null;
  return _audioContext;
}

/**
 * Create (if needed) and resume the AudioContext.
 * Must be called from a user-gesture handler (click, keydown, etc.).
 * Safe to call multiple times — subsequent calls are cheap no-ops.
 */
export function resumeAudioContext(): Promise<void> {
  if (_audioContext === undefined) {
    _audioContext = createAudioContext();
  }
  const ctx = _audioContext;
  if (ctx && ctx.state === 'suspended') {
    return ctx.resume();
  }
  return Promise.resolve();
}

/**
 * Reset the cached AudioContext — used in tests so each test gets a fresh mock.
 * @internal
 */
export function _resetAudioContext(): void {
  _audioContext = undefined;
}

/**
 * Directly set the cached AudioContext — used in tests to inject a mock instance.
 * @internal
 */
export function _setAudioContext(ctx: AudioContext | null): void {
  _audioContext = ctx;
}
