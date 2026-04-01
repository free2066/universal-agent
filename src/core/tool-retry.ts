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

export const DEFAULT_TOOL_RETRY_CONFIG: ToolRetryConfig = {
  maxRetries: 2,
  initialDelayMs: 500,
  backoffFactor: 2.0,
  maxDelayMs: 10_000,
  jitter: true,
  // By default, skip retry for HTTP 4xx errors (client errors are permanent)
  retryOn: isRetryableError,
};

/**
 * Default retry predicate: retry on 5xx / network errors; skip on 4xx client errors.
 * Checks the error message for common HTTP status codes or fetch failure signals.
 */
export function isRetryableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Explicitly skip 4xx (client errors): bad request, auth, not found, rate-limit
  // Note: 429 (rate-limit) is technically retryable but needs back-pressure logic;
  // leaving it as non-retryable here avoids hammering the endpoint.
  const clientError = /\b4[0-9]{2}\b/.test(msg);
  if (clientError) return false;
  // Retry on 5xx, network failure, timeout, ECONNRESET, etc.
  return true;
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
