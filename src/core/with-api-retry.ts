/**
 * C20: withApiRetry — 529 (Overloaded) + 429 (Rate Limit) 统一重试封装
 *
 * Mirrors claude-code src/services/api/withRetry.ts核心逻辑：
 *   - 529 Overloaded: 前台最多 MAX_529_RETRIES=3 次，后台立即抛出
 *   - 429 Rate Limit: 已有 withApiRateLimitRetry()，此处扩展为统一入口
 *   - Unattended 模式（AGENT_UNATTENDED=1）: 529 也无限等待（不立即抛出）
 *
 * 前台/后台区分（claude-code FOREGROUND_529_RETRY_SOURCES parity）：
 *   - 前台（isBackground=false, 默认）: 重试 3 次，达到上限触发模型 fallback
 *   - 后台（isBackground=true / AGENT_BACKGROUND=1）: 529 立即抛出，不阻塞
 *
 * SWR 语义：
 *   第 1-3 次失败 → 等待 2^attempt × BASE_DELAY_MS（jitter 后）再重试
 *   第 3 次仍失败 → 抛出 OverloadedError（caller 触发 ModelFallbackChain）
 */

/** Maximum 529 retries in foreground mode (mirrors claude-code MAX_529_RETRIES) */
const MAX_529_RETRIES = 3;

/** Base delay between retries (exponential backoff: 2^attempt × BASE_DELAY_MS) */
const BASE_DELAY_MS = 1_000;

/** Maximum retry delay cap (60 seconds) */
const MAX_DELAY_MS = 60_000;

/** Whether running in unattended/background mode (persistent retry) */
const isBackground = () =>
  process.env.AGENT_BACKGROUND === '1' || process.env.AGENT_HEADLESS === '1';

const isUnattended = () => process.env.AGENT_UNATTENDED === '1';

/**
 * C20: Detect if an error is a 529 Overloaded error from Anthropic API.
 * Matches HTTP 529 status code or error message patterns.
 */
export function isOverloadedError(err: unknown): boolean {
  if (!err) return false;
  const e = err as Record<string, unknown>;

  // Anthropic SDK OverloadedError has status=529
  if (typeof e['status'] === 'number' && e['status'] === 529) return true;

  // Check error message patterns
  const msg = (e['message'] ?? String(err)).toString().toLowerCase();
  if (msg.includes('overloaded') || msg.includes('529')) return true;

  // Check error name/type
  if (typeof e['name'] === 'string' && e['name'].toLowerCase().includes('overload')) return true;
  if (typeof e['error'] === 'object' && e['error'] !== null) {
    const inner = e['error'] as Record<string, unknown>;
    if (typeof inner['type'] === 'string' && inner['type'] === 'overloaded_error') return true;
  }

  return false;
}

/**
 * C20: Detect if an error is a 429 Rate Limit error from Anthropic API.
 */
export function isRateLimitError(err: unknown): boolean {
  if (!err) return false;
  const e = err as Record<string, unknown>;
  if (typeof e['status'] === 'number' && e['status'] === 429) return true;
  const msg = (e['message'] ?? String(err)).toString().toLowerCase();
  return msg.includes('rate_limit') || msg.includes('rate limit') || msg.includes('429');
}

/**
 * C20: Parse retry-after header from rate limit error.
 * Returns delay in milliseconds, or null if not available.
 */
function parseRetryAfterMs(err: unknown): number | null {
  const e = err as Record<string, unknown>;
  const headers = e['headers'] as Record<string, string> | undefined;
  if (!headers) return null;

  const retryAfter = headers['retry-after'] ?? headers['x-ratelimit-reset-requests'];
  if (!retryAfter) return null;

  // "retry-after" can be seconds (number) or HTTP date string
  const seconds = parseFloat(retryAfter);
  if (!isNaN(seconds)) return Math.ceil(seconds * 1000);

  // Try parsing as date
  const date = new Date(retryAfter);
  if (!isNaN(date.getTime())) {
    const delayMs = date.getTime() - Date.now();
    return Math.max(0, delayMs);
  }
  return null;
}

/**
 * C20: withApiRetry — wrap an LLM call with 529/429 retry logic.
 *
 * Usage:
 *   const response = await withApiRetry(
 *     () => llm.streamChat(opts, onChunk),
 *     (msg) => onProgress(msg),
 *   );
 *
 * @param fn             The async function to retry
 * @param onRetryMessage Called with a human-readable retry status message
 * @returns Result of fn on success
 * @throws On non-retryable errors, or after exhausting retries
 */
export async function withApiRetry<T>(
  fn: () => Promise<T>,
  onRetryMessage?: (msg: string) => void,
): Promise<T> {
  let attempt529 = 0;
  let attempt429 = 0;
  const startMs = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      // ── 529 Overloaded handling ─────────────────────────────────────────
      if (isOverloadedError(err)) {
        if (isBackground() && !isUnattended()) {
          // Background mode: 529 立即抛出，不阻塞
          throw err;
        }

        attempt529++;
        if (!isUnattended() && attempt529 > MAX_529_RETRIES) {
          // Foreground: exceeded max retries — throw so caller can trigger model fallback
          throw err;
        }

        const delayMs = Math.min(Math.pow(2, attempt529 - 1) * BASE_DELAY_MS, MAX_DELAY_MS);
        const jitter = Math.random() * 0.2 * delayMs; // ±10% jitter
        const actualDelay = Math.round(delayMs + jitter);

        const retryLabel = isUnattended()
          ? `(unattended, attempt ${attempt529})`
          : `(${attempt529}/${MAX_529_RETRIES})`;
        onRetryMessage?.(`\n⏳ Claude is overloaded — retrying in ${Math.round(actualDelay / 1000)}s… ${retryLabel}\n`);

        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, actualDelay);
          if (typeof t.unref === 'function') t.unref();
        });
        continue;
      }

      // ── 429 Rate Limit handling ─────────────────────────────────────────
      if (isRateLimitError(err)) {
        attempt429++;
        const retryAfterMs = parseRetryAfterMs(err) ?? Math.min(30_000 * attempt429, 300_000);

        onRetryMessage?.(
          `\n⏳ Rate-limited — waiting ${Math.round(retryAfterMs / 1000)}s… ` +
          `(attempt ${attempt429}, elapsed ${Math.round((Date.now() - startMs) / 1000)}s)\n`,
        );

        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, retryAfterMs);
          if (typeof t.unref === 'function') t.unref();
        });
        continue;
      }

      // Non-retryable error — rethrow immediately
      throw err;
    }
  }
}
