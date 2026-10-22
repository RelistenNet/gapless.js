import type { ReactNode } from 'react';
import { SiteHeader } from '../_components/site-header';
import { Code, CodeBlock } from '../_components/code';

export const metadata = {
  title: 'Docs · gapless.js',
  description: 'API reference and guides for gapless.js.',
};

const SECTIONS = [
  ['install', 'Install'],
  ['quick-start', 'Quick start'],
  ['how-it-works', 'How it works'],
  ['react', 'Using with React'],
  ['options', 'Options'],
  ['methods', 'Methods'],
  ['getters', 'Getters'],
  ['track-info', 'TrackInfo'],
  ['metadata', 'Metadata & Media Session'],
  ['playback-method', 'Playback method'],
  ['preloading', 'Preloading'],
  ['playback-rate', 'Playback rate'],
  ['autoplay', 'Autoplay'],
  ['migration', 'Migrating from v3'],
] as const;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-8 space-y-4">
      <h2 className="text-xl/8 font-semibold tracking-tight">
        <a href={`#${id}`} className="hover:underline hover:underline-offset-4">
          {title}
        </a>
      </h2>
      {children}
    </section>
  );
}

/** Columns listed in `code` render as inline code. The first column always does. */
function Table({ head, rows, code = [0] }: { head: string[]; rows: string[][]; code?: number[] }) {
  return (
    <div className="overflow-x-auto rounded-xl ring-1 ring-zinc-950/10 dark:ring-white/10">
      <table className="w-full text-left text-sm/6">
        <thead className="bg-zinc-50 dark:bg-white/5">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-4 py-2 font-semibold whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-950/5 dark:divide-white/5">
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td
                  key={j}
                  className={`px-4 py-2 align-top ${j === 0 ? 'whitespace-nowrap' : 'text-zinc-600 dark:text-zinc-400'}`}
                >
                  {code.includes(j) ? <Code>{cell}</Code> : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Docs() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <SiteHeader current="docs" />

      <div className="mt-10 lg:grid lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-12">
        <nav aria-label="On this page" className="max-lg:hidden">
          <ul className="sticky top-8 space-y-1 text-sm/6">
            {SECTIONS.map(([id, label]) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  className="text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white"
                >
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <article className="min-w-0 space-y-14 text-base/7">
          <aside className="rounded-xl bg-amber-50/70 px-4 py-3 text-sm/6 text-amber-900 ring-1 ring-amber-600/20 dark:bg-amber-400/5 dark:text-amber-200 dark:ring-amber-400/20">
            <span className="font-semibold">Heads up:</span> these docs are AI generated, we
            apologize. If you’d like to contribute hand-written docs, please{' '}
            <a href="https://github.com/RelistenNet/gapless.js/pulls" className="font-medium">
              send a PR
            </a>
            . We’ll hopefully get back to this in the future.
          </aside>
          <Section id="install" title="Install">
            <CodeBlock>{`pnpm add gapless`}</CodeBlock>
            <p>
              gapless.js is ESM only and ships its own types. Its one dependency,{' '}
              <a href="https://stately.ai/docs/xstate" className="underline underline-offset-4">
                XState
              </a>
              , is bundled.
            </p>
          </Section>

          <Section id="quick-start" title="Quick start">
            <p>
              Create a <Code>Queue</Code> with a list of track URLs, then call <Code>play()</Code>{' '}
              from a click handler.
            </p>
            <CodeBlock>{`
import Queue from 'gapless';

const player = new Queue({
  tracks: [
    'https://example.com/set1-01.mp3',
    'https://example.com/set1-02.mp3',
    'https://example.com/set1-03.mp3',
  ],
  trackMetadata: [
    { title: 'Help on the Way' },
    { title: 'Slipknot!' },
    { title: 'Franklin\\'s Tower' },
  ],
  onProgress: (track) => renderProgress(track.currentTime, track.duration),
  onStartNewTrack: (track) => renderNowPlaying(track.metadata?.title),
  onEnded: () => console.log('Show over'),
});

playButton.addEventListener('click', () => player.togglePlayPause());
nextButton.addEventListener('click', () => player.next());
`}</CodeBlock>
            <p>
              gapless.js has no UI. It hands you plain data through callbacks and getters and you
              render it however you like.
            </p>
          </Section>

          <Section id="how-it-works" title="How it works">
            <p>
              An <Code>{'<audio>'}</Code> element can’t start a file on an exact sample. Calling{' '}
              <Code>play()</Code> on the next file when the first one fires <Code>ended</Code>{' '}
              always leaves an audible gap, even when the next file is fully buffered.
            </p>
            <p>
              By default (<Code>HYBRID</Code> mode), each track starts playing right away through
              HTML5 audio so there’s no wait. Meanwhile gapless.js fetches and decodes the track
              with the Web Audio API. Once the decoded buffer is ready it swaps over mid-track
              without a click. Upcoming tracks are decoded ahead of time, and each one is scheduled
              on the <Code>AudioContext</Code> clock to start on the exact sample where the previous
              one ends.
            </p>
            <p>
              If the next track isn’t decoded in time (a slow network, or you skipped ahead), it
              falls back to HTML5 audio for that handoff. You get a small gap instead of silence or
              an error, and it picks up Web Audio again once the decode finishes.
            </p>
            <p>
              The queue and every track are driven by XState state machines, so playback is always
              in a known state no matter how fast users mash buttons.
            </p>
          </Section>

          <Section id="react" title="Using with React">
            <p>
              The <Code>Queue</Code> is a plain object. Create it once, read its getters into a
              snapshot whenever a callback fires, and subscribe with{' '}
              <Code>useSyncExternalStore</Code>.
            </p>
            <CodeBlock title="use-player.ts">{`
import { useEffect, useState, useSyncExternalStore } from 'react';
import Queue, { type TrackInfo } from 'gapless';

interface Snapshot {
  current?: TrackInfo;
  isPlaying: boolean;
}

class PlayerStore {
  queue: Queue | null = null;
  private snapshot: Snapshot = { isPlaying: false };
  private listeners = new Set<() => void>();

  constructor(private urls: string[]) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getSnapshot = () => this.snapshot;

  private sync = () => {
    const q = this.queue;
    if (!q) return;
    this.snapshot = { current: q.currentTrack, isPlaying: q.isPlaying };
    for (const fn of this.listeners) fn();
  };

  connect() {
    const queue = new Queue({
      tracks: this.urls,
      onProgress: this.sync,
      onStartNewTrack: this.sync,
      onEnded: this.sync,
    });
    this.queue = queue;
    return () => queue.destroy();
  }
}

export function usePlayer(urls: string[]) {
  const [store] = useState(() => new PlayerStore(urls));
  useEffect(() => store.connect(), [store]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { ...state, queue: store.queue };
}
`}</CodeBlock>
            <p>
              Create the <Code>Queue</Code> in an effect, not during render. It touches{' '}
              <Code>Audio</Code> and <Code>AudioContext</Code>, which don’t exist on the server.
              Call <Code>destroy()</Code> on unmount.
            </p>
          </Section>

          <Section id="options" title="Options">
            <p>
              Everything passed to <Code>new Queue(options)</Code>. All of it is optional.
            </p>
            <Table
              head={['Option', 'Type', 'Description']}
              rows={[
                ['tracks', 'string[]', 'Initial list of track URLs.'],
                [
                  'trackMetadata',
                  'TrackMetadata[]',
                  'Per-track metadata, matched to tracks by index.',
                ],
                ['volume', 'number', 'Initial volume, 0–1. Default 1.'],
                ['playbackRate', 'number', 'Initial playback rate, 0.25–4. Default 1.'],
                [
                  'preloadNumTracks',
                  'number',
                  'How many tracks to preload ahead. Default 2, 0 disables.',
                ],
                [
                  'playbackMethod',
                  "'HYBRID' | 'HTML5_ONLY' | 'WEBAUDIO_ONLY'",
                  'How audio is rendered. Default HYBRID. See Playback method.',
                ],
                [
                  'onProgress',
                  '(track: TrackInfo) => void',
                  'Called about 60 times a second while playing.',
                ],
                [
                  'onStartNewTrack',
                  '(track: TrackInfo) => void',
                  'Called whenever a different track becomes current, for any reason.',
                ],
                [
                  'onPlayNextTrack',
                  '(track: TrackInfo) => void',
                  'Called when the queue advances to the next track.',
                ],
                [
                  'onPlayPreviousTrack',
                  '(track: TrackInfo) => void',
                  'Called when the queue goes back a track.',
                ],
                ['onEnded', '() => void', 'Called when the last track finishes.'],
                ['onError', '(error: Error) => void', 'Called on audio errors.'],
                [
                  'onPlayBlocked',
                  '() => void',
                  'Called when the browser blocks playback (autoplay policy).',
                ],
                ['onDebug', '(msg: string) => void', 'Internal debug messages. Development only.'],
              ]}
            />
          </Section>

          <Section id="methods" title="Methods">
            <Table
              head={['Method', 'Description']}
              rows={[
                ['play()', 'Start or resume playback.'],
                ['pause()', 'Pause playback.'],
                ['togglePlayPause()', 'Play if paused, pause if playing.'],
                ['next()', 'Go to the next track. Does nothing on the last track.'],
                [
                  'previous()',
                  'Go to the previous track, or restart the current one if more than 8 seconds in.',
                ],
                [
                  'gotoTrack(index, playImmediately?, startTime?)',
                  'Jump to a track by index, optionally starting playback at startTime seconds.',
                ],
                ['seek(time)', 'Seek within the current track, in seconds.'],
                ['setVolume(volume)', 'Set volume, clamped to 0–1.'],
                [
                  'setPlaybackRate(rate)',
                  'Set playback rate, clamped to 0.25–4. Reschedules gapless transitions.',
                ],
                ['addTrack(url, options?)', 'Append a track. See AddTrackOptions below.'],
                ['removeTrack(index)', 'Remove a track by index.'],
                [
                  'resumeAudioContext()',
                  'Create and resume the shared AudioContext. Call from a user gesture.',
                ],
                ['destroy()', 'Stop playback and release every resource.'],
              ]}
            />
            <CodeBlock title="AddTrackOptions">{`
player.addTrack('https://example.com/encore.mp3', {
  // Skip the HEAD request used to resolve redirects, if the URL is already final.
  skipHEAD: true,
  metadata: { title: 'Ripple', artist: 'Grateful Dead' },
});
`}</CodeBlock>
          </Section>

          <Section id="getters" title="Getters">
            <p>
              Getters return fresh snapshots each time you read them. Nothing you get back is live.
            </p>
            <Table
              head={['Getter', 'Type', 'Description']}
              rows={[
                ['currentTrack', 'TrackInfo | undefined', 'The current track.'],
                ['currentTrackIndex', 'number', 'Index of the current track.'],
                ['tracks', 'readonly TrackInfo[]', 'Every track in the queue.'],
                ['isPlaying', 'boolean', 'Whether the queue is playing.'],
                ['isPaused', 'boolean', 'Whether the queue is paused.'],
                ['volume', 'number', 'Current volume.'],
                ['playbackRate', 'number', 'Current playback rate.'],
                ['preloadNumTracks', 'number', 'Tracks to preload ahead. Also settable.'],
              ]}
            />
          </Section>

          <Section id="track-info" title="TrackInfo">
            <p>
              Every callback and getter gives you <Code>TrackInfo</Code>: plain data with no
              methods, safe to store in React state or send over <Code>postMessage</Code>.
            </p>
            <CodeBlock>{`
interface TrackInfo {
  index: number;            // Position in the queue
  currentTime: number;      // Seconds
  duration: number;         // Seconds, NaN until loaded
  isPlaying: boolean;
  isPaused: boolean;
  volume: number;
  playbackRate: number;
  trackUrl: string;         // Resolved URL, after redirects
  playbackType: 'HTML5' | 'WEBAUDIO';   // Which backend is making sound right now
  webAudioLoadingState: 'NONE' | 'LOADING' | 'LOADED' | 'ERROR';
  metadata?: TrackMetadata;
  machineState: string;     // Internal state, handy for debugging
}
`}</CodeBlock>
            <p>
              <Code>playbackType</Code> tells you whether the next handoff can be gapless. When the
              current track is <Code>WEBAUDIO</Code> and the next one has{' '}
              <Code>webAudioLoadingState: &apos;LOADED&apos;</Code>, it will be.
            </p>
          </Section>

          <Section id="metadata" title="Metadata & Media Session">
            <p>
              Metadata is yours to define. <Code>title</Code>, <Code>artist</Code>,{' '}
              <Code>album</Code> and <Code>artwork</Code> are passed to the{' '}
              <a
                href="https://developer.mozilla.org/en-US/docs/Web/API/Media_Session_API"
                className="underline underline-offset-4"
              >
                Media Session API
              </a>
              , so they show up on lock screens, in OS media controls and on hardware media keys.
              Play, pause, next, previous and seek from those controls work automatically. Any other
              fields come back to you on <Code>track.metadata</Code>.
            </p>
            <CodeBlock>{`
interface TrackMetadata {
  title?: string;
  artist?: string;
  album?: string;
  artwork?: MediaImage[];   // [{ src, sizes, type }]
  [key: string]: unknown;   // Anything else you want to carry along
}
`}</CodeBlock>
          </Section>

          <Section id="playback-method" title="Playback method">
            <Table
              head={['Value', 'Behavior', 'Use it for']}
              rows={[
                [
                  'HYBRID',
                  'Starts on HTML5 audio, switches to Web Audio once decoded. The default.',
                  'Remote files. Instant start and gapless transitions.',
                ],
                [
                  'HTML5_ONLY',
                  'HTML5 audio only. No gapless playback.',
                  'When Web Audio is unavailable or unwanted.',
                ],
                [
                  'WEBAUDIO_ONLY',
                  'Web Audio only. Waits for each file to download and decode before playing.',
                  'Small or local files where loading is instant.',
                ],
              ]}
            />
          </Section>

          <Section id="preloading" title="Preloading">
            <p>
              gapless.js preloads and decodes the next two tracks by default. Lower it to save
              bandwidth and memory, raise it for flaky connections. You can change it at any time.
            </p>
            <CodeBlock>{`
const player = new Queue({ tracks, preloadNumTracks: 1 });

player.preloadNumTracks = 0; // Disable preloading
player.preloadNumTracks = 3; // Preload 3 ahead
`}</CodeBlock>
            <p>
              Decoded audio lives in memory as raw PCM, roughly 10 MB per minute of stereo at 44.1
              kHz. Keep this in mind for long tracks on mobile.
            </p>
          </Section>

          <Section id="playback-rate" title="Playback rate">
            <p>
              Speeds between 0.25× and 4× are supported, and gapless transitions are rescheduled to
              match.
            </p>
            <CodeBlock>{`
const player = new Queue({ tracks, playbackRate: 1.5 });

player.setPlaybackRate(2);
player.playbackRate; // 2
`}</CodeBlock>
          </Section>

          <Section id="autoplay" title="Autoplay">
            <p>
              Browsers won’t start audio until the user has interacted with the page. Call{' '}
              <Code>play()</Code>, <Code>next()</Code> or <Code>gotoTrack(…, true)</Code> from a
              click or key handler and it just works. gapless.js creates its{' '}
              <Code>AudioContext</Code> lazily on that first gesture, so you won’t see console
              warnings on page load.
            </p>
            <p>
              If you start playback outside a gesture and the browser refuses,{' '}
              <Code>onPlayBlocked</Code> fires. Show a play button and call <Code>play()</Code>{' '}
              again when it’s clicked.
            </p>
            <CodeBlock>{`
const player = new Queue({
  tracks,
  onPlayBlocked: () => showPlayButton(),
});
`}</CodeBlock>
          </Section>

          <Section id="migration" title="Migrating from v3">
            <p>
              v4 is a complete rewrite. It’s ESM only, callbacks receive plain{' '}
              <Code>TrackInfo</Code> objects instead of <Code>Track</Code> instances, and Media
              Session support is built in.
            </p>
            <Table
              head={['v3', 'v4']}
              code={[0, 1]}
              rows={[
                ["import GaplessQueue from 'gapless.js'", "import Queue from 'gapless'"],
                ['player.playNext()', 'player.next()'],
                ['player.playPrevious()', 'player.previous()'],
                ['player.resetCurrentTrack()', 'player.seek(0)'],
                ['player.disableWebAudio()', "playbackMethod: 'HTML5_ONLY'"],
                ['player.nextTrack', 'player.tracks[player.currentTrackIndex + 1]'],
                ['track.completeState', 'TrackInfo'],
              ]}
            />
          </Section>
        </article>
      </div>
    </main>
  );
}
