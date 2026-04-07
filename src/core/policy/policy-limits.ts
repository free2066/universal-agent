/**
 * policy-limits.ts — H32: PolicyLimits MVP
 *
 * Mirrors claude-code src/services/policyLimits/index.ts（简化版）
 *
 * 功能：从 Anthropic API 拉取企业策略限制，缓存到本地文件，
 *       提供 isPolicyAllowed(policy) 查询接口（fail-open）。
 *
 * 设计原则：
 *   - API Key 认证（无 OAuth 依赖）
 *   - fail-open：缓存不可用时默认允许所有策略
 *   - DENY_ON_MISS 例外：合规关键策略在无缓存时 fail-closed
 *   - 背景轮询：每 60 分钟自动刷新
 *   - ETag 去重：304 Not Modified 直接命中缓存
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const UAGENT_DIR = join(process.env['HOME'] ?? '~', '.uagent');
const CACHE_FILE = join(UAGENT_DIR, 'policy-limits.json');
const FETCH_TIMEOUT_MS = 10_000;
const POLLING_INTERVAL_MS = 60 * 60_000; // 1 hour
const MAX_RETRIES = 3;

// 需要 fail-closed 的策略（缓存不可用时返回 false）
// Mirrors claude-code policyLimits/index.ts ESSENTIAL_TRAFFIC_DENY_ON_MISS
const DENY_ON_MISS = new Set(['allow_product_feedback', 'allow_telemetry', 'allow_stats_collection']);

type Restriction = { allowed: boolean; reason?: string };
type PolicyCache = { restrictions: Record<string, Restriction>; fetchedAt: number; etag?: string };

let _sessionCache: PolicyCache | null = null;
let _pollingTimer: ReturnType<typeof setInterval> | null = null;

function _loadFileCache(): PolicyCache | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    return JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as PolicyCache;
  } catch { return null; }
}

function _saveFileCache(cache: PolicyCache): void {
  try {
    mkdirSync(UAGENT_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch { /* non-fatal */ }
}

function _getEndpoint(): string {
  const base = process.env['UAGENT_API_BASE'] ?? 'https://api.anthropic.com';
  return `${base}/api/claude_code/policy_limits`;
}

function _getAuthHeaders(): Record<string, string> | null {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (apiKey) return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  const oauthToken = process.env['CLAUDE_AI_OAUTH_TOKEN'];
  if (oauthToken) return { Authorization: `Bearer ${oauthToken}`, 'anthropic-version': '2023-06-01' };
  return null;
}

async function _fetchPolicyLimits(): Promise<Record<string, Restriction> | null> {
  const headers = _getAuthHeaders();
  if (!headers) return null;

  const fileCache = _loadFileCache();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const reqHeaders: Record<string, string> = { ...headers };
      if (fileCache?.etag) reqHeaders['If-None-Match'] = fileCache.etag;

      const res = await fetch(_getEndpoint(), {
        headers: reqHeaders,
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));

      if (res.status === 304 && fileCache) return fileCache.restrictions;
      if (res.status === 404) return {};
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) return null; // no retry
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
          continue;
        }
        return null;
      }

      const newEtag = res.headers.get('etag') ?? undefined;
      const data = await res.json() as { restrictions?: Record<string, Restriction> };
      const restrictions = data.restrictions ?? {};

      _saveFileCache({ restrictions, fetchedAt: Date.now(), etag: newEtag });
      return restrictions;
    } catch {
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    }
  }
  return null;
}

/**
 * H32: loadPolicyLimits — 启动时调用，拉取策略限制并启动背景轮询。
 * Mirrors claude-code policyLimits/index.ts loadPolicyLimits().
 * fail-open: 网络/认证失败时使用文件缓存，完全无缓存时默认 allow-all。
 */
export async function loadPolicyLimits(): Promise<void> {
  const restrictions = await _fetchPolicyLimits();
  const fileCache = _loadFileCache();
  const cache: PolicyCache = {
    restrictions: restrictions ?? fileCache?.restrictions ?? {},
    fetchedAt: Date.now(),
  };
  _sessionCache = cache;
  if (restrictions) _saveFileCache(cache);

  // 背景轮询（每小时刷新）
  if (!_pollingTimer) {
    _pollingTimer = setInterval(async () => {
      const r = await _fetchPolicyLimits();
      if (r) {
        _sessionCache = { restrictions: r, fetchedAt: Date.now() };
      }
    }, POLLING_INTERVAL_MS);
    // Node.js: unref 防止轮询阻止进程退出
    _pollingTimer.unref?.();
  }
}

/**
 * H32: isPolicyAllowed — 检查策略是否允许。
 * fail-open: 缓存不可用时返回 true（DENY_ON_MISS 例外返回 false）。
 * Mirrors claude-code policyLimits/index.ts isPolicyAllowed().
 */
export function isPolicyAllowed(policy: string): boolean {
  const cache = _sessionCache ?? _loadFileCache();
  if (!cache) {
    // 完全无缓存 — fail-open 默认，DENY_ON_MISS 策略 fail-closed
    return !DENY_ON_MISS.has(policy);
  }
  const r = cache.restrictions[policy];
  if (r === undefined) return true; // unknown policy = allowed
  return r.allowed;
}

/**
 * H32: getPolicyReason — 获取策略不允许的原因（用于用户提示）。
 */
export function getPolicyReason(policy: string): string | undefined {
  const cache = _sessionCache ?? _loadFileCache();
  return cache?.restrictions[policy]?.reason;
}

/**
 * H32: clearPolicyCache — 清除缓存（测试/重置用）。
 */
export function clearPolicyCache(): void {
  _sessionCache = null;
  if (_pollingTimer) {
    clearInterval(_pollingTimer);
    _pollingTimer = null;
  }
}
