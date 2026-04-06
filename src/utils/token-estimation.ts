/**
 * token-estimation.ts — Offline token estimation service
 *
 * Round 12 (I12): claude-code tokenEstimation.ts parity
 *
 * Provides a standalone token estimation service that:
 *   1. Re-exports core estimation functions from context-compressor.ts
 *   2. Adds estimateRemainingBudget() — compute remaining context capacity
 *      without making an API call (offline, synchronous)
 *   3. Adds estimateSystemPromptTokens() for system prompt cost estimation
 *
 * This allows any module to import token utilities without pulling in the
 * full context-compressor module (separation of concerns).
 *
 * Usage:
 *   import { estimateRemainingBudget } from '../../utils/token-estimation.js';
 *   const budget = estimateRemainingBudget(history, systemPrompt, model);
 *   if (budget.pct > 0.85) { ... trigger compact ... }
 */

import type { Message } from '../models/types.js';
import {
  estimateMessageTokens,
  estimateHistoryTokens,
  calculateTokenWarningState,
  type TokenWarningState,
} from '../core/context/context-compressor.js';
import { modelManager } from '../models/model-manager.js';

// Re-export for convenience — callers can import from a single location
export { estimateMessageTokens, estimateHistoryTokens, calculateTokenWarningState };
export type { TokenWarningState };

/**
 * Estimate the token cost of a system prompt string.
 * Uses the same CJK-aware heuristic as estimateMessageTokens().
 */
export function estimateSystemPromptTokens(systemPrompt: string): number {
  if (!systemPrompt) return 0;
  // Non-Latin character detection (CJK, Arabic, emoji → 2 chars/token)
  const nonLatinCount = (
    systemPrompt.match(
      /[\u0600-\u06FF\u0900-\u097F\u3000-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\u{1F300}-\u{1F9FF}]/gu,
    ) ?? []
  ).length;
  const nonLatinRatio = nonLatinCount / Math.max(systemPrompt.length, 1);
  const effectiveDivisor = 4 * (1 - nonLatinRatio) + 2 * nonLatinRatio;
  return Math.ceil(systemPrompt.length / effectiveDivisor);
}

/**
 * Token budget breakdown result.
 */
export interface TokenBudget {
  /** Total context window size for this model */
  total: number;
  /** Estimated tokens consumed by history messages */
  historyTokens: number;
  /** Estimated tokens consumed by system prompt */
  systemPromptTokens: number;
  /** Total estimated tokens in use */
  used: number;
  /** Remaining tokens available for new messages + LLM output */
  remaining: number;
  /** Fraction of context window in use (0.0 – 1.0) */
  pct: number;
  /** Warning state based on 4-tier threshold system */
  warningState: TokenWarningState;
}

/**
 * Compute the remaining token budget for the current session.
 * Offline and synchronous — does not make any API calls.
 *
 * Mirrors claude-code's token estimation service pattern.
 *
 * @param history       Current conversation history
 * @param systemPrompt  Current system prompt string (pass '' if unknown)
 * @param model         Model name (defaults to current main model)
 * @returns             Full token budget breakdown
 */
export function estimateRemainingBudget(
  history: Message[],
  systemPrompt = '',
  model = modelManager.getCurrentModel('main'),
): TokenBudget {
  const profile = [...modelManager.listProfiles()].find(
    (p) => p.name === model || p.modelName === model,
  );
  const total = profile?.contextLength ?? 128_000;

  const historyTokens = estimateHistoryTokens(history);
  const systemPromptTokens = estimateSystemPromptTokens(systemPrompt);
  const used = historyTokens + systemPromptTokens;
  const remaining = Math.max(0, total - used);
  const pct = used / total;
  const warningState = calculateTokenWarningState(used, model);

  return { total, historyTokens, systemPromptTokens, used, remaining, pct, warningState };
}

/**
 * Format a token budget as a human-readable status string.
 * Useful for status bars, debug output, and slash commands like /tokens.
 *
 * Example output: "42.3K / 200K (21%) [ok]"
 */
export function formatTokenBudget(budget: TokenBudget): string {
  const fmt = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000   ? `${(n / 1_000).toFixed(1)}K`
    : String(n);

  return `${fmt(budget.used)} / ${fmt(budget.total)} (${Math.round(budget.pct * 100)}%) [${budget.warningState}]`;
}
