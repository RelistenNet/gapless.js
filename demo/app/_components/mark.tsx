// The site mark: an irregular waveform with the green gap marker in it, as
// on the page. The bars either side of it are nearly the same height and it
// keeps the row's spacing, so the signal reads as carrying straight
// through. Rendered to PNG by takumi in icon.tsx / apple-icon.tsx and as plain
// DOM in the header (inline styles only, so both renderers agree).

const BEFORE = [0.5, 0.28, 0.82, 0.62];
const AFTER = [0.64, 0.9, 0.36, 0.55];

export function Mark({ size }: { size: number }) {
  const u = size / 64;
  const bar = (h: number, i: number) => (
    <div
      key={i}
      style={{ width: 3.5 * u, height: 40 * h * u, borderRadius: 1.75 * u, background: '#f4f4f5' }}
    />
  );
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2.5 * u,
        background: '#18181b',
        borderRadius: 14 * u,
      }}
    >
      {BEFORE.map(bar)}
      <div style={{ width: 4 * u, height: 46 * u, borderRadius: 2 * u, background: '#10b981' }} />
      {AFTER.map(bar)}
    </div>
  );
}
