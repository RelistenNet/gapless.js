import { defineConfig } from '@timber-js/app';
import { nitro } from '@timber-js/app/adapters/nitro';

// Pre-render every route to plain HTML + assets. No server at runtime — the
// Nitro adapter just merges pages and client assets into one directory that
// any static host can serve, and gives us `timber preview`.
export default defineConfig({
  output: 'static',
  adapter: nitro(),
});
