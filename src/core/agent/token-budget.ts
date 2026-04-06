/**
 * token-budget.ts -- Per-turn token budget tracking with diminishing returns detection
 *
 * Mirrors claude-code's tokenBudget.ts design.
 *
 * Key behaviors (claude-code parity):
 * 1. Sub-agents bypass budget checks entirely (have `isSubAgent=true`)
 * 2. Diminishing returns: if continuationCount>=3 AND tokenDelta<500 for 2+ consecutive
 *    rounds, the turn is considered "stalling" and should stop
 * 3. 90% threshold: if used tokens < budget*0.9 → nudge message and continue
 * 4. Budget exhausted → stop event
 *
 * Integration:
 *   - agent-loop.ts creates a `BudgetTracker` at start of each runStreamLoop call
 *   - After each LLM response, calls checkTokenBudget() to determine whether to continue
 *   - If stopReason returned, injects a STOP message and breaks the loop
 *
 * Round 5: claude-code tokenBudget.ts parity
 */

import { createLogger } from '../logger.js';

const log = createLogger('token-budget');

// ── Constants (matching claude-code values) ───────────────────────────────────

/** Usage fraction at which we signal "near limit" (90%) */
const COMPLETION_THRESHOLD = 0.9;

/** Token delta below which we consider a continuation "diminishing" */
const DIMINISHING_DELTA_THRESHOLD = 500;

/** Consecutive diminishing iterations before stopping */
const DIMINISHING_CONSECUTIVE_REQUIRED = 2;

/** Minimum continuations before diminishing check kicks in */
const DIMINISHING_MIN_CONTINUATIONS = 3;

// ── Types ─────────────────────────────────────────────────────────────────────

/** Mutable tracker — one instance per runStreamLoop() call */
export interface BudgetTracker {
  /** Number of times we have continued after a nudge */
  continuationCount: number;
  /** Token count from previous iteration (for delta calculation) */
  lastTurnTokens: number;
  /** Count of consecutive diminishing iterations */
  consecutiveDiminishing: number;
  /** Timestamp when the turn started */
  startedAt: number;
}

export function createBudgetTracker(): BudgetTracker {
  return {
    continuationCount: 0,
    lastTurnTokens: 0,
    consecutiveDiminishing: 0,
    startedAt: Date.now(),
  };
}

// ── Decision type ─────────────────────────────────────────────────────────────

export type TokenBudgetDecision =
  | { action: 'continue'; nudgeMessage?: string }
  | { action: 'stop'; reason: 'budget_exhausted' | 'diminishing_returns' | 'sub_agent' };

// ── Main budget check function ────────────────────────────────────────────────

/**
 * Check whether the current turn should continue or stop.
 *
 * Call this after each LLM response to get the budget decision.
 *
 * @param tracker - Mutable BudgetTracker (modified in place)
 * @param currentTokens - Token count for the current turn so far
 * @param budget - Maximum tokens allowed for this turn (null = no limit)
 * @param isSubAgent - If true, always return 'continue' (sub-agents bypass budget)
 */
export function checkTokenBudget(
  tracker: BudgetTracker,
  currentTokens: number,
  budget: number | null,
  isSubAgent: boolean = false,
): TokenBudgetDecision {
  // Sub-agents completely bypass budget checks (claude-code parity)
  if (isSubAgent) {
    log.debug('token-budget: sub-agent → skipping budget check');
    return { action: 'continue' };
  }

  // No budget set → continue freely
  if (budget === null || budget <= 0) {
    return { action: 'continue' };
  }

  const tokenDelta = currentTokens - tracker.lastTurnTokens;
  const usageRatio = currentTokens / budget;

  log.debug(
    `token-budget: tokens=${currentTokens}/${budget} (${(usageRatio * 100).toFixed(1)}%), delta=${tokenDelta}, continuations=${tracker.continuationCount}`
  );

  // Check diminishing returns (only after minimum continuations)
  if (tracker.continuationCount >= DIMINISHING_MIN_CONTINUATIONS) {
    const isDiminishing = tokenDelta < DIMINISHING_DELTA_THRESHOLD;
    if (isDiminishing) {
      tracker.consecutiveDiminishing++;
    } else {
      tracker.consecutiveDiminishing = 0;
    }

    if (tracker.consecutiveDiminishing >= DIMINISHING_CONSECUTIVE_REQUIRED) {
      log.debug(`token-budget: diminishing returns detected (delta=${tokenDelta}, consecutive=${tracker.consecutiveDiminishing}) → stopping`);
      return {
        action: 'stop',
        reason: 'diminishing_returns',
      };
    }
  }

  // Update tracker
  tracker.lastTurnTokens = currentTokens;

  // Budget exhausted check
  if (usageRatio >= 1.0) {
    log.debug('token-budget: budget exhausted → stopping');
    return {
      action: 'stop',
      reason: 'budget_exhausted',
    };
  }

  // Near-limit nudge (between 90% and 100%)
  if (usageRatio >= COMPLETION_THRESHOLD) {
    tracker.continuationCount++;
    const remaining = budget - currentTokens;
    const nudgeMessage = `[System: You have used ${(usageRatio * 100).toFixed(0)}% of your token budget (${remaining.toLocaleString()} tokens remaining). Please wrap up and provide your final answer now.]`;
    log.debug(`token-budget: near limit (${(usageRatio * 100).toFixed(0)}%) → nudge`);
    return {
      action: 'continue',
      nudgeMessage,
    };
  }

  // Under threshold — continue normally
  return { action: 'continue' };
}

// ── Budget helper ─────────────────────────────────────────────────────────────

/**
 * Estimate token budget from context window size.
 *
 * Token budget is set at the start of a turn based on the remaining context window.
 * This matches claude-code's approach: budget = contextWindow * BUDGET_FRACTION
 */
const BUDGET_FRACTION = 0.15; // 15% of context window for a single turn's output

export function estimateTurnBudget(contextWindowTokens: number): number {
  return Math.floor(contextWindowTokens * BUDGET_FRACTION);
}

/**
 * Build the stop message to inject when budget/diminishing-returns triggers.
 */
export function buildBudgetStopMessage(reason: 'budget_exhausted' | 'diminishing_returns'): string {
  if (reason === 'budget_exhausted') {
    return '[System: Token budget exhausted. Please provide a final summary of what was accomplished and any remaining steps.]';
  }
  return '[System: Detected diminishing returns in output generation. Please provide a concise final answer based on what you have so far.]';
}
