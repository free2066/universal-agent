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

import type { Message } from '../models/types.js';
import { estimateHistoryTokens, estimateMessageTokens } from './context-compressor.js';
import { createLogger } from './logger.js';

const log = createLogger('ctx-editor');

const CLEARED_PLACEHOLDER = '[cleared]';

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

export const DEFAULT_CTX_EDITOR_CONFIG: ContextEditorConfig = {
  trigger: 80_000,
  keep: 3,
  clearAtLeast: 0,
  excludeTools: new Set(),
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
    // callId format is "${toolName}-${timestamp}", but toolName may itself contain
    // hyphens (e.g. "web-search"), so we strip only the trailing "-<digits>" suffix.
    const rawId = msg.toolCallId ?? 'unknown';
    const toolName = rawId.replace(/-\d+$/, '');
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
