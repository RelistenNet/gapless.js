// ---------------------------------------------------------------------------
// Shared decoded buffers, one per source URL.
//
// Several tracks can play from one file (clips of a long recording). Without
// sharing, each fetches and decodes the whole file, and a decoded hour of
// audio is hundreds of MB. Tracks acquire a URL's buffer here and release it
// when they unload; the buffer, or the download still in flight, goes away
// when the last holder lets go.
// ---------------------------------------------------------------------------

type Load = (signal: AbortSignal) => Promise<AudioBuffer>;

interface Entry {
  /** Settles with the decoded buffer, or rejects (and the entry is dropped). */
  promise: Promise<AudioBuffer>;
  /** Aborts the shared download once nobody is waiting on it. */
  abort: AbortController;
  holders: Set<object>;
}

const entries = new Map<string, Entry>();

function abortError(): Error {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Get the decoded buffer for `key`, starting `load` if nobody has yet.
 * `holder` keeps the buffer alive until `releaseBuffer(key, holder)`.
 * Aborting `signal` releases this holder and rejects this call only: the
 * shared load keeps going while anyone else holds it.
 */
export function acquireBuffer(
  key: string,
  holder: object,
  signal: AbortSignal,
  load: Load
): Promise<AudioBuffer> {
  if (signal.aborted) return Promise.reject(abortError());
  let entry = entries.get(key);
  if (!entry) {
    const abort = new AbortController();
    const created: Entry = { abort, holders: new Set(), promise: load(abort.signal) };
    // A failed load is dropped, so the next acquire retries it.
    created.promise.catch(() => {
      if (entries.get(key) === created) entries.delete(key);
    });
    entries.set(key, created);
    entry = created;
  }
  entry.holders.add(holder);

  const shared = entry.promise;
  return new Promise<AudioBuffer>((resolve, reject) => {
    const onAbort = () => {
      releaseBuffer(key, holder);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    shared.then(
      (buf) => {
        signal.removeEventListener('abort', onAbort);
        resolve(buf);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

/** Let go of `key` for `holder`. The last holder out drops the buffer or aborts its load. */
export function releaseBuffer(key: string, holder: object): void {
  const entry = entries.get(key);
  if (!entry || !entry.holders.delete(holder)) return;
  if (entry.holders.size > 0) return;
  entries.delete(key);
  entry.abort.abort();
}

/** Whether a buffer for `key` is decoded or on its way. */
export function hasBuffer(key: string): boolean {
  return entries.has(key);
}

/** Test helper: forget every entry. */
export function _resetBufferCache(): void {
  for (const entry of entries.values()) entry.abort.abort();
  entries.clear();
}
