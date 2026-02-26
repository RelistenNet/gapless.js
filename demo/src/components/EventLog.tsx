import type { LogEntry } from '../useGapless';

interface EventLogProps {
  logs: LogEntry[];
}

export function EventLog({ logs }: EventLogProps) {
  return (
    <section>
      <h2>Event Log</h2>
      <div className="log">
        {logs.map((entry, i) => (
          <div key={i} className={entry.level !== 'info' ? entry.level : undefined}>
            [{entry.time}] {entry.msg}
          </div>
        ))}
      </div>
    </section>
  );
}
