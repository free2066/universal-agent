import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 30000,
    hookTimeout: 15000,
    // Run test *files* sequentially to prevent fake-timer cross-contamination.
    // Tests within a file that use vi.useFakeTimers() share the global timer state
    // for the entire worker; if two describe blocks both manipulate fake timers
    // concurrently, they interfere and produce PromiseRejectionHandledWarning.
    // Sequential file execution is a safe default here; parallelism inside a file
    // is still controlled by the describe block structure.
    sequence: {
      concurrent: false,
    },
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
