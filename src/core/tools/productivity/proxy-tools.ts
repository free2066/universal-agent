/**
 * HTTP Proxy / Traffic Capture Tools
 *
 * Inspired by kstack #15370 "抓包 MCP":
 * The article describes AI using a packet-capture MCP to:
 *   - Intercept HTTP traffic automatically
 *   - Analyze API request/response pairs without human relay
 *   - Mock specific endpoints for testing before the real server is ready
 *   - Debug networking issues autonomously
 *
 * For universal-agent, this means a lightweight local HTTP proxy that:
 *   1. Listens on a configurable port (default 8888)
 *   2. Forwards requests to their destinations (HTTP CONNECT tunneling for HTTPS)
 *   3. Captures request/response pairs into an in-memory log
 *   4. Allows Agent to query captured traffic (filter by URL, method, status)
 *   5. Allows Agent to mock specific URL patterns with custom responses
 *   6. Allows Agent to analyze request bodies and response data
 *
 * Tools:
 *   ProxyStart     — Start the HTTP proxy on a local port
 *   ProxyStop      — Stop the proxy and discard captured traffic
 *   ProxyStatus    — Show proxy status and traffic summary
 *   ProxyCaptures  — Read captured HTTP request/response pairs
 *   ProxyMock      — Add a mock rule: intercept URL pattern → return custom response
 *   ProxyMockList  — List active mock rules
 *   ProxyMockClear — Remove mock rules
 *   ProxyClear     — Clear captured traffic log
 *
 * Usage example:
 *   1. ProxyStart port=8888
 *   2. Set HTTP_PROXY=http://localhost:8888 in your app/browser
 *   3. Make requests normally
 *   4. ProxyCaptures filter_url="api.example.com"  — see what was sent
 *   5. ProxyMock url_pattern="api.example.com/users" response='{"users":[]}'  — mock it
 *
 * Note: HTTPS interception requires client-side proxy configuration.
 * The proxy supports HTTP CONNECT tunneling but cannot decrypt HTTPS by default.
 */

import { createServer, type IncomingMessage, type ServerResponse, request as httpRequest } from 'http';
import { connect as netConnect, type Socket } from 'net';
import type { Duplex } from 'stream';
import type { ToolRegistration } from '../../../models/types.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface CapturedRequest {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  host: string;
  path: string;
  requestHeaders: Record<string, string>;
  requestBody: string;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
  durationMs: number;
  mocked: boolean;
}

interface MockRule {
  id: string;
  urlPattern: string;      // substring match or regex
  method?: string;         // GET, POST, etc. or undefined for all
  statusCode: number;
  responseBody: string;
  contentType: string;
  description?: string;
  hitCount: number;
  createdAt: number;
}

// ── Proxy Core ────────────────────────────────────────────────────────────────

class HttpProxyServer {
  private server: ReturnType<typeof createServer> | null = null;
  private port = 0;
  private startedAt = 0;
  private captures: CapturedRequest[] = [];
  private mockRules: MockRule[] = [];
  private captureCount = 0;
  private readonly MAX_CAPTURES = 500;
  private readonly MAX_BODY_CHARS = 4000;

  isRunning(): boolean { return this.server !== null; }
  getPort(): number { return this.port; }

  // ── Start ────────────────────────────────────────────────────────────────────

  start(port: number): Promise<{ port: number; proxyUrl: string }> {
    if (this.server) {
      return Promise.resolve({ port: this.port, proxyUrl: `http://localhost:${this.port}` });
    }

    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handleHttpRequest(req, res));

      // Handle CONNECT method for HTTPS tunneling
      server.on('connect', (req, clientSocket, head) => {
        this.handleConnect(req, clientSocket, head);
      });

      server.on('error', (err: Error) => {
        this.server = null;
        reject(err);
      });

      server.listen(port, '127.0.0.1', () => {
        const addr = server.address();
        this.port = typeof addr === 'object' && addr ? addr.port : port;
        this.server = server;
        this.startedAt = Date.now();
        resolve({ port: this.port, proxyUrl: `http://localhost:${this.port}` });
      });
    });
  }

  // ── HTTP Request Handler ─────────────────────────────────────────────────────

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';
    const startTime = Date.now();
    const captureId = `req_${++this.captureCount}_${Date.now()}`;

    // Collect request body
    const bodyChunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));

    req.on('end', () => {
      const requestBody = Buffer.concat(bodyChunks).toString('utf-8').slice(0, this.MAX_BODY_CHARS);

      // Check mock rules first
      const mockRule = this.findMockRule(url, method);
      if (mockRule) {
        mockRule.hitCount++;
        const responseBody = mockRule.responseBody;

        res.writeHead(mockRule.statusCode, {
          'Content-Type': mockRule.contentType,
          'X-Proxied-By': 'universal-agent-proxy',
          'X-Mocked': 'true',
        });
        res.end(responseBody);

        this.captureRequest({
          id: captureId,
          timestamp: startTime,
          method,
          url,
          host: new URL(url, 'http://unknown').hostname,
          path: new URL(url, 'http://unknown').pathname,
          requestHeaders: this.headersToRecord(req.headers),
          requestBody,
          responseStatus: mockRule.statusCode,
          responseHeaders: { 'content-type': mockRule.contentType },
          responseBody: responseBody.slice(0, this.MAX_BODY_CHARS),
          durationMs: Date.now() - startTime,
          mocked: true,
        });
        return;
      }

      // Forward request
      try {
        const parsedUrl = new URL(url);
        const options = {
          hostname: parsedUrl.hostname,
          port: parseInt(parsedUrl.port) || 80,
          path: parsedUrl.pathname + parsedUrl.search,
          method,
          headers: { ...req.headers, host: parsedUrl.host },
        };

        const proxyReq = httpRequest(options, (proxyRes) => {
          const resChunks: Buffer[] = [];
          proxyRes.on('data', (chunk: Buffer) => resChunks.push(chunk));
          proxyRes.on('end', () => {
            const responseBody = Buffer.concat(resChunks).toString('utf-8');
            res.writeHead(proxyRes.statusCode ?? 200, {
              ...proxyRes.headers,
              'X-Proxied-By': 'universal-agent-proxy',
            });
            res.end(responseBody);

            this.captureRequest({
              id: captureId,
              timestamp: startTime,
              method,
              url,
              host: parsedUrl.hostname,
              path: parsedUrl.pathname,
              requestHeaders: this.headersToRecord(req.headers),
              requestBody,
              responseStatus: proxyRes.statusCode ?? 0,
              responseHeaders: this.headersToRecord(proxyRes.headers),
              responseBody: responseBody.slice(0, this.MAX_BODY_CHARS),
              durationMs: Date.now() - startTime,
              mocked: false,
            });
          });
        });

        proxyReq.on('error', (err: Error) => {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end(`Proxy error: ${err.message}`);
        });

        if (bodyChunks.length > 0) proxyReq.write(Buffer.concat(bodyChunks));
        proxyReq.end();
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad proxy request');
      }
    });
  }

  // ── HTTPS CONNECT Tunneling ───────────────────────────────────────────────────

  private handleConnect(
    req: IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
  ) {
    const [hostname, portStr] = (req.url ?? '').split(':');
    const port = parseInt(portStr ?? '443');

    // Record that we saw a CONNECT to this host
    this.captureRequest({
      id: `tunnel_${++this.captureCount}`,
      timestamp: Date.now(),
      method: 'CONNECT',
      url: req.url ?? '',
      host: hostname,
      path: '',
      requestHeaders: this.headersToRecord(req.headers),
      requestBody: '',
      responseStatus: 200,
      responseHeaders: {},
      responseBody: '[HTTPS tunnel — content encrypted]',
      durationMs: 0,
      mocked: false,
    });

    const serverSocket = netConnect(port, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: universal-agent\r\n\r\n');
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => serverSocket.destroy());
  }

  // ── Mock Rules ───────────────────────────────────────────────────────────────

  private findMockRule(url: string, method: string): MockRule | null {
    for (const rule of this.mockRules) {
      const methodMatch = !rule.method || rule.method.toUpperCase() === method.toUpperCase();
      const urlMatch = url.includes(rule.urlPattern) ||
        (() => { try { return new RegExp(rule.urlPattern).test(url); } catch { return false; } })();
      if (methodMatch && urlMatch) return rule;
    }
    return null;
  }

  addMockRule(rule: Omit<MockRule, 'id' | 'hitCount' | 'createdAt'>): MockRule {
    const newRule: MockRule = {
      ...rule,
      id: `mock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      hitCount: 0,
      createdAt: Date.now(),
    };
    this.mockRules.unshift(newRule); // higher-priority rules first
    return newRule;
  }

  removeMockRule(id: string): boolean {
    const before = this.mockRules.length;
    this.mockRules = this.mockRules.filter((r) => r.id !== id);
    return this.mockRules.length < before;
  }

  clearMockRules(): number {
    const count = this.mockRules.length;
    this.mockRules = [];
    return count;
  }

  getMockRules(): MockRule[] { return this.mockRules; }

  // ── Captures ─────────────────────────────────────────────────────────────────

  private captureRequest(capture: CapturedRequest) {
    this.captures.push(capture);
    if (this.captures.length > this.MAX_CAPTURES) this.captures.shift();
  }

  getCaptures(opts: {
    last?: number;
    filterUrl?: string;
    filterMethod?: string;
    filterStatus?: number;
    mockedOnly?: boolean;
  }): CapturedRequest[] {
    let results = [...this.captures];
    if (opts.filterUrl)    results = results.filter((c) => c.url.includes(opts.filterUrl!));
    if (opts.filterMethod) results = results.filter((c) => c.method.toUpperCase() === opts.filterMethod!.toUpperCase());
    if (opts.filterStatus) results = results.filter((c) => c.responseStatus === opts.filterStatus!);
    if (opts.mockedOnly)   results = results.filter((c) => c.mocked);
    return results.slice(-(opts.last ?? 20));
  }

  clearCaptures(): number {
    const count = this.captures.length;
    this.captures = [];
    this.captureCount = 0;
    return count;
  }

  // ── Stop ─────────────────────────────────────────────────────────────────────

  stop(): void {
    this.server?.close();
    this.server = null;
    this.port = 0;
  }

  // ── Status ───────────────────────────────────────────────────────────────────

  getStatus(): string {
    if (!this.server) return '🔴 HTTP Proxy: not running';
    const uptime = ((Date.now() - this.startedAt) / 1000 / 60).toFixed(1);
    const statusCounts: Record<number, number> = {};
    for (const c of this.captures) {
      statusCounts[c.responseStatus] = (statusCounts[c.responseStatus] ?? 0) + 1;
    }
    const statusSummary = Object.entries(statusCounts)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([s, n]) => `${s}×${n}`)
      .join('  ');

    return [
      `🟢 HTTP Proxy — http://localhost:${this.port}`,
      `   Uptime:    ${uptime} minutes`,
      `   Captured:  ${this.captures.length} requests`,
      `   Mocked:    ${this.mockRules.length} active rule(s)`,
      `   Status codes: ${statusSummary || '(none yet)'}`,
      '',
      `   Configure: HTTP_PROXY=http://localhost:${this.port}`,
      `   macOS:     export http_proxy=http://localhost:${this.port}`,
    ].join('\n');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private headersToRecord(headers: Record<string, string | string[] | undefined>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (v !== undefined) result[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    return result;
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

const httpProxy = new HttpProxyServer();

// ── Tools ─────────────────────────────────────────────────────────────────────

export const proxyStartTool: ToolRegistration = {
  definition: {
    name: 'ProxyStart',
    description: [
      'Start a local HTTP proxy for traffic capture (inspired by kstack #15370 抓包 MCP).',
      'Once started, configure your app/browser to use HTTP_PROXY=http://localhost:<port>.',
      'The proxy captures all HTTP requests and responses for later analysis.',
      'Use ProxyCaptures to read traffic, ProxyMock to mock specific endpoints.',
      'HTTPS: supports CONNECT tunneling (traffic is logged but not decrypted).',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        port: {
          type: 'number',
          description: 'Port to listen on (default: 8888). Use 0 for auto-assign.',
        },
      },
    },
  },
  async handler(args: Record<string, unknown>): Promise<string> {
    const port = Number(args.port ?? 8888);
    if (httpProxy.isRunning()) {
      return [`⚠️  HTTP proxy already running.`, httpProxy.getStatus()].join('\n');
    }
    try {
      const { port: actualPort, proxyUrl } = await httpProxy.start(port);
      return [
        `✅ HTTP Proxy started!`,
        `   URL:  ${proxyUrl}`,
        `   Port: ${actualPort}`,
        '',
        `Configure your app to use this proxy:`,
        `  Shell:   export http_proxy=${proxyUrl} https_proxy=${proxyUrl}`,
        `  Node.js: HTTP_PROXY=${proxyUrl} node your-app.js`,
        `  curl:    curl -x ${proxyUrl} https://api.example.com/endpoint`,
        '',
        `Next steps:`,
        `  ProxyCaptures           — view captured traffic`,
        `  ProxyMock               — mock specific endpoints`,
        `  ProxyStatus             — check proxy status`,
      ].join('\n');
    } catch (err) {
      return `❌ Failed to start proxy: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const proxyStopTool: ToolRegistration = {
  definition: {
    name: 'ProxyStop',
    description: 'Stop the HTTP proxy. Captured traffic and mock rules are preserved until ProxyClear.',
    parameters: { type: 'object', properties: {} },
  },
  async handler(): Promise<string> {
    if (!httpProxy.isRunning()) return '⚠️  HTTP proxy is not running.';
    httpProxy.stop();
    return '✅ HTTP proxy stopped.';
  },
};

export const proxyStatusTool: ToolRegistration = {
  definition: {
    name: 'ProxyStatus',
    description: 'Show HTTP proxy status: port, uptime, request count, status code breakdown, active mock rules.',
    parameters: { type: 'object', properties: {} },
  },
  async handler(): Promise<string> {
    return httpProxy.getStatus();
  },
};

export const proxyCapturesTool: ToolRegistration = {
  definition: {
    name: 'ProxyCaptures',
    description: [
      'Read captured HTTP request/response pairs from the proxy.',
      'Filter by URL substring, method, or status code.',
      'Returns request headers, body, response status, headers, and body.',
      'This is the core "抓包" (packet capture) capability.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        last: {
          type: 'number',
          description: 'Number of recent captures to return (default: 10, max: 50).',
        },
        filter_url: {
          type: 'string',
          description: 'Filter captures where URL contains this string.',
        },
        filter_method: {
          type: 'string',
          description: 'Filter by HTTP method: GET, POST, PUT, DELETE, etc.',
        },
        filter_status: {
          type: 'number',
          description: 'Filter by response status code (e.g. 200, 404, 500).',
        },
        mocked_only: {
          type: 'boolean',
          description: 'Show only mock-intercepted requests.',
        },
        verbose: {
          type: 'boolean',
          description: 'Include full request/response bodies (default: false shows summary).',
        },
      },
    },
  },
  async handler(args: Record<string, unknown>): Promise<string> {
    const last = Math.min(Number(args.last ?? 10), 50);
    const captures = httpProxy.getCaptures({
      last,
      filterUrl: args.filter_url ? String(args.filter_url) : undefined,
      filterMethod: args.filter_method ? String(args.filter_method) : undefined,
      filterStatus: args.filter_status ? Number(args.filter_status) : undefined,
      mockedOnly: Boolean(args.mocked_only ?? false),
    });
    const verbose = Boolean(args.verbose ?? false);

    if (captures.length === 0) {
      return [
        '📭 No captures found.',
        httpProxy.isRunning()
          ? `   Proxy is running at http://localhost:${httpProxy.getPort()}`
          : '   Proxy is not running. Start it with ProxyStart.',
        '   Make sure your app is configured to use the proxy.',
      ].join('\n');
    }

    const lines = [`📦 Captured Requests (${captures.length}):\n`];
    for (const c of captures) {
      const time = new Date(c.timestamp).toLocaleTimeString();
      const mockTag = c.mocked ? ' 🎭[MOCK]' : '';
      lines.push(`[${time}] ${c.method} ${c.url.slice(0, 80)} → ${c.responseStatus}${mockTag} (${c.durationMs}ms)`);

      if (verbose) {
        if (c.requestBody) lines.push(`  REQ BODY: ${c.requestBody.slice(0, 500)}`);
        lines.push(`  RES BODY: ${c.responseBody.slice(0, 500)}`);
      } else if (c.responseBody && c.responseStatus >= 400) {
        // Always show error responses
        lines.push(`  ERROR: ${c.responseBody.slice(0, 200)}`);
      }
    }

    lines.push(`\nTip: Use verbose=true to see full request/response bodies`);
    lines.push(`     Use filter_url="api.example.com" to filter by domain`);

    return lines.join('\n');
  },
};

export const proxyMockTool: ToolRegistration = {
  definition: {
    name: 'ProxyMock',
    description: [
      'Add a mock rule: intercept requests matching a URL pattern and return a custom response.',
      'This enables testing without a real server ("联调前自主调试" from kstack #15370).',
      'Rules are checked in order; first match wins.',
      'The URL pattern is matched as a substring; prefix with "regex:" for regex matching.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        url_pattern: {
          type: 'string',
          description: 'URL substring to match, e.g. "api.example.com/users". Prefix with "regex:" for regex.',
        },
        response_body: {
          type: 'string',
          description: 'Response body to return. JSON strings will be sent as application/json.',
        },
        status_code: {
          type: 'number',
          description: 'HTTP status code to return (default: 200).',
        },
        method: {
          type: 'string',
          description: 'Only mock this HTTP method (GET, POST, etc.). Omit to mock all methods.',
        },
        content_type: {
          type: 'string',
          description: 'Response Content-Type header (default: auto-detect from response_body).',
        },
        description: {
          type: 'string',
          description: 'Human-readable description of this mock rule.',
        },
      },
      required: ['url_pattern', 'response_body'],
    },
  },
  async handler(args: Record<string, unknown>): Promise<string> {
    const urlPattern = String(args.url_pattern ?? '');
    const responseBody = String(args.response_body ?? '');
    const statusCode = Number(args.status_code ?? 200);
    const method = args.method ? String(args.method).toUpperCase() : undefined;
    const description = args.description ? String(args.description) : undefined;

    // Auto-detect content type
    let contentType = args.content_type ? String(args.content_type) : 'text/plain';
    if (!args.content_type) {
      try { JSON.parse(responseBody); contentType = 'application/json'; } catch { /* keep text/plain */ }
    }

    const rule = httpProxy.addMockRule({ urlPattern, responseBody, statusCode, method, contentType, description });

    return [
      `✅ Mock rule added (id: ${rule.id})`,
      `   Pattern:  ${urlPattern}${method ? ` [${method}]` : ' [all methods]'}`,
      `   Status:   ${statusCode}`,
      `   Type:     ${contentType}`,
      `   Response: ${responseBody.slice(0, 100)}${responseBody.length > 100 ? '...' : ''}`,
      '',
      `Any request to a URL containing "${urlPattern}" will now return the mock response.`,
      `Use ProxyMockList to see all rules, ProxyMockClear to remove them.`,
    ].join('\n');
  },
};

export const proxyMockListTool: ToolRegistration = {
  definition: {
    name: 'ProxyMockList',
    description: 'List all active proxy mock rules with their hit counts.',
    parameters: { type: 'object', properties: {} },
  },
  async handler(): Promise<string> {
    const rules = httpProxy.getMockRules();
    if (rules.length === 0) return '📭 No mock rules active. Use ProxyMock to add one.';

    const lines = [`🎭 Active Mock Rules (${rules.length}):\n`];
    for (const r of rules) {
      const methodTag = r.method ? ` [${r.method}]` : ' [all methods]';
      lines.push(`  ${r.id}`);
      lines.push(`    Pattern:  ${r.urlPattern}${methodTag}`);
      lines.push(`    Status:   ${r.statusCode}  Hits: ${r.hitCount}`);
      if (r.description) lines.push(`    Note:     ${r.description}`);
      lines.push(`    Response: ${r.responseBody.slice(0, 80)}${r.responseBody.length > 80 ? '...' : ''}`);
      lines.push('');
    }

    lines.push(`Remove a rule:  ProxyMockClear id="<rule_id>"`);
    lines.push(`Remove all:     ProxyMockClear`);

    return lines.join('\n');
  },
};

export const proxyMockClearTool: ToolRegistration = {
  definition: {
    name: 'ProxyMockClear',
    description: 'Remove one or all proxy mock rules.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'ID of a specific mock rule to remove. Omit to remove ALL rules.',
        },
      },
    },
  },
  async handler(args: Record<string, unknown>): Promise<string> {
    if (args.id) {
      const removed = httpProxy.removeMockRule(String(args.id));
      return removed ? `✅ Mock rule "${args.id}" removed.` : `❌ Mock rule "${args.id}" not found.`;
    }
    const count = httpProxy.clearMockRules();
    return `✅ Cleared ${count} mock rule(s).`;
  },
};

export const proxyClearTool: ToolRegistration = {
  definition: {
    name: 'ProxyClear',
    description: 'Clear all captured traffic from the proxy log.',
    parameters: { type: 'object', properties: {} },
  },
  async handler(): Promise<string> {
    const count = httpProxy.clearCaptures();
    return `✅ Cleared ${count} captured request(s).`;
  },
};
