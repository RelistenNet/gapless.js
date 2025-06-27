import { ActorRefFrom } from 'xstate';
import type { createTrackMachine, GaplessTrackInfo as _GaplessTrackInfo } from './trackMachine';

export type TrackActor = ActorRefFrom<typeof createTrackMachine>;
export type GaplessTrackInfo = _GaplessTrackInfo;

export interface GaplessCallbacks {
  onProgress?: (track: GaplessTrackInfo) => void;
  onEnded?: () => void;
  onPlayNextTrack?: (track: TrackActor) => void;
  onPlayPreviousTrack?: (track: TrackActor) => void;
  onStartNewTrack?: (track: TrackActor) => void;
}
