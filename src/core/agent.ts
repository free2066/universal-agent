/**
 * core/agent.ts — 向后兼容转发层
 *
 * 原 1,205 行单文件已拆分到 src/core/agent/ 目录：
 *   - agent/types.ts       AgentEvents, AgentOptions, 常量
 *   - agent/agent-tools.ts registerAllTools() 工具注册
 *   - agent/agent-loop.ts  runStream() 主循环
 *   - agent/index.ts       AgentCore 类（薄壳组合）
 *
 * 此文件保留是为了不破坏现有 import '../core/agent.js' 路径。
 * 新代码请直接 import from './agent/index.js'。
 */
export { AgentCore } from './agent/index.js';
export type { AgentEvents, AgentOptions, PendingConfirmation } from './agent/types.js';
