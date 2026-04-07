/**
 * remote-config.ts — B29: remoteManagedSettings MVP HTTP 拉取
 *
 * 对标 claude-code src/services/remoteManagedSettings/index.ts L54-625
 *
 * 当前实现：启动时一次 HTTP 拉取（fail-open），无后台轮询。
 * 触发条件：环境变量 UAGENT_REMOTE_CONFIG_URL 存在。
 *
 * 功能：
 *   - SHA-256 ETag 校验（If-None-Match），304 命中时直接返回缓存
 *   - 本地缓存文件 ~/.uagent/remote-config-cache.json
 *   - 失败时 fail-open（返回缓存或 null，不阻断启动）
 *   - 5s 超时（AbortSignal.timeout）
 *
 * Mirrors: claude-code remoteManagedSettings/index.ts fetchWithRetry/computeChecksum/If-None-Match
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const UAGENT_DIR = join(homedir(), '.uagent');
const CACHE_FILE = join(UAGENT_DIR, 'remote-config-cache.json');
const TIMEOUT_MS = 5000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * B29: Python-compatible checksum for If-None-Match ETag.
 * Mirrors claude-code computeChecksumFromSettings(): sort_keys=True, separators=(',',':')
 */
export function computeChecksum(obj: unknown): string {
  const sorted = stableStringify(obj);
  return createHash('sha256').update(sorted).digest('hex');
}

/**
 * Stable JSON stringify (alphabetically sorted keys), no spaces.
 * Equivalent to Python json.dumps(sort_keys=True, separators=(',', ':'))
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const sorted = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(',');
  return '{' + sorted + '}';
}

function loadCachedRemoteConfig(): Record<string, unknown> | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const raw = readFileSync(CACHE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function saveCachedRemoteConfig(settings: Record<string, unknown>): void {
  try {
    if (!existsSync(UAGENT_DIR)) mkdirSync(UAGENT_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(settings, null, 2), 'utf-8');
  } catch {
    /* non-fatal: disk write failure should not block startup */
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * B29: Fetch remote config once at startup (fail-open).
 *
 * Returns merged config overrides to apply on top of local config,
 * or null if URL is not configured / request failed / 404.
 *
 * Mirrors claude-code remoteManagedSettings L526-531 (startup cache-first path)
 * and L274-295 (If-None-Match / 304 fast path).
 */
export async function fetchRemoteConfigOnce(): Promise<Record<string, unknown> | null> {
  const url = process.env['UAGENT_REMOTE_CONFIG_URL'];
  if (!url) return null;

  const cached = loadCachedRemoteConfig();
  const checksum = cached ? computeChecksum(cached) : undefined;

  try {
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        ...(checksum ? { 'If-None-Match': `"${checksum}"` } : {}),
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    // B29: 304 Not Modified — cached version is current, use it
    if (resp.status === 304) return cached;

    // B29: 404 / 204 — no remote config configured, silently skip
    if (resp.status === 404 || resp.status === 204) return null;

    // B29: fail-open on server error — use cache if available
    if (!resp.ok) {
      process.stderr.write(`[remote-config] HTTP ${resp.status}, using cached config\n`);
      return cached ?? null;
    }

    const settings = await resp.json() as unknown;
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
      return cached ?? null;
    }

    const result = settings as Record<string, unknown>;
    saveCachedRemoteConfig(result);
    return result;
  } catch (err) {
    // B29: fail-open on network error (timeout, DNS, etc.)
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('TimeoutError') && !msg.includes('fetch failed')) {
      process.stderr.write(`[remote-config] Fetch error: ${msg}\n`);
    }
    return cached ?? null; // use stale cache rather than blocking
  }
}

/**
 * B29: Shallow-merge remote config overrides into local config.
 * Remote settings take precedence (policy-first).
 *
 * Mirrors claude-code remoteManagedSettings securityCheck + merge pattern.
 */
export function applyRemoteConfig<T extends Record<string, unknown>>(
  localConfig: T,
  remote: Record<string, unknown>,
): T {
  // B29: shallow merge — remote wins for same keys
  return { ...localConfig, ...remote };
}
