import { Mark } from './mark';

const LINK = 'hover:text-zinc-950 dark:hover:text-white';
const ACTIVE = 'font-medium text-zinc-950 dark:text-white';

export function SiteHeader({ current }: { current: 'demo' | 'docs' }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
      <a href="/" className="flex items-center gap-3 no-underline">
        {/* Same mark as icon.tsx, rendered as plain DOM. */}
        <div
          aria-hidden="true"
          className="size-12 shrink-0 rounded-[0.65625rem] dark:ring-1 dark:ring-white/10"
        >
          <Mark size={48} />
        </div>
        <div>
          <h1 className="font-mono text-2xl font-semibold tracking-tight">gapless.js</h1>
          <p className="text-base/7 text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
            A gapless playback javascript library
          </p>
        </div>
      </a>

      <nav className="flex items-center gap-4 text-sm/6 text-zinc-600 dark:text-zinc-400">
        <code className="rounded-md bg-zinc-950/5 px-2 py-0.5 font-mono text-zinc-950 dark:bg-white/10 dark:text-zinc-100">
          pnpm add gapless
        </code>
        <a
          href="/"
          aria-current={current === 'demo' ? 'page' : undefined}
          className={current === 'demo' ? ACTIVE : LINK}
        >
          Demo
        </a>
        <a
          href="/docs"
          aria-current={current === 'docs' ? 'page' : undefined}
          className={current === 'docs' ? ACTIVE : LINK}
        >
          Docs
        </a>
        <a href="https://github.com/RelistenNet/gapless.js" className={LINK}>
          GitHub
        </a>
      </nav>
    </header>
  );
}
