/**
 * cdp.ts — CDP (Chrome DevTools Protocol) client for BrowserSandboxTool
 *
 * Provides a lightweight CDP WebSocket client using Node.js built-in WebSocket API.
 * Supports:
 * - Browser launch/connection management
 * - Network interception (request/response capture)
 * - Cookie injection
 * - Page navigation and evaluation
 *
 * This module does NOT depend on the `ws` npm package — it uses Node's built-in
 * WebSocket API (available in Node 18+) for CDP WebSocket connections.
 */

import { spawn, execSync } from 'child_process';
import http from 'http';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

// Re-export the injected script strings for use by BrowserSandboxTool
export { INTERCEPT_SCRIPT } from './injected-scripts.js';
export { JS_INTERCEPTOR_SCRIPT } from './injected-scripts.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ChromeHandle = { process: ReturnType<typeof spawn> | null; port?: number };

export type CDPConnection = {
  wsUrl: string;
  port: number;
};

export type InterceptionEntry = {
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  postData: string | null;
  timestamp: number;
  type: string;
  documentURL: string | null;
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    mimeType: string;
    url: string;
  } | null;
  responseBody: string | null;
  responseJson: unknown;
  source: string;
};

// ─── Chrome detection ─────────────────────────────────────────────────────────

export function detectChromePath(): string | null {
  const platform = process.platform;

  if (platform === 'darwin') {
    const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (existsSync(macChrome)) return macChrome;
  }

  const linuxCandidates = [
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
  ];
  if (platform === 'linux') {
    for (const p of linuxCandidates) {
      if (existsSync(p)) return p;
    }
  }

  // Try PATH
  for (const cmd of ['chromium-browser', 'chromium', 'google-chrome-stable', 'google-chrome']) {
    try {
      const out = execSync(`which ${cmd} 2>/dev/null`, { encoding: 'utf8', timeout: 2000 });
      const found = out.trim().split('\n')[0];
      if (found && existsSync(found)) return found;
    } catch {}
  }

  return null;
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function httpGet(url: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`HTTP timeout: ${url}`)); });
  });
}

// ─── CDP Client ───────────────────────────────────────────────────────────────

export class CDPClient {
  private ws: WebSocket | null = null;
  private msgId = 0;
  private cbs = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<(params: unknown) => void>>();
  private closed = false;

  constructor(private wsUrl: string) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error(`WebSocket error: ${String(e)}`)));
      this.ws.addEventListener('message', (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.id && this.cbs.has(msg.id)) {
          const cb = this.cbs.get(msg.id)!;
          this.cbs.delete(msg.id);
          if (msg.error) cb.reject(new Error(msg.error.message));
          else cb.resolve(msg.result);
        } else if (msg.method && this.listeners.has(msg.method)) {
          for (const cb of this.listeners.get(msg.method)!) {
            cb(msg.params);
          }
        }
      });
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.closed) { reject(new Error('CDP connection closed')); return; }
      const id = ++this.msgId;
      this.cbs.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, cb: (params: unknown) => void): void {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method)!.add(cb);
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }
}

// ─── Chrome launch helpers ────────────────────────────────────────────────────

export function launchChrome(port: number, chromePath: string | null): { process: ReturnType<typeof spawn> } {
  const userDataDir = `/tmp/chrome-debug-${port}`;
  mkdirSync(userDataDir, { recursive: true });
  const extraFlags: string[] = [];
  if (process.platform === 'linux') {
    extraFlags.push('--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage');
  }
  const args = [
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${userDataDir}`,
    ...extraFlags,
  ];
  if (!chromePath) {
    chromePath = detectChromePath();
  }
  if (!chromePath) {
    throw new Error('Chrome not found. Install Chrome or Chromium and ensure it is in PATH.');
  }
  const proc = spawn(chromePath, args, { detached: false });
  return { process: proc };
}

export async function tryExistingChrome(port: number): Promise<string | null> {
  try {
    const data = await httpGet(`http://localhost:${port}/json/version`);
    const info = JSON.parse(data);
    return info.webSocketDebuggerUrl || null;
  } catch {
    return null;
  }
}

export async function waitForChrome(port: number, maxAttempts = 20): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    const url = await tryExistingChrome(port);
    if (url) return;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Chrome did not start within timeout');
}

// ─── CDP commands ─────────────────────────────────────────────────────────────

export async function cdpEnableNetwork(client: CDPClient): Promise<void> {
  await client.send('Network.enable');
}

export async function cdpEnablePage(client: CDPClient): Promise<void> {
  await client.send('Page.enable');
}

export async function cdpNavigate(client: CDPClient, url: string): Promise<void> {
  await client.send('Page.navigate', { url });
}

export async function cdpReload(client: CDPClient): Promise<void> {
  await client.send('Page.reload');
}

export async function cdpEvaluate(client: CDPClient, expression: string): Promise<unknown> {
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true }) as { result: { value?: unknown; description?: string } };
  return result.result?.value ?? result.result?.description;
}

export async function cdpInjectScript(client: CDPClient, script: string): Promise<void> {
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: script });
}

export async function cdpSetCookie(
  client: CDPClient,
  name: string,
  value: string,
  domain: string,
): Promise<void> {
  await client.send('Network.setCookie', {
    name,
    value,
    domain,
    path: '/',
    secure: false,
    httpOnly: false,
  });
}

export async function cdpGetResponseBody(
  client: CDPClient,
  requestId: string,
): Promise<{ body: string; base64Encoded: boolean } | null> {
  try {
    return await client.send('Network.getResponseBody', { requestId }) as { body: string; base64Encoded: boolean };
  } catch {
    return null;
  }
}

// ─── Network interception collector ───────────────────────────────────────────

export type InterceptionCollector = {
  entries: Map<string, InterceptionEntry>;
  lastRequestTime: number;
};

export function createInterceptionCollector(): InterceptionCollector {
  return { entries: new Map(), lastRequestTime: Date.now() };
}

export function setupNetworkListeners(
  client: CDPClient,
  collector: InterceptionCollector,
  patterns: string[],
  maxRequests = 200,
): void {
  const matchesPattern = (url: string): boolean => {
    for (const p of patterns) {
      const escaped = p
        .replace(/\*\*/g, '\x00DBLSTAR\x00')
        .replace(/\*/g, '\x00STAR\x00')
        .replace(/[.+?()\[\]{} ^$|\\]/g, '\\$&')
        .replace(/\x00DBLSTAR\x00/g, '.*')
        .replace(/\x00STAR\x00/g, '[^/]*');
      if (new RegExp(escaped).test(url)) return true;
    }
    return false;
  };

  client.on('Network.requestWillBeSent', (params: unknown) => {
    const p = params as { requestId: string; request: { url: string; method: string; headers: Record<string, string>; postData?: string }; timestamp: number; type: string; documentURL?: string };
    if (!matchesPattern(p.request.url)) return;
    if (collector.entries.size >= maxRequests) return;

    collector.entries.set(p.requestId, {
      requestId: p.requestId,
      url: p.request.url,
      method: p.request.method,
      headers: p.request.headers,
      postData: p.request.postData || null,
      timestamp: p.timestamp,
      type: p.type || 'other',
      documentURL: p.documentURL || null,
      response: null,
      responseBody: null,
      responseJson: null,
      source: 'cdp-network',
    });
    collector.lastRequestTime = Date.now();
  });

  client.on('Network.responseReceived', (params: unknown) => {
    const p = params as { requestId: string; response: { status: number; statusText: string; headers: Record<string, string>; mimeType: string; url: string } };
    const entry = collector.entries.get(p.requestId);
    if (!entry) return;
    entry.response = {
      status: p.response.status,
      statusText: p.response.statusText,
      headers: p.response.headers,
      mimeType: p.response.mimeType,
      url: p.response.url,
    };
  });

  client.on('Network.loadingFinished', async (params: unknown) => {
    const p = params as { requestId: string };
    const entry = collector.entries.get(p.requestId);
    if (!entry || !entry.response) return;

    const body = await cdpGetResponseBody(client, p.requestId);
    if (body) {
      if (body.base64Encoded) {
        entry.responseBody = Buffer.from(body.body, 'base64').toString('utf8');
      } else {
        entry.responseBody = body.body;
      }
      try {
        entry.responseJson = JSON.parse(entry.responseBody);
      } catch {}
    }
  });
}
