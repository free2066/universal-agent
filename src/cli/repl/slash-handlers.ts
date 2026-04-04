/**
 * cli/repl/slash-handlers.ts — 向后兼容转发层
 *
 * 原 1,192 行单文件已拆分到 src/cli/repl/handlers/ 目录：
 *   - handlers/shared.ts           SlashContext 类型 + 工具函数
 *   - handlers/session-handlers.ts /log /logs /resume /clear /exit /branch /rename /export...
 *   - handlers/agent-handlers.ts   /model /models /domain /agents /context /compact /tokens
 *   - handlers/memory-handlers.ts  /memory /history /init /rules /review /spec /spec:*
 *   - handlers/tool-handlers.ts    /mcp /inspect /team /purify /skills /plugin /logout...
 *   - handlers/index.ts            路由总入口 (handleSlash)
 *
 * 此文件保留是为了不破坏现有 import './slash-handlers.js' 路径。
 * 新代码请直接 import from './handlers/index.js'。
 */
export { handleSlash } from './handlers/index.js';
export type { SlashContext } from './handlers/shared.js';
