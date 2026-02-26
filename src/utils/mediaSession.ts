// ---------------------------------------------------------------------------
// Media Session API integration
//
// Provides OS-level media controls (lock screen, notification shade, keyboard
// media keys). Gracefully no-ops when the API is unavailable.
// ---------------------------------------------------------------------------

import type { TrackMetadata } from '../types';

const hasMediaSession =
  typeof navigator !== 'undefined' && 'mediaSession' in navigator;

export interface MediaSessionHandlers {
  onPlay: () => void;
  onPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeek: (time: number) => void;
}

/** Register Media Session action handlers. Call once after construction. */
export function setupMediaSession(handlers: MediaSessionHandlers): void {
  if (!hasMediaSession) return;
  const { mediaSession } = navigator;
  mediaSession.setActionHandler('play', handlers.onPlay);
  mediaSession.setActionHandler('pause', handlers.onPause);
  mediaSession.setActionHandler('nexttrack', handlers.onNext);
  mediaSession.setActionHandler('previoustrack', handlers.onPrevious);
  mediaSession.setActionHandler('seekto', (details) => {
    if (details.seekTime != null) handlers.onSeek(details.seekTime);
  });
}

/** Update the OS metadata display (title, artist, album, artwork). */
export function updateMediaSessionMetadata(metadata?: TrackMetadata): void {
  if (!hasMediaSession) return;
  if (!metadata) {
    navigator.mediaSession.metadata = null;
    return;
  }
  navigator.mediaSession.metadata = new MediaMetadata({
    title: metadata.title ?? '',
    artist: metadata.artist ?? '',
    album: metadata.album ?? '',
    artwork: metadata.artwork ?? [],
  });
}

/** Sync the OS playback state indicator (playing / paused). */
export function updateMediaSessionPlaybackState(
  isPlaying: boolean,
): void {
  if (!hasMediaSession) return;
  navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
}
