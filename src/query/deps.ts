/**
 * query/deps.ts — Query layer dependency injection
 *
 * Mirrors claude-code's query/deps.ts.
 * Provides factory functions for query-layer dependencies.
 */

import type { QuerySource } from '../core/agent/types.js';

// ── Query context ─────────────────────────────────────────────────────────────

export interface QueryDeps {
  /** Source identifier for this query (used for retry gating, cache TTL) */
  querySource: QuerySource;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Whether this is a subagent (bypasses token budget) */
  isSubAgent?: boolean;
  /** Maximum number of turns (for coordinator/plan mode) */
  maxTurns?: number;
  /** Session ID override (for subagents) */
  sessionId?: string;
}

/**
 * Create a default QueryDeps for a main-thread REPL query.
 */
export function createReplQueryDeps(overrides?: Partial<QueryDeps>): QueryDeps {
  return {
    querySource: 'repl_main_thread',
    isSubAgent: false,
    ...overrides,
  };
}

/**
 * Create QueryDeps for a subagent invocation.
 */
export function createSubagentQueryDeps(overrides?: Partial<QueryDeps>): QueryDeps {
  return {
    querySource: 'agent',
    isSubAgent: true,
    ...overrides,
  };
}

/**
 * Create QueryDeps for compact (context compression).
 */
export function createCompactQueryDeps(overrides?: Partial<QueryDeps>): QueryDeps {
  return {
    querySource: 'compact',
    isSubAgent: false,
    ...overrides,
  };
}

/**
 * Check if a query source is foreground (retries on 529).
 */
export function isForegroundSource(source: QuerySource): boolean {
  const { FOREGROUND_RETRY_SOURCES } = require('./config.js');
  return FOREGROUND_RETRY_SOURCES.has(source);
}
