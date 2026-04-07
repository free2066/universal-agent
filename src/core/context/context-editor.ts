/**
 * Context Editor — selective tool result clearing
 *
 * Inspired by kwaibi's ContextEditingInterceptor pattern.
 *
 * When context grows past a token threshold, instead of doing a full
 * LLM-based compaction (expensive), selectively replace older tool
 * result messages with a "[cleared]" placeholder.
 *
 * This is cheaper and lighter than full summarization:
 * - Preserves conversation flow (assistant → tool-result structure)
 * - Removes only bulky intermediate tool outputs
 * - Keeps the N most recent tool results intact
 * - Excludes configurable tools (e.g., write_file outputs we always want)
 *
 * Usage:
 *   const cleared = editContextIfNeeded(history, { trigger: 80000, keep: 3 });
 *   if (cleared > 0) onChunk(`\n✂️  Cleared ${cleared} old tool results\n`);
 */

import type { Message } from '../../models/types.js';
import { estimateHistoryTokens, estimateMessageTokens } from './context-compressor.js';
import { createLogger } from '../logger.js';

const log = createLogger('ctx-editor');

const CLEARED_PLACEHOLDER = '[cleared]';

// ── Layer 3: Microcompact ──────────────────────────────────────────────────────

/**
 * Microcompact — replace stale tool results with a lightweight placeholder.
 *
 * Inspired by Claude Code's Layer 3 (kstack #15375):
 *   "Microcompact: clean up stale tool outputs — zero API calls, <1ms latency"
 *
 * Criteria for "stale":
 *   - Tool result is older than MICROCOMPACT_AGE_MS (default: 60 min)
 *   - Tool result content is over MICROCOMPACT_MIN_CHARS (only large results)
 *   - Not one of the always-preserve tools (read_file, etc.)
 *   - Not already cleared
 *
 * Each message has a `_ts` timestamp field we inject when adding to history.
 * If no timestamp is available (older messages), we fall back to position-based
 * heuristic: messages in the first half of history that are "large" get cleared.
 *
 * Returns the number of tool results cleared.
 */

/** Age threshold for microcompact — C34: 提升到 30min（从 15min），减少过早清除 tool results 导致的信息丢失。
 *  日志分析：复杂 Java 代码重构会话中，15min 阈值导致大量 Read 结果被清，LLM 被迫重复读取文件。
 *  可通过 AGENT_MICROCOMPACT_AGE_MS 环境变量覆盖（单位：毫秒）。
 */
const MICROCOMPACT_AGE_MS = parseInt(process.env.AGENT_MICROCOMPACT_AGE_MS ?? String(30 * 60 * 1000), 10);

/** Only microcompact tool results over this char count (small results stay).
 *  Lowered from 500 → 200 to catch medium-sized LS/Grep results earlier.
 */
const MICROCOMPACT_MIN_CHARS = 200;

export function microcompact(history: Message[]): number {
  const now = Date.now();
  let cleared = 0;

  // Build toolCallId → toolName map from assistant messages
  const toolCallIdToName = new Map<string, string>();
  for (const msg of history) {
    if (msg.role !== 'assistant') continue;
    const tc = (msg as unknown as { toolCalls?: Array<{ id: string; name: string }> }).toolCalls;
    if (!Array.isArray(tc)) continue;
    for (const call of tc) {
      if (call.id && call.name) toolCallIdToName.set(call.id, call.name);
    }
  }

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role !== 'tool') continue;
    if (msg.content === CLEARED_PLACEHOLDER) continue;
    if (msg.content.length < MICROCOMPACT_MIN_CHARS) continue;

    const rawId = msg.toolCallId ?? '';
    const toolName = toolCallIdToName.get(rawId)
      ?? rawId.replace(/-\d+-[a-z0-9]+$/, '').replace(/-\d+$/, '');
    if (PRESERVE_RESULT_TOOLS.has(toolName)) continue;

    // Age check: use _ts if available, otherwise position heuristic
    const msgTs = (msg as Message & { _ts?: number })._ts;
    const isStaleByTime = msgTs !== undefined && (now - msgTs) > MICROCOMPACT_AGE_MS;
    // Position heuristic: front 30% of history (down from 40%) — avoids clearing
    // too-recent results when there is no timestamp information.
    const isStaleByPosition = msgTs === undefined && i < Math.floor(history.length * 0.3);

    if (isStaleByTime || isStaleByPosition) {
      history[i] = {
        ...msg,
        content: `[cleared: ${toolName} result — re-run tool if needed (age: ${Math.round((now - (msgTs ?? now)) / 60000)}min)]`,
      };
      cleared++;
    }
  }

  if (cleared > 0) {
    log.info(`Microcompact: cleared ${cleared} stale tool results`);
  }
  return cleared;
}

export interface ContextEditorConfig {
  /**
   * Token count that triggers editing (approximated via chars/4 heuristic).
   * Default: 80_000 tokens (matches kwaibi's 100k trigger scaled down for 128k models)
   */
  trigger: number;
  /**
   * Keep this many most-recent tool-result messages intact.
   * Default: 3
   */
  keep: number;
  /**
   * Minimum tokens to free before stopping. 0 = clear as many as needed.
   * Default: 0
   */
  clearAtLeast: number;
  /**
   * Tool names whose results should never be cleared.
   * Default: [] (clear all old tool results)
   */
  excludeTools: Set<string>;
}

/**
 * s06 PRESERVE_RESULT_TOOLS — tool names whose results are reference material.
 * Clearing them forces the agent to re-read files, wasting tokens.
 * Mirrors learn-claude-code s06's PRESERVE_RESULT_TOOLS = {"read_file"}.
 */
export const PRESERVE_RESULT_TOOLS = new Set([
  'read_file',
  'read-file',
  'readFile',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
]);

export const DEFAULT_CTX_EDITOR_CONFIG: ContextEditorConfig = {
  // Trigger lowered from 80K → 60K tokens.
  // Rationale: 80K on a 128K model = 62% usage before ANY cleanup begins,
  // leaving insufficient headroom and causing rapid ctx-editor thrashing.
  // At 60K (47% of 128K) there is more buffer to compact gracefully.
  // Override via AGENT_CTX_TRIGGER environment variable.
  trigger: parseInt(process.env.AGENT_CTX_TRIGGER ?? '60000', 10),
  // Keep raised from 3 → 5: retain more recent tool results so the agent
  // doesn't need to re-run LS/Grep/Read to recover lost context.
  keep: 5,
  clearAtLeast: 0,
  // Preserve read_file results — they are reference material the agent
  // may still need; clearing them triggers pointless re-reads (s06 insight).
  excludeTools: PRESERVE_RESULT_TOOLS,
};

interface ClearableEntry {
  /** Index of the tool result message in history */
  index: number;
  /** Estimated tokens saved by clearing */
  estimatedTokens: number;
  /** Name of tool that produced this result */
  toolName: string;
}

/**
 * Find tool-result messages that can be cleared.
 * Returns them oldest-first, excluding the `keep` most recent.
 */
function findClearableCandidates(
  history: Message[],
  cfg: ContextEditorConfig,
): ClearableEntry[] {
  // Build a map from toolCallId → toolName by scanning assistant messages
  const toolCallIdToName = new Map<string, string>();
  for (const msg of history) {
    if (msg.role !== 'assistant') continue;
    const tc = (msg as unknown as { toolCalls?: Array<{ id: string; name: string }> }).toolCalls;
    if (!Array.isArray(tc)) continue;
    for (const call of tc) {
      if (call.id && call.name) toolCallIdToName.set(call.id, call.name);
    }
  }

  const candidates: ClearableEntry[] = [];

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role !== 'tool') continue;
    if (msg.content === CLEARED_PLACEHOLDER) continue;

    // Resolve tool name: prefer lookup from assistant's toolCalls map,
    // fall back to legacy callId parsing (format: "${toolName}-${ts}-${rand}")
    const rawId = msg.toolCallId ?? 'unknown';
    const toolName = toolCallIdToName.get(rawId)
      ?? rawId.replace(/-\d+-[a-z0-9]+$/, '').replace(/-\d+$/, '');
    if (cfg.excludeTools.has(toolName)) continue;

    candidates.push({
      index: i,
      estimatedTokens: estimateMessageTokens(msg),
      toolName,
    });
  }

  // Exclude the `keep` most recent candidates
  if (candidates.length <= cfg.keep) return [];
  return candidates.slice(0, candidates.length - cfg.keep);
}

/**
 * C34: editContextIfNeeded — 返回清除摘要（包含工具名列表）供调用方显示更有意义的消息。
 *
 * Edit conversation history in-place by clearing old tool results.
 *
 * @param history  Mutable message array
 * @param config   Optional config (merged with defaults)
 * @returns        Number of tool results cleared (0 if nothing happened)
 */
export function editContextIfNeeded(
  history: Message[],
  config: Partial<ContextEditorConfig> = {},
): number {
  // Merge config — excludeTools is a Set so it can't be spread-merged safely;
  // handle it separately to avoid overwriting with undefined.
  const cfg: ContextEditorConfig = {
    ...DEFAULT_CTX_EDITOR_CONFIG,
    ...config,
    excludeTools: config.excludeTools ?? DEFAULT_CTX_EDITOR_CONFIG.excludeTools,
  };

  const estimatedTokens = estimateHistoryTokens(history);
  if (estimatedTokens <= cfg.trigger) return 0;

  log.info(
    `Context editing triggered: ~${estimatedTokens} tokens > trigger ${cfg.trigger}`,
  );

  const candidates = findClearableCandidates(history, cfg);
  if (candidates.length === 0) {
    log.debug('No clearable tool results found');
    return 0;
  }

  let clearedTokens = 0;
  let clearedCount = 0;
  // C34: track which tool names were cleared for user-facing message
  const clearedToolNames: string[] = [];

  for (const candidate of candidates) {
    if (cfg.clearAtLeast > 0 && clearedTokens >= cfg.clearAtLeast) break;

    const msg = history[candidate.index]!;
    const originalContent = typeof msg.content === 'string' ? msg.content : '';

    // D34: 清除前将 tool result 写入持久化存储（同步写，fail-open）
    // 仅对 >500chars 的有意义内容写入；LLM 可通过 Read 工具按路径恢复。
    // Mirrors claude-code toolResultStorage.ts + context-editor clearing pattern.
    let persistHint = '';
    if (originalContent.length > 500) {
      try {
        const { mkdirSync: _mkdir, writeFileSync: _write } = require('fs') as typeof import('fs');
        const { join: _join, resolve: _resolve } = require('path') as typeof import('path');
        const toolResultsDir = _resolve(process.env['HOME'] ?? '~', '.uagent', 'tool-results');
        const safeId = (msg.toolCallId ?? candidate.toolName)
          .replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
        _mkdir(toolResultsDir, { recursive: true });
        const filePath = _join(toolResultsDir, `${safeId}_cleared.txt`);
        _write(filePath, originalContent, 'utf-8');
        persistHint = `\n  Full content saved: ${filePath} (use Read tool to retrieve)`;
      } catch { /* D34: fail-open */ }
    }

    history[candidate.index] = {
      ...msg,
      content: `[cleared: ${candidate.toolName} result — re-run tool if needed${persistHint}]`,
    };
    clearedTokens += candidate.estimatedTokens;
    clearedCount++;
    // C34: accumulate distinct tool names (limit to 5 for readability)
    if (!clearedToolNames.includes(candidate.toolName) && clearedToolNames.length < 5) {
      clearedToolNames.push(candidate.toolName);
    }
  }

  log.info(
    `Cleared ${clearedCount} tool results (~${clearedTokens} tokens freed): ${clearedToolNames.join(', ')}`,
  );
  // C34: store cleared tool names for callers to surface in UI
  (editContextIfNeeded as { lastClearedToolNames?: string[] }).lastClearedToolNames = clearedToolNames;
  return clearedCount;
}
