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
  /** 工具返回结果时触发（result 为工具原始返回字符串）*/
  onToolResult?: (name: string, result: string) => void;
  /** 工具调用完成时触发（success=false 表示抛异常）*/
  onToolEnd?: (name: string, success: boolean, durationMs: number, errorMsg?: string) => void;
  /** LLM 开始输出文本（首个 text chunk 到来）时触发 */
  onResponseStart?: () => void;
  /**
   * A13: withheld 可恢复错误被扣留时触发（claude-code withheld 机制对标）
   * 调用方可用于 UI 显示"正在尝试恢复..."状态
   */
  onWithheld?: (reason: 'prompt_too_long' | 'max_output_tokens' | 'context_overflow') => void;
  /**
   * A13: withheld 恢复成功后触发
   */
  onRecovered?: (reason: string) => void;
  /**
   * B13: 循环终止时触发，携带结构化终止原因
   */
  onTerminal?: (result: StreamLoopResult) => void;
  /**
   * C31: tool batch 完成后触发，携带 ≤30 字 commit-style 摘要标题
   * 仅当 ENABLE_TOOL_SUMMARY=true 时才会触发
   * Mirrors claude-code toolUseSummaryGenerator.ts batch-level summary
   */
  onToolBatchSummary?: (summary: string) => void;
  /**
   * C35: onCtxEvent — 上下文管理诊断事件（由 repl.ts 注入 SessionLogger 方法）
   * 在 editContextIfNeeded/autoCompact/reactiveCompact/HistorySnip/tokenWarning/apiUsage 触发
   */
  onCtxEvent?: (event: import('./agent-loop.js').CtxEvent) => void;
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
  /**
   * C19 (claude-code forkedAgent.ts canUseTool parity): Session grants inherited from parent agent.
   * When spawning a subagent, the parent's PermissionManager.exportSessionGrants() result is
   * passed here so the child inherits "Allow for this session" approvals without re-prompting.
   *
   * These grants are loaded into the child's PermissionManager.importSessionGrants() during init.
   */
  inheritedSessionGrants?: string[];
}

/** Pending dangerous command waiting for user confirmation (kstack article #15313). */
export interface PendingConfirmation {
  command: string;
  cwd: string;
  label: string;
  /** Index in history where the synthetic [SYSTEM] message was injected. */
  injectedAt?: number;
}

// ─── B13: Terminal / StreamLoopResult ────────────────────────────────────────

/**
 * B13: TerminalReason — 结构化循环终止原因（claude-code Terminal 对标）
 * 调用方可区分 9 种终止路径，提供精细的日志和恢复逻辑。
 */
export type TerminalReason =
  | 'completed'            // LLM 不再调用工具，正常完成
  | 'max_iterations'       // 达到最大迭代次数
  | 'max_turns'            // C21: 外部注入 maxTurns 超出 (claude-code query.ts parity)
  | 'blocking_limit'       // context 已满（blocking 状态）
  | 'hook_stopped'         // hook 返回 stop
  | 'hook_blocked'         // C17: user_prompt_submit hook 阻止了提交
  | 'budget_exhausted'     // token 预算耗尽
  | 'prompt_too_long'      // PTL 无法恢复
  | 'model_error'          // 模型调用失败
  | 'aborted'              // 用户中断（AbortSignal）
  | 'pending_confirmation'; // 等待用户确认危险操作

/**
 * B14: ContinueReason — 每次循环继续的原因（claude-code Continue type 对标）
 * 用于测试层断言哪条恢复路径被触发，也便于日志追踪。
 */
export type ContinueReason =
  | 'next_turn'                  // 正常工具循环进入下一轮
  | 'reactive_compact_retry'     // reactive compact 后重试
  | 'max_output_tokens_escalate' // B15: Phase-0 以 64k token 无声重试
  | 'max_output_tokens_recovery' // max_output_tokens 注入 recovery 消息后重试
  | 'ptl_retry'                  // prompt_too_long 截断后重试
  | 'unattended_retry'           // unattended-retry 等待超时后重试
  | 'context_overflow_retry'     // context overflow reactive compact 后重试
  | 'stop_hook_blocking';        // C15: Stop Hook blocking error 注入 history 后重试

/**
 * B14: ContinueTransition — 循环继续的元数据（claude-code State.transition 对标）
 */
export interface ContinueTransition {
  reason: ContinueReason;
  /** 针对同类型重试的计数（如第几次 ptl_retry） */
  attempt?: number;
  /** 本次 continue 前 compact/snip 释放的 token 数 */
  tokensFreed?: number;
}

/**
 * B13: StreamLoopResult — runStreamLoop() 返回值类型（claude-code Terminal 对标）
 */
export interface StreamLoopResult {
  reason: TerminalReason;
  iterations: number;
  tokensEstimated?: number;
  /** B14: 最后一次 continue 的原因（测试可观测性）*/
  lastTransition?: ContinueTransition;
}

/**
 * E25: QuerySource — complete enumeration for LLM call source identification.
 *
 * Used for:
 *   1. 529/429 retry gating — foreground retries 3x; background fails immediately
 *   2. A25 prompt cache TTL — main thread gets 1h TTL; background gets ephemeral
 *   3. Memory trigger precision — only 'repl_main_thread' triggers session_memory extraction
 *
 * Extends C18 (claude-code withRetry.ts) to match claude-code query.ts L63-80 (17+ values).
 * Mirrors claude-code FOREGROUND_529_RETRY_SOURCES Set in withRetry.ts L62-88.
 *
 * Foreground sources (retry on 529): repl_main_thread, compact, hook_agent, side_question,
 *   agent_coordinator, repl_main_thread_compact
 * Background sources (fail immediately on 529): all others
 */
export type QuerySource =
  // ── Foreground (interactive / user-facing) ──────────────────────────────────
  | 'repl_main_thread'            // E25: Main REPL conversation turn (primary foreground)
  | 'repl_main_thread:compact'    // E25: Main thread context compaction
  | 'agent_main'                  // C18: Alias for repl_main_thread (kept for backward compat)
  | 'compact'                     // C18: Context compaction / microcompact
  | 'agent:coordinator'           // E25: Coordinator/orchestrator agent (foreground)
  | 'hook_agent'                  // C18: Hook agent sub-call (foreground)
  | 'side_question'               // C18: Side question / ask-expert model
  // ── Background (fire-and-forget, fail immediately on 529) ────────────────────
  | 'agent'                       // E25: Generic subagent (background)
  | 'agent:autopilot'             // E25: Autopilot/autonomous subagent
  | 'agent:teammate'              // E25: Teammate/swarm member
  | 'tool_summary'                // C18: maybeGenerateToolSummary (background)
  | 'session_memory'              // C18/E25: Session memory extraction (background)
  | 'verification_agent'          // E25: Verification/validation subagent
  | 'auto_dream'                  // E25: AutoDream background synthesis
  | 'cron'                        // E25: ScheduleCronTool background invocation
  | 'speculation'                 // E25: PromptSuggestion speculative pre-execution
  | 'background_title'            // C18: Background title generation
  | 'background_classifier'       // C18: yolo-classifier approval check
  | 'agent_summarization';        // E25: AgentSummary 30s progress summarization
