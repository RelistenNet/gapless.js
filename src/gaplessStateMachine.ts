import { createActor, AnyActorRef } from 'xstate';
import { createQueueMachine } from './queueMachine';
import { createTrackMachine } from './trackMachine';
import { TrackActor, GaplessTrackInfo } from './types';

// Re-export types for convenience
export type { TrackActor, GaplessTrackInfo } from './types';

export interface GaplessOptions {
  tracks?: string[];
  onProgress?: (track: GaplessTrackInfo) => void;
  onEnded?: () => void;
  onPlayNextTrack?: (track: TrackActor) => void;
  onPlayPreviousTrack?: (track: TrackActor) => void;
  onStartNewTrack?: (track: TrackActor) => void;
  webAudioIsDisabled?: boolean;
  trackMetadata?: Array<{ title?: string; artist?: string; album?: string; artwork?: string }>;
}

export class Gapless {
  private _queueActor: AnyActorRef;

  constructor(options: GaplessOptions = {}) {
    const queueMachine = createQueueMachine;
    this._queueActor = createActor(queueMachine, {
      input: options,
    });
    this._queueActor.start();
  }

  play() {
    this._queueActor.send({ type: 'PLAY' });
  }

  pause() {
    this._queueActor.send({ type: 'PAUSE' });
  }

  togglePlayPause() {
    const snapshot = this._queueActor.getSnapshot();
    if (snapshot.status === 'active' && snapshot.value === 'playing') {
      this.pause();
    } else {
      this.play();
    }
  }

  next() {
    this._queueActor.send({ type: 'NEXT' });
  }

  previous() {
    this._queueActor.send({ type: 'PREVIOUS' });
  }

  gotoTrack(index: number, playImmediately = false) {
    this._queueActor.send({ type: 'GOTO', index, playImmediately });
  }

  seek(time: number) {
    this._queueActor.send({ type: 'SEEK', time });
  }

  setVolume(volume: number) {
    this._queueActor.send({ type: 'SET_VOLUME', volume });
  }

  addTrack(trackUrl: string, skipHEAD?: boolean, metadata?: Record<string, unknown>) {
    this._queueActor.send({
      type: 'ADD_TRACK',
      trackUrl,
      skipHEAD,
      metadata,
    });
  }

  removeTrack(trackIndex: number) {
    const snapshot = this._queueActor.getSnapshot();
    if (snapshot.status === 'active' && 'context' in snapshot) {
      const context = snapshot.context as { trackActors?: TrackActor[] };
      const track = context?.trackActors?.[trackIndex];
      if (track) {
        this._queueActor.send({ type: 'REMOVE_TRACK', track });
      }
    }
  }

  get currentTrack(): TrackActor | undefined {
    const snapshot = this._queueActor.getSnapshot();
    if (snapshot.status === 'active' && 'context' in snapshot) {
      const context = snapshot.context as { trackActors?: TrackActor[]; currentTrackIdx?: number };
      return context?.trackActors?.[context?.currentTrackIdx || 0];
    }
    return undefined;
  }

  get currentTrackIndex(): number {
    const snapshot = this._queueActor.getSnapshot();
    if (snapshot.status === 'active' && 'context' in snapshot) {
      const context = snapshot.context as { currentTrackIdx?: number };
      return context?.currentTrackIdx || 0;
    }
    return 0;
  }

  get tracks(): TrackActor[] {
    const snapshot = this._queueActor.getSnapshot();
    if (snapshot.status === 'active' && 'context' in snapshot) {
      const context = snapshot.context as { trackActors?: TrackActor[] };
      return context?.trackActors || [];
    }
    return [];
  }

  get isPlaying(): boolean {
    const snapshot = this._queueActor.getSnapshot();
    return snapshot.status === 'active' && snapshot.value === 'playing';
  }

  get isPaused(): boolean {
    const snapshot = this._queueActor.getSnapshot();
    return snapshot.status === 'active' && snapshot.value === 'paused';
  }

  get volume(): number {
    const snapshot = this._queueActor.getSnapshot();
    if (snapshot.status === 'active' && 'context' in snapshot) {
      const context = snapshot.context as { volume?: number };
      return context?.volume || 1;
    }
    return 1;
  }

  get queueActor(): AnyActorRef {
    return this._queueActor;
  }

  destroy() {
    this._queueActor.stop();
  }
}

// Export the state machine creators for advanced usage
export { createQueueMachine, createTrackMachine };
