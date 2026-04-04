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

/** Age threshold for microcompact — lowered to 15min for high-frequency tasks (code review, refactor).
 *  Original: 60min. Reduced to prevent context buildup during long-running sessions.
 */
const MICROCOMPACT_AGE_MS = parseInt(process.env.AGENT_MICROCOMPACT_AGE_MS ?? String(15 * 60 * 1000), 10);

/** Only microcompact tool results over this char count (small results stay).
 *  Lowered from 500 → 200 to catch medium-sized LS/Grep results earlier.
 */
const MICROCOMPACT_MIN_CHARS = 200;

export function microcompact(history: Message[]): number {
  const now = Date.now();
  let cleared = 0;

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role !== 'tool') continue;
    if (msg.content === CLEARED_PLACEHOLDER) continue;
    if (msg.content.length < MICROCOMPACT_MIN_CHARS) continue;

    // Check tool name — never clear read_file results (they're reference material)
    const rawId = msg.toolCallId ?? '';
    const toolName = rawId.replace(/-\d+-[a-z0-9]+$/, '').replace(/-\d+$/, '');
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
        content: `[microcompact: tool result cleared after ${Math.round((now - (msgTs ?? now)) / 60000)}min — re-run tool if needed]`,
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
  const candidates: ClearableEntry[] = [];

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role !== 'tool') continue;
    if (msg.content === CLEARED_PLACEHOLDER) continue;

    // Identify tool name from toolCallId.
    // callId format is "${toolName}-${timestamp}-${random5chars}" (see agent.ts).
    // toolName may itself contain hyphens (e.g. "web-search"), so we strip only
    // the trailing "-<digits>-<alphanum>" or "-<digits>" suffix.
    const rawId = msg.toolCallId ?? 'unknown';
    const toolName = rawId.replace(/-\d+-[a-z0-9]+$/, '').replace(/-\d+$/, '');
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

  for (const candidate of candidates) {
    if (cfg.clearAtLeast > 0 && clearedTokens >= cfg.clearAtLeast) break;

    history[candidate.index] = {
      ...history[candidate.index],
      content: CLEARED_PLACEHOLDER,
    };
    clearedTokens += candidate.estimatedTokens;
    clearedCount++;
  }

  log.info(
    `Cleared ${clearedCount} tool results (~${clearedTokens} tokens freed)`,
  );
  return clearedCount;
}
