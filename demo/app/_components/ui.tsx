export type Tone = 'neutral' | 'busy' | 'good' | 'warn' | 'bad';

const TONE_BADGE: Record<Tone, string> = {
  neutral: 'bg-zinc-950/5 text-zinc-600 dark:bg-white/10 dark:text-zinc-300',
  busy: 'bg-amber-400/15 text-amber-800 dark:bg-amber-400/10 dark:text-amber-300',
  good: 'bg-emerald-500/10 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300',
  warn: 'bg-amber-400/15 text-amber-800 dark:bg-amber-400/10 dark:text-amber-300',
  bad: 'bg-rose-500/10 text-rose-700 dark:bg-rose-400/10 dark:text-rose-300',
};

export function StageBadge({ stage }: { stage: { tone: Tone; label: string } }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full py-0.5 pr-2 pl-1.5 text-xs/5 font-medium ${TONE_BADGE[stage.tone]}`}
    >
      <span
        className={`size-1.5 rounded-full bg-current ${stage.tone === 'busy' ? 'animate-pulse' : ''}`}
        aria-hidden="true"
      />
      {stage.label}
    </span>
  );
}
