/**
 * E19: apiKeyHelper — External program SWR (Stale-While-Revalidate) API key cache.
 *
 * Mirrors claude-code src/utils/auth.ts apiKeyHelper mechanism (Lines 355-583).
 *
 * Use case: Enterprise environments that store API keys in Vault, AWS Secrets Manager,
 * or other dynamic secret stores. Instead of a static ANTHROPIC_API_KEY env var,
 * users configure an `apiKeyHelper` command that returns the current key.
 *
 * SWR semantics:
 *   1. First call: execute command, cache result, return key
 *   2. Subsequent calls within TTL: return cached key immediately
 *   3. After TTL: return stale cached key immediately, refresh in background
 *   4. On 401: call clearApiKeyHelperCache() to force next call to re-execute
 *
 * Configuration:
 *   In .uagent/config.json or ~/.uagent/config.json:
 *   { "apiKeyHelper": "vault read -field=key secret/anthropic/api-key" }
 *
 * Environment override:
 *   UNIVERSAL_AGENT_API_KEY_HELPER_TTL_MS — cache TTL in ms (default: 5 minutes)
 *
 * Security: apiKeyHelper command inherits the current process's env vars.
 * The command is executed via shell, so treat it as code you trust.
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/** Cache TTL: default 5 minutes, configurable via env var */
const API_KEY_HELPER_TTL_MS = parseInt(
  process.env.UNIVERSAL_AGENT_API_KEY_HELPER_TTL_MS ?? String(5 * 60 * 1000),
  10,
);

/** Maximum execution time for apiKeyHelper command (10 minutes — mirrors claude-code) */
const API_KEY_HELPER_TIMEOUT_MS = 10 * 60 * 1000;

/** Cached API key entry */
interface ApiKeyCache {
  key: string;
  fetchedAt: number;
}

/** In-memory SWR cache */
let _cache: ApiKeyCache | null = null;

/** Epoch counter — incremented on clearApiKeyHelperCache() to invalidate in-flight refreshes */
let _epoch = 0;

/** Whether a background refresh is currently in progress */
let _refreshing = false;

/**
 * E19: Execute the apiKeyHelper command and return the trimmed output.
 * Returns null on failure (non-zero exit, timeout, or empty output).
 */
async function executeApiKeyHelper(command: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: API_KEY_HELPER_TIMEOUT_MS,
      env: process.env,
    });

    if (stderr?.trim()) {
      // Log stderr to help debugging without surfacing to user
      // Using console.error so it appears in debug logs but not main output
      process.stderr.write(`[apiKeyHelper] stderr: ${stderr.trim()}\n`);
    }

    const key = stdout.trim();
    if (!key) return null;
    return key;
  } catch {
    return null;
  }
}

/**
 * E19: Get API key from helper with SWR semantics.
 *
 * - If cache is fresh (< TTL): return cached key
 * - If cache is stale (≥ TTL): return stale key + trigger background refresh
 * - If no cache: execute command and wait for result
 *
 * Returns null if no apiKeyHelper is configured or execution fails.
 */
export async function getApiKeyFromHelper(command: string): Promise<string | null> {
  const now = Date.now();

  // Cache hit and still fresh
  if (_cache && (now - _cache.fetchedAt) < API_KEY_HELPER_TTL_MS) {
    return _cache.key;
  }

  // Cache stale — return stale value + trigger background refresh
  if (_cache && !_refreshing) {
    _refreshing = true;
    const epochAtStart = _epoch;
    executeApiKeyHelper(command).then((key) => {
      // Only update cache if epoch hasn't changed (no clearApiKeyHelperCache() call)
      if (key && _epoch === epochAtStart) {
        _cache = { key, fetchedAt: Date.now() };
      }
      _refreshing = false;
    }).catch(() => { _refreshing = false; });
    return _cache.key; // Return stale key immediately
  }

  // No cache — execute and wait
  const key = await executeApiKeyHelper(command);
  if (key) {
    _cache = { key, fetchedAt: Date.now() };
    return key;
  }
  return null;
}

/**
 * E19: Synchronously get the cached API key (if available and still within TTL).
 * Returns null if cache is empty or stale.
 * Used in hot paths where awaiting a command execution is not acceptable.
 */
export function getApiKeyFromHelperCached(): string | null {
  if (!_cache) return null;
  if (Date.now() - _cache.fetchedAt >= API_KEY_HELPER_TTL_MS) return null;
  return _cache.key;
}

/**
 * E19: Clear the API key cache.
 * Call this when receiving a 401 Unauthorized response to force re-execution
 * of the apiKeyHelper command on the next getApiKeyFromHelper() call.
 *
 * Incrementing _epoch invalidates any in-flight background refresh.
 */
export function clearApiKeyHelperCache(): void {
  _cache = null;
  _epoch++;
}

/**
 * E19: Resolve API key — check apiKeyHelper config and fall back to env var.
 *
 * Priority:
 *   1. apiKeyHelper command (if configured in .uagent/config.json)
 *   2. ANTHROPIC_API_KEY env var
 *   3. OPENAI_API_KEY env var
 *
 * @param apiKeyHelperCommand  Command string from config, or undefined if not configured
 * @returns API key string, or null if none available
 */
export async function resolveApiKey(apiKeyHelperCommand?: string): Promise<string | null> {
  if (apiKeyHelperCommand) {
    const helperKey = await getApiKeyFromHelper(apiKeyHelperCommand);
    if (helperKey) return helperKey;
  }
  return process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY ?? null;
}
