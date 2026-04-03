import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 30000,
    hookTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/core/**/*.ts'],
      exclude: ['src/cli/**', 'src/domains/**', 'node_modules', 'dist'],
    },
    reporter: ['verbose'],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
});
