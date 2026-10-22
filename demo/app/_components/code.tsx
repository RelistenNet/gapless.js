import type { ReactNode } from 'react';
import { highlight } from 'sugar-high';

export function CodeBlock({ children, title }: { children: string; title?: string }) {
  return (
    <div className="overflow-hidden rounded-xl bg-zinc-950 ring-1 ring-zinc-950/10 dark:bg-zinc-800/60 dark:ring-white/10">
      {title && (
        <p className="border-b border-white/10 px-4 py-2 font-mono text-xs/5 text-zinc-400">
          {title}
        </p>
      )}
      {/* Highlighted at render time on the server; sugar-high escapes the source. */}
      <pre className="sh overflow-x-auto px-4 py-3 font-mono text-sm/6 text-zinc-100">
        <code dangerouslySetInnerHTML={{ __html: highlight(children.trim()) }} />
      </pre>
    </div>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-md bg-zinc-950/5 px-1.5 py-0.5 font-mono text-[0.875em] text-zinc-950 dark:bg-white/10 dark:text-zinc-100">
      {children}
    </code>
  );
}
