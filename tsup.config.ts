import { defineConfig } from 'tsup';

const commonOptions = {
  entry: ['src/index.ts'],
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: true,
  // Bundle xstate so consumers don't need to install it separately
  noExternal: ['xstate'],
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
    esbuildOptions: (options: Parameters<NonNullable<import('tsup').Options['esbuildOptions']>>[0]) => {
      options.footer = {
        // Ensure the package works as a CommonJS default export
        js: 'module.exports = module.exports.default ?? module.exports;',
      };
    },
  },
]);
