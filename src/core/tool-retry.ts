/**
 * Tool Retry with Exponential Backoff + Jitter
 *
 * Inspired by kwaibi's ToolRetryInterceptor pattern.
 *
 * Automatically retries failed tool executions with configurable
 * exponential backoff and optional ±25% random jitter.
 *
 * Usage:
 *   const result = await withToolRetry(() => registry.execute(name, args), name);
 */

import { createLogger } from './logger.js';

const log = createLogger('tool-retry');

export interface ToolRetryConfig {
  /** Maximum number of retries (default: 2) */
  maxRetries: number;
  /** Initial delay in ms (default: 500) */
  initialDelayMs: number;
  /** Multiplier per retry (default: 2.0) */
  backoffFactor: number;
  /** Maximum delay cap in ms (default: 10000) */
  maxDelayMs: number;
  /** Add ±25% random jitter (default: true) */
  jitter: boolean;
  /** Only retry if predicate returns true (default: retry all) */
  retryOn?: (err: unknown) => boolean;
}

/**
 * Default retry configuration.
 *
 * maxDelayMs aligned to 32s per Claude Code production data (kstack #15375):
 * "指数退避+加性抖动，最大退避32s" — 32s cap prevents excessive wait
 * while still giving overloaded backends time to recover.
 */
export const DEFAULT_TOOL_RETRY_CONFIG: ToolRetryConfig = {
  maxRetries: 2,
  initialDelayMs: 500,
  backoffFactor: 2.0,
  maxDelayMs: 32_000,  // 32s cap (aligned to Claude Code's observed optimal, kstack #15375)
  jitter: true,
  // By default, skip retry for HTTP 4xx errors (client errors are permanent)
  retryOn: isRetryableError,
};

/**
 * Default retry predicate: retry on 5xx / network errors; skip on 4xx client errors.
 * Checks the error message for common HTTP status codes or fetch failure signals.
 *
 * Note: 429 (rate-limit) and 529 (overload) are NOT retried here because they
 * need prolonged back-pressure (30s heartbeat intervals, 6h hard cap).
 * Use withApiRateLimitRetry() for those cases (kstack #15375: AGENT_UNATTENDED_RETRY).
 */
export function isRetryableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Skip ALL 4xx (client errors): bad request, auth, not found, rate-limit (429), etc.
  const clientError = /\b4[0-9]{2}\b/.test(msg);
  if (clientError) return false;
  // Skip 529 (overload — handled by withApiRateLimitRetry instead)
  if (/\b529\b/.test(msg)) return false;
  // Retry on 5xx, network failure, timeout, ECONNRESET, etc.
  return true;
}

// ── Rate-limit / Overload Retry (kstack #15375: AGENT_UNATTENDED_RETRY) ───────
//
// Claude Code implements a second retry tier for 429/529 API responses that is
// distinct from normal tool retries:
//   - 30-second heartbeat intervals (not exponential backoff)
//   - Indefinite retries until 6-hour hard cap
//   - Prints heartbeat dots every 30s so CI logs show progress
//   - Only active when AGENT_UNATTENDED_RETRY=1 (opt-in for CI/batch mode)
//
// This mirrors Claude Code's observed behavior: in --print mode with 529 responses
// the agent would wait in 30s increments, logging "..." to stderr, up to ~6h.

/** Maximum total wait time for rate-limit retry (6 hours, matching Claude Code) */
const RATE_LIMIT_MAX_WAIT_MS = 6 * 60 * 60 * 1000; // 6h

/** Heartbeat interval — wait and log '.' every 30s (matches Claude Code's 30s cadence) */
const RATE_LIMIT_HEARTBEAT_MS = 30_000;

// ── Interactive 429 Retry (short exponential backoff for free-tier models) ─────
//
// Free models (wanqing, Gemini free, Groq free) have low QPS limits.
// In interactive mode, the previous behavior was fail-fast on 429, which
// caused the agent to abort mid-task with an unhelpful error.
//
// New behavior: up to 3 short retries with exponential backoff + jitter:
//   Attempt 1: ~5s   (5000 ± 25%)
//   Attempt 2: ~10s  (10000 ± 25%)
//   Attempt 3: ~20s  (20000 ± 25%)
// If all 3 fail, rethrow so the user sees the error.

/** Max interactive-mode retries for 429/529 */
const INTERACTIVE_RATE_LIMIT_MAX_RETRIES = 3;
/** Initial backoff for interactive 429 retry: 5 seconds */
const INTERACTIVE_RATE_LIMIT_INITIAL_MS = 5_000;
/** Maximum backoff cap: 60 seconds */
const INTERACTIVE_RATE_LIMIT_MAX_MS = 60_000;

/**
 * Detect 429 (Too Many Requests) or 529 (Overload) from an error.
 */
export function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(429|529)\b|rate.?limit|too.many.request|overload/i.test(msg);
}

/**
 * Execute `fn` with 429/529 rate-limit back-pressure retry.
 *
 * Behavior:
 *   - If AGENT_UNATTENDED_RETRY=1: retry indefinitely up to RATE_LIMIT_MAX_WAIT_MS
 *   - Otherwise: same as isRetryableError (fail fast on rate-limit)
 *   - Prints heartbeat '.' every 30s to keep CI logs alive
 *   - Hard abort after 6 hours total wait (prevents infinite blocking)
 *
 * C18 (claude-code withRetry.ts FOREGROUND_529_RETRY_SOURCES parity):
 *   - Background tasks (querySource='tool_summary'/'background_*'/'session_memory')
 *     → 529 fails immediately (no retries, preserves retry budget for foreground)
 *   - Foreground tasks (querySource='agent_main'/'compact') → normal retry logic
 *
 * @param fn - Async function to execute (typically an LLM API call)
 * @param onHeartbeat - Optional callback for each 30s heartbeat (e.g. log to console)
 * @param querySource - C18: Caller identity for 529 retry gating (default: 'agent_main')
 */
export async function withApiRateLimitRetry<T>(
  fn: () => Promise<T>,
  onHeartbeat?: (waitedMs: number) => void,
  querySource?: import('./agent/types.js').QuerySource,
): Promise<T> {
  const unattended = process.env.AGENT_UNATTENDED_RETRY === '1';
  const startTime = Date.now();

  // C18/E25: Background tasks should fail immediately on 529 — no retries
  // Mirrors claude-code FOREGROUND_529_RETRY_SOURCES Set (withRetry.ts L62-88)
  // E25: Expanded to match full QuerySource enumeration
  const FOREGROUND_SOURCES = new Set<import('./agent/types.js').QuerySource>([
    'repl_main_thread',           // Primary interactive source
    'repl_main_thread:compact',   // Main thread compaction
    'agent_main',                 // Backward compat alias
    'compact',                    // Compaction (foreground-ish)
    'agent:coordinator',          // Coordinator agent is user-facing
    'hook_agent',                 // Hook agents are user-initiated
    'side_question',              // Side questions are user-facing
  ]);
  const isBackground = querySource !== undefined && !FOREGROUND_SOURCES.has(querySource);

  // ── Interactive mode: short exponential backoff (up to 3 retries) ──────────
  // Free-tier models (wanqing, Gemini free, Groq) have low QPS limits.
  // Instead of fail-fast, give the rate limiter a chance to recover.
  if (!unattended) {
    let interactiveRetry = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await fn();
      } catch (err) {
        if (!isRateLimitError(err)) throw err;           // non-429: rethrow immediately
        // C18: Background tasks fail immediately on 529 — don't waste retries
        if (isBackground) throw err;
        if (interactiveRetry >= INTERACTIVE_RATE_LIMIT_MAX_RETRIES) throw err; // give up

        // Exponential backoff: 5s → 10s → 20s  (±25% jitter)
        const base = Math.min(
          INTERACTIVE_RATE_LIMIT_INITIAL_MS * Math.pow(2, interactiveRetry),
          INTERACTIVE_RATE_LIMIT_MAX_MS,
        );
        const jitter = base * 0.25 * (Math.random() * 2 - 1);
        const wait = Math.round(base + jitter);
        interactiveRetry++;

        log.warn(
          `Rate-limit/overload (429/529) — interactive retry ${interactiveRetry}/${INTERACTIVE_RATE_LIMIT_MAX_RETRIES} ` +
          `in ${Math.round(wait / 1000)}s…`,
        );
        onHeartbeat?.(Date.now() - startTime);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }

  // ── Unattended / CI mode: 30s heartbeat, up to 6 hours ─────────────────────
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      // Always rethrow non-rate-limit errors immediately
      if (!isRateLimitError(err)) throw err;
      // C18: Background tasks fail immediately even in unattended mode
      if (isBackground) throw err;

      const elapsed = Date.now() - startTime;

      // Hard cap: 6 hours total wait
      if (elapsed >= RATE_LIMIT_MAX_WAIT_MS) {
        log.error(`Rate-limit retry exceeded 6h hard cap — giving up`);
        throw err;
      }

      // Wait 30s (heartbeat interval)
      const remaining = RATE_LIMIT_MAX_WAIT_MS - elapsed;
      const wait = Math.min(RATE_LIMIT_HEARTBEAT_MS, remaining);

      log.warn(
        `Rate-limit/overload error — waiting ${Math.round(wait / 1000)}s ` +
        `(${Math.round(elapsed / 60000)}min elapsed, 6h max)`,
      );
      onHeartbeat?.(elapsed);

      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/**
 * Calculate delay for retry attempt `n` (0-indexed).
 */
function calculateDelay(n: number, cfg: ToolRetryConfig): number {
  let delay = cfg.initialDelayMs * Math.pow(cfg.backoffFactor, n);
  delay = Math.min(delay, cfg.maxDelayMs);
  if (cfg.jitter) {
    // ±25% jitter
    delay = delay * (0.75 + Math.random() * 0.5);
  }
  return Math.round(delay);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute `fn` with automatic retry on failure.
 *
 * @param fn - Async function to execute
 * @param toolName - Tool name for logging
 * @param config - Optional retry configuration (merged with defaults)
 * @returns Result of `fn`
 * @throws Last error after all retries exhausted
 */
export async function withToolRetry<T>(
  fn: () => Promise<T>,
  toolName: string,
  config: Partial<ToolRetryConfig> = {},
): Promise<T> {
  const cfg: ToolRetryConfig = { ...DEFAULT_TOOL_RETRY_CONFIG, ...config };

  let lastErr: unknown;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      // Check if we should retry this error (always evaluated; default retryOn skips 4xx)
      if (cfg.retryOn && !cfg.retryOn(err)) {
        const errMsg2 = err instanceof Error ? err.message : String(err);
        log.debug(`Tool "${toolName}" error is not retryable (skipping retries): ${errMsg2}`);
        throw err;
      }

      if (attempt >= cfg.maxRetries) {
        // Last attempt failed
        break;
      }

      const delay = calculateDelay(attempt, cfg);
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn(`Tool "${toolName}" failed (attempt ${attempt + 1}/${cfg.maxRetries + 1}), retrying in ${delay}ms: ${errMsg}`);
      await sleep(delay);
    }
  }

  const errMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  log.error(`Tool "${toolName}" failed after ${cfg.maxRetries + 1} attempts: ${errMsg}`);
  throw lastErr;
}
