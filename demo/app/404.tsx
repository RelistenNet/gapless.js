'use client';

export default function NotFound() {
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-24 sm:px-6 lg:px-8">
      <p className="font-mono text-sm/6 font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
        404
      </p>
      <h1 className="text-4xl font-semibold tracking-tight text-balance">Nothing here.</h1>
      <p className="text-base/7 text-zinc-600 dark:text-zinc-400">
        <a href="/" className="font-medium text-zinc-950 dark:text-white">
          Back to the demo
        </a>
      </p>
    </main>
  );
}
