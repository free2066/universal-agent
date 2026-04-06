/**
 * mcp-auth.ts — MCP OAuth 2.0 Authorization Code Flow
 *
 * Batch 3 baseline + Batch 4 upgrade (claude-code parity):
 *
 *  New in upgrade:
 *   - SecureStorage abstraction: macOS Keychain (security CLI) with plaintext
 *     fallback — inspired by claude-code's secureStorage/index.ts
 *   - serverKey hashing: sha256(url+type)[0:16] prevents cross-server credential
 *     reuse when two servers share the same name but different URLs
 *   - RFC 7009 token revocation: revoke() now sends revocation requests to the
 *     server before clearing local storage
 *
 * Flow:
 *  1. Check if a valid (non-expired) token exists in SecureStorage
 *  2. If not, initiate Authorization Code Flow:
 *     a. Open browser with authorizationUrl + PKCE challenge
 *     b. Start a local HTTP callback server on a random port (default 9876)
 *     c. Exchange the code for access_token + refresh_token via tokenUrl
 *  3. Persist token via SecureStorage (Keychain on macOS, file fallback elsewhere)
 *  4. Refresh automatically when access_token is near expiry (< 5 min)
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync,
} from 'fs';
import { resolve, join } from 'path';
import { createServer } from 'http';
import { randomBytes, createHash } from 'crypto';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ── Cross-process token refresh lockfile (claude-code auth.ts parity) ────────
//
// Prevents multiple uagent instances from racing to refresh the same MCP token.
// Uses atomic O_EXCL file creation as a process-level mutex.
// Design mirrors claude-code's MAX_LOCK_RETRIES + double-check pattern:
//   1. Try to create lockfile atomically (fs.open flags='wx')
//   2. On EEXIST: another process holds lock — wait 1~2s + retry (up to 5 times)
//   3. On success: read fresh token from storage (double-check)
//   4. If another process already refreshed (expiresAt > now + 300s) → reuse it
//   5. Release lock in finally block (fs.unlink)
// If lock acquisition fails completely (5 retries or non-EEXIST error):
//   fall through without lock (fail-open — better than blocking forever)

const MAX_LOCK_RETRIES = 5;
const LOCK_DIR = resolve(process.env.HOME ?? '~', '.uagent', 'mcp-tokens');

/** Atomic lock file creation using O_EXCL (exclusive create). */
async function acquireLock(lockPath: string): Promise<(() => void) | null> {
  mkdirSync(LOCK_DIR, { recursive: true, mode: 0o700 });
  for (let retry = 0; retry < MAX_LOCK_RETRIES; retry++) {
    try {
      const fd = openSync(lockPath, 'wx');   // O_WRONLY | O_CREAT | O_EXCL
      closeSync(fd);
      return () => {
        try { unlinkSync(lockPath); } catch { /* non-fatal */ }
      };
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        // Another process holds the lock — wait with random jitter
        await new Promise<void>((res) => setTimeout(res, 1000 + Math.random() * 1000));
        continue;
      }
      // ENOENT (race between mkdirSync and openSync) or other error → fail-open
      break;
    }
  }
  return null; // fail-open: proceed without lock
}

/** Sleep helper for lock retry */
function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ── C23: RFC 9728 OAuth 自动发现链 ───────────────────────────────────────────
//
// 三段式自动发现：① RFC 9728 → ② RFC 8414 AS 元数据 → ③ 路径感知 fallback
// Mirrors claude-code auth.ts L256-311 fetchAuthServerMetadata().
//
// 无需手动配置 authorizationUrl/tokenUrl，适用于所有标准 MCP 服务器。

interface OAuthDiscoveredEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

export async function discoverOAuthEndpoints(
  serverUrl: string,
): Promise<OAuthDiscoveredEndpoints | null> {
  const DISCOVERY_TIMEOUT_MS = 5000;
  const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);

  // Step 1: RFC 9728 — /.well-known/oauth-protected-resource
  try {
    const prmUrl = new URL('/.well-known/oauth-protected-resource', serverUrl);
    const prmRes = await fetch(prmUrl.href, { signal });
    if (prmRes.ok) {
      const prm = await prmRes.json() as Record<string, unknown>;
      const asServers = prm['authorization_servers'];
      const asUrl = Array.isArray(asServers) && typeof asServers[0] === 'string'
        ? asServers[0] : null;
      if (asUrl) {
        // Step 2: RFC 8414 — AS 的 /.well-known/oauth-authorization-server
        const asmUrl = new URL('/.well-known/oauth-authorization-server', asUrl);
        const asmRes = await fetch(asmUrl.href, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
        if (asmRes.ok) {
          const asm = await asmRes.json() as Record<string, unknown>;
          if (typeof asm['authorization_endpoint'] === 'string' && typeof asm['token_endpoint'] === 'string') {
            return {
              authorizationEndpoint: asm['authorization_endpoint'] as string,
              tokenEndpoint: asm['token_endpoint'] as string,
            };
          }
        }
      }
    }
  } catch { /* fallthrough to path-aware discovery */ }

  // Step 3: 路径感知 fallback — 直接对 serverUrl 走 RFC 8414
  // 适用于 MCP 服务器自身也是 AS 的场景（路径型服务器）
  try {
    const asmUrl = new URL('/.well-known/oauth-authorization-server', serverUrl);
    const asmRes = await fetch(asmUrl.href, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
    if (asmRes.ok) {
      const asm = await asmRes.json() as Record<string, unknown>;
      if (typeof asm['authorization_endpoint'] === 'string' && typeof asm['token_endpoint'] === 'string') {
        return {
          authorizationEndpoint: asm['authorization_endpoint'] as string,
          tokenEndpoint: asm['token_endpoint'] as string,
        };
      }
    }
  } catch { /* all discovery paths failed */ }

  return null; // 无法自动发现，调用方需手动配置
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OAuthConfig {
  /**
   * OAuth 2.0 Authorization endpoint URL.
   * C23: 可选 — 若未设置，通过 RFC 9728 自动发现链推断。
   */
  authorizationUrl?: string;
  /**
   * OAuth 2.0 Token endpoint URL.
   * C23: 可选 — 若未设置，通过 RFC 9728 自动发现链推断。
   */
  tokenUrl?: string;
  /** OAuth 2.0 Client ID */
  clientId: string;
  /** Optional client secret (PKCE is used when omitted) */
  clientSecret?: string;
  /** OAuth scopes to request */
  scopes?: string[];
  /** Redirect URI (default: http://localhost:<callbackPort>/callback) */
  redirectUri?: string;
  /** Local callback port (default: 9876) */
  callbackPort?: number;
  /**
   * Token revocation endpoint (RFC 7009).
   * If provided, revoke() will notify the server before clearing local storage.
   */
  revocationUrl?: string;
  /**
   * Server config hash key for storage isolation.
   * Prevents credential reuse when two servers share the same name but differ in URL.
   * Auto-computed from (url + type) if not provided.
   */
  configHash?: string;
  /**
   * C23: 服务器 URL，用于 RFC 9728 自动发现链（当 authorizationUrl/tokenUrl 未配置时使用）
   */
  serverUrl?: string;
}

export interface TokenData {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expiresAt: number;      // Unix ms timestamp when access_token expires
  scope?: string;
}

// ── SecureStorage — inspired by claude-code's secureStorage/index.ts ─────────
//
// Priority: macOS Keychain (security CLI) → plaintext file (chmod 0o600)
// The plaintext fallback path is chmod 0o600, matching ssh key permissions.
//
// Key format: "uagent-mcp:<serverKey>" where serverKey includes a config hash
// to prevent cross-server credential reuse.

interface SecureStorage {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * macOS Keychain storage via `security` CLI.
 *
 * Upgrades (claude-code macOsKeychainStorage.ts parity):
 *  1. TTL cache (5 min): avoid repeated subprocess spawning for frequent reads
 *  2. stale-while-error: return cached value on Keychain failure (resilience)
 *  3. Large payload support: hex-encode when > 4032 bytes (Keychain limit)
 */
function createKeychainStorage(): SecureStorage {
  const serviceName = 'uagent-mcp-oauth';

  // TTL cache per key: Map<key, { data: string | null; expiresAt: number }>
  const KEYCHAIN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const _cache = new Map<string, { data: string | null; expiresAt: number }>();

  function getCached(key: string): string | null | undefined {
    const entry = _cache.get(key);
    if (!entry) return undefined;          // no cache entry
    if (Date.now() < entry.expiresAt) return entry.data;  // fresh hit
    return undefined;                      // expired
  }

  function setCached(key: string, data: string | null): void {
    _cache.set(key, { data, expiresAt: Date.now() + KEYCHAIN_CACHE_TTL_MS });
  }

  function getStale(key: string): string | null {
    return _cache.get(key)?.data ?? null;
  }

  async function read(key: string): Promise<string | null> {
    // Fast path: return cached value if still fresh
    const cached = getCached(key);
    if (cached !== undefined) return cached;

    try {
      const { stdout } = await execAsync(
        `security find-generic-password -a "${serviceName}" -s "${sanitizeKey(key)}" -w 2>/dev/null`,
      );
      const raw = stdout.trim() || null;
      // Decode hex-encoded large payloads (written by write() when > 4032 bytes)
      const data = raw && raw.startsWith('hex:') ? Buffer.from(raw.slice(4), 'hex').toString('utf-8') : raw;
      setCached(key, data);
      return data;
    } catch {
      // stale-while-error: return stale cached value on Keychain failure
      return getStale(key);
    }
  }

  async function write(key: string, value: string): Promise<void> {
    const safeKey = sanitizeKey(key);
    const byteSize = Buffer.byteLength(value, 'utf-8');

    // Large payload path (> 4032B): hex-encode to avoid Keychain size limit
    // Mirrors claude-code's macOsKeychainStorage.ts large-payload branch
    const payload = byteSize > 4032 ? `hex:${Buffer.from(value, 'utf-8').toString('hex')}` : value;

    await new Promise<void>((res, rej) => {
      const child = spawn('security', [
        'add-generic-password', '-U',
        '-a', serviceName,
        '-s', safeKey,
        '-w', payload,
      ], { stdio: ['ignore', 'ignore', 'ignore'] });
      child.on('close', (code) => {
        if (code === 0) {
          setCached(key, value); // update cache on successful write
          res();
        } else {
          rej(new Error(`Keychain write failed: exit ${code}`));
        }
      });
      child.on('error', rej);
    });
  }

  async function remove(key: string): Promise<void> {
    try {
      await execAsync(`security delete-generic-password -a "${serviceName}" -s "${sanitizeKey(key)}" 2>/dev/null`);
      _cache.delete(key); // invalidate cache
    } catch { /* already gone — non-fatal */ }
  }

  return { read, write, remove };
}

const TOKEN_DIR = resolve(process.env.HOME ?? '~', '.uagent', 'mcp-tokens');

// Re-export LOCK_DIR as same as TOKEN_DIR (they share the directory)
// Note: LOCK_DIR is already defined at module top, but TOKEN_DIR is its alias
// for file storage reads/writes. Both point to the same path.

/**
 * Plaintext file storage (fallback when Keychain is unavailable).
 * Files are chmod 0o600 — same permissions as SSH private keys.
 */
function createFileStorage(): SecureStorage {
  const ensureDir = () => mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });

  async function read(key: string): Promise<string | null> {
    try {
      const p = resolve(TOKEN_DIR, `${sanitizeKey(key)}.json`);
      if (!existsSync(p)) return null;
      return readFileSync(p, 'utf-8');
    } catch { return null; }
  }

  async function write(key: string, value: string): Promise<void> {
    ensureDir();
    writeFileSync(resolve(TOKEN_DIR, `${sanitizeKey(key)}.json`), value, { mode: 0o600 });
  }

  async function remove(key: string): Promise<void> {
    try {
      const p = resolve(TOKEN_DIR, `${sanitizeKey(key)}.json`);
      if (existsSync(p)) unlinkSync(p);
    } catch { /* non-fatal */ }
  }

  return { read, write, remove };
}

function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

/**
 * Wrapping storage: try primary, fall back to secondary on error.
 */
function createFallbackStorage(primary: SecureStorage, secondary: SecureStorage): SecureStorage {
  return {
    read: async (key) => {
      try { return await primary.read(key); } catch { return secondary.read(key); }
    },
    write: async (key, value) => {
      try { await primary.write(key, value); } catch { await secondary.write(key, value); }
    },
    remove: async (key) => {
      await Promise.allSettled([primary.remove(key), secondary.remove(key)]);
    },
  };
}

let _secureStorage: SecureStorage | null = null;

function getSecureStorage(): SecureStorage {
  if (_secureStorage) return _secureStorage;
  const file = createFileStorage();
  if (process.platform === 'darwin') {
    _secureStorage = createFallbackStorage(createKeychainStorage(), file);
  } else {
    _secureStorage = file;
  }
  return _secureStorage;
}

// ── serverKey hashing (inspired by claude-code auth.ts) ─────────────────────
//
// Prevents credential reuse when two MCP servers share a name but differ in URL.
// Key format: "<serverName>|<sha256(url+type)[0:16]>"

function computeServerKey(serverName: string, config: OAuthConfig): string {
  const hashInput = JSON.stringify({
    url: config.tokenUrl ?? config.serverUrl ?? '',
    auth: config.authorizationUrl ?? config.serverUrl ?? '',
    clientId: config.clientId,
  });
  const hash = createHash('sha256').update(hashInput).digest('hex').slice(0, 16);
  return `${serverName}|${hash}`;
}

// ── Token storage helpers ─────────────────────────────────────────────────────

async function loadToken(serverKey: string): Promise<TokenData | null> {
  try {
    const raw = await getSecureStorage().read(`uagent-mcp:${serverKey}`);
    if (!raw) return null;
    const data = JSON.parse(raw) as TokenData;
    if (!data.access_token) return null;
    return data;
  } catch { return null; }
}

async function saveToken(serverKey: string, token: TokenData): Promise<void> {
  await getSecureStorage().write(`uagent-mcp:${serverKey}`, JSON.stringify(token));
}

async function clearToken(serverKey: string): Promise<void> {
  await getSecureStorage().remove(`uagent-mcp:${serverKey}`);
}

// ── PKCE helpers ──────────────────────────────────────────────────────────────

function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

// ── Browser open ──────────────────────────────────────────────────────────────

async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? `open "${url}"`
    : platform === 'win32' ? `start "" "${url}"`
    : `xdg-open "${url}"`;
  try { await execAsync(cmd); } catch { /* non-fatal: user can open manually */ }
}

// ── Callback server ───────────────────────────────────────────────────────────

function waitForCallback(port: number, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(code
        ? '<h2>Authorization successful! You may close this tab.</h2>'
        : `<h2>Authorization failed: ${error ?? 'unknown'}</h2>`);
      server.close();
      if (code) resolve(code);
      else reject(new Error(`OAuth error: ${error ?? 'no code returned'}`));
    });
    server.listen(port, '127.0.0.1');
    setTimeout(() => {
      server.close();
      reject(new Error(`OAuth callback timeout after ${timeoutMs / 1000}s`));
    }, timeoutMs);
  });
}

// ── Token exchange ────────────────────────────────────────────────────────────

async function exchangeCode(
  code: string,
  config: OAuthConfig,
  verifier: string,
  redirectUri: string,
): Promise<TokenData> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
    code_verifier: verifier,
  });
  if (config.clientSecret) body.set('client_secret', config.clientSecret);
  if (!config.tokenUrl) throw new Error(`[MCP OAuth] tokenUrl is required for code exchange`);
  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  // A23: normalizeOAuthErrorBody for token exchange response too
  const normalizedRes = await normalizeOAuthErrorBody(res);
  if (!normalizedRes.ok) {
    const text = await normalizedRes.text();
    throw new Error(`Token exchange failed: HTTP ${normalizedRes.status} — ${text.slice(0, 200)}`);
  }
  const data = await normalizedRes.json() as {
    access_token: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
  };
  const expiresAt = Date.now() + ((data.expires_in ?? 3600) * 1000);
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type ?? 'Bearer',
    expiresAt,
    scope: data.scope,
  };
}

/**
 * Perform the actual HTTP token refresh request.
 * Wrapped by refreshTokenWithLock() which adds cross-process serialization.
 */
async function _doRefresh(serverKey: string, config: OAuthConfig, token: TokenData): Promise<TokenData> {
  if (!token.refresh_token) throw new Error('No refresh_token available');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
    client_id: config.clientId,
  });
  if (config.clientSecret) body.set('client_secret', config.clientSecret);
  if (!config.tokenUrl) throw new Error(`[MCP OAuth] tokenUrl is required for token refresh (server: ${serverKey})`);
  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  // A23: normalizeOAuthErrorBody — Slack 等非标准 AS 可能返回 200 但 body 含 error
  const normalizedRes = await normalizeOAuthErrorBody(res);
  if (!normalizedRes.ok) {
    const text = await normalizedRes.text();
    throw new Error(`Token refresh failed: HTTP ${normalizedRes.status} — ${text.slice(0, 200)}`);
  }
  const data = await normalizedRes.json() as {
    access_token: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
  };
  const expiresAt = Date.now() + ((data.expires_in ?? 3600) * 1000);
  const newToken: TokenData = {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? token.refresh_token,
    token_type: data.token_type ?? token.token_type,
    expiresAt,
    scope: data.scope ?? token.scope,
  };
  await saveToken(serverKey, newToken);
  return newToken;
}

/**
 * Refresh token with cross-process lockfile serialization.
 *
 * Claude-code parity (auth.ts refreshAuthorization):
 *  1. Acquire per-server lockfile (O_EXCL atomic create)
 *  2. After acquiring lock: re-read storage (double-check)
 *     — If another process already refreshed (expiresAt > now + 300s), reuse it
 *  3. If still stale: call _doRefresh()
 *  4. Release lock in finally block
 */
async function refreshTokenData(serverKey: string, config: OAuthConfig, token: TokenData): Promise<TokenData> {
  const sanitized = serverKey.replace(/[^a-zA-Z0-9]/g, '_');
  const lockPath = join(LOCK_DIR, `mcp-refresh-${sanitized}.lock`);
  const release = await acquireLock(lockPath);

  try {
    // Double-check: re-read from storage after acquiring lock
    // Another process may have already refreshed the token while we waited
    const freshToken = await loadToken(serverKey);
    if (freshToken) {
      const expiresIn = (freshToken.expiresAt - Date.now()) / 1000;
      if (expiresIn > 300) {
        // Another process already refreshed — reuse without network call
        return freshToken;
      }
      // Use the latest refresh_token from storage (it may have rotated)
      if (freshToken.refresh_token) {
        token = { ...token, refresh_token: freshToken.refresh_token };
      }
    }
    return await _doRefresh(serverKey, config, token);
  } finally {
    release?.();
  }
}

// ── A23: normalizeOAuthErrorBody — Slack 200-but-error 兼容 ─────────────────
//
// 部分非标准 OAuth 服务器（如 Slack）在 token refresh 时返回 HTTP 200，
// 但 body 包含 {"error":"invalid_refresh_token"} 这样的错误对象。
// 此函数将这类"伪成功"响应重写为 HTTP 400，使错误处理路径正常触发。
// 同时将 Slack 专有错误码规范化为 RFC 6749 标准 error code。
//
// Mirrors claude-code auth.ts L127-190 normalizeOAuthErrorBody().

const NONSTANDARD_INVALID_GRANT_ALIASES = new Set([
  'invalid_refresh_token',
  'expired_refresh_token',
  'token_expired',
  'token_revoked',
]);

async function normalizeOAuthErrorBody(res: Response): Promise<Response> {
  if (!res.ok) return res; // 已经是错误状态，无需处理
  // 克隆以避免消费原始 body（确保调用方还能读取）
  let body: Record<string, unknown>;
  try {
    body = await res.clone().json() as Record<string, unknown>;
  } catch {
    return res; // 非 JSON body — 不干预
  }
  const errCode = typeof body['error'] === 'string' ? body['error'] : undefined;
  if (!errCode) return res; // 无 error 字段 → 正常成功响应
  // 规范化非标准错误码
  const normalizedCode = NONSTANDARD_INVALID_GRANT_ALIASES.has(errCode)
    ? 'invalid_grant' : errCode;
  const normalizedBody = { ...body, error: normalizedCode };
  return new Response(
    JSON.stringify(normalizedBody),
    { status: 400, statusText: 'Bad Request', headers: { 'Content-Type': 'application/json' } },
  );
}

// ── B23: wrapFetchWithStepUpDetection — 403 insufficient_scope 拦截 ───────────
//
// 当 MCP 服务器响应 403 且 WWW-Authenticate 含 insufficient_scope 时，
// 清除当前 token 并设置 _pendingStepUpScope 标志，迫使下次 getToken()
// 跳过 refresh_token 走完整 PKCE 重新授权，避免 403 无限重试循环。
//
// Mirrors claude-code auth.ts L1354-1471 wrapFetchWithStepUpDetection().

function wrapFetchWithStepUpDetection(
  originalFetch: typeof globalThis.fetch,
  onStepUpNeeded: (scope: string) => void,
): typeof globalThis.fetch {
  return async (input, init) => {
    const res = await originalFetch(input as Parameters<typeof fetch>[0], init);
    if (res.status === 403) {
      const wwwAuth = res.headers.get('WWW-Authenticate') ?? '';
      if (wwwAuth.includes('insufficient_scope')) {
        // 尝试解析所需 scope
        const scopeMatch = /scope="?([^",\s]+)"?/.exec(wwwAuth) ??
                           /error_scope="?([^",\s]+)"?/.exec(wwwAuth);
        const scope = scopeMatch?.[1] ?? 'unknown';
        onStepUpNeeded(scope);
      }
    }
    return res;
  };
}

// ── RFC 7009 Token Revocation ─────────────────────────────────────────────────

async function revokeTokenAtServer(
  tokenValue: string,
  tokenTypeHint: 'refresh_token' | 'access_token',
  config: OAuthConfig,
): Promise<void> {
  if (!config.revocationUrl) return;
  const body = new URLSearchParams({ token: tokenValue, token_type_hint: tokenTypeHint });
  if (config.clientSecret) {
    // client_secret_post method
    body.set('client_id', config.clientId);
    body.set('client_secret', config.clientSecret);
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (!config.clientSecret) {
    // client_secret_basic method (RFC 6749 §2.3.1)
    headers['Authorization'] = `Basic ${Buffer.from(`${config.clientId}:`).toString('base64')}`;
  }
  try {
    await fetch(config.revocationUrl, { method: 'POST', headers, body: body.toString() });
  } catch { /* non-fatal: best-effort revocation */ }
}

// ── McpAuth class ─────────────────────────────────────────────────────────────

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 min before expiry

export class McpAuth {
  private serverKey: string | null = null;
  // B23: Step-up 认证状态（claude-code auth.ts markStepUpPending() parity）
  // 当检测到 403 insufficient_scope 时设置，下次 getToken() 跳过 refresh 走完整 PKCE
  private _pendingStepUpScope: string | null = null;

  constructor(private readonly serverName: string) {}

  private getServerKey(config: OAuthConfig): string {
    if (!this.serverKey) {
      this.serverKey = computeServerKey(this.serverName, config);
    }
    return this.serverKey;
  }

  /**
   * B23: 创建带 step-up 检测的 fetch 包装器
   * 返回的 fetch 会在检测到 403 insufficient_scope 时触发 _pendingStepUpScope
   */
  createFetchWithStepUp(): typeof globalThis.fetch {
    return wrapFetchWithStepUpDetection(globalThis.fetch, (scope) => {
      this._pendingStepUpScope = scope;
      process.stderr.write(
        `[MCP OAuth] ${this.serverName}: step-up required for scope "${scope}" — next request will re-authenticate.\n`,
      );
    });
  }

  /**
   * Get a valid access token, initiating OAuth flow if needed.
   * Prints instructions to stderr so TTY stdout is not corrupted.
   * C23: 若 config 未设置 authorizationUrl/tokenUrl，先调用 RFC 9728 自动发现链。
   */
  async getToken(config: OAuthConfig): Promise<TokenData> {
    // C23: 若未提供 endpoints，先 RFC 9728 自动发现，然后递归调用
    if (!config.authorizationUrl || !config.tokenUrl) {
      if (config.serverUrl) {
        const discovered = await discoverOAuthEndpoints(config.serverUrl).catch(() => null);
        if (discovered) {
          return this.getToken({
            ...config,
            authorizationUrl: discovered.authorizationEndpoint,
            tokenUrl: discovered.tokenEndpoint,
          });
        }
        // 无法发现 → 交给 authorize() 抛出清晰错误
      }
    }
    const key = this.getServerKey(config);
    const cached = await loadToken(key);
    if (cached) {
      // B23: Step-up pending — 跳过 refresh_token，强制走完整 PKCE
      if (this._pendingStepUpScope) {
        this._pendingStepUpScope = null; // 清除标志（无论后续认证是否成功）
        await clearToken(key);           // 清除旧 token
        return this.authorize(config);
      }
      // Token still valid (with 5-min buffer)?
      if (cached.expiresAt - Date.now() > REFRESH_BUFFER_MS) {
        return cached;
      }
      // Try refresh
      if (cached.refresh_token) {
        try {
          return await refreshTokenData(key, config, cached);
        } catch {
          // Refresh failed — fall through to full re-auth
        }
      }
    }
    return this.authorize(config);
  }

  /**
   * Initiate Authorization Code Flow (PKCE).
   * C23: 若 config 未设置 authorizationUrl/tokenUrl，先调用 RFC 9728 自动发现链。
   */
  async authorize(config: OAuthConfig): Promise<TokenData> {
    // C23: 若未提供 endpoints，先 RFC 9728 自动发现
    let effectiveConfig = config;
    if (!config.authorizationUrl || !config.tokenUrl) {
      if (config.serverUrl) {
        const discovered = await discoverOAuthEndpoints(config.serverUrl).catch(() => null);
        if (discovered) {
          effectiveConfig = {
            ...config,
            authorizationUrl: discovered.authorizationEndpoint,
            tokenUrl: discovered.tokenEndpoint,
          };
        } else {
          throw new Error(
            `[MCP OAuth] Cannot auto-discover OAuth endpoints for ${this.serverName}. ` +
            `Please configure authorizationUrl and tokenUrl manually.`,
          );
        }
      } else {
        throw new Error(
          `[MCP OAuth] ${this.serverName}: authorizationUrl and tokenUrl are required ` +
          `(or provide serverUrl for RFC 9728 auto-discovery).`,
        );
      }
    }

    const port = effectiveConfig.callbackPort ?? 9876;
    const redirectUri = effectiveConfig.redirectUri ?? `http://localhost:${port}/callback`;
    const verifier = generateCodeVerifier();
    const challenge = generateCodeChallenge(verifier);
    const state = randomBytes(8).toString('hex');
    const scopes = (effectiveConfig.scopes ?? ['openid']).join(' ');

    const authUrl = new URL(effectiveConfig.authorizationUrl!);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', effectiveConfig.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', scopes);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    process.stderr.write(
      `\n[MCP OAuth] Opening browser for ${this.serverName}...\n` +
      `  If browser does not open, visit:\n  ${authUrl.toString()}\n\n`,
    );
    await openBrowser(authUrl.toString());
    const code = await waitForCallback(port);
    const key = this.getServerKey(effectiveConfig);
    const token = await exchangeCode(code, effectiveConfig, verifier, redirectUri);
    await saveToken(key, token);
    process.stderr.write(`[MCP OAuth] ${this.serverName}: authorized successfully.\n`);
    return token;
  }

  /** Check if a valid token exists without triggering OAuth flow */
  async hasToken(config: OAuthConfig): Promise<boolean> {
    const key = this.getServerKey(config);
    const t = await loadToken(key);
    return t !== null && t.expiresAt - Date.now() > 0;
  }

  /**
   * Revoke token via RFC 7009 revocation endpoint, then clear local storage.
   * Sends revocation for refresh_token first, then access_token (best-effort).
   */
  async revoke(config?: OAuthConfig): Promise<void> {
    const key = config ? this.getServerKey(config) : `${this.serverName}|`;
    const token = await loadToken(key);
    if (token && config?.revocationUrl) {
      // RFC 7009: revoke refresh_token first (invalidates all derived access tokens)
      if (token.refresh_token) {
        await revokeTokenAtServer(token.refresh_token, 'refresh_token', config);
      }
      await revokeTokenAtServer(token.access_token, 'access_token', config);
    }
    await clearToken(key);
  }

  /** Get token status string for /mcp display */
  async status(config?: OAuthConfig): Promise<string> {
    const key = config ? this.getServerKey(config) : null;
    const t = key ? await loadToken(key) : null;
    if (!t) return 'unauthenticated';
    const remaining = t.expiresAt - Date.now();
    if (remaining <= 0) return 'token expired';
    const minLeft = Math.floor(remaining / 60000);
    if (minLeft < 5) return `token expiring soon (${minLeft}m)`;
    const hrLeft = Math.floor(minLeft / 60);
    return hrLeft > 0 ? `authenticated (${hrLeft}h left)` : `authenticated (${minLeft}m left)`;
  }
}

// ── Singleton map ─────────────────────────────────────────────────────────────

const _instances = new Map<string, McpAuth>();

export function getMcpAuth(serverName: string): McpAuth {
  if (!_instances.has(serverName)) {
    _instances.set(serverName, new McpAuth(serverName));
  }
  return _instances.get(serverName)!;
}

/**
 * C23: hasMcpDiscoveryButNoToken — 已发现 AS 但无有效 token
 *
 * 用于连接预检：若此函数返回 true，跳过连接尝试，提示用户先认证。
 * Mirrors claude-code auth.ts L349-363 hasMcpDiscoveryButNoToken().
 */
export async function hasMcpDiscoveryButNoToken(
  serverName: string,
  serverUrl: string,
): Promise<boolean> {
  const discovered = await discoverOAuthEndpoints(serverUrl).catch(() => null);
  if (!discovered) return false; // 不支持 OAuth → 无需认证
  const auth = getMcpAuth(serverName);
  const hasT = await auth.hasToken({
    authorizationUrl: discovered.authorizationEndpoint,
    tokenUrl: discovered.tokenEndpoint,
    clientId: 'uagent',
  }).catch(() => false);
  return !hasT;
}
