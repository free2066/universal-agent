/**
 * src/query.ts — Agent query entry point
 *
 * Mirrors claude-code's query.ts.
 * This is the central module for running LLM queries through the agent loop.
 * Provides the main API surface for running agent turns.
 *
 * Usage:
 *   import { runQuery, streamQuery } from './query.js';
 *
 *   const result = await runQuery({ prompt: 'Hello, world!' });
 */

// ── Re-export query-layer types ───────────────────────────────────────────────

export type { QueryDeps } from './query/deps.js';
export {
  createReplQueryDeps,
  createSubagentQueryDeps,
  createCompactQueryDeps,
} from './query/deps.js';

export {
  MAX_OUTPUT_TOKENS,
  COMPACT_MAX_OUTPUT_TOKENS,
  MAX_API_RETRIES,
  FOREGROUND_RETRY_SOURCES,
} from './query/config.js';

export {
  BudgetTracker,
  TokenBudgetDecision,
  checkTokenBudget,
  estimateTurnBudget,
  buildBudgetStopMessage,
} from './query/tokenBudget.js';

// ── Main query runner ─────────────────────────────────────────────────────────

export {
  RunStreamOptions,
  CtxEvent,
  runStreamLoop,
  handlePendingConfirmation,
  expandMentions,
  captureIterationSnapshot,
} from './core/agent/agent-loop.js';
