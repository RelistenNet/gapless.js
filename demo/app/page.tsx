import { NativeDemo } from './_components/native-demo';
import { GaplessDemo } from './_components/gapless-demo';
import { FullShow } from './_components/player';
import { SiteHeader } from './_components/site-header';
import { StageBadge } from './_components/ui';
import { CodeBlock } from './_components/code';

export default function Home() {
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <SiteHeader current="demo" />
      <div className="flex flex-col gap-3">
        <div className="mt-2 mb-4 max-w-3xl space-y-2 text-sm/6 text-zinc-700 dark:text-zinc-300">
          <p>
            gapless.js is a javascript library for playing recorded concerts, to suit our needs over{' '}
            <a href="https://relisten.net" className="underline underline-offset-4">
              https://relisten.net
            </a>
            . It is driven by a state machine and is completely headless (you design your own UI)
            and library agnostic.
          </p>
          <p>
            It is not intended to be a universal solution to all use-cases, but specifically to
            solve playing back concerts and similar “song”/“album” style playback. Meaning, it’s not
            designed for short loops (though it could support that).
          </p>

          <p>
            This library is over a decade old at this point, though we completely re-wrote it from
            scratch in the past year. It takes inspiration from{' '}
            <a href="https://github.com/regosen/Gapless-5">Gapless 5 by Rego Sen</a>, who pioneered
            these techniques on the web. We wrote our own after we had slightly different needs,
            like playing back concerts and a headless UI.
          </p>
        </div>
        <p className="flex items-center gap-2 font-semibold text-zinc-500 dark:text-zinc-400">
          Plain <code className="font-mono">{`<audio />`}</code> tags (non-library)
          <StageBadge stage={{ tone: 'warn', label: 'Not gapless' }} />
        </p>
        <NativeDemo />
        <p className="flex items-center gap-2 font-semibold text-zinc-600 dark:text-zinc-100">
          gapless.js
          <StageBadge stage={{ tone: 'good', label: 'Gapless' }} />
        </p>
        <GaplessDemo />
        <p className="font-semibold text-zinc-600 dark:text-zinc-100 flex gap-2">
          A complete gapless.js concert
        </p>
        <FullShow />
        <section className="mt-6 space-y-3">
          <h2 className="text-lg/7 font-semibold">Quick start</h2>
          <CodeBlock>{`
import Queue from 'gapless';

const player = new Queue({
  tracks: [
    'https://example.com/set1-01.mp3',
    'https://example.com/set1-02.mp3',
    'https://example.com/set1-03.mp3',
  ],
  onProgress: (track) => console.log(track.index, track.currentTime, track.duration),
  onEnded: () => console.log('Show over'),
});

// Call from a click handler. Browsers only allow audio after a user gesture.
playButton.addEventListener('click', () => player.togglePlayPause());
`}</CodeBlock>
          <p className="text-sm/6 text-zinc-600 dark:text-zinc-400">
            gapless.js preloads and decodes upcoming tracks in the background and starts each one on
            the exact sample the previous one ends. Bring your own UI.{' '}
            <a href="/docs" className="font-medium text-zinc-950 dark:text-white">
              Read the full docs →
            </a>
          </p>
        </section>
      </div>
    </main>
  );
}
