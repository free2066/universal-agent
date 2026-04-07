/**
 * query/config.ts — Query-layer configuration constants
 *
 * Mirrors claude-code's query/config.ts.
 * Provides configuration for the agent query loop and LLM call behavior.
 */

// ── Token limits ──────────────────────────────────────────────────────────────

/** Maximum tokens for agent output in a single turn */
export const MAX_OUTPUT_TOKENS = 32_000;

/** Maximum tokens for compact (context compression) output */
export const COMPACT_MAX_OUTPUT_TOKENS = 8_096;

/** Maximum context window tokens before triggering reactive compact */
export const MAX_CONTEXT_WINDOW_TOKENS = 200_000;

/** Fraction of context window at which compact is triggered (90%) */
export const COMPACT_TRIGGER_THRESHOLD = 0.9;

/** Fraction of context window at which token warning is shown (80%) */
export const TOKEN_WARNING_THRESHOLD = 0.8;

// ── Retry configuration ───────────────────────────────────────────────────────

/** Maximum number of API retry attempts */
export const MAX_API_RETRIES = 3;

/** Base delay between retries in ms */
export const API_RETRY_BASE_DELAY_MS = 1_000;

/** Maximum retry delay in ms */
export const API_RETRY_MAX_DELAY_MS = 30_000;

// ── Foreground sources (retry on 529/rate-limit) ──────────────────────────────
// Mirrors claude-code's FOREGROUND_529_RETRY_SOURCES

export const FOREGROUND_RETRY_SOURCES = new Set<import('../core/agent/types.js').QuerySource>([
  'repl_main_thread',
  'repl_main_thread:compact',
  'agent_main',
  'compact',
  'agent:coordinator',
  'hook_agent',
  'side_question',
]);
