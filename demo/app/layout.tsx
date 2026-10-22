import type { ReactNode } from 'react';
import { Inter, JetBrains_Mono } from '@timber-js/app/fonts/google';
import './globals.css';

// `.className` defines the CSS variable (globals.css maps it into Tailwind's
// font-sans / font-mono). `.variable` is only the variable's name.
const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-inter',
});
const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-jetbrains-mono',
});

export const metadata = {
  // Makes the auto-linked og:image absolute, which link unfurlers require.
  metadataBase: new URL('https://gapless.saewitz.com'),
  title: 'gapless.js',
  description: 'Gapless audio playback for the web.',
  openGraph: {
    title: 'gapless.js',
    description: 'Gapless audio playback for the web.',
    type: 'website',
  },
  twitter: { card: 'summary_large_image' },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.className} ${mono.className} bg-white text-zinc-950 antialiased dark:bg-zinc-900 dark:text-zinc-100`}
    >
      <body className="font-sans">
        <div className="isolate">{children}</div>
      </body>
    </html>
  );
}
