/**
 * CurlExecute Tool — inspired by kstack #15372 "邪修 TDD"
 *
 * Article insight: AI 改完代码后，最自然的验证方式就是直接 curl 接口看响应。
 * "邪修 TDD" 的第一步就是：F12 抓 curl → 给 AI → AI 自己执行验证。
 *
 * This tool lets the Agent:
 *   1. Execute any curl command and get structured output
 *   2. Parse response: status code, headers, body (JSON auto-parsed)
 *   3. Build and execute curl from structured params (no raw curl needed)
 *   4. Extract/assert specific fields from JSON responses
 *   5. Chain multiple requests for end-to-end API testing
 *
 * The key difference from just using bash: CurlExecute returns structured data
 * that the Agent can reason about (compare fields, detect regressions, etc.)
 * rather than opaque text.
 *
 * Tools:
 *   CurlExecute  — Execute a curl command or build one from params, return structured result
 */

import { execSync } from 'child_process';
import type { ToolRegistration } from '../../../models/types.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface CurlResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  bodyParsed: unknown;
  durationMs: number;
  url: string;
  method: string;
  success: boolean;
  error?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      const key = line.slice(0, colon).trim().toLowerCase();
      const val = line.slice(colon + 1).trim();
      headers[key] = val;
    }
  }
  return headers;
}

function tryParseJson(body: string): unknown {
  try { return JSON.parse(body); } catch { return null; }
}

function formatResult(result: CurlResult, verbose: boolean): string {
  const statusIcon = result.success ? '✅' : '❌';
  const lines: string[] = [
    `${statusIcon} ${result.method} ${result.url}`,
    `   Status:   ${result.status} ${result.statusText}`,
    `   Duration: ${result.durationMs}ms`,
  ];

  if (result.error) {
    lines.push(`   Error:    ${result.error}`);
  }

  if (verbose && Object.keys(result.headers).length > 0) {
    lines.push('\n📋 Response Headers:');
    for (const [k, v] of Object.entries(result.headers)) {
      lines.push(`   ${k}: ${v}`);
    }
  }

  lines.push('\n📄 Response Body:');
  if (result.bodyParsed && typeof result.bodyParsed === 'object') {
    // Pretty-print JSON, truncated
    const pretty = JSON.stringify(result.bodyParsed, null, 2);
    const truncated = pretty.length > 3000;
    lines.push(truncated ? pretty.slice(0, 3000) + '\n... [truncated]' : pretty);
  } else if (result.body) {
    const truncated = result.body.length > 3000;
    lines.push(truncated ? result.body.slice(0, 3000) + '\n... [truncated]' : result.body);
  } else {
    lines.push('   (empty body)');
  }

  return lines.join('\n');
}

// ── Tool ─────────────────────────────────────────────────────────────────────

export const curlExecuteTool: ToolRegistration = {
  definition: {
    name: 'CurlExecute',
    description: [
      'Execute an HTTP request (via curl) and get structured results: status code, headers, parsed JSON body, duration.',
      'Inspired by kstack #15372 "邪修 TDD": AI can verify API behavior by directly executing requests.',
      '',
      'Two modes:',
      '  1. Raw curl: pass the full curl command string (e.g. copied from browser DevTools)',
      '  2. Structured: specify url + method + headers + body — tool builds the curl command',
      '',
      'Returns structured data the Agent can reason about (check status codes, extract fields, compare values).',
      'Ideal for: API testing, verifying DB writes via HTTP, end-to-end flow validation.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        curl_command: {
          type: 'string',
          description: [
            'Raw curl command to execute. Paste directly from browser DevTools "Copy as cURL".',
            'If provided, url/method/headers/body are ignored.',
            'Example: curl -X POST https://api.example.com/users -H "Authorization: Bearer token" -d \'{"name":"test"}\'',
          ].join('\n'),
        },
        url: {
          type: 'string',
          description: 'Request URL (used when curl_command is not provided).',
        },
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
          description: 'HTTP method (default: GET).',
        },
        headers: {
          type: 'object',
          description: 'Request headers as key-value pairs. E.g. {"Authorization": "Bearer token", "Content-Type": "application/json"}.',
          properties: {},
        },
        body: {
          type: 'string',
          description: 'Request body (for POST/PUT/PATCH). JSON strings will be sent with Content-Type: application/json.',
        },
        timeout_seconds: {
          type: 'number',
          description: 'Request timeout in seconds (default: 30).',
        },
        follow_redirects: {
          type: 'boolean',
          description: 'Follow HTTP redirects (default: true).',
        },
        verbose: {
          type: 'boolean',
          description: 'Include response headers in output (default: false).',
        },
        assert_status: {
          type: 'number',
          description: 'If provided, the tool will flag an error if the response status != this value.',
        },
        extract_path: {
          type: 'string',
          description: [
            'Dot-notation path to extract from JSON response body.',
            'E.g. "data.user.id" extracts response.data.user.id',
            'E.g. "items.0.name" extracts first item\'s name from an array',
          ].join('\n'),
        },
        env_vars: {
          type: 'object',
          description: 'Environment variables to set for the curl command (e.g. for cookie files or auth tokens).',
          properties: {},
        },
      },
    },
  },

  async handler(args: Record<string, unknown>): Promise<string> {
    const timeout = Number(args.timeout_seconds ?? 30);
    const verbose = Boolean(args.verbose ?? false);
    const followRedirects = Boolean(args.follow_redirects ?? true);
    const assertStatus = args.assert_status ? Number(args.assert_status) : null;
    const extractPath = args.extract_path ? String(args.extract_path) : null;

    let curlCmd: string;
    let url = '(unknown)';
    let method = 'GET';

    if (args.curl_command) {
      // Raw curl mode — user pasted from DevTools
      curlCmd = String(args.curl_command).trim();

      // Extract method and URL for display
      const methodMatch = curlCmd.match(/-X\s+(\w+)/);
      if (methodMatch) method = methodMatch[1];
      const urlMatch = curlCmd.match(/curl\s+(?:-\S+\s+)*['"]?(https?:\/\/[^\s'"]+)['"]?/);
      if (urlMatch) url = urlMatch[1];
    } else {
      // Structured mode — build curl command
      if (!args.url) return 'Error: Either curl_command or url is required.';
      url = String(args.url);
      method = String(args.method ?? 'GET').toUpperCase();

      const parts = ['curl'];
      parts.push(`-X ${method}`);

      // Headers
      const headers = (args.headers && typeof args.headers === 'object')
        ? args.headers as Record<string, string>
        : {};

      // Auto-detect JSON body
      const body = args.body ? String(args.body) : null;
      if (body && !headers['content-type'] && !headers['Content-Type']) {
        try { JSON.parse(body); headers['Content-Type'] = 'application/json'; } catch { /* keep as-is */ }
      }

      for (const [k, v] of Object.entries(headers)) {
        parts.push(`-H '${k}: ${v.replace(/'/g, "'\\''")}'`);
      }

      if (body) parts.push(`-d '${body.replace(/'/g, "'\\''")}'`);
      if (followRedirects) parts.push('-L');
      parts.push(`--max-time ${timeout}`);

      // Capture headers separately with -D -
      parts.push('-D -');  // dump headers to stdout
      parts.push('-s');    // silent (no progress)
      parts.push(`'${url.replace(/'/g, "'\\''")}'`);

      curlCmd = parts.join(' ');
    }

    // Add -D - and -s if raw curl doesn't have them
    if (args.curl_command) {
      if (!curlCmd.includes('-D -') && !curlCmd.includes('--dump-header')) {
        curlCmd = curlCmd.replace(/^curl/, 'curl -D - -s');
      }
      if (!curlCmd.includes('--max-time') && !curlCmd.includes('-m ')) {
        curlCmd += ` --max-time ${timeout}`;
      }
      if (followRedirects && !curlCmd.includes('-L') && !curlCmd.includes('--location')) {
        curlCmd += ' -L';
      }
    }

    const startTime = Date.now();
    let rawOutput: string;

    try {
      const envOverrides = (args.env_vars && typeof args.env_vars === 'object')
        ? args.env_vars as Record<string, string>
        : {};
      rawOutput = execSync(curlCmd, {
        encoding: 'utf-8',
        timeout: (timeout + 5) * 1000,
        env: { ...process.env as Record<string, string>, ...envOverrides },
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number; message?: string };
      const durationMs = Date.now() - startTime;
      const output = e.stdout ?? '';
      const errMsg = e.stderr || e.message || 'curl failed';

      // Try to parse whatever output we got
      if (output) {
        // Fall through to parse partial output
        rawOutput = output;
      } else {
        return [
          `❌ curl failed (${durationMs}ms)`,
          `   URL:    ${url}`,
          `   Error:  ${errMsg.slice(0, 500)}`,
        ].join('\n');
      }
    }

    const durationMs = Date.now() - startTime;

    // ── Parse response: split headers from body ────────────────────────────────
    // curl -D - outputs: HTTP/1.1 STATUS\r\nheaders...\r\n\r\nbody
    const headerBodySplit = rawOutput.indexOf('\r\n\r\n');
    let headerSection = '';
    let body = rawOutput;

    if (headerBodySplit !== -1) {
      headerSection = rawOutput.slice(0, headerBodySplit);
      body = rawOutput.slice(headerBodySplit + 4);
    }

    // Parse status line
    const statusMatch = headerSection.match(/HTTP\/[\d.]+ (\d+)\s*(.*)/i)
      ?? rawOutput.match(/HTTP\/[\d.]+ (\d+)\s*(.*)/i);
    const status = statusMatch ? parseInt(statusMatch[1]) : 0;
    const statusText = statusMatch ? (statusMatch[2] ?? '').trim() : 'Unknown';

    const headers = parseHeaders(headerSection);
    const bodyParsed = tryParseJson(body.trim());

    const result: CurlResult = {
      status, statusText, headers,
      body: body.trim(),
      bodyParsed,
      durationMs,
      url, method,
      success: status >= 200 && status < 300,
    };

    // ── Extract path from JSON ────────────────────────────────────────────────
    let extractedValue: string | null = null;
    if (extractPath && bodyParsed) {
      try {
        const parts = extractPath.split('.');
        let current: unknown = bodyParsed;
        for (const part of parts) {
          if (current && typeof current === 'object') {
            current = (current as Record<string, unknown>)[part];
          } else if (Array.isArray(current)) {
            current = (current as unknown[])[parseInt(part)];
          } else {
            current = undefined;
            break;
          }
        }
        extractedValue = current !== undefined ? JSON.stringify(current) : null;
      } catch { /* ignore */ }
    }

    // ── Assert status ─────────────────────────────────────────────────────────
    const assertFailed = assertStatus !== null && result.status !== assertStatus;

    const output = formatResult(result, verbose);
    const extras: string[] = [];

    if (extractedValue !== null) {
      extras.push(`\n🔍 Extracted [${extractPath}]: ${extractedValue}`);
    }

    if (assertFailed) {
      extras.push(`\n⚠️  Assertion FAILED: expected status ${assertStatus}, got ${result.status}`);
    } else if (assertStatus !== null) {
      extras.push(`\n✅ Assertion PASSED: status is ${assertStatus}`);
    }

    return output + extras.join('');
  },
};
