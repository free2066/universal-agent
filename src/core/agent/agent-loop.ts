/**
 * agent/agent-loop.ts — AgentCore 主循环逻辑
 *
 * 包含：
 *  - runStream() 主循环（LLM 调用 + 工具分发 + 确认流程）
 *  - expandMentions() @run-agent / @ask-<model> 提及扩展
 *  - _captureIterationSnapshot() 迭代快照
 */

import type { LLMClient, Message } from '../../models/types.js';
import type { ToolRegistry } from '../tool-registry.js';
import type { DomainRouter } from '../domain-router.js';
import type { MCPManager } from '../mcp-manager.js';
import type { ModelFallbackChain } from '../model-fallback.js';
import type { AgentEvents, ContinueTransition, PendingConfirmation, StreamLoopResult, TerminalReason } from './types.js';
import {
  PARALLELIZABLE_TOOLS,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_UNATTENDED_RETRIES,
  DEFAULT_UNATTENDED_RETRY_DELAY_MS,
  MAX_UNATTENDED_RETRY_DELAY_MS,
  TODO_NAG_ROUNDS,
} from './types.js';
import { modelManager } from '../../models/model-manager.js';
import { buildSystemPromptWithContext } from '../context/context-loader.js';
import { subagentSystem } from '../subagent-system.js';
import { autoCompact, reactiveCompact, shouldCompact, calculateTokenWarningState, estimateHistoryTokens, snipCompactIfNeeded } from '../context/context-compressor.js';
import {
  updateSessionMemory,
  trySessionMemoryCompaction,
} from '../memory/session-memory.js';
import { getMemoryStore, triggerIncrementalIngest } from '../memory/memory-store.js';
import { createLogger } from '../logger.js';
import { triggerHook, createHookEvent } from '../hooks.js';
import { withToolRetry, withApiRateLimitRetry } from '../tool-retry.js';
import { withApiRetry } from '../with-api-retry.js';
import { editContextIfNeeded } from '../context/context-editor.js';
import { selectTools } from '../tool-selector.js';
import { backgroundManager } from '../background-manager.js';
import { todoManager } from '../tools/productivity/todo-tool.js';
import { getTeammateManager } from '../teammate-manager.js';
import { sessionMetrics } from '../metrics.js';
import { getPermissionManager } from './permission-manager.js';
import {
  createBudgetTracker,
  checkTokenBudget,
  buildBudgetStopMessage,
} from './token-budget.js';

const log = createLogger('agent-loop');

// ── B26: InterruptMessage 常量 — Ctrl+C 中断时注入 history ──────────────────
// Mirrors claude-code messages.ts L207-209.
// Only injected when signal.reason !== 'interrupt' (new message submitted),
// to avoid redundant notifications when user types a new prompt.
const INTERRUPT_MESSAGE = '[Request interrupted by user]';
const INTERRUPT_MESSAGE_FOR_TOOL_USE = '[Request interrupted by user for tool use]';

// ── Tombstone mechanism (claude-code parity) ──────────────────────────────────
//
// When the LLM stream is interrupted (e.g. model fallback, context overflow),
// partial streaming messages may have been pushed to the history and rendered
// in the UI. These orphaned assistant messages need to be "tombstoned" so the
// UI can remove them before the retry, preventing duplicate/garbled output.
//
// A tombstone message is a synthetic assistant message with type:'tombstone'
// that signals the UI to delete everything from the tombstone position onward.
// This mirrors claude-code's query.ts tombstone pattern.

interface TombstoneMessage {
  role: 'assistant';
  content: string;
  type: 'tombstone';
  tombstoneAt: number; // history length at time of tombstone
}

function createTombstone(historyLength: number): TombstoneMessage {
  return {
    role: 'assistant',
    content: '[tombstone]',
    type: 'tombstone',
    tombstoneAt: historyLength,
  };
}

// ── ToolUseSummary (claude-code parity) ────────────────────────────────────────
//
// When a tool result exceeds TOOL_USE_SUMMARY_THRESHOLD characters, fire a
// background Haiku-model call to generate a compressed summary. The summary
// is stored as a Promise (_pendingToolUseSummaryPromise, B18 upgrade) and awaited
// at the START of the next iteration, before the LLM call.
//
// B18: Upgrade from fire-and-forget array to cross-iteration Promise propagation.
// Mirrors claude-code State.pendingToolUseSummary (Promise<ToolUseSummaryMessage | null>).
// Two things happen in parallel:
//   1. Previous iteration fires summary generation (fire-and-forget Promise)
//   2. Next iteration awaits the Promise before calling LLM, injects as user message

const TOOL_USE_SUMMARY_THRESHOLD = 8_000; // chars above which we summarize

async function maybeGenerateToolSummary(
  toolName: string,
  rawResult: string,
): Promise<string | null> {
  if (rawResult.length < TOOL_USE_SUMMARY_THRESHOLD) return null;

  try {
    const client = modelManager.getClient('compact');
    // C18: querySource='tool_summary' — background, 529 fails immediately (no retries)
    const response = await client.chat({
      systemPrompt: 'You are summarizing a tool result for an AI coding assistant. Be concise and preserve key findings, errors, and actionable information.',
      messages: [{
        role: 'user',
        content: `Summarize the following ${toolName} tool result in 2-4 sentences, preserving the most important information:\n\n${rawResult.slice(0, 20_000)}`,
      }],
    });
    const summary = response.content.trim();
    if (summary.length > 50 && summary.length < rawResult.length * 0.8) {
      return `[${toolName} result compressed] ${summary}`;
    }
    return null;
  } catch {
    return null; // summary failure is non-fatal
  }
}

// ── B15: maxOutputTokens Phase-0 Escalation + Phase-1~3 Recovery ─────────────
//
// claude-code 的四阶段恢复流程（B15 对齐）：
//   Phase 0: 精确检测 apiError='max_output_tokens'，以 ESCALATED_MAX_TOKENS=64k 无声重试
//   Phase 1-3: 注入 recovery 消息 "Output token limit hit..."（最多 3 次）
//   Phase 4: 超过 3 次 → 向用户显示错误
//
// 检测优先级：apiError 字段 > finish_reason 字段 > 尾字符启发式

/** B15: ESCALATED_MAX_TOKENS — Phase-0 静默重试使用的 max token 限制 */
export const ESCALATED_MAX_TOKENS = 64_000;
/** B15: CAPPED_DEFAULT_MAX_TOKENS — 默认输出 token 上限（Phase-0 触发阈值） */
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000;

const MAX_CONTINUATION_RETRIES = 3;

/**
 * B15: isWithheldMaxOutputTokens — 精确检测是否命中 max_output_tokens 限制
 * 对标 claude-code isWithheldMaxOutputTokens()
 * 优先检查 apiError 字段，其次回落到 finish_reason 和尾字符启发式
 */
function isWithheldMaxOutputTokens(responseContent: string, finishReason?: string, apiError?: string): boolean {
  if (apiError === 'max_output_tokens') return true;
  if (finishReason === 'max_tokens' || finishReason === 'length') return true;
  // 兼容旧逻辑：尾字符启发式检测
  const trimmed = responseContent.trimEnd();
  if (trimmed.length < 50) return false;
  const lastChar = trimmed[trimmed.length - 1];
  if (['.', '?', '!', '`', '>', '}', ']', '"', "'"].includes(lastChar)) return false;
  return /\w$/.test(trimmed);
}

// 旧别名，保持向后兼容
const isResponseTruncated = (content: string, fr?: string) => isWithheldMaxOutputTokens(content, fr);

// ─── Pending confirmation helpers ────────────────────────────────────────────

/** 处理挂起的危险命令确认（kstack article #15313）。*/
export async function handlePendingConfirmation(
  pending: PendingConfirmation,
  prompt: string,
  history: Message[],
  onChunk: (chunk: string) => void,
): Promise<boolean> {
  const { command, cwd, label, injectedAt } = pending;
  const isConfirmed = /^\s*(yes|y|confirm|ok|go|proceed|execute|run it|do it)\s*$/i.test(prompt.trim());

  if (isConfirmed) {
    if (injectedAt !== undefined && history.length > injectedAt) {
      history.splice(injectedAt);
    }
    onChunk(`\n✅ Confirmed. Executing: \`${command}\`\n\n`);
    try {
      const { execSync } = await import('child_process');
      const output = execSync(command, {
        cwd,
        encoding: 'utf-8',
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      onChunk(output.trim() || '(no output)');
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const parts: string[] = [];
      if (e.stdout?.trim()) parts.push(e.stdout.trim());
      if (e.stderr?.trim()) parts.push(e.stderr.trim());
      if (!e.stderr && e.message) parts.push(e.message);
      onChunk(`\n❌ Command failed:\n${parts.join('\n') || 'Unknown error'}`);
    }
    onChunk('\n');
  } else {
    if (injectedAt !== undefined && history.length > injectedAt) {
      history.splice(injectedAt);
    }
    onChunk(`\n🚫 Cancelled. The following command was NOT executed:\n  \`${command}\`\n  (${label})\n`);
  }
  return true; // consumed — caller should return
}

// ─── Memory recall ────────────────────────────────────────────────────────────

/** 将 MemoryStore 中相关记忆注入到 systemPrompt 中。*/
async function appendMemoriesToPrompt(prompt: string, systemPrompt: string): Promise<string> {
  try {
    const store = getMemoryStore(process.cwd());
    const memories = await store.recall(prompt);
    if (memories.length === 0) return systemPrompt;

    const iterations = memories.filter((m) => m.type === 'iteration');
    const others = memories.filter((m) => m.type !== 'iteration');

    if (others.length > 0) {
      const relativeTime = (ms: number): string => {
        const diffSec = Math.floor((Date.now() - ms) / 1000);
        if (diffSec < 60) return `${diffSec}s ago`;
        if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
        if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
        const days = Math.floor(diffSec / 86400);
        if (days === 1) return 'yesterday';
        if (days < 30) return `${days} days ago`;
        if (days < 365) return `${Math.floor(days / 30)} months ago`;
        return `${Math.floor(days / 365)} years ago`;
      };
      const memLines = others.map((m) => {
        const tag = m.type === 'pinned' ? '📌' : m.type === 'insight' ? '💡' : '📝';
        return `${tag} [${relativeTime(m.createdAt)}] ${m.content}`;
      }).join('\n');
      systemPrompt += `\n\n## Relevant Memories (from previous sessions)\n${memLines}`;
    }

    if (iterations.length > 0) {
      const iterLines = iterations.map((m) => {
        const d = new Date(m.createdAt).toISOString().slice(0, 10);
        return `### [${d}]\n${m.content}`;
      }).join('\n\n');
      systemPrompt += `\n\n## Recent Iteration History (from past sessions)\n` +
        `> These are auto-captured snapshots of what was done in previous sessions.\n` +
        `> Use them to maintain continuity and avoid repeating past mistakes.\n\n${iterLines}`;
    }
  } catch {
    // Memory recall failure is non-fatal
  }
  return systemPrompt;
}

// ─── Iteration snapshot ───────────────────────────────────────────────────────

/**
 * 在成功完成一次 session turn 后，自动捕获迭代快照。
 * Cowork Forge "迭代知识记忆" 模式。
 */
export async function captureIterationSnapshot(
  originalPrompt: string,
  history: Message[],
): Promise<void> {
  if (history.length < 4) return;

  try {
    const store = getMemoryStore(process.cwd());
    const recentTurns = history.slice(-20);
    const convText = recentTurns
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => `[${m.role.toUpperCase()}]: ${String(m.content).slice(0, 400)}`)
      .join('\n');

    const snapshotPrompt = `You are creating a brief retrospective snapshot of an AI coding session.

## Original Request
${originalPrompt.slice(0, 300)}

## Session Summary (recent turns)
${convText}

## Your Task
Write a concise retrospective in 3-5 bullet points covering:
1. What was accomplished (files created/modified, features added)
2. Key decisions made or patterns established
3. Any problems encountered and how they were resolved
4. Tech debt or follow-up items left for future sessions

Rules:
- Be specific (name actual files, functions, patterns)
- Keep each bullet to 1-2 sentences
- Start each bullet with • 
- Do NOT include meta-commentary about this being a snapshot
- Write from first-person perspective ("We refactored...", "Added support for...")`;

    const client = modelManager.getClient('compact');
    const response = await client.chat({
      systemPrompt: 'You are a retrospective assistant. Write concise, specific session summaries.',
      messages: [{ role: 'user', content: snapshotPrompt }],
    });

    const content = response.content.trim();
    if (content && content.length > 20) {
      store.add({
        type: 'iteration',
        content,
        tags: ['session', 'retrospective', 'auto-snapshot'],
        source: 'agent',
      });
    }
  } catch {
    // Snapshot failure is completely non-fatal
  }
}

// ─── @mention expansion ───────────────────────────────────────────────────────

/**
 * Expand @run-agent-<name> and @ask-<model> mentions into tool call hints.
 */
export function expandMentions(prompt: string): string {
  const hints: string[] = [];

  const agentMentions = prompt.match(/@run-agent-([\w-]+)/g) || [];
  for (const mention of agentMentions) {
    const agentName = mention.replace('@run-agent-', '');
    if (subagentSystem.getAgent(agentName)) {
      hints.push(`delegate to subagent "${agentName}" using the Task tool`);
    }
  }

  const modelMentions = prompt.match(/@ask-([\w-.:]+)/g) || [];
  for (const mention of modelMentions) {
    const modelName = mention.replace('@ask-', '');
    hints.push(`consult expert model "${modelName}" using the AskExpertModel tool`);
  }

  if (hints.length === 0) return prompt;
  return `${prompt}\n\n[Hints: ${hints.join('; ')}]`;
}

// ─── Main loop ────────────────────────────────────────────────────────────────

export interface RunStreamOptions {
  prompt: string;
  onChunk: (chunk: string) => void;
  events?: AgentEvents;
  filePath?: string;
  abortSignal?: AbortSignal;
  history: Message[];
  /** Mutable reference — loop sets this to null after consuming */
  pendingConfirmationRef: { value: PendingConfirmation | null };
  uncertainItems: string[];
  systemPromptOverride: string | null;
  appendSystemPrompt: string | null;
  thinkingLevel: import('../../models/types.js').ThinkingLevel | undefined;
  currentDomain: string;
  verbose: boolean;
  registry: ToolRegistry;
  router: DomainRouter;
  getLLM: () => LLMClient;
  fallbackChain: ModelFallbackChain | null;
  /** Permission mode: 'default' | 'autoEdit' | 'yolo' (Round 4, claude-code parity) */
  approvalMode?: import('./permission-manager.js').ApprovalMode;
  /**
   * C21: maxTurns — 外部注入最大迭代轮数（claude-code RunOptions.maxTurns parity）
   * 优先级高于环境变量 AGENT_MAX_ITERATIONS。
   */
  maxTurns?: number;
  /**
   * E22: taskBudget — 跨 compact 边界的任务 token 预算（claude-code QueryParams.taskBudget parity）
   * 在每次 compact 后递减 preCompact token 消耗，透传给 API task_budget 字段。
   */
  taskBudget?: { total: number };
  /**
   * F22: userContext — 动态键值对注入（claude-code QueryParams.userContext parity）
   * 内容包装在 <system-reminder> 标签中作为首条 user 消息注入，使 LLM 可见。
   */
  userContext?: Record<string, string>;
  /**
   * F22: systemContext — 系统 prompt 末尾追加上下文（claude-code QueryParams.systemContext parity）
   * 键值对以 "key: value" 格式追加到 systemPrompt 末尾。
   */
  systemContext?: Record<string, string>;
  /**
   * B35: onCtxEvent — 上下文管理事件回调（由 repl.ts 注入 SessionLogger 方法）
   * 在 agent-loop 内部的关键上下文管理路径（editContextIfNeeded/autoCompact/
   * reactiveCompact/HistorySnip/tokenWarning/apiUsage）触发。
   * fail-open：不影响主流程。
   */
  onCtxEvent?: (event: CtxEvent) => void;
}

/**
 * B35: CtxEvent — 上下文管理诊断事件联合类型
 * 传递给 RunStreamOptions.onCtxEvent 回调，由 repl.ts 路由到 SessionLogger。
 */
export type CtxEvent =
  | { type: 'clear';   count: number; tokensFreed: number; toolNames: string[]; estimatedBefore: number }
  | { type: 'compact'; compactType: 'auto' | 'reactive' | 'snip'; before: number; after: number; msgsBefore: number; msgsAfter: number }
  | { type: 'warning'; state: 'ok' | 'warning' | 'blocking'; est: number; ctx: number; pct: number }
  | { type: 'api_usage'; iteration: number; input: number; output: number; cacheWrite: number; cacheRead: number; totalInput: number; histEst: number }
  | { type: 'llm_req'; iteration: number; historyLen: number; estimatedTokens: number; toolCount: number; model: string };

export async function runStreamLoop(opts: RunStreamOptions): Promise<StreamLoopResult> {
  const {
    prompt, onChunk, events, filePath,
    history, pendingConfirmationRef, uncertainItems,
    systemPromptOverride, appendSystemPrompt, thinkingLevel,
    currentDomain, verbose, registry, router, getLLM, fallbackChain,
    approvalMode = 'default',
  } = opts;

  // E22: taskBudget cross-compact tracking (claude-code query.ts L291, L508-514, L699-706 parity)
  const _taskBudget = opts.taskBudget;
  let _taskBudgetRemaining: number | undefined;

  // F22: userContext/systemContext 分离注入（claude-code query.ts L184-185 + api.ts L437-474 parity）
  const _userContext = opts.userContext ?? {};
  const _systemContext = opts.systemContext ?? {};
  // B35: onCtxEvent — 上下文管理诊断事件回调（由 repl.ts 注入，fail-open）
  const _onCtxEvent = opts.onCtxEvent;

  // ── Pending confirmation check ─────────────────────────────────────────────
  if (pendingConfirmationRef.value) {
    const pending = pendingConfirmationRef.value;
    pendingConfirmationRef.value = null;
    await handlePendingConfirmation(pending, prompt, history, onChunk);
    // B13: 等待用户确认时终止
    const result: StreamLoopResult = { reason: 'pending_confirmation', iterations: 0 };
    events?.onTerminal?.(result);
    return result;
  }

  // Auto-detect domain
  const domain = currentDomain === 'auto'
    ? router.detectDomain(prompt)
    : currentDomain;

  const expandedPrompt = expandMentions(prompt);

  // ── Round 7: ultrathink keyword → max thinking budget ─────────────────────
  // If user includes "ultrathink" in the prompt, auto-escalate to maximum
  // thinking budget (32k tokens) for this turn only.
  // Reference: claude-code thinking.ts ultrathink trigger
  let _ultrathinkActive = false;
  if (/\bultrathink\b/i.test(expandedPrompt) && thinkingLevel !== undefined) {
    _ultrathinkActive = true;
    onChunk('\n🧠 ultrathink mode activated — maximum thinking budget (32k tokens)\n\n');
  }

  const baseSystemPrompt = router.getSystemPrompt(domain);
  let systemPrompt = systemPromptOverride ?? buildSystemPromptWithContext(baseSystemPrompt);
  if (appendSystemPrompt) systemPrompt += `\n\n${appendSystemPrompt}`;

  // F22: appendSystemContext — 将 systemContext 键值对追加到 systemPrompt 末尾
  // Mirrors claude-code api.ts appendSystemContext() L437-447.
  if (Object.keys(_systemContext).length > 0) {
    const appended = Object.entries(_systemContext)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    systemPrompt = `${systemPrompt}\n\n${appended}`;
  }

  // ── Memory recall ──────────────────────────────────────────────────────────
  systemPrompt = await appendMemoriesToPrompt(expandedPrompt, systemPrompt);

  const userMessage: Message = {
    role: 'user',
    content: filePath ? `${expandedPrompt}\n\n[File context: ${filePath}]` : expandedPrompt,
  };

  // 记录调用时的 history 长度，用于后续判断是否是第一轮（session:start hook）
  const _initialHistoryLen = history.length;

  // F22: prependUserContext — 将 userContext 键值对包装在 <system-reminder> 中，作为首条 user 消息注入
  // Mirrors claude-code api.ts prependUserContext() L449-474.
  // 跳过测试环境注入（与 claude-code 保持一致）。
  if (Object.keys(_userContext).length > 0 && process.env.NODE_ENV !== 'test') {
    const userCtxContent = [
      '<system-reminder>',
      Object.entries(_userContext).map(([k, v]) => `# ${k}\n${v}`).join('\n'),
      '</system-reminder>',
    ].join('\n');
    // 只在 history 头部没有同一条 system-reminder 时才注入，防止多轮累积
    const alreadyInjected = history[0]?.content === userCtxContent;
    if (!alreadyInjected) {
      // 移除上一轮注入的旧 system-reminder（内容可能已变化）
      if (history[0]?.role === 'user' && typeof history[0].content === 'string' &&
          history[0].content.startsWith('<system-reminder>')) {
        history.shift();
      }
      history.unshift({ role: 'user', content: userCtxContent });
    }
  }

  // C17: user_prompt_submit hook — fire before adding message to history
  // Allows hooks to inject additionalContext into the user message
  try {
    const { HookRunner } = await import('../hooks.js');
    const _hookRunner = new HookRunner(process.cwd());
    if (_hookRunner.hasHooksFor('user_prompt_submit')) {
      const hookResult = await _hookRunner.run({
        event: 'user_prompt_submit',
        userPrompt: expandedPrompt,
        cwd: process.cwd(),
      });
      if (hookResult.proceed === false) {
        // Hook blocked the prompt submission
        const reason = hookResult.blockReason ?? hookResult.stopReason ?? 'Blocked by user_prompt_submit hook';
        onChunk(`\n[Hook] user_prompt_submit hook blocked prompt: ${reason}\n`);
        const result: StreamLoopResult = { reason: 'hook_blocked', iterations: 0 };
        events?.onTerminal?.(result);
        return result;
      }
      // Inject additionalContext into user message
      if (hookResult.additionalContext) {
        (userMessage as { content: string }).content =
          (userMessage.content as string) + '\n\n' + hookResult.additionalContext;
      }
    }
  } catch { /* non-fatal: hook failure does not block prompt */ }

  history.push(userMessage);

  // ── Layer 4: Session Memory Update ─────────────────────────────────────────
  updateSessionMemory(history);
  const smCompacted = trySessionMemoryCompaction(history, onChunk);
  if (smCompacted) {
    await triggerHook(createHookEvent('agent', 'compact', { compacted: -1, layer: 4 }));
  }

  // ── Layer 5: Auto-compact ───────────────────────────────────────────────────
  // G12: applyToolResultBudget — 在 autoCompact 前先按预算截断工具结果
  // 防止超大工具结果（如读取 200KB 文件）一次性消耗大量 context。
  // 预算 = 40% of context window，从最新消息向前遍历，超出预算部分截断。
  const _currentModel = modelManager.getCurrentModel('main');
  {
    const _profile = [...modelManager.listProfiles()].find(
      (p) => p.name === _currentModel || p.modelName === _currentModel,
    );
    const _ctxWindow = _profile?.contextLength ?? 128_000;
    const TOOL_RESULT_BUDGET_TOKENS = Math.floor(_ctxWindow * 0.4);
    let _toolBudgetUsed = 0;
    // 从最新消息向前遍历：先累计最新工具结果，超出 budget 的旧结果才截断
    for (let _i = history.length - 1; _i >= 0; _i--) {
      const _msg = history[_i]!;
      if (_msg.role !== 'tool') continue;
      const _content = typeof _msg.content === 'string' ? _msg.content : JSON.stringify(_msg.content);
      const _tokens = Math.ceil(_content.length / 4);
      _toolBudgetUsed += _tokens;
      if (_toolBudgetUsed > TOOL_RESULT_BUDGET_TOKENS) {
        // 超出 budget：截断此条旧工具结果（保留最新的）
        const _allowedChars = Math.max(200, Math.floor((_tokens - (_toolBudgetUsed - TOOL_RESULT_BUDGET_TOKENS)) * 4));
        if (_content.length > _allowedChars) {
          (_msg as unknown as { content: string }).content =
            _content.slice(0, _allowedChars) +
            `\n...[truncated by token budget, ${_content.length - _allowedChars} chars omitted]`;
        }
      }
    }
  }

  // G12: A12 blocking 拦截 — context 已满时直接停止，不发起新 LLM 调用
  // D21: 扣减 snipTokensFreed 避免 snip 后 stale token 计数错误触发 blocking_limit
  // Mirrors claude-code query.ts L638: tokenCountWithEstimation(messagesForQuery) - snipTokensFreed
  const _snipResult = snipCompactIfNeeded(history, _currentModel);
  if (_snipResult.tokensFreed > 0) {
    history.splice(0, history.length, ..._snipResult.messages);
    onChunk(`\n  HistorySnip: freed ~${_snipResult.tokensFreed} tokens (${_snipResult.messages.length} messages remain)\n`);
    // B35-1: HistorySnip CTX_COMPACT 日志
    try {
      const _afterSnip = estimateHistoryTokens(history);
      _onCtxEvent?.({ type: 'compact', compactType: 'snip', before: _afterSnip + _snipResult.tokensFreed, after: _afterSnip, msgsBefore: history.length + (_snipResult.messages.length - history.length), msgsAfter: history.length });
    } catch { /* B35: fail-open */ }
  }
  const _adjustedBlockingTokens = Math.max(0, estimateHistoryTokens(history) - _snipResult.tokensFreed);
  const _warningState = calculateTokenWarningState(_adjustedBlockingTokens, _currentModel);
  // B35-2: CTX_WARNING 日志（在调用前记录一次初始状态）
  try {
    const _ctxProfile = [...modelManager.listProfiles()].find(
      (p) => p.name === _currentModel || p.modelName === _currentModel,
    );
    const _ctxWindow = _ctxProfile?.contextLength ?? 128000;
    const _pct = _ctxWindow > 0 ? Math.round((_adjustedBlockingTokens / _ctxWindow) * 100) : 0;
    _onCtxEvent?.({ type: 'warning', state: _warningState === 'blocking' ? 'blocking' : _warningState === 'warning' ? 'warning' : 'ok', est: _adjustedBlockingTokens, ctx: _ctxWindow, pct: _pct });
  } catch { /* B35: fail-open */ }
  if (_warningState === 'blocking') {
    onChunk(`\n[SYSTEM] Context window critical (${_adjustedBlockingTokens.toLocaleString()} tokens after snip adjustment) — stopping to prevent prompt_too_long error.\n`);
    // B13: blocking_limit 终止
    const result: StreamLoopResult = { reason: 'blocking_limit', iterations: 0, tokensEstimated: _adjustedBlockingTokens };
    events?.onTerminal?.(result);
    return result;
  }

  // C13: PostCompactContext — 传给 autoCompact，压缩后重注入 MCP 工具和 agent 列表
  // 这里通过 opts.registry 和 opts 推断可注入的上下文
  // F15: 提前判断是否是子代理（穿讻e _isSubAgent 被下面重复定义但应一致）
  const _isSubAgentCtx = !!(opts as unknown as Record<string, unknown>).isSubAgent;
  const _postCompactCtx: import('../context/context-compressor.js').PostCompactContext = {
    mcpToolsSummary: undefined,      // 由调用 runStreamLoop 的 AgentCore 填充（目前占位）
    agentListingSummary: undefined,
    reFireSessionStartHooks: false,
    querySource: _isSubAgentCtx ? 'agent' : 'repl_main_thread',  // E25/F15: 主线程和子代理区分缓存清理范围
  };

  // H15: 将 snipTokensFreed 传入 autoCompact，防止在 snip 后立即重复触发
  const compacted = await autoCompact(history, onChunk, _postCompactCtx, _snipResult.tokensFreed);
  if (compacted.wasCompacted) {
    await triggerHook(createHookEvent('agent', 'compact', { compacted: compacted.compactedTurns }));
    if (compacted.isRecompactionInChain) {
      onChunk(`  Warning: rapid re-compaction detected (chain compaction).\n`);
    }
    // B35-3: autoCompact CTX_COMPACT 日志
    try {
      const _afterCompact = estimateHistoryTokens(history);
      _onCtxEvent?.({ type: 'compact', compactType: 'auto', before: compacted.preTokens ?? (_afterCompact + 1), after: _afterCompact, msgsBefore: compacted.compactedTurns ?? history.length, msgsAfter: history.length });
    } catch { /* B35: fail-open */ }
    // E22: taskBudget cross-compact tracking (claude-code query.ts L508-514 parity)
    // 在每次 compact 后更新 _taskBudgetRemaining（累减 preCompact token 消耗）
    // 防止 compact 后 taskBudget 仍然计算压缩前的 token 消耗。
    if (_taskBudget && compacted.preTokens !== undefined) {
      _taskBudgetRemaining = Math.max(
        0,
        (_taskBudgetRemaining ?? _taskBudget.total) - compacted.preTokens,
      );
    }
  }

  // session:start fires only on the first turn (before this call, history was empty)
  if (_initialHistoryLen === 0) {
    await triggerHook(createHookEvent('session', 'start', {
      domain,
      model: modelManager.getCurrentModel('main'),
    }));
  }

  let iteration = 0;
  let _ptlRetryCount = 0; // PTL retry counter — local to this invocation, never stored on opts
  let lastLLMCallAt = 0;
  const MAX_ITERATIONS = parseInt(process.env.AGENT_MAX_ITERATIONS ?? String(DEFAULT_MAX_ITERATIONS), 10);
  // C21: maxTurns 外部注入参数 (claude-code query.ts L191 parity)
  // 调用方可通过 opts.maxTurns 注入，优先于环境变量 AGENT_MAX_ITERATIONS
  const _externalMaxTurns = (opts as unknown as Record<string, unknown>).maxTurns as number | undefined;
  const _effectiveMaxTurns = _externalMaxTurns ?? MAX_ITERATIONS;

  // B13: 记录终止原因，默认 'completed'
  let _terminalReason: TerminalReason = 'completed';
  // B14: 追踪最后一次 continue 的原因（测试可观测性，对标 claude-code State.transition）
  let _lastTransition: ContinueTransition | undefined;
  // B15: maxOutputTokens Phase-0 Escalation 状态变量
  let _maxOutputTokensOverride: number | undefined; // Phase-0 设置为 ESCALATED_MAX_TOKENS
  let _motRecoveryCount = 0;                         // Phase-1~3 恢复次数计数器

  // D20: hasAttemptedReactiveCompact — 防 413 reactive compact 无限循环
  // Mirrors claude-code State.hasAttemptedReactiveCompact in query.ts L1070
  // Once set true, a second 413 will not trigger another compact (prevents infinite loop).
  // Reset to false after a successful non-error LLM turn.
  let _reactiveCompactAttempted = false;

  // F20: stopHookActive — cross-iteration State carry for stop hook防死循环
  // Mirrors claude-code State.stopHookActive in query.ts L1300 + stopHooks.ts L184.
  // When true (stop hook fired blocking errors last iteration), skip stop hook this iteration.
  let _stopHookActive = false;

  // A20: PTL withheld mechanism — store PTL error for deferred reactive compact recovery
  // Mirrors claude-code query.ts "withheld" isWithheld413 pattern.
  // When set: next iteration triggers reactiveCompact instead of a fresh LLM call.
  let _withheldPtlError: Error | null = null;
  // A20: skip stop hooks after PTL terminal (prevents stop hook triggering new tool calls → new PTL)
  let _skipStopHooks = false;

  // ── Token Budget Tracker (Round 5: claude-code tokenBudget.ts parity) ────────
  // Tracks per-turn token usage to detect diminishing returns and enforce budget.
  // Sub-agents (spawned via SpawnAgent/CoordinatorTool) bypass budget entirely.
  const _budgetTracker = createBudgetTracker();
  const _isSubAgent = !!(opts as unknown as Record<string, unknown>).isSubAgent;
  const _tokenBudget = process.env.AGENT_TOKEN_BUDGET
    ? parseInt(process.env.AGENT_TOKEN_BUDGET, 10)
    : null;

  const unattendedRetry = process.env.AGENT_UNATTENDED_RETRY === '1';
  let unattendedRetryCount = 0;
  const MAX_UNATTENDED_RETRIES = parseInt(
    process.env.AGENT_MAX_UNATTENDED_RETRIES ?? String(DEFAULT_MAX_UNATTENDED_RETRIES), 10);
  const UNATTENDED_RETRY_DELAY_MS = Math.min(
    parseInt(process.env.AGENT_UNATTENDED_RETRY_DELAY_MS ?? String(DEFAULT_UNATTENDED_RETRY_DELAY_MS), 10),
    MAX_UNATTENDED_RETRY_DELAY_MS,
  );

  let roundsWithoutTodo = 0;
  const teamMgr = getTeammateManager(process.cwd());

  // B18: Cross-iteration tool summary Promise (claude-code State.pendingToolUseSummary parity)
  // Fires summary generation as a Promise after tool batch; awaited before the next LLM call.
  // Two things happen in parallel: previous iteration generates summary, next iteration awaits.
  let _pendingToolUseSummaryPromise: Promise<string | null> | undefined;

  // A19: Extract abortSignal from opts for use throughout the loop
  const _abortSignal = opts.abortSignal;

  // Outer unattended-retry loop
  let _unattendedDone = false;
  // B13: _earlyExit — 在嵌套循环中（工具执行）需要提前终止函数时使用
  let _earlyExit = false;
  while (!_unattendedDone) {
    _unattendedDone = true;

    while (iteration < MAX_ITERATIONS) {
      iteration++;

      // ── A19: AbortSignal check — detect cancellation at the start of each iteration ──
      // Mirrors claude-code query.ts signal.aborted checks at iteration boundaries.
      // Exits cleanly with 'aborted' reason rather than throwing an error.
      if (_abortSignal?.aborted) {
        // B26: InterruptMessage — inject into history so LLM can see why we stopped.
        // Mirrors claude-code messages.ts createUserInterruptionMessage() L545-560.
        // Only inject when reason is NOT 'interrupt' (new prompt submitted — user intent is clear).
        if (_abortSignal.reason !== 'interrupt' && history.length > 0) {
          const lastMsg = history[history.length - 1];
          const toolsWereRunning = lastMsg?.role === 'tool' ||
            (lastMsg?.role === 'assistant' && Array.isArray((lastMsg as unknown as Record<string, unknown>)['toolCalls']));
          const interruptContent = toolsWereRunning
            ? INTERRUPT_MESSAGE_FOR_TOOL_USE
            : INTERRUPT_MESSAGE;
          history.push({ role: 'user', content: interruptContent, isMeta: true });
        }
        _terminalReason = 'aborted';
        _earlyExit = true;
        break;
      }

      // ── A20: withheld PTL recovery — reactive compact before next LLM call ──────
      // Mirrors claude-code query.ts "withheld" isWithheld413 pattern (L1065-1095).
      // When a PTL error was withheld in the previous iteration, attempt reactiveCompact
      // BEFORE making a new LLM call. This avoids immediately surfacing the error to user.
      //
      // If reactiveCompact succeeds: clear withheld error, continue with compacted history.
      // If reactiveCompact fails (or already attempted): surface the error, terminal.
      if (_withheldPtlError) {
        if (!_reactiveCompactAttempted) {
          _reactiveCompactAttempted = true;
          onChunk(`\n  PTL recovery: attempting reactive compact before retry…\n`);
          try {
            const recovered = await reactiveCompact(history, onChunk);
            if (recovered) {
              _withheldPtlError = null;
              _lastTransition = { reason: 'reactive_compact_retry' };
              onChunk('  Reactive compact succeeded — retrying with compacted context…\n');
              // B35-4: PTL reactiveCompact CTX_COMPACT 日志
              try {
                const _afterRC = estimateHistoryTokens(history);
                _onCtxEvent?.({ type: 'compact', compactType: 'reactive', before: _afterRC + 10000, after: _afterRC, msgsBefore: history.length, msgsAfter: history.length });
              } catch { /* B35: fail-open */ }
              continue; // retry LLM with compacted history
            }
          } catch { /* reactiveCompact failure → fall through to terminal */ }
        }
        // A20: reactive compact failed or already attempted — surface withheld error
        // A20: skip stop hooks to prevent stop hook → new tool calls → new PTL (dead loop)
        _skipStopHooks = true;
        onChunk(`\n  PTL recovery failed: ${_withheldPtlError?.message ?? 'unknown error'}\n`);
        _withheldPtlError = null;
        _terminalReason = 'prompt_too_long';
        _earlyExit = true;
        break;
      }

      // ── D20: Reset reactiveCompact防循环标志 after a successful (non-error) LLM turn ──
      // Only reset once per normal-completion iteration to avoid marking compact as "used" prematurely.
      // The flag is set in the 413/PTL error handler below.

      // ── H19: formatInterruptReason — structured reason for aborted tool operations ──
      // Mirrors claude-code interruptSignalReason() in query.ts.
      // Allows downstream observers (tests, UI) to distinguish user cancel vs timeout.
      const _formatInterruptReason = (signal: AbortSignal | undefined): string => {
        if (!signal?.aborted) return 'Operation aborted';
        const reason = signal.reason;
        if (reason === 'user_interrupt' || (typeof reason === 'string' && /interrupt|cancel/i.test(reason))) {
          return 'User cancelled operation';
        }
        if (reason === 'timeout' || (typeof reason === 'string' && /timeout/i.test(reason))) {
          return 'Operation timed out';
        }
        return typeof reason === 'string' ? `Operation aborted: ${reason}` : 'Operation aborted';
      };
      // Summary was fire-and-forget fired at end of previous iteration.
      // Await it NOW (before LLM call) and inject as user message if available.
      if (_pendingToolUseSummaryPromise) {
        try {
          const summary = await _pendingToolUseSummaryPromise;
          if (summary) {
            history.push({ role: 'user', content: `<tool-summaries>\n${summary}\n</tool-summaries>` });
          }
        } catch { /* non-fatal */ } finally {
          _pendingToolUseSummaryPromise = undefined;
        }
      }

      // ── Min-round-interval throttle ──────────────────────────────────────────
      const _minInterval = parseInt(process.env.AGENT_MIN_ROUND_INTERVAL_MS ?? '500', 10);
      if (_minInterval > 0 && lastLLMCallAt > 0) {
        const _elapsed = Date.now() - lastLLMCallAt;
        if (_elapsed < _minInterval) {
          await new Promise((resolve) => setTimeout(resolve, _minInterval - _elapsed));
        }
      }

      // s08 — drain background task notifications
      const bgNotifs = backgroundManager.drainNotifications();
      if (bgNotifs.length > 0) {
        const notifText = bgNotifs
          .map((n) => `[bg:${n.taskId}] ${n.status}: ${n.result}`)
          .join('\n');
        history.push({
          role: 'user',
          content: `<background-results>\n${notifText}\n</background-results>`,
        });
      }

      // s09 — drain lead inbox
      const inboxMsgs = teamMgr.bus.readInbox('lead');
      if (inboxMsgs.length > 0) {
        history.push({
          role: 'user',
          content: `<inbox>\n${JSON.stringify(inboxMsgs)}\n</inbox>`,
        });
      }

      // Context editing
      const cleared = editContextIfNeeded(history);
      if (cleared > 0) {
        // C34: 展示被清除工具的名称列表，帮助用户了解哪些信息被释放
        const clearedNames = (editContextIfNeeded as { lastClearedToolNames?: string[] }).lastClearedToolNames;
        const namesSuffix = clearedNames && clearedNames.length > 0
          ? ` (${clearedNames.join(', ')}) — re-run tools if needed`
          : ' to free context space';
        onChunk(`\n✂️  Cleared ${cleared} old tool result(s)${namesSuffix}\n`);
        // B35-5: editContextIfNeeded CTX_CLEAR 日志
        try {
          const _estBefore = estimateHistoryTokens(history);
          const _freed = clearedNames ? cleared * 3000 : 0; // 粗估
          _onCtxEvent?.({
            type: 'clear',
            count: cleared,
            tokensFreed: _freed,
            toolNames: clearedNames ?? [],
            estimatedBefore: _estBefore + _freed,
          });
        } catch { /* B35: fail-open */ }
      }

      await triggerHook(createHookEvent('agent', 'turn', {
        iteration,
        model: modelManager.getCurrentModel('main'),
      }));

      // Fire plugin pre_prompt hooks — allow plugins to augment system prompt
      try {
        const { getPluginHooks } = await import('../domain-router.js');
        const prePromptHooks = getPluginHooks('pre_prompt');
        for (const hook of prePromptHooks) {
          if (hook.handler) {
            const result = await hook.handler({ systemPrompt, iteration }).catch(() => undefined);
            if (typeof result === 'string' && result.length > 0) {
              systemPrompt = systemPrompt + '\n\n' + result;
            }
          }
        }
      } catch { /* plugin hooks are non-fatal */ }

      const currentTools = registry.getToolDefinitions();
      // I15: 注入 registry 到 globalThis，供 ToolSearchTool 访问
      (globalThis as Record<string, unknown>)['__uagent_tool_registry'] = registry;
      const _lastUserRaw = [...history].reverse().find((m) => m.role === 'user')?.content ?? prompt;
      const lastUserMsg: string = typeof _lastUserRaw === 'string'
        ? _lastUserRaw
        : Array.isArray(_lastUserRaw)
          ? _lastUserRaw.map((b: import('../../models/types.js').ContentBlock) => typeof b === 'string' ? b : '').join('')
          : prompt;
      const tools = await selectTools(currentTools, lastUserMsg, history);

      let response;
      const _llmCallStart = Date.now();
      // D35/B35: LLM_REQ 日志 — 在每轮 LLM 调用前触发 llm_req 事件
      try {
        const _estForReq = estimateHistoryTokens(history);
        _onCtxEvent?.({
          type: 'llm_req',
          iteration,
          historyLen: history.length,
          estimatedTokens: _estForReq,
          toolCount: tools?.length ?? 0,
          model: modelManager.getCurrentModel('main'),
        });
      } catch { /* D35: fail-open */ }
      // ── StreamingToolExecutor: eagerly execute read-only tools during streaming ──
      // Mirrors claude-code's StreamingToolExecutor.  Create a new executor per
      // iteration (reset state).  The executor is fed tool call deltas via
      // onToolCallDelta callback as the LLM streams them out; read-only tools
      // (in PARALLELIZABLE_TOOLS) are submitted immediately when their JSON is
      // complete, without waiting for the full LLM stream to finish.
      let _streamingExecutor: import('./streaming-tool-executor.js').StreamingToolExecutor | null = null;
      try {
        const { StreamingToolExecutor } = await import('./streaming-tool-executor.js');
        _streamingExecutor = new StreamingToolExecutor(registry);
      } catch { /* streaming executor unavailable — fall back to sequential */ }

      const onToolCallDelta = _streamingExecutor
        ? (idx: number, name: string, delta: string, id?: string) => {
            _streamingExecutor!.onToolCallChunk(idx, name, delta, id);
          }
        : undefined;
      try {
        const chatOpts = {
          systemPrompt,
          messages: history,
          tools,
          stream: true,
          // Round 7: ultrathink keyword overrides thinkingLevel to max budget
          thinkingLevel: _ultrathinkActive ? 'max' as const : thinkingLevel,
          onToolCallDelta,
          // A19: Propagate AbortSignal to LLM call (claude-code toolUseContext.abortController.signal parity)
          // Allows HTTP fetch to be cancelled when user interrupts with Ctrl+C
          signal: _abortSignal,
          // E22: taskBudget — 透传 API task_budget（claude-code query.ts L699-706 parity）
          // 携带 total + remaining（compact 后递减），服务端用于精确预算控制。
          ...(_taskBudget
            ? {
                taskBudget: {
                  total: _taskBudget.total,
                  ...(_taskBudgetRemaining !== undefined ? { remaining: _taskBudgetRemaining } : {}),
                },
              }
            : {}),
        };
        response = fallbackChain
          ? await withApiRetry(
              () => fallbackChain!.callStream(getLLM(), chatOpts, onChunk),
              (msg) => onChunk(msg),
            )
          : await withApiRetry(
              () => getLLM().streamChat(chatOpts, onChunk),
              (msg) => onChunk(msg),
            );
        lastLLMCallAt = Date.now();
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // Record failed call
        sessionMetrics.record({
          model: modelManager.getCurrentModel('main'),
          durationMs: Date.now() - _llmCallStart,
          inputTokens: 0,
          outputTokens: 0,
          success: false,
          error: errMsg.slice(0, 120),
        });
        const isContextOverflow = /413|context.{0,30}(overflow|limit|length|window)|too.{0,10}(long|large|many.{0,10}token)|maximum.{0,20}(context|length)/i.test(errMsg);
        const isPromptTooLong = /prompt_too_long|PROMPT_TOO_LONG|PromptTooLong/i.test(errMsg);

        // ── PTL Retry (Round 5: claude-code PTL retry parity) ─────────────
        // When the LLM explicitly returns a "prompt_too_long" error (as opposed
        // to a general 413), truncate the oldest message group from history and
        // retry — up to MAX_PTL_RETRIES times before giving up.
        if (isPromptTooLong) {
          const MAX_PTL_RETRIES = 3;

          // A13: withheld 机制 — PTL 是可恢复错误，先扣留再尝试恢复
          events?.onWithheld?.('prompt_too_long');

          if (_ptlRetryCount < MAX_PTL_RETRIES) {
            _ptlRetryCount++;
            // Remove oldest 2 messages (one user+assistant pair)
            const removeCount = Math.min(2, Math.max(0, history.length - 3));
            if (removeCount > 0) {
              history.splice(0, removeCount);
              // A13: 恢复成功 — 不向用户输出错误，只输出轻量提示
              events?.onRecovered?.('prompt_too_long');
              onChunk(`\n  Prompt too long — truncating oldest ${removeCount} message(s) and retrying (attempt ${_ptlRetryCount}/${MAX_PTL_RETRIES})…\n`);
              history.push(createTombstone(history.length) as unknown as Message);
              // B14: 记录 continue 原因
              _lastTransition = { reason: 'ptl_retry', attempt: _ptlRetryCount };
              continue;
            }
          }
          // A13: 恢复失败 — A20: withheld 模式：扣押 PTL 错误供下轮 reactive compact 处理
          // Mirrors claude-code query.ts "isWithheld413" pattern (L1065-1095).
          // Instead of immediately surfacing the error, store it and attempt reactiveCompact next iteration.
          events?.onWithheld?.('prompt_too_long');
          history.push(createTombstone(history.length) as unknown as Message);
          if (!_reactiveCompactAttempted) {
            _withheldPtlError = err instanceof Error ? err : new Error(String(err));
            onChunk(`\n  Prompt too long — withheld, will attempt reactive compact on next iteration…\n`);
            _lastTransition = { reason: 'ptl_retry', attempt: MAX_PTL_RETRIES + 1 };
            continue; // A20: triggers withheld PTL recovery path at top of next iteration
          }
          onChunk(`\n  Prompt too long and max PTL retries (${MAX_PTL_RETRIES}) reached.\n`);
          _terminalReason = 'prompt_too_long';
          break;
        }

        if (isContextOverflow) {
          // A13: context overflow 是可恢复错误，先扣留再尝试恢复
          events?.onWithheld?.('context_overflow');
          onChunk(`\n  Context overflow detected — attempting reactive compact…\n`);
          // ── Tombstone: clear partial streaming messages before retry ────────
          history.push(createTombstone(history.length) as unknown as Message);
          // D20: hasAttemptedReactiveCompact — 防 413 无限循环（对标 claude-code query.ts L1070）
          if (_reactiveCompactAttempted) {
            onChunk('  Already attempted reactive compact this session — surfacing error.\n');
          } else {
            _reactiveCompactAttempted = true;
            const recovered = await reactiveCompact(history, onChunk);
            if (recovered) {
              // A13: 恢复成功 — 不向用户显示错误，继续正常流
              events?.onRecovered?.('context_overflow');
              onChunk('  Retrying with compacted context…\n');
              // B14: 记录 continue 原因
              _lastTransition = { reason: 'context_overflow_retry' };
              continue;
            }
          }
        }
        // ── Tombstone on any LLM error (not just context overflow) ──────────
        // Ensures UI cleans up partial renders from failed stream attempts.
        history.push(createTombstone(history.length) as unknown as Message);
        onChunk(`\n  LLM error: ${errMsg}\n`);
        _terminalReason = 'model_error';
        break;
      }

      // Track token usage + metrics; also attach usage to last assistant message
      // so countTokensFromHistory() can use precise counts without extra API calls
      {
        const rawUsage = ((response as unknown as Record<string, unknown>).usage ?? {}) as {
          input_tokens?: number; output_tokens?: number;
          prompt_tokens?: number; completion_tokens?: number;
          cache_creation_input_tokens?: number; cache_read_input_tokens?: number;
          web_search_requests?: number;
        };
        const rawId = ((response as unknown as Record<string, unknown>).id as string | undefined);
        const inputTokens  = rawUsage.input_tokens  ?? rawUsage.prompt_tokens  ?? 0;
        const outputTokens = rawUsage.output_tokens ?? rawUsage.completion_tokens ?? 0;
        const cacheReadTokens  = rawUsage.cache_read_input_tokens       ?? 0;
        const cacheWriteTokens = rawUsage.cache_creation_input_tokens   ?? 0;
        const webSearchRequests = rawUsage.web_search_requests ?? 0;

        modelManager.recordUsage(
          { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, webSearchRequests },
          modelManager.getCurrentModel('main'),
        );
        sessionMetrics.record({
          model: modelManager.getCurrentModel('main'),
          durationMs: Date.now() - _llmCallStart,
          inputTokens,
          outputTokens,
          success: true,
        });

        // Attach usage + messageId to last assistant message in history for
        // token counting (mirrors claude-code's AssistantMessage.usage pattern)
        if (inputTokens > 0 || outputTokens > 0) {
          const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant');
          if (lastAssistant) {
            lastAssistant.usage = {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              cache_creation_input_tokens: rawUsage.cache_creation_input_tokens,
              cache_read_input_tokens: rawUsage.cache_read_input_tokens,
            };
            if (rawId) lastAssistant.messageId = rawId;
          }
        }

        // D26: ContextWindowUsage — pass API usage (including cache tokens) to StatusBar
        // Mirrors claude-code calculateContextPercentages() src/utils/context.ts L118-144.
        // totalInputTokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
        if (inputTokens > 0) {
          const totalInputTokens = inputTokens + cacheWriteTokens + cacheReadTokens;
          try {
            const { updateStatusBar } = await import('../../cli/statusbar.js');
            updateStatusBar({
              apiTokensUsed: totalInputTokens,
              cacheCreationTokens: cacheWriteTokens,
              cacheReadTokens: cacheReadTokens,
            });
          } catch { /* non-fatal: StatusBar update is best-effort */ }
          // B35-6: CTX_API_USAGE 日志（API token 完整统计）
          try {
            const _histEst = estimateHistoryTokens(history);
            _onCtxEvent?.({
              type: 'api_usage',
              iteration,
              input: inputTokens,
              output: outputTokens,
              cacheWrite: cacheWriteTokens,
              cacheRead: cacheReadTokens,
              totalInput: totalInputTokens,
              histEst: _histEst,
            });
          } catch { /* B35: fail-open */ }
        }
      }

      if (response.type === 'text') {
        const content = response.content;

        // ── B15: maxOutputTokens Phase-0 + Phase-1~3 恢复（claude-code ESCALATED_MAX_TOKENS 对标）
        // Phase 0: 以 ESCALATED_MAX_TOKENS=64k 无声重试（不注入任何 meta 消息）
        // Phase 1-3: 注入 recovery 消息，最多 3 次
        const finishReason = (response as unknown as Record<string, unknown>)['finish_reason'] as string | undefined;
        const apiError = (response as unknown as Record<string, unknown>)['apiError'] as string | undefined;
        if (isWithheldMaxOutputTokens(content, finishReason, apiError)) {
          if (_maxOutputTokensOverride === undefined && _motRecoveryCount === 0) {
            // Phase 0: 静默 escalate 到 64k，不注入任何 meta 消息
            _maxOutputTokensOverride = ESCALATED_MAX_TOKENS;
            onChunk(`\n  max_output_tokens 检测到 — Phase-0: 升级到 ${ESCALATED_MAX_TOKENS.toLocaleString()} tokens 重试…\n`);
            _lastTransition = { reason: 'max_output_tokens_escalate' };
            events?.onWithheld?.('max_output_tokens');
            continue;
          }
          _maxOutputTokensOverride = undefined; // Phase 0 应用一次后重置
          if (_motRecoveryCount < MAX_CONTINUATION_RETRIES) {
            _motRecoveryCount++;
            // Phase 1~3: 将部分内容写入 history 并注入 recovery 消息
            history.push({ role: 'assistant', content });
            history.push({
              role: 'user',
              content: 'Output token limit hit. Resume directly where you left off without repeating any previous content.',
            });
            onChunk(`\n↩️  Output token limit hit — requesting recovery (attempt ${_motRecoveryCount}/${MAX_CONTINUATION_RETRIES})…\n`);
            _lastTransition = { reason: 'max_output_tokens_recovery', attempt: _motRecoveryCount };
            events?.onWithheld?.('max_output_tokens');
            continue;
          } else {
            // Phase 4: 最大次数达到 — 向用户展示错误
            onChunk(`\n⚠️  Response was truncated and ${MAX_CONTINUATION_RETRIES} recovery attempts failed. The response may be incomplete.\n`);
            history.push({ role: 'assistant', content });
            break;
          }
        }
        // 返回正常内容 — 重置所有 maxOutputTokens 计数器
        _maxOutputTokensOverride = undefined;
        _motRecoveryCount = 0;
        // D20: 成功 LLM 调用后重置 reactive compact 防循环标志
        // Allows future 413 recovery after a normal completion (not infinite prevention).
        _reactiveCompactAttempted = false;

        // Confidence mechanism (kstack article #15310)
        const uncertainPattern = /\[UNCERTAIN\]|⚠️\s*\[UNCERTAIN\]/gi;
        const lines = content.split('\n');
        for (const line of lines) {
          if (uncertainPattern.test(line)) {
            uncertainItems.push(line.trim().replace(/^[\-*>]+\s*/, ''));
          }
        }

        if (uncertainItems.length > 0) {
          const checklist = uncertainItems
            .map((item, i) => `  ${i + 1}. ${item}`)
            .join('\n');
          onChunk(`\n\n---\n⚠️  **Pending Confirmations** (items marked [UNCERTAIN]):  \n${checklist}\n---\n`);
          uncertainItems.length = 0;
        }

        history.push({ role: 'assistant', content });

        // ── Token Budget Check (Round 5: claude-code tokenBudget.ts parity) ──
        // After a text response is committed, check if we've used too many tokens.
        // Diminishing returns: if the model keeps adding tiny increments → stop.
        // Use turn-level token count from the last recorded usage.
        const _lastUsage = (() => {
          const last = [...history].reverse().find((m) => m.role === 'assistant' && m.usage);
          return last?.usage ?? null;
        })();
        const _turnTokens = _lastUsage
          ? (_lastUsage.input_tokens ?? 0) + (_lastUsage.output_tokens ?? 0)
          : 0;
        if (_turnTokens > 0 || _tokenBudget !== null) {
          const _budgetDecision = checkTokenBudget(
            _budgetTracker,
            _turnTokens,
            _tokenBudget,
            _isSubAgent,
          );
          if (_budgetDecision.action === 'stop' && _budgetDecision.reason !== 'sub_agent') {
            const _stopReason = _budgetDecision.reason as 'budget_exhausted' | 'diminishing_returns';
            const stopMsg = buildBudgetStopMessage(_stopReason);
            onChunk(`\n${stopMsg}\n`);
            _terminalReason = 'budget_exhausted';
            break;
          } else if (_budgetDecision.action === 'continue') {
            const _nudge = (_budgetDecision as { action: 'continue'; nudgeMessage?: string }).nudgeMessage;
            if (_nudge) {
              history.push({ role: 'user', content: _nudge });
              continue;
            }
          }
        }

        // ── C15: Stop Hook Blocking Errors → Continue 循环（claude-code stopHooks.ts 对标）
        // Fires after each successful AI text reply, before breaking the loop.
        // 如果 Stop Hook 返回 blockingErrors → 注入 history，继续 LLM 调用。
        // 如果 Stop Hook 返回 preventContinuation=true → 终止循环（hook_stopped）。
        // F20: _stopHookActive 字段防止 Stop Hook 触发新一轮 stop hook 形成无限循环
        // (claude-code State.stopHookActive + stopHooks.ts L184 parity)
        // A20: _skipStopHooks — PTL terminal 后跳过 stop hooks（防 hook 触发新工具调用 → 新 PTL）
        if (!_isSubAgent && !_skipStopHooks) {
          try {
            const { getHookRunner: _getStopHookRunner } = await import('../hooks.js');
            const _stopRunner = _getStopHookRunner(process.cwd());
            if (_stopRunner.hasHooksFor('agent_stop')) {
              // F20: 若上轮已触发过 stop hook blocking，本轮跳过（防死循环）
              if (_stopHookActive) {
                _stopHookActive = false; // 重置，让下轮正常触发
                break; // 跳过 stop hook，正常完成
              }
              const _lastMsg = history[history.length - 1];
              const _lastContent = _lastMsg?.role === 'assistant'
                ? (typeof _lastMsg.content === 'string' ? _lastMsg.content : '')
                : '';
              // C15: 收集 blocking errors（run() 返回的 blockingErrors 字段）
              const _blockingErrors: import('../../models/types.js').Message[] = [];
              let _preventContinuation = false;
              try {
                const _hookResult = await _stopRunner.run({
                  event: 'agent_stop',
                  stopHookActive: true,
                  lastAssistantMessage: _lastContent.slice(0, 2000),
                  cwd: process.cwd(),
                });
                const _hr = _hookResult as unknown as Record<string, unknown> | undefined;
                if (_hr?.preventContinuation === true) {
                  _preventContinuation = true;
                } else if (Array.isArray(_hr?.blockingErrors) && (_hr.blockingErrors as unknown[]).length > 0) {
                  _blockingErrors.push(...(_hr.blockingErrors as import('../../models/types.js').Message[]));
                }
              } catch { /* hook run non-fatal */ }

              if (_blockingErrors.length > 0) {
                // C15: 将 blocking errors 注入 history，继续 LLM 调用
                history.push(..._blockingErrors);
                // F20: 设置 _stopHookActive = true，防止下一轮 stop hook 再次触发造成死循环
                _stopHookActive = true;
                _lastTransition = { reason: 'stop_hook_blocking' };
                continue; // 重新进入主循环
              }
              if (_preventContinuation) {
                _terminalReason = 'hook_stopped';
                break;
              }
            }
          } catch { /* agent_stop hook failure is non-fatal */ }
        }

        break;
      }

      if (response.type === 'tool_calls') {
        if (verbose) {
          onChunk(`\n🔧 Tools: ${response.toolCalls.map((t) => t.name).join(', ')}\n`);
        }

        history.push({
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls,
        });

        const toolResults: Message[] = [];
        const MAX_PARALLEL_TOOLS = 5;
        const allParallelizable = response.toolCalls.every((c) => PARALLELIZABLE_TOOLS.has(c.name));
        const canParallelize = allParallelizable && response.toolCalls.length > 1;

        // ── StreamingToolExecutor: drain pre-executed results ──────────────
        // If the streaming executor already started executing some tools
        // during the LLM stream, finalize remaining tool calls and collect.
        // This means many read-only tools already have results ready.
        let preExecutedResults: Map<string, string> | null = null;
        if (_streamingExecutor && allParallelizable) {
          try {
            for (let i = 0; i < response.toolCalls.length; i++) {
              const call = response.toolCalls[i];
              _streamingExecutor.finalizeToolCall(
                i, call.name,
                JSON.stringify(call.arguments),
                call.id,
              );
            }
            const drainResults = await _streamingExecutor.drainAndCollect();
            preExecutedResults = new Map(drainResults.map((r) => [r.toolCallId, r.content]));
          } catch { /* drain failure is non-fatal — fall back to normal execution */ }
        }

        const runCall = async (call: (typeof response.toolCalls)[0]) => {
          // ── StreamingToolExecutor: use pre-executed result if available ──
          // If this tool was already executed during LLM streaming, return
          // the cached result immediately without re-executing.
          if (preExecutedResults?.has(call.id)) {
            const preResult = preExecutedResults.get(call.id)!;
            events?.onToolStart?.(call.name, call.arguments as Record<string, unknown>);
            events?.onToolResult?.(call.name, preResult);
            events?.onToolEnd?.(call.name, true, 0);
            return { role: 'tool' as const, toolCallId: call.id, content: preResult };
          }

          events?.onToolStart?.(call.name, call.arguments as Record<string, unknown>);
          const callId = `${call.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          const toolStartMs = Date.now();
          await triggerHook(createHookEvent('tool', 'before', { callId, toolName: call.name, args: call.arguments }));

          // ── ApprovalMode enforcement (Round 4: claude-code parity) ──────────
          // Check permission rules before hooks. In yolo mode, bypass entirely.
          // In autoEdit mode, write tools that are not in alwaysAllow still prompt.
          const permMgr = getPermissionManager(process.cwd());

          // F19: backfillObservableInput — expand relative paths BEFORE permission check and hooks.
          // Mirrors claude-code Tool.backfillObservableInput():
          //   "Called on copies of tool_use input before observers see it.
          //    The original API-bound input is never mutated (preserves prompt cache)."
          let _observableArgs = call.arguments as Record<string, unknown>;
          try {
            const _toolReg = registry.getRegistration(call.name);
            if (_toolReg?.backfillObservableInput) {
              _observableArgs = { ..._observableArgs };
              _toolReg.backfillObservableInput(_observableArgs);
            }
          } catch { /* backfill failure is non-fatal */ }

          const permDecision = permMgr.decide(call.name, _observableArgs, approvalMode);
          if (permDecision === 'deny') {
            await triggerHook(createHookEvent('tool', 'error', { callId, toolName: call.name, error: 'Denied by permission rule', success: false }));
            events?.onToolEnd?.(call.name, false, Date.now() - toolStartMs);
            return { role: 'tool' as const, toolCallId: call.id, content: `[Permission denied] Tool "${call.name}" is blocked by an alwaysDeny rule.` };
          }

          // ── PreToolUse hook: block/modify tool input (inspired by claude-code) ──
          // Hooks may: (1) block the tool by outputting JSON with proceed=false or exit 2
          //            (2) modify tool arguments via updatedInput in JSON stdout
          //            (3) E20: provide permissionBehavior='allow' to skip 'ask' UI (but NOT deny rules)
          // This runs via the user-configurable HookRunner (on_tool_call event),
          // separate from the internal triggerHook() above.
          let effectiveArgs = call.arguments;
          let _hookAllowedPermission = false; // E20: hook granted allow (from hook result)
          let _hookProvidedupdatedInput = false; // E20: hook modified input (interactionSatisfied)
          try {
            const { getHookRunner } = await import('../hooks.js');
            const runner = getHookRunner(process.cwd());
            // Round 8: fire tool_pre_use (PreToolUse parity) + legacy on_tool_call
            const hasPreUse = runner.hasHooksFor('tool_pre_use');
            const hasOnToolCall = runner.hasHooksFor('on_tool_call');
            if (hasPreUse || hasOnToolCall) {
              const hookCtx = {
                toolName: call.name,
                toolArgs: call.arguments as Record<string, unknown>,
                cwd: process.cwd(),
              };
              const eventToFire = hasPreUse ? 'tool_pre_use' as const : 'on_tool_call' as const;
              const hookResult = await runner.run({ event: eventToFire, ...hookCtx });
              if (!hookResult.proceed || hookResult.blocked) {
                // Hook blocked the tool call
                const reason = hookResult.blockReason ?? 'Blocked by hook';
                await triggerHook(createHookEvent('tool', 'error', { callId, toolName: call.name, error: reason, success: false }));
                events?.onToolEnd?.(call.name, false, Date.now() - toolStartMs);
                return { role: 'tool' as const, toolCallId: call.id, content: `[Hook blocked] ${reason}` };
              }
              // Apply updatedInput if hook modified the tool arguments
              if (hookResult.updatedInput) {
                effectiveArgs = hookResult.updatedInput;
                _hookProvidedupdatedInput = true;
              }
              // E20: resolveHookPermissionDecision — hook allow vs deny rules
              // Mirrors claude-code toolHooks.ts resolveHookPermissionDecision():
              //   hook allow skips 'ask' UI confirmation, but deny rules STILL apply.
              //   If permMgr.decide() returns 'deny', the deny rule wins over hook allow.
              const _hookBehavior = (hookResult as unknown as Record<string, unknown>)['permissionBehavior'] as string | undefined;
              if (_hookBehavior === 'allow') {
                _hookAllowedPermission = true;
                // E20: Re-check deny rules even when hook says 'allow'
                const _denyCheck = permMgr.decide(call.name, _observableArgs, approvalMode);
                if (_denyCheck === 'deny') {
                  await triggerHook(createHookEvent('tool', 'error', { callId, toolName: call.name, error: 'Denied by permission rule (hook allow cannot override deny)', success: false }));
                  events?.onToolEnd?.(call.name, false, Date.now() - toolStartMs);
                  return { role: 'tool' as const, toolCallId: call.id, content: `[Permission denied] Tool "${call.name}" is blocked by an alwaysDeny rule (hook allow cannot override deny rules).` };
                }
              }
            }
          } catch { /* Hook check failure is non-fatal — proceed with original args */ }

          // E20: interactionSatisfied — if hook provided updatedInput, skip 'ask' confirmation
          // Mirrors claude-code toolHooks.ts interactionSatisfied pattern.
          // This handles automation scenarios: hook programmatically modifies input, no user confirm needed.
          const _interactionSatisfied = _hookProvidedupdatedInput || _hookAllowedPermission;

          // Fire plugin on_tool_call hooks (non-blocking, errors are silent)
          try {
            const { getPluginHooks } = await import('../domain-router.js');
            const toolHooks = getPluginHooks('on_tool_call').filter((h) => !h.tool || h.tool === call.name);
            for (const hook of toolHooks) {
              if (hook.handler) await hook.handler({ toolName: call.name, args: effectiveArgs }).catch(() => {});
            }
          } catch { /* ignore */ }

          try {
            const result = await withToolRetry(
              () => {
                // ── Plan Mode: block write tools (Batch 2) ─────────────────
                const isPlanMode = process.env.UAGENT_PLAN_MODE === '1';
                const WRITE_TOOLS = new Set([
                  'Write', 'Edit', 'Bash', 'FileWrite', 'FileEdit',
                  'write_file', 'edit_file', 'bash',
                ]);
                if (isPlanMode && WRITE_TOOLS.has(call.name)) {
                  return Promise.resolve(
                    `[Plan Mode] Tool "${call.name}" is blocked in plan mode. ` +
                    `This action would write/modify files or execute commands. ` +
                    `Describe the plan but do NOT execute write operations. ` +
                    `Use /plan to exit plan mode.`
                  );
                }
                return registry.execute(call.name, effectiveArgs);
              },
              call.name,
            );
            const durationMs = Date.now() - toolStartMs;
            const newlyActivated = registry.evaluateConditionals(call.name, result);
            if (newlyActivated.length > 0) onChunk(`\n🔓 Unlocked tools: ${newlyActivated.join(', ')}\n`);
            await triggerHook(createHookEvent('tool', 'after', { callId, toolName: call.name, success: true }));
            events?.onToolEnd?.(call.name, true, durationMs);
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
            events?.onToolResult?.(call.name, resultStr);
            // Round 8: fire tool_post_use (PostToolUse parity)
            // H17: updatedMCPToolOutput — allows hook to modify MCP tool output
            // B21: hook_stopped_continuation + hook_blocking_error (claude-code toolHooks.ts parity)
            let finalResultStr = resultStr;
            let _postUsePreventContinuation = false;
            try {
              const { getHookRunner: _postUseRunner } = await import('../hooks.js');
              const _pr = _postUseRunner(process.cwd());
              if (_pr.hasHooksFor('tool_post_use')) {
                const _postResult = await _pr.run({
                  event: 'tool_post_use',
                  toolName: call.name,
                  toolArgs: effectiveArgs as Record<string, unknown>,
                  toolResult: resultStr.slice(0, 2000), // cap to avoid huge payloads
                  cwd: process.cwd(),
                });
                // H17: if hook returns updatedMCPToolOutput and this is an MCP tool, use it
                if (
                  _postResult.updatedMCPToolOutput !== undefined &&
                  (call.name.startsWith('mcp_') || call.name.includes('__mcp__'))
                ) {
                  finalResultStr = typeof _postResult.updatedMCPToolOutput === 'string'
                    ? _postResult.updatedMCPToolOutput
                    : JSON.stringify(_postResult.updatedMCPToolOutput);
                }
                // B21: hook_blocking_error — PostToolUse exit-2 阻断，覆盖工具输出
                // Mirrors claude-code toolHooks.ts runPostToolUseHooks() hook_blocking_error branch.
                if (_postResult.blocked && _postResult.blockReason) {
                  finalResultStr = `[PostToolUse hook blocked] ${_postResult.blockReason}`;
                }
                // B21: hook_stopped_continuation — PostToolUse preventContinuation 终止主循环
                // Mirrors claude-code toolHooks.ts L121-130: yield hook_stopped_continuation → return.
                // Flag is checked after all tool results are collected, then breaks the main loop.
                const _preventCont = (_postResult as unknown as Record<string, unknown>)['preventContinuation'];
                if (_preventCont === true || _postResult.stopReason) {
                  _postUsePreventContinuation = true;
                  onChunk(`\n🛑 PostToolUse hook requested stop (hook_stopped_continuation)\n`);
                }
                // B22: hook_additional_context — PostToolUse hook 返回的额外上下文注入 LLM
                // Mirrors claude-code toolHooks.ts L133-143 hook_additional_context branch.
                // 允许 hook 向 LLM 的下一轮传递审计日志/安全检查结果等附加信息。
                const _addCtx = (_postResult as unknown as Record<string, unknown>)['additionalContext'];
                if (_addCtx && typeof _addCtx === 'string') {
                  // 注入为额外的 tool 消息，LLM 在下一轮可以看到
                  toolResults.push({
                    role: 'tool' as const,
                    toolCallId: `__additional_context_${call.id}`,
                    content: `[PostToolUse Hook Context] ${_addCtx}`,
                  });
                }
              }
            } catch { /* non-fatal */ }
            // B21: propagate prevent-continuation flag to outer runCall context
            if (_postUsePreventContinuation) {
              _terminalReason = 'hook_stopped';
              _earlyExit = true;
            }
            // ── ToolUseSummary: async compress large results (Round 3) ─────
            // B18 upgrade: fire-and-forget into Promise, awaited at next iteration start.
            if (finalResultStr.length >= TOOL_USE_SUMMARY_THRESHOLD && PARALLELIZABLE_TOOLS.has(call.name)) {
              _pendingToolUseSummaryPromise = maybeGenerateToolSummary(call.name, finalResultStr)
                .catch(() => null);
            }

            // C24: processToolResult -- persist large results to disk instead of truncating
            // Mirrors claude-code toolResultStorage.ts L205 processToolResultBlock().
            // Results > 50k chars are saved to ~/.uagent/tool-results/ and replaced with
            // a <persisted-output> reference. The model can use Read tool to access full content.
            let persistedResultStr = finalResultStr;
            try {
              const { processToolResult } = await import('../tools/tool-result-storage.js');
              persistedResultStr = await processToolResult(call.id, call.name, finalResultStr);
            } catch { /* non-fatal: fall through with original result */ }

            return { role: 'tool' as const, toolCallId: call.id, content: persistedResultStr };
          } catch (err) {
            const durationMs = Date.now() - toolStartMs;
            const toolErrMsg = err instanceof Error ? err.message : String(err);
            await triggerHook(createHookEvent('tool', 'error', { callId, toolName: call.name, error: toolErrMsg, success: false }));
            events?.onToolEnd?.(call.name, false, durationMs, toolErrMsg);
            // Round 8: fire tool_use_failure (PostToolUseFailure parity)
            try {
              const { getHookRunner: _failRunner } = await import('../hooks.js');
              const _fr = _failRunner(process.cwd());
              if (_fr.hasHooksFor('tool_use_failure')) {
                await _fr.run({
                  event: 'tool_use_failure',
                  toolName: call.name,
                  toolArgs: effectiveArgs as Record<string, unknown>,
                  toolError: toolErrMsg,
                  cwd: process.cwd(),
                });
              }
            } catch { /* non-fatal */ }
            return { role: 'tool' as const, toolCallId: call.id, content: `Error: ${toolErrMsg}` };
          }
        };

        if (canParallelize) {
          const batch = response.toolCalls.slice(0, MAX_PARALLEL_TOOLS);
          const overflow = response.toolCalls.slice(MAX_PARALLEL_TOOLS);

          if (verbose) {
            onChunk(`\n🔧 Tools (parallel): ${batch.map((t) => t.name).join(', ')}\n`);
          }

          // 为并行 batch 添加超时保护，防止单个工具 hang 导致整个 batch 卡住
          const BATCH_TIMEOUT_MS = 30 * 60 * 1000; // 30min（与 Bash 最大超时对齐）
          const batchWithTimeout = Promise.all(batch.map(runCall));
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Parallel tool batch timed out after ${BATCH_TIMEOUT_MS / 60000}min`)), BATCH_TIMEOUT_MS)
          );
          const parallelResults = await Promise.race([batchWithTimeout, timeoutPromise]).catch((err) => {
            // 超时时返回错误结果，不中断整个循环
            return batch.map((call) => ({
              role: 'tool' as const,
              toolCallId: call.id,
              content: `Error: ${err instanceof Error ? err.message : String(err)}`,
            }));
          });
          toolResults.push(...parallelResults);

          for (const call of overflow) {
            const r = await runCall(call);
            toolResults.push(r);
          }
        } else {
          // Sequential branch — reuse runCall() for consistent hook behavior
          for (const call of response.toolCalls) {
            if (verbose) {
              const TOOL_ARGS_PREVIEW_CHARS = 120;
              const argsStr = JSON.stringify(call.arguments).slice(0, TOOL_ARGS_PREVIEW_CHARS);
              onChunk(`  → ${call.name}(${argsStr}${argsStr.length >= 120 ? '...' : ''})\n`);
            }

            const toolResult = await runCall(call);

            if (verbose) {
              const TOOL_RESULT_PREVIEW_CHARS = 300;
              const preview = toolResult.content.slice(0, TOOL_RESULT_PREVIEW_CHARS);
              onChunk(`  ✓ ${preview}${preview.length >= TOOL_RESULT_PREVIEW_CHARS ? '...' : ''}\n`);
            }

            // ── Dry-run confirmation gate (kstack article #15313) ──────────────
            // In yolo mode (approvalMode='yolo'), skip the confirmation gate entirely.
            if (toolResult.content.startsWith('__CONFIRM_REQUIRED__:')) {
              // yolo mode: skip user confirmation — execute directly
              if (approvalMode === 'yolo') {
                // Strip the sentinel prefix and continue without prompting
                const firstNewline = toolResult.content.indexOf('\n');
                const dangerousCommand = firstNewline > -1
                  ? toolResult.content.slice(firstNewline + 1).trim()
                  : '';
                onChunk(`\n⚡ [yolo mode] Auto-approving command: \`${dangerousCommand.slice(0, 80)}\`\n`);
                toolResults.push({ ...toolResult, content: `[Auto-approved by yolo mode] ${toolResult.content.slice('__CONFIRM_REQUIRED__:'.length)}` });
                continue;
              }
              const firstNewline = toolResult.content.indexOf('\n');
              const header = toolResult.content.slice('__CONFIRM_REQUIRED__:'.length, firstNewline > -1 ? firstNewline : undefined);
              const dangerousCommand = firstNewline > -1 ? toolResult.content.slice(firstNewline + 1).trim() : '';
              const cmdCwd = (call.arguments.cwd as string | undefined)
                ? String(call.arguments.cwd)
                : process.cwd();

              pendingConfirmationRef.value = {
                command: dangerousCommand,
                cwd: cmdCwd,
                label: header,
                injectedAt: history.length + toolResults.length,
              };

              toolResults.push({
                role: 'tool',
                toolCallId: call.id,
                content: `[Paused for confirmation] Dangerous command detected: ${header}`,
              });
              history.push(...toolResults);

              history.push({
                role: 'user',
                content:
                  `[SYSTEM] The Bash tool wants to execute a potentially destructive command.\n` +
                  `Risk: ${header}\n` +
                  `Command:\n\`\`\`\n${dangerousCommand}\n\`\`\`\n\n` +
                  `Please show the user this information and ask them to reply **yes** to execute or **no** to cancel.`,
              });

              const confirmOpts = { systemPrompt, messages: history, tools: [], stream: false };
              try {
                const confirmResp = fallbackChain
                  ? await fallbackChain.call(getLLM(), confirmOpts)
                  : await getLLM().chat(confirmOpts);
                if (confirmResp.type === 'text') {
                  onChunk(confirmResp.content);
                  history.push({ role: 'assistant', content: confirmResp.content });
                }
              } catch { /* ignore — user will still see the raw prompt */ }

              // B13: 等待用户确认时设置终止原因，通过 _earlyExit 标志跳出嵌套循环
              _terminalReason = 'pending_confirmation';
              _earlyExit = true;
              break;
            }

            toolResults.push(toolResult);
          }
        }

        history.push(...toolResults);

        // Auto-verify reminder: if this batch contained write operations (Write/Edit/MultiEdit),
        // inject a lightweight reminder so the LLM proactively runs build/test verification.
        // Only fires when the system prompt doesn't already contain explicit verify instructions,
        // preventing duplicate reminders from CLAUDE.md.
        const _hasWriteOps = response.toolCalls.some((tc) =>
          tc.name === 'Write' || tc.name === 'Edit' || tc.name === 'MultiEdit',
        );
        if (_hasWriteOps && !systemPrompt.includes('After Every Code Change') && !systemPrompt.includes('mvn compile')) {
          history.push({
            role: 'user',
            content: '<reminder>You just modified files. If this is a compiled language (Java, TypeScript, Go, etc.), run the build/compile command to verify no errors were introduced before continuing.</reminder>',
            isMeta: true,
          });
        }

        // C31: ToolUseSummary D29 集成 — tool batch 完成后生成 commit-style 摘要标题
        // D29 的 generateToolUseSummary 模块已创建但未被调用。
        // 在这里集成：每批 tool 全部执行完后，若开启 ENABLE_TOOL_SUMMARY，
        // 异步生成 ≤30 字标题并通过 onToolBatchSummary 事件广播（非阻塞）。
        // Mirrors claude-code toolUseSummaryGenerator.ts batch-level summary.
        if (events?.onToolBatchSummary && toolResults.length > 0) {
          try {
            const { generateToolUseSummary } = await import('../tools/tool-use-summary.js');
            // 提取 tool 结果（最多 5 条，避免 prompt 过长）
            const batchParams = toolResults.slice(0, 5).map((r) => ({
              toolName: (r as { toolCallId?: string; content?: string }).toolCallId ?? '',
              result: (r as { content?: string }).content?.slice(0, 500) ?? '',
            }));
            const lastText = typeof response === 'object' && 'content' in response
              ? String((response as { content?: unknown }).content ?? '').slice(0, 200)
              : '';
            generateToolUseSummary({ toolResults: batchParams, lastAssistantText: lastText })
              .then((summary) => { if (summary) events.onToolBatchSummary?.(summary); })
              .catch(() => { /* C31: non-fatal */ });
          } catch { /* C31: non-fatal */ }
        }

        // B21: hook_stopped_continuation — 工具结果收集完毕后检查 PostToolUse 终止标志
        // Mirrors claude-code toolHooks.ts L121-130 + query.ts hook_stopped_continuation handling.
        // PostToolUse hook 请求停止时，结果已注入 history（让 LLM 知道工具执行了），但主循环终止。
        if (_earlyExit && _terminalReason === 'hook_stopped') {
          break; // B21: hook_stopped_continuation 生效
        }

        // A18: Apply contextModifiers from StreamingToolExecutor (claude-code parity)
        // Tools like EnterPlanMode/ExitPlanMode/WorktreeEnter can modify session state
        // by returning a contextModifier in their ToolRegistration.
        if (_streamingExecutor) {
          try {
            const modifiers = _streamingExecutor.collectContextModifiers();
            for (const modifier of modifiers) {
              try {
                // Build current AgentContextState snapshot and apply modifier
                const { isPlanModeActive } = await import('../tools/agents/plan-mode-tools.js');
                const currentCtx: import('../../models/types.js').AgentContextState = {
                  cwd: process.cwd(),
                  approvalMode: approvalMode as 'default' | 'autoEdit' | 'yolo',
                  planModeActive: isPlanModeActive(),
                };
                const newCtx = modifier(currentCtx);
                // Apply non-cwd state changes (cwd change via process.chdir would affect subprocess)
                // Plan mode state is managed by plan-mode-tools.ts module, so we skip it here
                // approvalMode is local to this runStreamLoop closure — reassign if changed
                if (newCtx.approvalMode !== currentCtx.approvalMode) {
                  (opts as unknown as Record<string, unknown>).approvalMode = newCtx.approvalMode;
                }
              } catch { /* non-fatal: contextModifier errors do not block agent */ }
            }
          } catch { /* non-fatal */ }
        }

        // s03: TodoWrite nag
        const usedTodo = response.toolCalls.some((tc) => tc.name === 'TodoWrite');
        roundsWithoutTodo = usedTodo ? 0 : roundsWithoutTodo + 1;
        if (todoManager.hasOpenItems() && roundsWithoutTodo >= TODO_NAG_ROUNDS) {
          history.push({ role: 'user', content: '<reminder>Update your TodoWrite list.</reminder>' });
          roundsWithoutTodo = 0;
        }
        // B14: 记录正常工具轮 continue 原因
        _lastTransition = { reason: 'next_turn' };
      }
    } // end inner while

    // B13: 如果提前退出（pending_confirmation），立即结束外层循环
    if (_earlyExit) break;

    if (iteration >= _effectiveMaxTurns) {
      // C21: max_turns_reached — 外部注入 maxTurns 超出时发出结构化通知
      // Mirrors claude-code query.ts L1705-1711: yield createAttachmentMessage({ type: 'max_turns_reached' })
      if (_externalMaxTurns !== undefined) {
        // 外部注入的 maxTurns — 触发 max_turns_reached 事件（client 可捕获）
        onChunk(`\n⚠️  Max turns limit reached (${_externalMaxTurns} turns).\n`);
        _terminalReason = 'max_turns';
      } else {
        onChunk(
          `\n⚠️  Reached iteration limit (${_effectiveMaxTurns} rounds).\n` +
          `   Type /continue (or just press Enter after typing your next message)\n` +
          `   to keep going from where the agent left off.\n` +
          `   To raise the limit: AGENT_MAX_ITERATIONS=100 uagent\n`,
        );
      }
      const last = history[history.length - 1];
      if (last?.role === 'tool') {
        history.push({ role: 'assistant', content: '[Iteration limit reached]' });
      }

      if (unattendedRetry && unattendedRetryCount < MAX_UNATTENDED_RETRIES) {
        unattendedRetryCount++;
        onChunk(
          `\n♻️  Unattended retry ${unattendedRetryCount}/${MAX_UNATTENDED_RETRIES} ` +
          `— waiting ${UNATTENDED_RETRY_DELAY_MS / 1000}s before continuing…\n`,
        );
        await new Promise((res) => setTimeout(res, UNATTENDED_RETRY_DELAY_MS));
        iteration = 0;
        _unattendedDone = false;
        history.push({
          role: 'user',
          content: `[SYSTEM] Unattended retry ${unattendedRetryCount}: please continue from where you left off. Max iterations reset.`,
        });
      }
    } else {
      // _terminalReason stays 'completed' for successful runs
      // Capture iteration snapshot (non-blocking)
      captureIterationSnapshot(prompt, history).catch(() => { /* non-fatal */ });
      // Incremental memory ingest: fire-and-forget after each successful round
      // Inspired by claude-code's extractMemories: per-round instead of exit-time batch.
      // Only processes new messages since the last ingest (cursor-based).
      triggerIncrementalIngest(history);
    }
  } // end outer while

  // B13: 返回结构化终止结果（claude-code Terminal 对标）
  if (iteration >= _effectiveMaxTurns && _terminalReason === 'completed') {
    _terminalReason = _externalMaxTurns !== undefined ? 'max_turns' : 'max_iterations';
  }
  // E21: executeNotificationHooks — 触发 notification hook（claude-code executeNotificationHooks 对标）
  // 在 agent 正常完成时向用户/脚本发送结构化通知。
  // Mirrors claude-code src/utils/hooks.ts executeNotificationHooks() L3570-3592.
  if (_terminalReason === 'completed') {
    try {
      const { executeNotificationHooks } = await import('../hooks.js');
      await executeNotificationHooks({
        notificationType: 'agent_complete',
        message: 'Agent completed successfully',
        title: domain,
      });
    } catch { /* notification hooks are non-fatal */ }

    // F23: AutoDream — 后台记忆整合（claude-code autoDream.ts parity）
    // 非阻塞触发，三重门控（时间/会话数/进程锁），失败不影响主循环。
    // D32/C33: 传入 onProgress 回调，整合完成时向 onChunk 输出通知
    try {
      const { executeAutoDream } = await import('../memory/auto-dream.js');
      const dreamOnProgress: import('../memory/auto-dream.js').DreamProgressCallback = (evt) => {
        if (evt.type === 'dream_completed' && evt.filesTouched.length > 0) {
          onChunk(`\n[Memory] Dream consolidated: ${evt.filesTouched.length} file(s) updated\n`);
        }
        // dream_failed is non-fatal — suppress from user output
      };
      executeAutoDream(domain, {}, dreamOnProgress); // 异步触发，不 await
    } catch { /* auto-dream is non-fatal */ }
  }

  const _result: StreamLoopResult = {
    reason: _terminalReason,
    iterations: iteration,
    tokensEstimated: estimateHistoryTokens(history),
    // B14: 最后一次 continue 的追踪（测试可观测性）
    lastTransition: _lastTransition,
  };
  events?.onTerminal?.(_result);
  log.debug('runStream completed', { reason: _terminalReason, iterations: iteration, lastTransition: _lastTransition });
  return _result;
}
