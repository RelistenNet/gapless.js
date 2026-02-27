import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  outExtension: () => ({ js: '.mjs' }),
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: true,
  dts: true,
  // Mark xstate as external so consumers can share a single instance
  external: ['xstate'],
});
