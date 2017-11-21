# gapless.js

gapless.js is a library for gapless audio playback. It is not intended to be a flawless solution for every use-case, but rather a balance between the needs of my use-case over at <Relisten.net>.

In short, it takes an array of audio tracks and utilizes HTML5 audio and the web audio API to enable gapless playback of individual tracks.

I will expand this README with more details in time.

You can see a sample of the library in use currently at <Relisten.live> which is the not-yet-released beta of the next version of <Relisten.net>

## Sample usage

```javascript
    const player = new Gapless.Queue({
      tracks: [
        "http://phish.in/audio/000/012/321/12321.mp3",
        "http://phish.in/audio/000/012/322/12322.mp3",
        "http://phish.in/audio/000/012/323/12323.mp3",
        "http://phish.in/audio/000/012/324/12324.mp3"
      ],
      onProgress: function(track) {
        track && console.log(track.completeState);
      }
    });
    
    player.play();
```

## Gapless.Queue Options
```javascript
        tracks = [],
        onProgress,
        onEnded,
        onPlayNextTrack,
        onPlayPreviousTrack,
        onStartNewTrack,
        webAudioIsDisabled = false
```

## API (subject to change)

```javascript
// functions
player.togglePlayPause();   // toggle play/pause
player.playNext();          // play next track
player.playPrevious();      // play previous track
player.resetCurrentTrack(); // reset current track to 0
player.gotoTrack(idx, playImmediately); // jump to track by index and pass true to play immediately
player.disableWebAudio();   // disable gapless playback/web audio

// getters
player.currentTrack;        // returns current active track
player.nextTrack;           // returns next track
```

## License

MIT - do as you please
