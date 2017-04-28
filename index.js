const PRELOAD_NUM_TRACKS = 2;

const audioContext = new AudioContext();

const GaplessPlaybackType = {
  HTML5: 'HTML5',
  WEBAUDIO: 'WEBAUDIO'
};

const GaplessPlaybackLoadingState = {
  NONE: 'NONE',
  LOADING: 'LOADING',
  LOADED: 'LOADED'
};

class GaplessQueue {
  constructor(props = {}) {
    const { tracks = [], onProgress } = props;

    this.props = { onProgress };
    this.state = { volume: 1, currentTrackIdx: 0 };

    this.tracks = tracks.map((trackUrl, idx) =>
      new GaplessTrack({
        trackUrl,
        idx,
        queue: this
      })
    );
  }

  addTrack(trackUrl) {
    this.tracks.push(
      new GaplessTrack({
        trackUrl,
        idx: this.tracks.length,
        queue: this
      })
    );
  }

  removeTrack(track) {
    const index = this.tracks.indexOf(track);
    return this.tracks.splice(index, 1);
  }

  play() {
    if (this.currentTrack) this.currentTrack.play();
  }

  pause() {
    if (this.currentTrack) this.currentTrack.pause();
  }

  playNext() {
    this.state.currentTrackIdx++;

    this.play();
  }

  pauseAll() {
    Object.values(this.tracks).map(track => {
      track.pause();
    });
  }

  gotoTrack(idx) {
    this.pauseAll();
    this.state.currentTrackIdx = idx;
  }

  loadTrack(idx, loadHTML5) {
    console.log(idx, loadHTML5, this)
    // only preload if song is within the next 2
    if (this.state.currentTrackIdx + PRELOAD_NUM_TRACKS <= idx) return;
    const track = this.tracks[idx];

    if (track) track.preload(loadHTML5);
  }

  onProgress(track) {
    if (this.props.onProgress) this.props.onProgress(track);
  }

  get currentTrack() {
    return this.tracks[this.state.currentTrackIdx];
  }

  get isNextTracksBufferLoaded() {
    const nextTrack = this.tracks[this.state.currentTrackIdx + 1];

    if (!nextTrack) return false;

    return nextTrack.isLoaded;
  }
}

/*

states:

audio
webaudio

get rid of fetch, just use <audio /> to source it.
https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/createMediaElementSource
https://jsfiddle.net/k3op44o5/2/

may not be possible. try skipping to end of file and missing middle of audio buffer

*/
class GaplessTrack {
  constructor({ trackUrl, queue, idx }) {
    // playback type state
    this.playbackType = GaplessPlaybackType.HTML5;
    this.webAudioLoadingState = GaplessPlaybackLoadingState.NONE;
    this.loadedHEAD = false;

    // basic inputs from GaplessQueue
    this.idx = idx;
    this.queue = queue;
    this.trackUrl = trackUrl;

    this.onEnded = this.onEnded.bind(this);
    this.onProgress = this.onProgress.bind(this);

    // HTML5 Audio
    this.audio = new Audio();
    this.audio.onerror = this.audioOnError;
    this.audio.onended = this.onEnded;
    this.audio.controls = false;
    this.audio.volume = queue.state.volume;
    this.audio.preload = 'none';
    this.audio.src = trackUrl;
    // this.audio.onprogress = () => this.debug(this.idx, this.audio.buffered)

    // WebAudio
    this.audioContext = audioContext;
    this.gainNode = this.audioContext.createGain();
    this.gainNode.connect(this.audioContext.destination);
    this.gainNode.gain.value = queue.state.volume;
    this.webAudioStartedPlayingAt = 0;
    this.webAudioPausedDuration = 0;
    this.webAudioPausedAt = 0;
    this.audioBuffer = null;

    this.bufferSourceNode = this.audioContext.createBufferSource();
    this.bufferSourceNode.onended = this.onEnded;
  }

  // private functions
  loadHead(cb) {
    if (this.loadedHEAD) return cb();

    const options = {
      method: 'HEAD'
    };

    fetch(this.trackUrl, options)
      .then(res => {
        if (res.redirected) {
          this.trackUrl = res.url;
        }

        this.loadedHEAD = true;

        cb();
      })
    }

  loadBuffer(cb) {
    if (this.webAudioLoadingState !== GaplessPlaybackLoadingState.NONE) return;

    this.webAudioLoadingState = GaplessPlaybackLoadingState.LOADING;
    const options = {
      // headers: new Headers({
      //     Range: "bytes=-" + 1024 * 1024
      // })
    };

    fetch(this.trackUrl, options)
      .then(res => res.arrayBuffer())
      .then(res =>
        this.audioContext.decodeAudioData(res, buffer => {
          this.debug('finished downloading track');
          this.webAudioLoadingState = GaplessPlaybackLoadingState.LOADED;
          this.bufferSourceNode.buffer = this.audioBuffer = buffer;
          this.bufferSourceNode.connect(this.gainNode);
          this.queue.loadTrack(this.idx + 1);
          if (this.isActiveTrack) this.switchToWebAudio();
          cb && cb(buffer);
        })
      )
      .catch(e => this.debug('caught fetch error', e));
  }

  switchToWebAudio() {
    // if we've switched tracks, don't switch to web audio
    if (!this.isActiveTrack) return;

    this.debug('switch to web audio', this.currentTime, this.isPaused, this.audio.duration - this.audioBuffer.duration);

    // if currentTime === 0, this is a new track, so play it
    // otherwise we're hitting this mid-track which may
    // happen in the middle of a paused track
    this.bufferSourceNode.playbackRate.value = this.currentTime !== 0 && this.isPaused ? 0 : 1;

    this.webAudioStartedPlayingAt = this.audioContext.currentTime - this.currentTime;

    // slight blip, could be improved
    this.bufferSourceNode.start(0, this.currentTime);
    this.audio.pause();

    this.playbackType = GaplessPlaybackType.WEBAUDIO;
  }

  // public-ish functions
  pause() {
    if (this.isUsingWebAudio) {
      this.webAudioPausedAt = this.audioContext.currentTime;
      this.bufferSourceNode.playbackRate.value = 0;
    }
    else {
      this.audio.pause();
    }
  }

  play() {
    this.debug('play');
    if (this.audioBuffer) {
      // if we've already set up the buffer just set playbackRate to 1
      if (this.isUsingWebAudio) {
        this.bufferSourceNode.playbackRate.value = 1;

        if (this.webAudioPausedAt) {
          this.webAudioPausedDuration += this.audioContext.currentTime - this.webAudioPausedAt;
        }

        this.webAudioPausedAt = 0;
      }
      // otherwise set the bufferSourceNode buffer and switch to WebAudio
      else {
        this.switchToWebAudio();
      }

      // Try to preload the next track
      this.queue.loadTrack(this.idx + 1);
    }
    else {
      this.audio.preload = 'auto';
      this.audio.play();
      this.loadHead(() => this.loadBuffer());
    }

    this.onProgress();
  }

  togglePlayPause() {
    this.isPaused ? this.play() : this.pause();
  }

  preload(HTML5) {
    this.debug('preload', HTML5);
    if (HTML5 && this.audio.preload !== 'auto') {
      this.audio.preload = 'auto';
    }
    else if (!this.audioBuffer) {
      this.loadBuffer();
    }
  }

  // TODO: add checks for to > duration or null or negative (duration - to)
  seek(to = 0) {
    if (this.isUsingWebAudio) {
      this.seekBufferSourceNode(to);
    }
    else {
      this.audio.currentTime = to;
    }
  }

  seekBufferSourceNode(to) {
    this.bufferSourceNode.onended = null;
    this.bufferSourceNode.stop();

    this.bufferSourceNode = this.audioContext.createBufferSource();

    this.webAudioStartedPlayingAt = this.audioContext.currentTime - to;
    this.webAudioPausedDuration = 0;

    this.bufferSourceNode.buffer = this.audioBuffer;
    this.bufferSourceNode.connect(this.gainNode);
    this.bufferSourceNode.onended = this.onEnded;

    this.bufferSourceNode.start(0, to);
  }


  // basic event handlers
  audioOnError(e) {
    this.debug('audioOnError', e);
  }

  onEnded() {
    this.debug('onEnded');
    this.queue.playNext();
  }

  onProgress() {
    if (this.isPaused || !this.isActiveTrack) return;

    const isWithinLastTenSeconds = (this.duration - this.currentTime) <= 10;

    // if in last 10 seconds and next track hasn't loaded yet
    // start loading next track's HTML5
    if (isWithinLastTenSeconds && !this.queue.isNextTracksBufferLoaded) {
      this.queue.loadTrack(this.idx + 1, true);
    }

    this.queue.onProgress(this);

    // this.debug(this.currentTime, this.duration);
    window.requestAnimationFrame(this.onProgress);
    // setTimeout(this.onProgress, 33.33); // 30fps
  }


  // getter helpers
  get isUsingWebAudio() {
    return this.playbackType === GaplessPlaybackType.WEBAUDIO;
  }

  get isPaused() {
    if (this.isUsingWebAudio) {
      return this.bufferSourceNode.playbackRate.value === 0;
    }
    else {
      return this.audio.paused;
    }
  }

  get currentTime() {
    if (this.isUsingWebAudio) {
      return this.audioContext.currentTime - this.webAudioStartedPlayingAt - this.webAudioPausedDuration;
    }
    else {
      return this.audio.currentTime;
    }
  }

  get duration() {
    if (this.isUsingWebAudio) {
      return this.audioBuffer.duration;
    }
    else {
      return this.audio.duration;
    }
  }

  get isActiveTrack() {
    return this.queue.currentTrack === this;
  }

  get isLoaded() {
    return !!this.audioBuffer;
  }

  get state() {
    return {
      playbackType: this.playbackType,
      webAudioLoadingState: this.webAudioLoadingState
    };
  }

  get completeState() {
    return {
      playbackType: this.playbackType,
      webAudioLoadingState: this.webAudioLoadingState,
      isPaused: this.isPaused,
      currentTime: this.currentTime,
      duration: this.duration
    };
  }

  // debug helper
  debug(first, ...args) {
    console.log(`${this.idx}:${first}`, ...args, this.state);
  }

  seekToEnd() {
    if (this.isUsingWebAudio) {
      this.seekBufferSourceNode(this.audioBuffer.duration - 6);
    }
    else {
      this.audio.currentTime = this.audio.duration - 6;
    }
  }
}
