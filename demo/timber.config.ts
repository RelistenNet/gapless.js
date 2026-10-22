import { defineConfig } from '@timber-js/app';
import { nitro } from '@timber-js/app/adapters/nitro';

// timber (0.2.0-alpha.217) also switches the dev client to static mode, so
// HMR refetches /_rsc/index.rsc, which only exists in a static build. Use the
// server output in dev until that's fixed upstream.
const isDev = process.argv.includes('dev');

// Pre-render every route to plain HTML + assets. No server at runtime — the
// Nitro adapter just merges pages and client assets into one directory that
// any static host can serve, and gives us `timber preview`.
export default defineConfig({
  output: isDev ? 'server' : 'static',
  adapter: nitro(),
});
