import { defineConfig } from 'vite';
import { timber } from '@timber-js/app';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [timber(), tailwindcss()],
  server: {
    proxy: {
      // audio.relisten.net only sends CORS headers to allow-listed origins.
      '/relisten-audio': {
        target: 'https://audio.relisten.net',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/relisten-audio/, ''),
      },
    },
  },
  resolve: {
    alias: {
      // Always demo the library source in this repo, not a published build.
      gapless: path.resolve(import.meta.dirname, '../src/index.ts'),
    },
  },
});
