// ---------------------------------------------------------------------------
// gapless.js — public API surface
// ---------------------------------------------------------------------------

export { Queue } from './Queue';
export type {
  GaplessOptions,
  AddTrackOptions,
  TrackInfo,
  TrackMetadata,
  PlaybackType,
  WebAudioLoadingState,
} from './types';

// Default export for convenience: import Gapless from 'gapless.js'
export { Queue as default } from './Queue';
