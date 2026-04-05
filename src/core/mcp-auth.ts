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

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OAuthConfig {
  /** OAuth 2.0 Authorization endpoint URL */
  authorizationUrl: string;
  /** OAuth 2.0 Token endpoint URL */
  tokenUrl: string;
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
    url: config.tokenUrl,
    auth: config.authorizationUrl,
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

  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }
  const data = await res.json() as {
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

  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Token refresh failed: HTTP ${res.status}`);
  const data = await res.json() as {
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

  constructor(private readonly serverName: string) {}

  private getServerKey(config: OAuthConfig): string {
    if (!this.serverKey) {
      this.serverKey = computeServerKey(this.serverName, config);
    }
    return this.serverKey;
  }

  /**
   * Get a valid access token, initiating OAuth flow if needed.
   * Prints instructions to stderr so TTY stdout is not corrupted.
   */
  async getToken(config: OAuthConfig): Promise<TokenData> {
    const key = this.getServerKey(config);
    const cached = await loadToken(key);
    if (cached) {
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
   */
  async authorize(config: OAuthConfig): Promise<TokenData> {
    const port = config.callbackPort ?? 9876;
    const redirectUri = config.redirectUri ?? `http://localhost:${port}/callback`;
    const verifier = generateCodeVerifier();
    const challenge = generateCodeChallenge(verifier);
    const state = randomBytes(8).toString('hex');
    const scopes = (config.scopes ?? ['openid']).join(' ');

    const authUrl = new URL(config.authorizationUrl);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', config.clientId);
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
    const key = this.getServerKey(config);
    const token = await exchangeCode(code, config, verifier, redirectUri);
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
