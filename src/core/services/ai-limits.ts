/**
 * ai-limits.ts — B31: Anthropic API 速率限制状态追踪
 *
 * 对标 claude-code src/services/claudeAiLimits.ts (simplified)
 *
 * 功能：
 *   - 解析 Anthropic API 响应头中的速率限制字段
 *   - 发布订阅模式广播限制状态变化
 *   - 两级早期预警：Header-based (surpassed-threshold) + Time-relative fallback
 *
 * 不包含（claude-code 企业版专有，外部产品不适用）：
 *   - overage 自动续费逻辑
 *   - OAuth 订阅类型检查
 *   - 后台轮询
 *
 * Mirrors: claude-code claudeAiLimits.ts extractQuotaStatusFromHeaders() + emitStatusChange()
 */

export type QuotaStatus = 'allowed' | 'allowed_warning' | 'rejected';

export interface AiLimitsState {
  status: QuotaStatus;
  /** 5h 窗口利用率 0-1 */
  utilization5h?: number;
  /** 7d 窗口利用率 0-1 */
  utilization7d?: number;
  /** 5h 窗口重置时间（unix epoch seconds） */
  resetsAt5h?: number;
  /** 7d 窗口重置时间（unix epoch seconds） */
  resetsAt7d?: number;
  /** 是否处于 overage（超额计费）状态 */
  isUsingOverage?: boolean;
}

// ── 状态管理 ──────────────────────────────────────────────────────────────────

let _current: AiLimitsState = { status: 'allowed' };
const _listeners = new Set<(s: AiLimitsState) => void>();

// ── 发布订阅 ──────────────────────────────────────────────────────────────────

/** B31: 订阅速率限制状态变化，返回取消订阅函数 */
export function onAiLimitsChange(fn: (s: AiLimitsState) => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/** B31: 获取当前速率限制状态 */
export function getAiLimitsState(): AiLimitsState {
  return _current;
}

// ── 响应头解析 ────────────────────────────────────────────────────────────────

/**
 * B31: 从 Anthropic API 响应头提取速率限制状态，并广播变化。
 *
 * 支持两种头字典形式：
 *   - Node.js IncomingMessage headers（全小写键）
 *   - fetch Response headers（通过 entries()）
 *
 * Mirrors: claude-code claudeAiLimits.ts extractQuotaStatusFromHeaders() L454-485
 *          + emitStatusChange() L184-197
 */
export function parseAiLimitHeaders(
  headers: Record<string, string | string[] | undefined>,
): void {
  /** 安全读取单值响应头（忽略数组）*/
  const get = (key: string): string | undefined => {
    const v = headers[key] ?? headers[key.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };

  // 速率限制头（Anthropic 专属）
  // 参考: https://docs.anthropic.com/en/api/rate-limits
  const util5h = parseFloat(get('anthropic-ratelimit-unified-5h-utilization') ?? '');
  const util7d = parseFloat(get('anthropic-ratelimit-unified-7d-utilization') ?? '');
  const reset5h = parseFloat(get('anthropic-ratelimit-unified-5h-reset') ?? '');
  const reset7d = parseFloat(get('anthropic-ratelimit-unified-7d-reset') ?? '');
  const surpassed5h = get('anthropic-ratelimit-unified-5h-surpassed-threshold');
  const surpassed7d = get('anthropic-ratelimit-unified-7d-surpassed-threshold');
  const headerStatus = get('anthropic-ratelimit-unified-status') as QuotaStatus | undefined;
  const overageStatus = get('anthropic-ratelimit-unified-overage-status');

  // 若无任何相关头，说明非 Anthropic 响应或旧版 API，静默跳过
  if (util5h === undefined && util7d === undefined && headerStatus === undefined) {
    // 仅当有 surpassed 头时才处理（某些版本可能只发该头）
    if (surpassed5h === undefined && surpassed7d === undefined) return;
  }

  // ── 状态计算（三级优先级）───────────────────────────────────────────────────

  let status: QuotaStatus = headerStatus ?? 'allowed';

  // 优先级 1: Server-side 早期预警头（surpassed-threshold）
  // Mirrors: claude-code claudeAiLimits.ts "surpassed-threshold" check
  if (status === 'allowed' && (surpassed5h !== undefined || surpassed7d !== undefined)) {
    status = 'allowed_warning';
  }

  // 优先级 2: Time-relative fallback 早期预警
  // 5h 窗口：利用率 >= 90% 且当前处于该窗口的前 72% 时间段内 → 预警
  // Mirrors: claude-code claudeAiLimits.ts EARLY_WARNING_CONFIGS fallback logic
  if (status === 'allowed' && !isNaN(util5h) && !isNaN(reset5h)) {
    const windowStart = reset5h - 5 * 3600;
    const windowElapsed = (Date.now() / 1000 - windowStart) / (5 * 3600);
    if (util5h >= 0.9 && windowElapsed <= 0.72) {
      status = 'allowed_warning';
    }
  }

  // B31: overage 状态（超额计费）
  const isUsingOverage = status === 'rejected' && overageStatus === 'allowed';

  // ── 构建新状态 ────────────────────────────────────────────────────────────

  const next: AiLimitsState = {
    status,
    utilization5h: isNaN(util5h) ? undefined : util5h,
    utilization7d: isNaN(util7d) ? undefined : util7d,
    resetsAt5h: isNaN(reset5h) ? undefined : reset5h,
    resetsAt7d: isNaN(reset7d) ? undefined : reset7d,
    ...(isUsingOverage ? { isUsingOverage } : {}),
  };

  // ── 变化才广播（防止重复事件）─────────────────────────────────────────────

  if (JSON.stringify(next) === JSON.stringify(_current)) return;

  _current = next;
  _listeners.forEach((fn) => {
    try { fn(next); } catch { /* listener error is non-fatal */ }
  });

  // B31: 控制台早期预警输出（仅 allowed_warning 时）
  // Mirrors: claude-code UI warning notification
  if (status === 'allowed_warning') {
    const maxUtil = Math.max(
      isNaN(util5h) ? 0 : util5h,
      isNaN(util7d) ? 0 : util7d,
    );
    process.stderr.write(
      `[RateLimit] Warning: ${(maxUtil * 100).toFixed(0)}% API quota used — ` +
      `approaching limit\n`,
    );
  } else if (status === 'rejected') {
    process.stderr.write(`[RateLimit] Rejected: API quota exceeded\n`);
  }
}
