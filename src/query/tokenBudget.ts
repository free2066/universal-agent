/**
 * query/tokenBudget.ts — Per-turn token budget tracking
 *
 * Mirrors claude-code's query/tokenBudget.ts.
 * Moved from src/core/agent/token-budget.ts to align with claude-code structure.
 *
 * Re-exports everything from the original location for backward compatibility.
 */

export {
  BudgetTracker,
  TokenBudgetDecision,
  createBudgetTracker,
  checkTokenBudget,
  estimateTurnBudget,
  buildBudgetStopMessage,
} from '../core/agent/token-budget.js';
