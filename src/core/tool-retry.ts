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
 * Usage: wrap LLM API calls that may hit 429/529 in unattended/CI mode.
 *
 * @param fn - Async function to execute (typically an LLM API call)
 * @param onHeartbeat - Optional callback for each 30s heartbeat (e.g. log to console)
 */
export async function withApiRateLimitRetry<T>(
  fn: () => Promise<T>,
  onHeartbeat?: (waitedMs: number) => void,
): Promise<T> {
  const unattended = process.env.AGENT_UNATTENDED_RETRY === '1';
  const startTime = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      // Always rethrow non-rate-limit errors immediately
      if (!isRateLimitError(err)) throw err;

      // If not in unattended mode, rethrow immediately
      if (!unattended) throw err;

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
