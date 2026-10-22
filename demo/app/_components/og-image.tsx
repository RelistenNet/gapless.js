import { ImageResponse } from 'takumi-js/response';
import { Mark } from './mark';

export function ogImage({ section, subtitle }: { section?: string; subtitle: string }) {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 48,
        padding: 96,
        // Tailwind's emerald scale throughout, so the text sits in the same hue
        // as the background and the mark's gap bar (emerald-500).
        color: '#ecfdf5', // emerald-50
        background: '#022c22', // emerald-950
      }}
    >
      <div style={{ width: 160, height: 160, display: 'flex' }}>
        <Mark size={160} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', gap: 24, fontSize: 88, fontWeight: 600, letterSpacing: -2 }}>
          <span>gapless.js</span>
          {section && <span style={{ color: '#34d399' }}>/ {section}</span>}
        </div>
        <div style={{ fontSize: 40, color: 'rgba(167, 243, 208, 0.7)' }}>{subtitle}</div>
      </div>
    </div>,
    { width: 1200, height: 630 }
  );
}
