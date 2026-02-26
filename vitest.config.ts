import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests run in Node.js with the happy-dom environment
    environment: 'happy-dom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/gapless.js'],
    },
    // Browser-mode integration tests are run separately via playwright
    // (see package.json test:integration script)
  },
});
