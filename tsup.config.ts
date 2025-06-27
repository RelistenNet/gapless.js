import { defineConfig } from 'tsup';

const commonOptions = {
  entry: ['src/index.ts'],
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: true,
  bundle: true,
  external: [], // Bundle all dependencies including XState
  noExternal: ['xstate'], // Force XState to be bundled inline
  platform: 'browser' as const, // Ensure browser-compatible build
};

export default defineConfig(() => [
  {
    ...commonOptions,
    format: ['esm'],
    outExtension: () => ({ js: '.mjs' }),
    dts: true,
    clean: true,
  },
  {
    ...commonOptions,
    format: 'cjs',
    outDir: './dist/cjs/',
    outExtension: () => ({ js: '.cjs' }),
    esbuildOptions: (options: any) => {
      options.footer = {
        // This will ensure we can continue writing this plugin
        // as a modern ECMA module, while still publishing this as a CommonJS
        // library with a default export, as that's how ESLint expects plugins to look.
        // @see https://github.com/evanw/esbuild/issues/1182#issuecomment-1011414271
        js: 'module.exports = module.exports.default;',
      };
    },
  },
]);
