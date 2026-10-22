import { ImageResponse } from 'takumi-js/response';
import { Mark } from './_components/mark';

// Shared by every page: nested segments inherit the root's opengraph-image.
export default function OpengraphImage() {
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
        color: '#f4f4f5',
        background: '#0a1f17',
      }}
    >
      <div style={{ width: 160, height: 160, display: 'flex' }}>
        <Mark size={160} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ fontSize: 88, fontWeight: 600, letterSpacing: -2 }}>gapless.js</div>
        <div style={{ fontSize: 40, color: '#a1a1aa' }}>Gapless audio playback for the web</div>
      </div>
    </div>,
    { width: 1200, height: 630 }
  );
}
