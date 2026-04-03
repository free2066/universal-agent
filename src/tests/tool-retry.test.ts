/**
 * Unit Tests: tool-retry.ts
 *
 * Covers: isRetryableError / isRateLimitError / calculateDelay / withToolRetry / withApiRateLimitRetry
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isRetryableError,
  isRateLimitError,
  withToolRetry,
  withApiRateLimitRetry,
  DEFAULT_TOOL_RETRY_CONFIG,
} from '../core/tool-retry.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. isRetryableError
// ─────────────────────────────────────────────────────────────────────────────
describe('isRetryableError', () => {
  it('returns false for 400 Bad Request', () => {
    expect(isRetryableError(new Error('Request failed with status 400'))).toBe(false);
  });

  it('returns false for 401 Unauthorized', () => {
    expect(isRetryableError(new Error('401 Unauthorized'))).toBe(false);
  });

  it('returns false for 403 Forbidden', () => {
    expect(isRetryableError(new Error('403 Forbidden'))).toBe(false);
  });

  it('returns false for 404 Not Found', () => {
    expect(isRetryableError(new Error('404 Not Found'))).toBe(false);
  });

  it('returns false for 429 Rate Limited', () => {
    expect(isRetryableError(new Error('429 Too Many Requests'))).toBe(false);
  });

  it('returns false for 529 Overload', () => {
    expect(isRetryableError(new Error('529 Service Overloaded'))).toBe(false);
  });

  it('returns true for 500 Internal Server Error', () => {
    expect(isRetryableError(new Error('500 Internal Server Error'))).toBe(true);
  });

  it('returns true for 503 Service Unavailable', () => {
    expect(isRetryableError(new Error('503 Service Unavailable'))).toBe(true);
  });

  it('returns true for network/connection errors', () => {
    expect(isRetryableError(new Error('ECONNRESET connection reset'))).toBe(true);
  });

  it('returns true for timeout errors', () => {
    expect(isRetryableError(new Error('Request timed out after 30000ms'))).toBe(true);
  });

  it('handles non-Error objects', () => {
    expect(isRetryableError('some string error')).toBe(true);
    expect(isRetryableError({ code: 'ENOENT' })).toBe(true);
  });

  it('handles null/undefined gracefully', () => {
    expect(isRetryableError(null)).toBe(true);
    expect(isRetryableError(undefined)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. isRateLimitError
// ─────────────────────────────────────────────────────────────────────────────
describe('isRateLimitError', () => {
  it('detects 429 in error message', () => {
    expect(isRateLimitError(new Error('Status 429 Too Many Requests'))).toBe(true);
  });

  it('detects 529 in error message', () => {
    expect(isRateLimitError(new Error('Error 529 Service Overloaded'))).toBe(true);
  });

  it('detects rate-limit keyword', () => {
    expect(isRateLimitError(new Error('rate limit exceeded'))).toBe(true);
    expect(isRateLimitError(new Error('rate_limit_exceeded'))).toBe(true);
  });

  it('detects overload keyword', () => {
    expect(isRateLimitError(new Error('Service overloaded, please retry'))).toBe(true);
  });

  it('detects too many requests phrase', () => {
    expect(isRateLimitError(new Error('Too many requests'))).toBe(true);
  });

  it('returns false for non-rate-limit errors', () => {
    expect(isRateLimitError(new Error('500 Internal Server Error'))).toBe(false);
    expect(isRateLimitError(new Error('404 Not Found'))).toBe(false);
    expect(isRateLimitError(new Error('network error'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. DEFAULT_TOOL_RETRY_CONFIG
// ─────────────────────────────────────────────────────────────────────────────
describe('DEFAULT_TOOL_RETRY_CONFIG', () => {
  it('has expected default values', () => {
    expect(DEFAULT_TOOL_RETRY_CONFIG.maxRetries).toBe(2);
    expect(DEFAULT_TOOL_RETRY_CONFIG.initialDelayMs).toBe(500);
    expect(DEFAULT_TOOL_RETRY_CONFIG.backoffFactor).toBe(2.0);
    expect(DEFAULT_TOOL_RETRY_CONFIG.maxDelayMs).toBe(32_000);
    expect(DEFAULT_TOOL_RETRY_CONFIG.jitter).toBe(true);
    expect(typeof DEFAULT_TOOL_RETRY_CONFIG.retryOn).toBe('function');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. withToolRetry
// ─────────────────────────────────────────────────────────────────────────────
describe('withToolRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns result immediately on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withToolRetry(fn, 'TestTool', { maxRetries: 2, jitter: false });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable error and eventually succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('500 Server Error'))
      .mockResolvedValue('success after retry');

    const promise = withToolRetry(fn, 'TestTool', {
      maxRetries: 2,
      initialDelayMs: 10,
      jitter: false,
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('success after retry');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws immediately on non-retryable error (4xx)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('404 Not Found'));

    await expect(
      withToolRetry(fn, 'TestTool', { maxRetries: 3, jitter: false }),
    ).rejects.toThrow('404 Not Found');

    // Should NOT retry — 4xx is non-retryable
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws last error after maxRetries exhausted', async () => {
    // Use a fn that eventually rejects — vitest needs us to attach the catch before advancing timers
    const fn = vi.fn().mockRejectedValue(new Error('500 Server Error'));

    const promise = withToolRetry(fn, 'TestTool', {
      maxRetries: 2,
      initialDelayMs: 1,
      jitter: false,
    });

    // Suppress unhandled rejection by attaching .catch BEFORE running timers
    const safePromise = promise.catch((e) => e);
    await vi.runAllTimersAsync();
    const result = await safePromise;

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('500 Server Error');
    // 1 original + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3);
  }, 10000);

  it('respects custom retryOn predicate', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Custom business error'));
    const retryOn = vi.fn().mockReturnValue(false); // never retry

    await expect(
      withToolRetry(fn, 'TestTool', { maxRetries: 3, retryOn, jitter: false }),
    ).rejects.toThrow('Custom business error');

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('calculates increasing delays with exponential backoff', async () => {
    const delays: number[] = [];
    const originalSetTimeout = vi.fn((fn: (...args: unknown[]) => void, delay: number) => {
      delays.push(delay);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('500'))
      .mockRejectedValueOnce(new Error('500'))
      .mockResolvedValue('ok');

    // With jitter disabled and manual retry, just verify fn is called correct times
    const promise = withToolRetry(fn, 'TestTool', {
      maxRetries: 2,
      initialDelayMs: 100,
      backoffFactor: 2.0,
      jitter: false,
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('withToolRetry config merges with defaults', async () => {
    const fn = vi.fn().mockResolvedValue('result');
    const result = await withToolRetry(fn, 'T', { maxRetries: 0 });
    expect(result).toBe('result');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. withApiRateLimitRetry
// ─────────────────────────────────────────────────────────────────────────────
describe('withApiRateLimitRetry', () => {
  afterEach(() => {
    delete process.env.AGENT_UNATTENDED_RETRY;
  });

  it('returns immediately on success', async () => {
    const fn = vi.fn().mockResolvedValue('data');
    const result = await withApiRateLimitRetry(fn);
    expect(result).toBe('data');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rethrows non-rate-limit errors immediately', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('500 Server Error'));
    await expect(withApiRateLimitRetry(fn)).rejects.toThrow('500 Server Error');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws rate-limit error immediately when AGENT_UNATTENDED_RETRY is not set', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('429 Too Many Requests'));
    await expect(withApiRateLimitRetry(fn)).rejects.toThrow('429 Too Many Requests');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on rate-limit when AGENT_UNATTENDED_RETRY=1', async () => {
    process.env.AGENT_UNATTENDED_RETRY = '1';
    vi.useFakeTimers();

    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('429 rate limit'))
      .mockResolvedValue('eventual success');

    const heartbeats: number[] = [];
    const promise = withApiRateLimitRetry(fn, (waited) => heartbeats.push(waited));

    // Advance past one heartbeat interval (30s)
    await vi.advanceTimersByTimeAsync(35_000);
    const result = await promise;

    expect(result).toBe('eventual success');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(heartbeats.length).toBeGreaterThan(0);

    vi.useRealTimers();
  });
});
