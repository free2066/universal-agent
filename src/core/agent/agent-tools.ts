/**
 * agent/agent-tools.ts — 工具注册逻辑
 *
 * 从 AgentCore.registerAllTools() 提取，独立为纯函数。
 * 接收 registry 和 router 引用，不依赖 AgentCore 实例状态。
 */

import type { ToolRegistry } from '../tool-registry.js';
import type { DomainRouter } from '../domain-router.js';
import type { ToolRegistration } from '../../models/types.js';
import { subagentSystem, createTaskTool, askExpertModelTool } from '../subagent-system.js';
import { readFileTool, writeFileTool, editFileTool, bashTool, listFilesTool, grepTool } from '../tools/fs/fs-tools.js';
import { webFetchTool, webSearchTool } from '../tools/web/web-tools.js';
import { codeInspectorTool } from '../tools/code/code-inspector.js';
import { selfHealTool } from '../tools/code/self-heal.js';
import { spawnAgentTool, spawnParallelTool } from '../tools/agents/spawn-agent.js';
import { coordinatorRunTool } from '../tools/agents/coordinator-tool.js';
import { businessDefectDetectorTool } from '../tools/code/business-defect-detector.js';
import { reverseAnalyzeTool } from '../tools/code/reverse-analyze.js';
import { loadSkillTool, runSkillTool } from '../tools/productivity/skill-tool.js';
import { readDocTool, docSearchTool, fetchDocTool } from '../tools/productivity/docs-tool.js';
import { scriptSaveTool, scriptRunTool, scriptListTool } from '../tools/productivity/script-tools.js';
import { testRunnerTool } from '../tools/productivity/test-runner.js';
import { envProbeTool } from '../tools/productivity/env-probe.js';
import {
  wsServerStartTool, wsServerStopTool, wsServerStatusTool,
  wsBroadcastTool, wsInboxTool, wsMockInjectTool,
} from '../tools/productivity/ws-mcp-server.js';
import {
  proxyStartTool, proxyStopTool, proxyStatusTool,
  proxyCapturesTool, proxyMockTool, proxyMockListTool, proxyMockClearTool, proxyClearTool,
} from '../tools/productivity/proxy-tools.js';
import { curlExecuteTool } from '../tools/productivity/curl-tool.js';
import {
  githubCreatePRTool,
  githubListPRsTool,
  githubMergePRTool,
} from '../tools/productivity/github-pr-tool.js';
import { autopilotRunTool } from '../tools/agents/autopilot-tool.js';
import {
  terminalSendTool,
  terminalReadTool,
  terminalExecTool,
  terminalListTool,
} from '../tools/productivity/terminal-ipc-tool.js';
import { redisProbeTool } from '../tools/productivity/redis-probe.js';
import { databaseQueryTool } from '../tools/productivity/database-query.js';
import { taskCreateTool, taskUpdateTool, taskListTool, taskGetTool } from '../task-board.js';
import { backgroundRunTool, checkBackgroundTool, killBashTool } from '../tools/productivity/background-tools.js';
import { todoWriteTool } from '../tools/productivity/todo-tool.js';
import { syntheticOutputTool } from '../tools/productivity/synthetic-output.js';
import {
  spawnTeammateTool,
  listTeammatesTool,
  sendMessageTool,
  readInboxTool,
  broadcastTool,
  shutdownRequestTool,
  planApprovalTool,
  claimTaskFromBoardTool,
} from '../teammate-manager.js';
import {
  worktreeCreateTool,
  worktreeListTool,
  worktreeStatusTool,
  worktreeRunTool,
  worktreeRemoveTool,
  worktreeKeepTool,
  worktreeEventsTool,
  taskBindWorktreeTool,
} from '../tools/agents/worktree-tools.js';

/**
 * 向 registry 注册所有工具。
 *
 * @param registry  工具注册表
 * @param router    域路由器（用于注册域专属工具）
 * @param domain    当前域名
 * @param disabledTools  禁用工具映射（tool name → false 表示禁用）
 */
export function registerAllTools(
  registry: ToolRegistry,
  router: DomainRouter,
  domain: string,
  disabledTools?: Record<string, boolean>,
): void {
  // Build a name-based filter.
  const isDisabled = (toolName: string): boolean => {
    if (disabledTools && disabledTools[toolName] === false) return true;
    const lower = toolName.toLowerCase();
    if (disabledTools && disabledTools[lower] === false) return true;
    return false;
  };

  const reg = (tool: ToolRegistration) => {
    if (!isDisabled(tool.definition.name)) registry.register(tool);
  };
  const regMany = (tools: ToolRegistration[]) => {
    for (const t of tools) reg(t);
  };

  // Core FS tools (always registered — these are the foundation)
  regMany([
    readFileTool,
    writeFileTool,
    editFileTool,
    bashTool,
    listFilesTool,
    grepTool,
  ]);

  // Web tools
  regMany([webFetchTool, webSearchTool]);

  // Code quality & self-healing tools (always available)
  reg(codeInspectorTool);
  reg(selfHealTool);

  // Subagent tools
  reg(createTaskTool(subagentSystem));
  reg(askExpertModelTool);
  reg(spawnAgentTool);
  reg(spawnParallelTool);
  reg(coordinatorRunTool);
  reg(businessDefectDetectorTool);
  reg(reverseAnalyzeTool);

  // s03 — in-session todo tracking with nag reminder
  {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    let todoEnabled = true;
    try {
      const cs = require('../../cli/config-store.js') as typeof import('../../cli/config-store.js');
      todoEnabled = cs.loadConfig().todo !== false;
    } catch { /* config unavailable → default ON */ }
    if (todoEnabled) reg(todoWriteTool);
  }

  // s05 — on-demand skill loading
  reg(loadSkillTool);
  reg(runSkillTool);

  // Docs tools
  regMany([readDocTool, docSearchTool, fetchDocTool]);

  // Script tools
  regMany([scriptSaveTool, scriptRunTool, scriptListTool]);

  // TDD tools
  reg(testRunnerTool);

  // EnvProbe
  reg(envProbeTool);

  // WebSocket MCP Server
  regMany([
    wsServerStartTool, wsServerStopTool, wsServerStatusTool,
    wsBroadcastTool, wsInboxTool, wsMockInjectTool,
  ]);

  // HTTP Proxy / Traffic Capture
  regMany([
    proxyStartTool, proxyStopTool, proxyStatusTool,
    proxyCapturesTool, proxyMockTool, proxyMockListTool, proxyMockClearTool, proxyClearTool,
  ]);

  reg(curlExecuteTool);
  reg(redisProbeTool);
  reg(databaseQueryTool);

  // Terminal IPC tools
  regMany([
    terminalListTool,
    terminalSendTool,
    terminalReadTool,
    terminalExecTool,
  ]);

  // GitHub PR tools
  regMany([
    githubCreatePRTool,
    githubListPRsTool,
    githubMergePRTool,
  ]);

  // AutopilotRun
  reg(autopilotRunTool);

  // s07 — persistent task board (+ s11 claim)
  regMany([taskCreateTool, taskUpdateTool, taskListTool, taskGetTool]);
  reg(claimTaskFromBoardTool);

  // s08 — background command execution
  regMany([backgroundRunTool, checkBackgroundTool, killBashTool]);

  // s09/s10/s11 — teammate system
  regMany([
    spawnTeammateTool,
    listTeammatesTool,
    sendMessageTool,
    readInboxTool,
    broadcastTool,
    shutdownRequestTool,
    planApprovalTool,
  ]);

  // s12 — worktree isolation tools
  regMany([
    worktreeCreateTool,
    worktreeListTool,
    worktreeStatusTool,
    worktreeRunTool,
    worktreeRemoveTool,
    worktreeKeepTool,
    worktreeEventsTool,
    taskBindWorktreeTool,
  ]);

  // s13 — structured / synthetic output
  reg(syntheticOutputTool);

  // Domain-specific tools
  router.registerTools(registry, domain);
}
