export function PlayIcon({ className = 'size-5 sm:size-4' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      <path d="M4.5 2.9v10.2a.9.9 0 0 0 1.37.77l8.2-5.1a.9.9 0 0 0 0-1.54l-8.2-5.1A.9.9 0 0 0 4.5 2.9Z" />
    </svg>
  );
}

export function PauseIcon({ className = 'size-5 sm:size-4' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      <rect x="3.5" y="2.5" width="3" height="11" rx="1" />
      <rect x="9.5" y="2.5" width="3" height="11" rx="1" />
    </svg>
  );
}

export function PreviousIcon({ className = 'size-5 sm:size-4' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      <rect x="2.5" y="3" width="2" height="10" rx="0.75" />
      <path d="M13.5 3.9v8.2a.9.9 0 0 1-1.38.76L6.1 8.76a.9.9 0 0 1 0-1.52l6.02-3.1a.9.9 0 0 1 1.38.76Z" />
    </svg>
  );
}

export function NextIcon({ className = 'size-5 sm:size-4' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      <rect x="11.5" y="3" width="2" height="10" rx="0.75" />
      <path d="M2.5 3.9v8.2a.9.9 0 0 0 1.38.76l6.02-3.1a.9.9 0 0 0 0-1.52L3.88 3.14A.9.9 0 0 0 2.5 3.9Z" />
    </svg>
  );
}
