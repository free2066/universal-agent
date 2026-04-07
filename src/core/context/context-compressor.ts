/**
 * Context Auto-Compactor — Claude Code 7-layer defence alignment
 *
 * Layers implemented here:
 *   Layer 5 (AutoCompact)  — LLM 9-chapter summary + circuit breaker + anti-recursion
 *   Layer 6 (Blocking)     — Hard stop when circuit open (no infinite loops)
 *
 * Layers in context-editor.ts:
 *   Layer 2 (Snip)         — Selective tool result clearing (editContextIfNeeded)
 *   Layer 3 (Microcompact) — Time-based stale tool result replacement (microcompact)
 *
 * Layer 7 (Reactive)       — 413/context-overflow emergency compact (reactiveCompact, in agent.ts)
 *
 * Environment overrides:
 *   DISABLE_AUTO_COMPACT=1          — Skip AutoCompact entirely (e.g. for CI)
 *   AGENT_COMPACT_PCT_OVERRIDE=0.6  — Override threshold fraction (default 0.75)
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import type { Message } from '../../models/types.js';
import { getContentText } from '../../models/types.js';
import { modelManager } from '../../models/model-manager.js';

// ── Environment overrides ──────────────────────────────────────────────────────

/** Set DISABLE_AUTO_COMPACT=1 to skip all LLM-based compaction (e.g. in CI or batch mode)
 *  or set `autoCompact: false` in .codeflicker/config.json */
export const AUTO_COMPACT_DISABLED = (() => {
  if (process.env.DISABLE_AUTO_COMPACT === '1') return true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadConfig } = require('../../cli/config-store.js') as typeof import('../../cli/config-store.js');
    return loadConfig().autoCompact === false;
  } catch { return false; }
})();

/**
 * Override the compaction threshold fraction via AGENT_COMPACT_PCT_OVERRIDE.
 * Values: 0.0–1.0. Default: 0.75.
 * Example: AGENT_COMPACT_PCT_OVERRIDE=0.6 triggers compact earlier (60% of context window).
 */
const COMPACT_THRESHOLD_OVERRIDE = (() => {
  const v = parseFloat(process.env.AGENT_COMPACT_PCT_OVERRIDE ?? '');
  if (!isNaN(v) && v > 0 && v <= 1.0) return v;
  return null;
})();

/** Fraction of context window that triggers compaction (default: 75%) */
const COMPACT_THRESHOLD = COMPACT_THRESHOLD_OVERRIDE ?? 0.75;

/** Always keep at least this many recent turns intact after compaction */
const KEEP_LAST_TURNS = 6;

/**
 * Circuit breaker: max consecutive autocompact failures per session.
 * After this many failures, stop attempting autocompact for the rest of the session.
 * Inspired by Claude Code's MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3 pattern.
 * (Production data: 1,279 sessions had 50+ consecutive failures, ~250K wasted API calls/day)
 */
const MAX_CONSECUTIVE_FAILURES = 3;

/** Session-level circuit breaker state */
let consecutiveFailures = 0;
let circuitOpen = false;

/**
 * Anti-recursion guard: compact calls triggered from within compact are rejected.
 * Prevents recursive deadlock when the compact LLM call itself triggers another compact.
 */
let isCompacting = false;

/** Reset circuit breaker (called at session start / manually) */
export function resetCompactCircuitBreaker(): void {
  consecutiveFailures = 0;
  circuitOpen = false;
}

// ── Token estimation ──────────────────────────────────────────────────────────

/**
 * Rough token estimate from a string.
 *
 * Accounts for non-Latin scripts (CJK, Arabic, etc.) which typically encode
 * as 1-2 chars per token rather than the 4-chars-per-token Latin heuristic.
 * Without this correction, a conversation in Chinese would be estimated at
 * ~4× fewer tokens than reality, causing missed compaction triggers.
 *
 * Heuristic:
 *   - CJK / full-width / emoji codepoints  → 2.0 chars/token  (divisor 2.0)
 *   - Latin + JSON                          → 2.0 chars/token  (divisor 2)
 *   - Latin text                            → 4.0 chars/token  (divisor 4)
 */
function estimateTokens(text: string, isJson = false): number {
  if (!text) return 0;
  // Count non-Latin characters: CJK, Arabic, Devanagari, Korean, and emoji.
  // Emoji (U+1F300-U+1F9FF) live in the Supplementary Multilingual Plane and
  // each codepoint encodes to ~1-2 tokens but takes 2 UTF-16 code units (surrogate
  // pair). Without the /u flag + explicit SMP range, emojis would be counted as
  // latin chars (divisor 4) and their token count would be underestimated by ~4x,
  // potentially delaying compaction when users paste emoji-heavy content.
  const nonLatinCount = (
    text.match(/[\u0600-\u06FF\u0900-\u097F\u3000-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\u{1F300}-\u{1F9FF}]/gu) ?? []
  ).length;
  const nonLatinRatio = nonLatinCount / Math.max(text.length, 1);

  const latinDivisor = isJson ? 2 : 4;
  const nonLatinDivisor = 2.0;
  const effectiveDivisor = latinDivisor * (1 - nonLatinRatio) + nonLatinDivisor * nonLatinRatio;

  return Math.ceil(text.length / effectiveDivisor);
}

// Export estimateMessageTokens so context-editor.ts can reuse it
export function estimateMessageTokens(msg: Message): number {
  const contentTokens = estimateTokens(getContentText(msg.content), msg.role === 'tool');
  const toolCallTokens = msg.toolCalls
    ? msg.toolCalls.reduce(
        (sum, tc) => sum + estimateTokens(JSON.stringify(tc.arguments), true) + 10,
        0,
      )
    : 0;
  return contentTokens + toolCallTokens + 4; // role overhead
}

export function estimateHistoryTokens(history: Message[]): number {
  return history.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

// ── Compact decision ──────────────────────────────────────────────────────────

export interface CompactDecision {
  shouldCompact: boolean;
  estimatedTokens: number;
  contextLength: number;
  threshold: number;
  warningState: TokenWarningState;
}

// ── A12: 四档阈值系统（claude-code autoCompact.ts 对标）──────────────────────────
//
// claude-code 使用绝对 buffer 减法而非百分比阈值，提供更细粒度的4档控制：
//   ok → warning → error（触发 autoCompact）→ blocking（直接停止，不调用 LLM）
// 每档有独立缓冲区，为 LLM 输出 token 留出 OUTPUT_RESERVE_TOKENS 空间。
//
// 与现有百分比 COMPACT_THRESHOLD 并存：两者满足其一即触发压缩。

const OUTPUT_RESERVE_TOKENS = 20_000;   // 给 LLM 生成摘要的输出预留
const AUTOCOMPACT_BUFFER_TOKENS = 13_000; // autoCompact 触发缓冲
const WARNING_BUFFER_TOKENS = 20_000;   // 警告阈值缓冲
const BLOCKING_BUFFER_TOKENS = 3_000;   // blocking 阈值：此时停止请求避免 PTL

export type TokenWarningState = 'ok' | 'warning' | 'error' | 'blocking';

/**
 * A12: 计算当前 token 使用状态（四档）。
 * 对标 claude-code 的 calculateTokenWarningState()。
 *
 * @returns 'ok'      — context 使用正常，无需压缩
 *          'warning' — 接近阈值，UI 可以用颜色提示用户
 *          'error'   — 超过 autoCompact 阈值，应立即触发压缩
 *          'blocking'— context 已满（仅剩 3K buffer），应停止新 LLM 调用
 */
export function calculateTokenWarningState(
  estimatedTokens: number,
  model = modelManager.getCurrentModel('main'),
): TokenWarningState {
  const profile = [...modelManager.listProfiles()].find(
    (p) => p.name === model || p.modelName === model,
  );
  const contextWindow = profile?.contextLength ?? 128_000;
  const effective = contextWindow - OUTPUT_RESERVE_TOKENS;

  if (estimatedTokens >= effective - BLOCKING_BUFFER_TOKENS) return 'blocking';
  if (estimatedTokens >= effective - AUTOCOMPACT_BUFFER_TOKENS) return 'error';
  if (estimatedTokens >= effective - WARNING_BUFFER_TOKENS) return 'warning';
  return 'ok';
}

export function shouldCompact(
  history: Message[],
  model = modelManager.getCurrentModel('main'),
  snipTokensFreed = 0,  // H15: 已释放的 token，从阈值中减去以防止重复触发
): CompactDecision {
  const profile = [...modelManager.listProfiles()].find(
    (p) => p.name === model || p.modelName === model,
  );
  const contextLength = profile?.contextLength ?? 128000;
  const threshold = Math.floor(contextLength * COMPACT_THRESHOLD);
  const estimatedTokens = estimateHistoryTokens(history);
  // H15: 减去 snip 已释放的部分，防止在 snip 后立即重复触发 autoCompact
  const effectiveTokens = Math.max(0, estimatedTokens - snipTokensFreed);
  const warningState = calculateTokenWarningState(effectiveTokens, model);

  // 触发条件：百分比阈值（向后兼容）OR 四档阈值达到 error/blocking
  const shouldCompactByState = warningState === 'error' || warningState === 'blocking';

  return {
    shouldCompact: effectiveTokens > threshold || shouldCompactByState,
    estimatedTokens,
    contextLength,
    threshold,
    warningState,
  };
}

// ── 9-Chapter Structured Summary ─────────────────────────────────────────────

/**
 * System prompt for 9-chapter structured summary.
 * Inspired by Claude Code's autoCompact prompt structure (kstack #15375).
 *
 * B12: 引入 <analysis> 草稿环节（claude-code prompt.ts 对标）
 * 要求 LLM 先在 <analysis> 标签内思考推导，再输出 <summary>。
 * 减少直接输出摘要时的幻觉风险（先思考后总结）。
 */
const COMPACT_SYSTEM =
  'You are a conversation summarizer for an AI coding assistant session. ' +
  'Given a list of conversation turns, produce a structured summary using EXACTLY these 9 chapters. ' +
  'Be dense, factual, and preserve ALL important decisions, file edits, tool results, and conclusions. ' +
  'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools. Tool calls will be REJECTED.\n\n' +
  'First, think through what is most important to preserve in <analysis> tags.\n' +
  'Then write your final summary inside <summary> tags:\n\n' +
  '<summary>\n' +
  '## 1. Primary Request and Intent\n' +
  '[What the user originally asked for and the overall goal]\n\n' +
  '## 2. Key Technical Concepts\n' +
  '[Languages, frameworks, patterns, architectures discussed]\n\n' +
  '## 3. Files and Code\n' +
  '[Specific files read/edited, functions modified, code snippets]\n\n' +
  '## 4. Errors and Fixes\n' +
  '[Errors encountered and how they were resolved]\n\n' +
  '## 5. Problem Solving\n' +
  '[Approaches tried, decisions made, trade-offs]\n\n' +
  '## 6. All User Messages\n' +
  '[Verbatim list of every user message — do NOT summarize or omit any]\n\n' +
  '## 7. Pending Tasks\n' +
  '[Incomplete work, TODO items, blocked items]\n\n' +
  '## 8. Current Work\n' +
  '[The most recent thing being worked on, last state]\n\n' +
  '## 9. Optional Next Step\n' +
  '[What should happen next, if clear from context]\n' +
  '</summary>';

/**
 * B12: 从 LLM 响应中提取 <summary> 块内容。
 * 如果 LLM 遵循指令，内容在 <summary>...</summary> 中。
 * fallback: 若无标签则返回原始响应（向后兼容）。
 */
function parseCompactSummary(raw: string): string {
  const match = raw.match(/<summary>([\s\S]*?)<\/summary>/);
  return match ? match[1]!.trim() : raw.trim();
};

// ── C12: Image handling + PTL retry（claude-code compact.ts 对标）──────────────
//
// 含图片（base64）的历史做 compact 时极易触发 prompt_too_long（PTL）。
// stripImages() 在压缩前将图片 content block 替换为 '[image]' 占位文本，
// 显著减少 compact prompt 的 token 占用。
// PTL 重试：最多 3 次，每次截断最老 1/4 历史。

const MAX_PTL_RETRIES = 3;

/**
 * C12: 从消息列表中剥离图片内容块，替换为轻量文本占位符。
 * 对标 claude-code compact.ts stripImagesFromMessages()。
 */
function stripImages(msgs: Message[]): Message[] {
  return msgs.map((msg) => {
    if (typeof msg.content === 'string') return msg;
    if (!Array.isArray(msg.content)) return msg;
    // ContentBlock = string | ImageBlock | ImageUrlBlock
    // Replace image-type blocks with a plain string placeholder (valid ContentBlock)
    const stripped: import('../../models/types.js').ContentBlock[] = (
      msg.content as import('../../models/types.js').ContentBlock[]
    ).map((block) => {
      if (typeof block === 'string') return block;
      if (block.type === 'image' || block.type === 'image_url') return '[image]';
      return block;
    });
    return { ...msg, content: stripped };
  });
}

function isPtlError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('prompt_too_long') || msg.includes('413') || msg.includes('context_length_exceeded');
}

/** Max chars to include from a single tool result in the compaction prompt */
const MAX_TOOL_RESULT_CHARS = 1500;

function serializeTurns(turns: Message[]): string {
  return turns
    .map((m) => {
      if (m.role === 'tool') {
        const content = m.content.length > MAX_TOOL_RESULT_CHARS
          ? m.content.slice(0, MAX_TOOL_RESULT_CHARS) + `\n...(truncated, ${m.content.length - MAX_TOOL_RESULT_CHARS} chars omitted)`
          : m.content;
        return `[Tool result id=${m.toolCallId}]\n${content}`;
      }
      if (m.toolCalls?.length) {
        const calls = m.toolCalls
          .map((tc) => `  ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 200)})`)
          .join('\n');
        return `[${m.role}]\n${m.content || ''}\n[Tool calls]\n${calls}`;
      }
      return `[${m.role}]\n${m.content}`;
    })
    .join('\n\n---\n\n');
}

/**
 * Find a safe split point that doesn't break tool_use/tool_result pairs.
 * Returns the largest index ≤ `targetIdx` where splitting is safe.
 */
/**
 * Export for use in session-memory.ts (D13: adjustIndexToPreserveAPIInvariants)
 */
export function findSafeSplitPoint(history: Message[], targetIdx: number): number {
  let idx = targetIdx;
  while (idx > 0) {
    const msg = history[idx];
    if (msg?.role === 'tool') { idx--; continue; }
    if (msg?.role === 'assistant' && msg.toolCalls?.length) {
      const callIds = new Set(msg.toolCalls.map((tc) => tc.id));
      let allResultsBeforeIdx = true;
      for (let i = idx + 1; i < history.length; i++) {
        if (history[i].role === 'tool' && history[i].toolCallId) {
          if (callIds.has(history[i].toolCallId!) && i > targetIdx) {
            allResultsBeforeIdx = false;
            break;
          }
        }
      }
      if (!allResultsBeforeIdx) { idx--; continue; }
    }
    break;
  }
  return idx;
}

// ── Layer 5: AutoCompact ──────────────────────────────────────────────────────

/**
 * Auto-compact the history in-place using LLM 9-chapter summarization.
 * Returns the number of turns compacted (0 if nothing happened).
 *
 * Respects:
 *   DISABLE_AUTO_COMPACT=1          — skip entirely
 *   AGENT_COMPACT_PCT_OVERRIDE=0.x  — override threshold fraction
 */
// ── Round 7: Time-based microcompact ─────────────────────────────────────────
//
// When the session is idle for more than TIME_BASED_COMPACT_THRESHOLD_MINUTES,
// the server's prompt cache has likely expired. Proactively microcompact stale
// tool results to minimize the cache miss cost on the next LLM call.
//
// This mirrors claude-code's time-based microcompact trigger.
// Override threshold: UAGENT_TIME_COMPACT_MINUTES env var (default: 30)

const TIME_BASED_COMPACT_THRESHOLD_MS = (() => {
  const v = parseInt(process.env.UAGENT_TIME_COMPACT_MINUTES ?? '30', 10);
  return (isNaN(v) || v <= 0 ? 30 : v) * 60_000;
})();

/** Track the last time a microcompact was triggered (session-level) */
let _lastTimeBasedMicrocompactAt = 0;

/** Exported for testing only */
export function _resetTimeBasedMicrocompact(): void { _lastTimeBasedMicrocompactAt = 0; }

/**
 * Time-based microcompact: called from autoCompact() before full compaction.
 * If idle for >30 min AND context is below full-compact threshold,
 * clear stale tool results without an LLM call.
 *
 * Returns number of messages cleared (0 if not triggered).
 */
async function runTimeBasedMicrocompact(
  history: Message[],
  now: number,
  onProgress?: (msg: string) => void,
): Promise<number> {
  // Only trigger if last assistant message has a timestamp and it's old enough
  const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant');
  const msgTs = (lastAssistant as { timestamp?: number } | undefined)?.timestamp;
  if (!msgTs) return 0;                              // no timestamp available

  const gap = now - msgTs;
  if (gap < TIME_BASED_COMPACT_THRESHOLD_MS) return 0; // not idle long enough

  // Avoid triggering multiple times per idle window
  if (_lastTimeBasedMicrocompactAt > 0 && now - _lastTimeBasedMicrocompactAt < TIME_BASED_COMPACT_THRESHOLD_MS) return 0;

  const { microcompact } = await import('./context-editor.js');
  const cleared = microcompact(history);
  if (cleared > 0) {
    const gapMin = Math.round(gap / 60_000);
    _lastTimeBasedMicrocompactAt = now;
    onProgress?.(`\n[context] time-based microcompact triggered (gap=${gapMin}min, cleared=${cleared} stale results)\n`);
  }
  return cleared;
}

// ── C13: PostCompactContext — PostCompact 重注入上下文接口 ────────────────────
//
// claude-code compact.ts L517-694 在压缩完成后执行 7 个步骤重注入环境。
// 我们实现其中可选控的三步：MCP 工具摘要、agent 列表摘要、session_start hooks。
// 文件恢复（步骤 2）已在 Round 12 (D12) 实现。

export interface PostCompactContext {
  /**
   * C13-1: MCP 工具描述摘要（注入为 user 消息，防止压缩后 LLM 遗忘 MCP 工具）
   */
  mcpToolsSummary?: string;
  /**
   * C13-2: 子 agent 列表摘要（注入为 user 消息）
   */
  agentListingSummary?: string;
  /**
   * C13-3: 是否重新触发 session_start hooks（默认 false，避免重复触发）
   */
  reFireSessionStartHooks?: boolean;
  /**
   * F15/E25: querySource — 用于 postCompactCleanup 判断是否是主线程（子代理不重置全局状态）
   * 'main'/'repl_main_thread'：主线程压缩，清理所有缓存
   * 'subagent'/'agent'：子代理压缩，仅清理安全的 session 级别缓存
   * E25: expanded to accept full QuerySource union
   */
  querySource?: import('../agent/types.js').QuerySource | 'main' | 'subagent';
}

// ── C14: CompactionResult — 结构化压缩返回值（claude-code CompactionResult 对标）─
//
// 比原来只返回 number（compactedTurns）提供更多诊断信息：
//   - wasCompacted: 是否实际发生了压缩
//   - tokensFreed: 释放了多少 token（用于日志和测试断言）
//   - isRecompactionInChain: 是否是链式快速重压缩（用于警告用户异常情况）
//   - compactionPath: 走了哪条压缩路径

export interface CompactionResult {
  /** 是否实际发生了 LLM 压缩 */
  wasCompacted: boolean;
  /** 被压缩的历史轮数 */
  compactedTurns: number;
  /** 压缩前估算 token 数 */
  preTokens: number;
  /** 压缩后估算 token 数 */
  postTokens: number;
  /** 释放的 token 数（preTokens - postTokens） */
  tokensFreed: number;
  /** 是否是链式快速重压缩（上次压缩后很快又触发了压缩，可能有异常） */
  isRecompactionInChain: boolean;
  /** 走了哪条压缩路径 */
  compactionPath: 'llm_full' | 'skipped';
  /**
   * B19 (claude-code CompactionResult.boundaryMarker parity): UUID of the
   * compact boundary message inserted into history after this compaction.
   * Null if no compaction occurred.
   * Used by getMessagesAfterCompactBoundary() for precise re-compaction positioning.
   */
  boundaryUuid?: string;
  /**
   * E32 (claude-code CompactionResult.truePostCompactTokenCount parity):
   * Actual token count of the context after compaction (from LLM usage response).
   * Unlike postTokens (rough estimate), this is the true measured count.
   * Used to detect if compaction would immediately re-trigger on the next turn.
   */
  truePostCompactTokenCount?: number;
  /**
   * E32: Whether the compacted context would trigger another compaction immediately.
   * True when truePostCompactTokenCount >= autoCompact threshold.
   * Mirrors claude-code compact.ts post-compact re-trigger detection.
   */
  willRetriggerNextTurn?: boolean;
  /**
   * E32 (claude-code CompactionResult.compactionUsage parity):
   * Token usage consumed by the LLM compaction call itself (not the resulting context).
   * Used for cost tracking and cache token analysis.
   */
  compactionUsage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number };
  /**
   * E32 (claude-code CompactionResult.userDisplayMessage parity):
   * Optional user-visible message from a pre_compact hook, shown in the REPL after compaction.
   * Mirrors the hook result injection mechanism in claude-code compact.ts.
   */
  userDisplayMessage?: string;
}

/**
 * B19 (claude-code getMessagesAfterCompactBoundary parity):
 * Scan history for the last compact_boundary message and return all messages after it.
 * Used when re-compacting to identify only NEW messages since the last compact.
 *
 * Returns the full history if no boundary is found (first compaction).
 */
export function getMessagesAfterCompactBoundary(history: Message[]): Message[] {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i] as Message & { type?: string };
    if (msg.type === 'compact_boundary') {
      return history.slice(i + 1);
    }
  }
  return history;
}

/**
 * B19: isCompactBoundaryMessage — type guard for compact boundary messages.
 * Mirrors claude-code isCompactBoundaryMessage() in messages.ts.
 */
export function isCompactBoundaryMessage(msg: Message): boolean {
  return (msg as Message & { type?: string }).type === 'compact_boundary';
}

// ── A14: SnipResult — HistorySnip 截断结果（claude-code snipCompact.ts 对标）─────
//
// claude-code query.ts L401-410 在 microcompact 之后、autoCompact 之前运行
// snipCompactIfNeeded，选择性删除旧 API 轮次历史消息，并将 snipTokensFreed
// 传给 autoCompactIfNeeded 修正 blocking limit 判断。
// 这是一个零 LLM 成本的轻量级截断步骤。

export interface SnipResult {
  /** 截断后的消息列表 */
  messages: Message[];
  /** 释放的 token 数（估算） */
  tokensFreed: number;
  /** 可选的截断边界标记消息（注入到历史最前） */
  boundaryMessage?: Message;
}

/**
 * A14: 在历史底部找到安全的 snip 分割点。
 * 从末尾数 minKeepTurns 轮（每次 user 消息计一轮），找到分割索引。
 * 同时确保分割点不会切断 tool_use/tool_result 配对（防止 API invariants）。
 */
function findSnipBoundary(history: Message[], minKeepTurns: number): number {
  let turns = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === 'user') turns++;
    if (turns >= minKeepTurns) {
      // 找到安全的分割点（不切断 tool_use / tool_result 配对）
      return findSafeSplitPoint(history, i);
    }
  }
  return 0;
}

/**
 * A14: snipCompactIfNeeded — 轻量级历史截断（claude-code snipCompactIfNeeded 对标）
 *
 * 在 warning 或更高状态时删除旧轮次，降低 LLM autoCompact 的触发频率（避免 5-30s 等待）。
 * 保留最近 MIN_KEEP_TURNS=10 轮（user 消息计轮），保留所有 system 消息。
 * 返回 SnipResult，caller 用 tokensFreed 决定是否跳过 autoCompact。
 */
export function snipCompactIfNeeded(
  history: Message[],
  model = modelManager.getCurrentModel('main'),
): SnipResult {
  const state = calculateTokenWarningState(estimateHistoryTokens(history), model);

  // 仅在 warning 或更高状态时触发（节省开销）
  if (state === 'ok') return { messages: history, tokensFreed: 0 };

  const MIN_KEEP_TURNS = 10;
  const originalTokens = estimateHistoryTokens(history);

  // 找到安全的 snip 边界（保留最近 MIN_KEEP_TURNS 轮消息）
  const keepFromIdx = findSnipBoundary(history, MIN_KEEP_TURNS);
  if (keepFromIdx <= 0) return { messages: history, tokensFreed: 0 };

  // 被截断的部分
  const snippedPart = history.slice(0, keepFromIdx);
  const keptPart = history.slice(keepFromIdx);
  const snippedTokens = estimateHistoryTokens(snippedPart);

  // 若截断量很小（< 1000 tokens），不值得做
  if (snippedTokens < 1000) return { messages: history, tokensFreed: 0 };

  // 插入 snip boundary 标记（供后续逻辑和测试识别）
  const boundaryMessage: Message = {
    role: 'system' as const,
    content: `[SNIP BOUNDARY ${new Date().toISOString()}] ${snippedPart.length} old messages removed, ~${snippedTokens} tokens freed`,
    ...({ type: 'snip_boundary' } as Record<string, unknown>),
  };

  const newMessages = [boundaryMessage, ...keptPart];
  const newTokens = estimateHistoryTokens(newMessages);

  return {
    messages: newMessages,
    tokensFreed: originalTokens - newTokens,
    boundaryMessage,
  };
}

export async function autoCompact(
  history: Message[],
  onProgress?: (msg: string) => void,
  postCompactCtx?: PostCompactContext,
  snipTokensFreed = 0,  // H15: snip 已释放的 token 数（防止重复触发 autoCompact）
): Promise<CompactionResult> {
  const _noCompact: CompactionResult = {
    wasCompacted: false, compactedTurns: 0, preTokens: 0, postTokens: 0,
    tokensFreed: 0, isRecompactionInChain: false, compactionPath: 'skipped',
  };
  // Environment kill switch
  if (AUTO_COMPACT_DISABLED) return _noCompact;

  // Circuit breaker — stop after MAX_CONSECUTIVE_FAILURES failures
  if (circuitOpen) return _noCompact;

  // ── Round 7: Time-based microcompact (Layer 3 enhancement) ────────────────
  // Before checking full-compact threshold, try time-based microcompact.
  // This clears stale tool results when the session has been idle, reducing
  // cache miss costs. Runs even if full compact is not triggered.
  const _now = Date.now();
  await runTimeBasedMicrocompact(history, _now, onProgress);
  // Anti-recursion guard
  if (isCompacting) return _noCompact;

  const decision = shouldCompact(history, undefined, snipTokensFreed);
  if (!decision.shouldCompact) return _noCompact;

  // ── B20: Session Memory Compaction 优先路径（claude-code sessionMemoryCompact.ts parity）──
  // 在 LLM full compact 之前，先尝试 Session Memory（零 LLM 成本）。
  // 仅在 error/blocking 状态时尝试（ok/warning 不需要紧急压缩）。
  // 若成功：跳过 LLM compact，返回 _noCompact（Session Memory 已就地修改 history）。
  // 若失败：正常进入 LLM compact 路径。
  if (decision.warningState === 'error' || decision.warningState === 'blocking') {
    try {
      const { trySessionMemoryCompaction } = await import('../memory/session-memory.js');
      const sessionCompacted = trySessionMemoryCompaction(history, onProgress);
      if (sessionCompacted) {
        onProgress?.('\n📋 B20: Session Memory Compaction applied — skipping LLM compact.\n');
        return _noCompact; // Session Memory already modified history in-place
      }
    } catch { /* session memory compact failure is non-fatal — fall through to LLM compact */ }
  }

  const targetSplit = history.length - KEEP_LAST_TURNS;
  if (targetSplit <= 0) return _noCompact;

  const safeSplit = findSafeSplitPoint(history, targetSplit);
  if (safeSplit <= 0) return _noCompact;

  const toCompact = history.slice(0, safeSplit);
  const toKeep = history.slice(safeSplit);
  if (toCompact.length === 0) return _noCompact;

  // C14: 检测是否是链式快速重压缩（compact_boundary 最近出现超过 1 次）
  const recentBoundaries = history.filter(
    (m) => (m as unknown as { type?: string }).type === 'compact_boundary',
  );
  const isRecompactionInChain = recentBoundaries.length >= 2;

  const preTokens = decision.estimatedTokens;

  // Emit pre_compact hook (Batch 2)
  try {
    const { emitHook } = await import('../hooks.js');
    emitHook('pre_compact', { tokensBefore: decision.estimatedTokens });
  } catch { /* non-fatal */ }

  onProgress?.(
    `\n🗜️  Auto-compact: ${decision.estimatedTokens.toLocaleString()} tokens` +
    ` > threshold ${decision.threshold.toLocaleString()} — summarizing ${toCompact.length} turns…\n`,
  );

  // ── C12: 压缩前剥离图片，避免 base64 撑爆 compact prompt ──────────────────────
  const strippedToCompact = stripImages(toCompact);

  const serialized = serializeTurns(strippedToCompact);

  let summary = '';
  isCompacting = true;
  let ptlRetries = 0;
  let currentMsgs = strippedToCompact;
  try {
    while (ptlRetries <= MAX_PTL_RETRIES) {
      try {
        const client = modelManager.getClient('quick');
        const serializedRetry = ptlRetries === 0 ? serialized : serializeTurns(currentMsgs);
        const response = await client.chat({
          systemPrompt: COMPACT_SYSTEM,
          messages: [{ role: 'user', content: 'Please summarize the following conversation turns using the 9-chapter format:\n\n' + serializedRetry }],
          tools: [],
        });
        // B12: 提取 <summary> 块（过滤 <analysis> 草稿）
        summary = parseCompactSummary(response.content);
        consecutiveFailures = 0; // Reset on success
        break;
      } catch (err) {
        // C12: PTL 重试 — 截断最老 1/4 历史
        if (isPtlError(err) && ptlRetries < MAX_PTL_RETRIES) {
          const trimCount = Math.max(1, Math.floor(currentMsgs.length / 4));
          currentMsgs = currentMsgs.slice(trimCount);
          ptlRetries++;
          onProgress?.(`\n  Compact PTL retry ${ptlRetries}/${MAX_PTL_RETRIES}: trimmed ${trimCount} oldest msgs\n`);
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      circuitOpen = true;
      onProgress?.(
        `\n⚡ Auto-compact circuit breaker opened after ${consecutiveFailures} consecutive failures — ` +
        `stopping compact attempts for this session.\n`,
      );
    } else {
      onProgress?.(
        `\n⚠️  Auto-compact failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    return _noCompact;
  } finally {
    isCompacting = false;
  }

  const summaryMessage: Message = {
    role: 'user',
    content: `[Context summary — ${toCompact.length} earlier turns compressed using 9-chapter structure]\n\n` + summary,
    // B12: 标记为 compact summary，供后续逻辑识别
    ...({ isCompactSummary: true } as Record<string, unknown>),
  };

  // D12: Boundary Marker 持久化（claude-code CompactionResult.boundaryMarker 对标）
  // 在 history 中插入结构化边界标记，记录压缩前后的元数据。
  // 重启后可通过 getMessagesAfterCompactBoundary() 定位最近一次压缩边界。
  // C14: preTokens 已在函数顶部通过 decision.estimatedTokens 定义
  // B19: 为边界标记分配 UUID，供 CompactionResult.boundaryUuid 使用
  const _boundaryUuid = `compact-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const boundaryMarker: Message = {
    role: 'system' as const,
    content: `[COMPACT BOUNDARY ${new Date().toISOString()}] turns=${toCompact.length} preTokens=${preTokens} warningState=${decision.warningState}`,
    // Attach type metadata without breaking Message type compatibility
    ...({ type: 'compact_boundary', uuid: _boundaryUuid } as Record<string, unknown>),
    // E27: isMeta=true — compact boundary is a system-injected marker, not user-visible
    isMeta: true,
  };

  history.splice(0, history.length, boundaryMarker, summaryMessage, ...toKeep);
  onProgress?.(`\n  Compacted ${toCompact.length} turns → 1 structured summary (9 chapters).\n`);

  // Emit post_compact hook (Batch 2)
  try {
    const { emitHook } = await import('../hooks.js');
    const { estimateHistoryTokens } = await import('./context-compressor.js');
    emitHook('post_compact', {
      tokensBefore: decision.estimatedTokens,
      tokensAfter: estimateHistoryTokens(history),
    });
  } catch { /* non-fatal */ }

  // ── Post-Compact File Recovery (kstack #15375) ─────────────────────────────
  // After compacting, re-inject the most recently read files (up to 5 files,
  // each truncated to 5K tokens = 20K chars) so the agent doesn't lose
  // file context that was active just before compaction.
  //
  // Inspired by Claude Code's post-compact file re-injection:
  //   "压缩后自动恢复最多5个最近读取的文件 (每个5K tokens)"
  //
  // Algorithm:
  //   1. Scan the compacted turns for Read tool calls
  //   2. Collect unique file paths (newest first)
  //   3. For each file: read it from disk and inject as a system note
  // Non-blocking: file read failures are silently ignored.
  try {
    const MAX_RECOVERY_FILES = 5;
    const MAX_CHARS_PER_FILE = 5_000 * 4; // 5K tokens × 4 chars/token

    // Extract recently read file paths from compacted turns
    const readFilePaths: string[] = [];
    const seenPaths = new Set<string>();

    for (let i = toCompact.length - 1; i >= 0 && readFilePaths.length < MAX_RECOVERY_FILES; i--) {
      const msg = toCompact[i];
      if (msg.role !== 'assistant' || !msg.toolCalls?.length) continue;
      for (const tc of msg.toolCalls) {
        if (tc.name === 'Read' || tc.name === 'read_file' || tc.name === 'readFile') {
          const filePath = (tc.arguments.file_path ?? tc.arguments.path ?? tc.arguments.filePath) as string | undefined;
          if (filePath && typeof filePath === 'string' && !seenPaths.has(filePath)) {
            seenPaths.add(filePath);
            readFilePaths.push(filePath);
            if (readFilePaths.length >= MAX_RECOVERY_FILES) break;
          }
        }
      }
    }

    if (readFilePaths.length > 0) {
      const recoveryParts: string[] = [];
      const cwdResolved = resolve(process.cwd());
      for (const filePath of readFilePaths) {
        try {
          const absPath = resolve(cwdResolved, filePath);
          // CWE-22: reject path traversal attempts — recovered files must stay
          // within the current working directory. A filePath like '../../etc/passwd'
          // could otherwise escape to arbitrary locations on disk.
          if (!absPath.startsWith(cwdResolved + '/') && absPath !== cwdResolved) continue;
          if (!existsSync(absPath)) continue;
          const content = readFileSync(absPath, 'utf-8');
          const truncated = content.length > MAX_CHARS_PER_FILE
            ? content.slice(0, MAX_CHARS_PER_FILE) + `\n...(truncated at 5K token limit)`
            : content;
          recoveryParts.push(`### File: ${filePath}\n\`\`\`\n${truncated}\n\`\`\``);
        } catch { /* skip unreadable files */ }
      }

      if (recoveryParts.length > 0) {
        const recoveryMsg: Message = {
          role: 'user',
          content:
            `[Post-Compact File Recovery — restoring ${recoveryParts.length} recently read files]\n\n` +
            recoveryParts.join('\n\n'),
        };
        // Inject after boundary marker + summary (index 2), before the kept tail
        history.splice(2, 0, recoveryMsg);
        onProgress?.(
          `\n  Post-compact file recovery: restored ${recoveryParts.length} file(s) to context.\n`
        );
      }
    }
  } catch { /* file recovery is non-fatal */ }

  // C14: 返回 CompactionResult 结构化结果
  const postTokens = estimateHistoryTokens(history);
  // E32: truePostCompactTokenCount — 直接用 estimateHistoryTokens 作为 truePost
  // （LLM client 当前未暴露 usage，此为最优估算；后续 B31 AI Limits 集成后可接入真实值）
  const truePostTokens = postTokens;
  // E32: willRetriggerNextTurn — 检测压缩后是否立即再次触发压缩（防级联）
  const autoCompactThreshold = Math.floor((decision.contextLength ?? 128_000) * 0.75);
  const willRetrigger = truePostTokens >= autoCompactThreshold;

  const compactionResult: CompactionResult = {
    wasCompacted: true,
    compactedTurns: toCompact.length,
    preTokens,
    postTokens,
    tokensFreed: preTokens - postTokens,
    isRecompactionInChain,
    compactionPath: 'llm_full',
    boundaryUuid: _boundaryUuid, // B19: expose boundary UUID for caller tracking
    truePostCompactTokenCount: truePostTokens, // E32
    willRetriggerNextTurn: willRetrigger,       // E32
  };

  // F15: runPostCompactCleanup — 压缩后 5 类缓存清理（claude-code postCompactCleanup.ts 对标）
  try {
    const { runPostCompactCleanup } = await import('./post-compact-cleanup.js');
    await runPostCompactCleanup(postCompactCtx?.querySource ?? 'main');
  } catch { /* non-fatal */ }

  return compactionResult;
}

// ── Layer 7: Reactive Compact (emergency compaction on 413 / context overflow) ──

/**
 * Reactive compact: triggered when the LLM returns a 413 or context-overflow error.
 *
 * Strategy (Claude Code-inspired):
 *   1. Immediately try microcompact (zero LLM cost — replace stale tool results)
 *   2. If still over limit, do an emergency LLM compact with 50% retention target
 *   3. If compact also fails, throw to surface the error (no infinite retry)
 *
 * Returns true if recovery was successful, false if it could not recover.
 */
export async function reactiveCompact(
  history: Message[],
  onProgress?: (msg: string) => void,
): Promise<boolean> {
  onProgress?.('\n🚨 Context overflow detected — triggering reactive compact (Layer 7)…\n');

  // Step 1: Microcompact (zero cost, immediate)
  const { microcompact } = await import('./context-editor.js');
  const microdCleared = microcompact(history);
  if (microdCleared > 0) {
    onProgress?.(`  ✂️  Microcompact cleared ${microdCleared} stale tool results.\n`);
  }

  // Step 2: Check if that was enough
  const dec = shouldCompact(history);
  if (!dec.shouldCompact) {
    onProgress?.('  ✅ Context recovered via microcompact — no LLM call needed.\n');
    return true;
  }

  // Step 3: Emergency LLM compact — compress aggressively (keep only last 3 turns)
  const emergencySafeSplit = findSafeSplitPoint(history, Math.max(0, history.length - 3));
  if (emergencySafeSplit <= 0) {
    onProgress?.('  ⚠️  Cannot compact further — too few turns to split safely.\n');
    return false;
  }

  const toCompact = history.slice(0, emergencySafeSplit);
  const toKeep = history.slice(emergencySafeSplit);

  onProgress?.(`  🗜️  Emergency compact: summarizing ${toCompact.length} turns (keeping last 3)…\n`);

  const serialized = serializeTurns(toCompact);
  const emergencyPrompt =
    'EMERGENCY: Produce the most compact possible 9-chapter summary of these turns. ' +
    'Be extremely terse — every token counts. The context window is nearly full.\n\n' +
    serialized;

  try {
    // Use the fast/cheap model for emergency compact — speed over quality
    const client = modelManager.getClient('quick');
    const response = await client.chat({
      systemPrompt: COMPACT_SYSTEM,
      messages: [{ role: 'user', content: emergencyPrompt }],
      tools: [],
    });

    const summaryMessage: Message = {
      role: 'user',
      content: `[Emergency compact — ${toCompact.length} turns compressed]\n\n` + response.content,
    };
    history.splice(0, history.length, summaryMessage, ...toKeep);
    onProgress?.('  ✅ Emergency compact complete.\n');
    return true;
  } catch (err) {
    onProgress?.(`  ❌ Emergency compact failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return false;
  }
}
