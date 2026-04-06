/**
 * agent/types.ts — AgentCore 相关公共类型和常量
 *
 * 从 agent.ts 提取，避免循环依赖：
 *   types.ts ← agent-tools.ts ← agent-loop.ts ← index.ts
 */

import type { ThinkingLevel } from '../../models/types.js';

// ─── Agent Loop Constants ────────────────────────────────────────────────────

/**
 * Tools that are safe to run in parallel (read-only / idempotent).
 * Declared at module level so it is allocated once, not on every LLM response.
 */
export const PARALLELIZABLE_TOOLS = new Set([
  // File system — read
  'Read', 'read_file', 'readFile',
  'LS', 'ls', 'list_files',
  'Grep', 'grep_search',
  'Glob', 'glob',              // Round 6: GlobTool parity
  // Web
  'WebFetch', 'WebSearch', 'web_search', 'web_fetch',
  // Analysis / inspection
  'InspectCode', 'inspect_code',
  'DatabaseQuery', 'database_query',
  'EnvProbe', 'env_probe',
  // Worktree read operations
  'worktree_list', 'worktree_status', 'worktree_events',
]);

/** Default maximum LLM iterations per runStream() call. */
export const DEFAULT_MAX_ITERATIONS = 50;
/** Default maximum unattended-retry rounds (CI mode) */
export const DEFAULT_MAX_UNATTENDED_RETRIES = 2;
/** Default wait between unattended retries (ms) */
export const DEFAULT_UNATTENDED_RETRY_DELAY_MS = 30_000;
/** Hard ceiling for unattended retry wait to prevent indefinite blocking */
export const MAX_UNATTENDED_RETRY_DELAY_MS = 5 * 60 * 1000;
/** TodoWrite nag reminder fires after this many rounds without a TodoWrite call */
export const TODO_NAG_ROUNDS = 3;

// ─── Public Interfaces ───────────────────────────────────────────────────────

/**
 * AgentEvents — CLI 层感知工具调用生命周期的回调接口
 *
 * 由 runStream() 第三参数传入，CLI 侧（index.ts）用来驱动 CliSpinner 的
 * 工具调用行追踪，替代原来只在 verbose=true 时打印 onChunk 的方式。
 */
export interface AgentEvents {
  /** 工具调用开始时触发 */
  onToolStart?: (name: string, args: Record<string, unknown>) => void;
  /** 工具调用完成时触发（success=false 表示抛异常）*/
  onToolEnd?: (name: string, success: boolean, durationMs: number) => void;
  /** LLM 开始输出文本（首个 text chunk 到来）时触发 */
  onResponseStart?: () => void;
}

export interface AgentOptions {
  domain: string;
  model: string;
  stream: boolean;
  verbose: boolean;
  safeMode?: boolean;
  /** Override system prompt entirely */
  systemPromptOverride?: string;
  /** Append extra text to the system prompt */
  appendSystemPrompt?: string;
  /** Claude extended-thinking level: 'low' | 'medium' | 'high' | 'max' | 'xhigh' | 'maxOrXhigh' */
  thinkingLevel?: ThinkingLevel;
  /** Approval mode: 'default' | 'autoEdit' | 'yolo' */
  approvalMode?: 'default' | 'autoEdit' | 'yolo';
  /**
   * Per-tool enable/disable overrides. Keys are tool names (e.g. "write", "bash",
   * "mcp__filesystem__write_file"). A value of `false` disables that tool.
   * CLI --tools flag and config.tools field are both resolved before construction
   * and merged here. Priority: CLI --tools > project config > global config.
   */
  disabledTools?: Record<string, boolean>;
}

/** Pending dangerous command waiting for user confirmation (kstack article #15313). */
export interface PendingConfirmation {
  command: string;
  cwd: string;
  label: string;
  /** Index in history where the synthetic [SYSTEM] message was injected. */
  injectedAt?: number;
}
