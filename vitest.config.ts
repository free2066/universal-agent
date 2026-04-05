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
      // 统计范围：核心逻辑层 + models 层
      // 排除大型工具文件（需要复杂 mock，后续单独处理）和 cli/
      include: [
        'src/core/**/*.ts',
        'src/models/**/*.ts',
      ],
      exclude: [
        // cli 层（readline/UI mock 成本高）
        'src/cli/**',
        // domain plugins
        'src/domains/**',
        // 大型工具文件（需要外部系统 mock：Docker、Redis、proxy、ws…）
        'src/core/tools/code/ai-reviewer.ts',
        'src/core/tools/code/bug-detector.ts',
        'src/core/tools/productivity/proxy-tools.ts',
        'src/core/tools/productivity/redis-probe.ts',
        'src/core/tools/productivity/script-tools.ts',
        'src/core/tools/productivity/test-runner.ts',
        'src/core/tools/productivity/ws-mcp-server.ts',
        'src/core/tools/productivity/docs-tool.ts',
        'src/core/tools/productivity/database-query.ts',
        'src/core/tools/productivity/terminal-ipc-tool.ts',
        'src/core/tools/agents/spawn-agent.ts',
        'src/core/skills/skill-loader.ts',
        'src/core/task-board.ts',
        'src/core/tools/web/web-tools.ts',
        // 转发 shim（只有 export，无实际逻辑）
        'src/core/agent.ts',
        'src/models/llm/index.ts',
        // 节点模块和构建产物
        'node_modules',
        'dist',
      ],
      // 目标：lines/statements >= 35%，branches >= 40%
      thresholds: {
        lines: 30,
        functions: 25,
        branches: 35,
        statements: 30,
      },
    },
    reporter: ['verbose'],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
});
