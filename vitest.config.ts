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
      // 覆盖范围扩大：包含 core/ 和 models/
      // cli/ 和 domains/ 当前 mock 成本高，后续分批加入
      include: ['src/core/**/*.ts', 'src/models/**/*.ts'],
      exclude: ['src/cli/**', 'src/domains/**', 'node_modules', 'dist'],
      // 保底覆盖率阈值；后续随测试增加而提高
      thresholds: {
        lines: 20,
        functions: 20,
        branches: 15,
        statements: 20,
      },
    },
    reporter: ['verbose'],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
});
