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
  // Bundle xstate so consumers don't need to install it separately
  noExternal: ['xstate'],
});
