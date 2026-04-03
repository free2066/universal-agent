/**
 * RedisProbe Tool — inspired by kstack #15372 "邪修 TDD"
 *
 * Article insight: "改完代码后，AI 需要自主验证数据流转对不对 —— DB 写对了吗？Redis 更新了吗？"
 * Redis is typically the hardest to inspect because devs have to manually run redis-cli.
 *
 * This tool gives the Agent direct read access to Redis, enabling:
 *   - Verify that cache was written after an API call (邪修 TDD step: check Redis after curl)
 *   - Check TTL to confirm expiration policy is correct
 *   - Scan keys to find unexpected entries (regression detection)
 *   - Inspect hash/list/sorted set contents
 *   - Compare cached value with expected value
 *
 * Implementation: wraps redis-cli (must be installed on the system).
 * No Node.js Redis client dependency needed — redis-cli is universally available
 * wherever Redis is installed.
 *
 * Tools:
 *   RedisProbe  — One tool with a 'command' selector (GET/TTL/KEYS/SCAN/TYPE/HGET/HGETALL/LRANGE/SMEMBERS/ZRANGE/INFO/PING)
 */

import { execSync } from 'child_process';
import type { ToolRegistration } from '../../../models/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
  tls?: boolean;
}

function buildRedisCliPrefix(config: RedisConfig): string {
  const parts = ['redis-cli'];
  parts.push(`-h ${config.host}`);
  parts.push(`-p ${config.port}`);
  if (config.password) parts.push(`-a '${config.password.replace(/'/g, "'\\''")}'`);
  if (config.db !== undefined && config.db !== 0) parts.push(`-n ${config.db}`);
  if (config.tls) parts.push('--tls');
  return parts.join(' ');
}

function runRedisCli(cmd: string, timeoutMs = 5000): { output: string; error?: string } {
  try {
    const output = execSync(cmd, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return { output };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const stderr = (e.stderr ?? '').trim();
    const stdout = (e.stdout ?? '').trim();
    return {
      output: stdout,
      error: stderr || (err instanceof Error ? err.message : String(err)),
    };
  }
}

function parseConfig(args: Record<string, unknown>): RedisConfig {
  // Support connection URL: redis://[:password@]host[:port][/db]
  if (args.url) {
    const urlStr = String(args.url);
    try {
      const u = new URL(urlStr);
      return {
        host: u.hostname || '127.0.0.1',
        port: u.port ? parseInt(u.port) : 6379,
        password: u.password || undefined,
        db: u.pathname && u.pathname !== '/' ? parseInt(u.pathname.slice(1)) : 0,
        tls: u.protocol === 'rediss:',
      };
    } catch { /* fall through to manual config */ }
  }
  return {
    host: args.host ? String(args.host) : (process.env.REDIS_HOST ?? '127.0.0.1'),
    port: args.port ? Number(args.port) : parseInt(process.env.REDIS_PORT ?? '6379'),
    password: args.password ? String(args.password) : (process.env.REDIS_PASSWORD ?? undefined),
    db: args.db !== undefined ? Number(args.db) : undefined,
  };
}

function tryParseJson(s: string): string {
  try {
    const parsed = JSON.parse(s);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return s;
  }
}

// ── Tool ─────────────────────────────────────────────────────────────────────

export const redisProbeTool: ToolRegistration = {
  definition: {
    name: 'RedisProbe',
    description: [
      'Query Redis to verify cached data, TTLs, and key state — part of "邪修 TDD" (kstack #15372).',
      'Enables AI to autonomously verify that caching behaves correctly after code changes.',
      '',
      'Requires redis-cli to be installed on the system.',
      'Supports: GET, TTL, KEYS, SCAN, TYPE, HGET, HGETALL, LRANGE, SMEMBERS, ZRANGE, INFO, PING, EXISTS, MGET',
      '',
      'Connection priority:',
      '  1. url parameter (redis://[:password@]host[:port][/db])',
      '  2. host/port/password/db parameters',
      '  3. REDIS_HOST / REDIS_PORT / REDIS_PASSWORD env vars (default: 127.0.0.1:6379)',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          enum: ['GET', 'TTL', 'PTTL', 'KEYS', 'SCAN', 'TYPE', 'HGET', 'HGETALL',
                 'LRANGE', 'SMEMBERS', 'ZRANGE', 'INFO', 'PING', 'EXISTS', 'MGET',
                 'STRLEN', 'LLEN', 'SCARD', 'HLEN', 'DBSIZE'],
          description: 'Redis command to execute.',
        },
        key: {
          type: 'string',
          description: 'Redis key to operate on (required for most commands except INFO, PING, DBSIZE).',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: [
            'Additional arguments after the key.',
            'HGET: [field]',
            'LRANGE: [start, stop] (e.g. ["0", "-1"] for all elements)',
            'ZRANGE: [start, stop] (e.g. ["0", "-1", "WITHSCORES"])',
            'MGET: additional keys (key arg becomes first key)',
            'SCAN: [cursor, "MATCH", pattern, "COUNT", count]',
          ].join('\n'),
        },
        url: {
          type: 'string',
          description: 'Redis connection URL: redis://[:password@]host[:port][/db] or rediss:// for TLS.',
        },
        host: {
          type: 'string',
          description: 'Redis host (default: REDIS_HOST env or 127.0.0.1).',
        },
        port: {
          type: 'number',
          description: 'Redis port (default: REDIS_PORT env or 6379).',
        },
        password: {
          type: 'string',
          description: 'Redis password (default: REDIS_PASSWORD env).',
        },
        db: {
          type: 'number',
          description: 'Redis database index (default: 0).',
        },
        parse_json: {
          type: 'boolean',
          description: 'If true, attempt to parse the value as JSON and pretty-print it (default: true).',
        },
        assert_exists: {
          type: 'boolean',
          description: 'If true, flag an error if the key does not exist (for GET/EXISTS commands).',
        },
        assert_value: {
          type: 'string',
          description: 'If provided, flag an error if the value does not equal this string.',
        },
      },
      required: ['command'],
    },
  },

  async handler(args: Record<string, unknown>): Promise<string> {
    const command = String(args.command ?? '').toUpperCase();
    const key = args.key ? String(args.key) : null;
    const extraArgs = Array.isArray(args.args) ? args.args.map(String) : [];
    const parseJson = Boolean(args.parse_json ?? true);
    const assertExists = Boolean(args.assert_exists ?? false);
    const assertValue = args.assert_value !== undefined ? String(args.assert_value) : null;

    const config = parseConfig(args);
    const prefix = buildRedisCliPrefix(config);

    // Validate required key
    const noKeyCommands = ['INFO', 'PING', 'DBSIZE', 'SCAN'];
    if (!key && !noKeyCommands.includes(command)) {
      return `Error: The ${command} command requires a key parameter.`;
    }

    // Build the redis-cli command
    const cmdParts = [prefix];
    cmdParts.push(command);
    if (key) cmdParts.push(`'${key.replace(/'/g, "'\\''")}'`);
    for (const arg of extraArgs) {
      cmdParts.push(`'${arg.replace(/'/g, "'\\''")}'`);
    }
    const fullCmd = cmdParts.join(' ');

    const { output, error } = runRedisCli(fullCmd);

    if (error && !output) {
      // Check if redis-cli is installed
      if (error.includes('command not found') || error.includes('not found')) {
        return [
          `❌ redis-cli not found. Please install Redis:`,
          `   macOS:  brew install redis`,
          `   Ubuntu: sudo apt-get install redis-tools`,
          `   CentOS: sudo yum install redis`,
        ].join('\n');
      }
      if (error.includes('Connection refused') || error.includes('NOAUTH')) {
        return [
          `❌ Redis connection failed: ${error}`,
          `   Host: ${config.host}:${config.port}`,
          error.includes('NOAUTH') ? '   Hint: Redis requires authentication. Provide password parameter.' : '',
          `   Hint: Is Redis running? Try: redis-cli ping`,
        ].filter(Boolean).join('\n');
      }
      return `❌ Redis error: ${error}`;
    }

    // Format output based on command
    const lines: string[] = [];
    const connStr = `${config.host}:${config.port}${config.db ? `/db${config.db}` : ''}`;

    lines.push(`🔴 Redis [${connStr}] — ${command}${key ? ` "${key}"` : ''}${extraArgs.length > 0 ? ` ${extraArgs.join(' ')}` : ''}`);
    lines.push('');

    if (!output || output === '(nil)' || output === '') {
      lines.push('   Result: (nil) — key does not exist');
      if (assertExists) {
        lines.push(`\n⚠️  Assertion FAILED: key "${key}" does not exist in Redis`);
      }
      return lines.join('\n');
    }

    // Special formatting for specific commands
    if (command === 'PING') {
      lines.push(`   ✅ ${output}`);
      return lines.join('\n');
    }

    if (command === 'TTL' || command === 'PTTL') {
      const ttlNum = parseInt(output);
      if (ttlNum === -1) lines.push('   TTL: No expiration (key persists indefinitely)');
      else if (ttlNum === -2) lines.push('   TTL: Key does not exist');
      else if (command === 'TTL') lines.push(`   TTL: ${ttlNum}s (expires in ${(ttlNum / 60).toFixed(1)} minutes)`);
      else lines.push(`   PTTL: ${ttlNum}ms`);
      return lines.join('\n');
    }

    if (command === 'EXISTS') {
      const exists = output === '1';
      lines.push(`   Exists: ${exists ? '✅ YES' : '❌ NO'}`);
      if (assertExists && !exists) {
        lines.push(`\n⚠️  Assertion FAILED: key "${key}" does not exist`);
      }
      return lines.join('\n');
    }

    if (command === 'TYPE') {
      lines.push(`   Type: ${output}`);
      return lines.join('\n');
    }

    if (command === 'DBSIZE') {
      lines.push(`   Database size: ${output} keys`);
      return lines.join('\n');
    }

    // For commands returning lists (KEYS, HGETALL, LRANGE, SMEMBERS, ZRANGE)
    if (['KEYS', 'HGETALL', 'LRANGE', 'SMEMBERS', 'ZRANGE', 'MGET'].includes(command)) {
      const items = output.split('\n').filter(Boolean);
      lines.push(`   Count: ${items.length} item(s)`);
      lines.push('   Values:');
      for (const item of items.slice(0, 50)) {
        const display = parseJson ? tryParseJson(item.trim()) : item.trim();
        lines.push(`     ${display}`);
      }
      if (items.length > 50) lines.push(`     ... and ${items.length - 50} more`);
      return lines.join('\n');
    }

    // Default: single value (GET, HGET, STRLEN, LLEN, SCARD, HLEN)
    const displayValue = parseJson ? tryParseJson(output) : output;
    const truncated = displayValue.length > 2000;
    lines.push(`   Value:`);
    lines.push(truncated ? displayValue.slice(0, 2000) + '\n   ... [truncated]' : displayValue);

    // Assertions
    if (assertValue !== null) {
      const matches = output.trim() === assertValue.trim();
      if (matches) {
        lines.push(`\n✅ Assertion PASSED: value equals "${assertValue}"`);
      } else {
        lines.push(`\n⚠️  Assertion FAILED:`);
        lines.push(`   Expected: "${assertValue}"`);
        lines.push(`   Got:      "${output.trim().slice(0, 200)}"`);
      }
    }

    return lines.join('\n');
  },
};
