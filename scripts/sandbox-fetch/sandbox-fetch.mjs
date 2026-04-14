#!/usr/bin/env node
// sandbox-fetch.mjs — Browser sandbox with CDP network interception
//
// Usage:
//   node sandbox-fetch.mjs --url <url> [--intercept <pattern>] [--cookies "k=v;k2=v2"]
//                           [--output <file>] [--cdp-port <port>] [--wait-ms <ms>]
//                           [--inject-script <path>]
//
// Example:
//   node sandbox-fetch.mjs \
//     --url "https://example.com/dashboard" \
//     --intercept "**/api/v1/**" \
//     --intercept "**/data/query**" \
//     --cookies "token=xxx;user=yyy" \
//     --output .output/sandbox.json \
//     --cdp-port 9222
//
// Features:
// - Connects to Chrome Debug Mode (CDP WebSocket)
// - Auto-launches Chrome with --remote-debugging-port if not running
// - Primary: CDP Network domain interception (most reliable)
// - Fallback: JS injection (fetch/XHR monkey-patch) when page is fully loaded
// - Waits for request stability before returning results
// - Extracts: intercepted requests/responses, page title, DOM snapshot, JS eval

'use strict';

import { WebSocket } from 'ws';
import { spawn, execSync } from 'child_process';
import { createWriteStream, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2).reduce((acc, arg, i, arr) => {
  if (arg.startsWith('--')) {
    const key = arg.slice(2);
    const next = arr[i + 1];
    // If next arg is also a flag or missing, treat as boolean
    if (!next || next.startsWith('--')) {
      acc[key] = true;
    } else {
      // Accumulate values for repeatable flags (e.g., multiple --intercept)
      if (acc[key] !== undefined) {
        acc[key] = Array.isArray(acc[key]) ? [...acc[key], next] : [acc[key], next];
      } else {
        acc[key] = next;
      }
    }
  }
  return acc;
}, {});

const TARGET_URL = args.url;
const INTERCEPT_PATTERNS = args.intercept
  ? (Array.isArray(args.intercept) ? args.intercept : [args.intercept])
  : ['**/api/**', '**/data/**', '**/query**'];
const COOKIES_STR = args.cookies || '';
const OUTPUT_FILE = args.output || null;
const CDP_PORT = parseInt(args['cdp-port'] || '9222', 10);
const WAIT_MS = parseInt(args['wait-ms'] || '60000', 10);
const SETTLE_MS = parseInt(args['settle-ms'] || '5000', 10);
const MAX_REQUESTS = parseInt(args['max-requests'] || '200', 10);
const CHROME_PATH = args['chrome-path'] || detectChromePath();

if (!TARGET_URL) {
  console.error('Usage: node sandbox-fetch.mjs --url <url> [--intercept <pattern>] [--cookies "k=v"] [--output <file>] [--cdp-port <port>] [--wait-ms <ms>] [--settle-ms <ms>]');
  process.exit(1);
}

// ─── Chrome path detection ────────────────────────────────────────────────────

function detectChromePath() {
  // macOS
  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(macChrome)) return macChrome;

  // Linux
  const linuxCandidates = [
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
  ];
  for (const p of linuxCandidates) {
    if (existsSync(p)) return p;
  }

  // Try which
  try {
    const out = execSync('which chromium-browser chromium google-chrome-stable google-chrome 2>/dev/null || true', { encoding: 'utf8' });
    const found = out.trim().split('\n').find(l => l && existsSync(l.trim()));
    if (found) return found.trim();
  } catch {}

  return null;
}

// ─── CDP WebSocket client ─────────────────────────────────────────────────────

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.msgId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this._connected = false;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.on('open', () => { this._connected = true; resolve(); });
      this.ws.on('error', reject);
      this.ws.on('message', data => this._handleMessage(JSON.parse(data)));
    });
  }

  _handleMessage(msg) {
    // Response to a sent command
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    // Event notification
    if (msg.method) {
      const handler = this.handlers.get(msg.method);
      if (handler) handler(msg.params);
    }
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.msgId;
      this.pending.set(id, { resolve, reject, timer: setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30000) });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    this.handlers.set(method, handler);
  }

  close() {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }
}

// ─── Chrome lifecycle ─────────────────────────────────────────────────────────

let chromeProcess = null;

async function ensureChromeRunning() {
  // Check if CDP port is already listening
  try {
    const http = await import('http');
    await new Promise((resolve, reject) => {
      const req = http.get(`http://localhost:${CDP_PORT}/json/version`, res => {
        if (res.statusCode === 200) resolve();
        else reject(new Error(`Status ${res.statusCode}`));
      });
      req.on('error', reject);
      req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
    });
    console.error(`[sandbox] Chrome already running on port ${CDP_PORT}`);
    return;
  } catch {
    // Not running, need to start it
  }

  if (!CHROME_PATH) {
    throw new Error('Chrome not found. Install Chrome or specify --chrome-path.');
  }

  const userDataDir = `/tmp/chrome-sandbox-${process.getuid?.() || process.pid}`;
  const platform = process.platform;

  const chromeArgs = [
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${userDataDir}`,
  ];

  if (platform === 'linux') {
    chromeArgs.push('--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage');
  }

  console.error(`[sandbox] Launching Chrome: ${CHROME_PATH}`);
  chromeProcess = spawn(CHROME_PATH, chromeArgs, {
    detached: true,
    stdio: 'ignore',
  });
  chromeProcess.unref();

  // Wait for CDP port to be ready
  const http = await import('http');
  const maxAttempts = 15;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:${CDP_PORT}/json/version`, res => {
          if (res.statusCode === 200) resolve();
          else reject(new Error(`Status ${res.statusCode}`));
        });
        req.on('error', reject);
        req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
      });
      console.error(`[sandbox] Chrome ready on port ${CDP_PORT}`);
      return;
    } catch {
      process.stderr.write(`\r[sandbox] Waiting for Chrome... ${i + 1}/${maxAttempts}`);
    }
  }
  throw new Error('Chrome failed to start within timeout');
}

async function getCDPEndpoint() {
  const http = await import('http');
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${CDP_PORT}/json/list`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', async () => {
        try {
          const targets = JSON.parse(d);
          const page = targets.find(t => t.type === 'page') || targets[0];
          if (page && page.webSocketDebuggerUrl) {
            resolve(page.webSocketDebuggerUrl);
            return;
          }
          // No page target — create one via Target.createTarget
          console.error(`[sandbox] No page target, creating new tab...`);
          const ws = new WebSocket(`http://localhost:${CDP_PORT}/json/protocol`);
          await new Promise((res2, rej2) => {
            ws.on('open', res2);
            ws.on('error', rej2);
          });
          let msgId = 0;
          const cbs = new Map();
          ws.on('message', data => {
            const msg = JSON.parse(String(data));
            if (msg.id && cbs.has(msg.id)) {
              const { resolve: r, reject: rj } = cbs.get(msg.id);
              cbs.delete(msg.id);
              msg.error ? rj(new Error(msg.error.message)) : r(msg.result);
            }
          });
          const send = (m, p = {}) => new Promise((r, rj) => {
            cbs.set(++msgId, { resolve: r, reject: rj });
            ws.send(JSON.stringify({ id: msgId, method: m, params: p }));
          });
          try {
            const newTarget = await send('Target.createTarget', { url: 'about:blank' });
            const wsUrl = `ws://localhost:${CDP_PORT}/devtools/page/${newTarget.targetId}`;
            ws.close();
            resolve(wsUrl);
          } catch (e) {
            ws.close();
            reject(new Error('Failed to create page target: ' + e.message));
          }
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ─── URL pattern matching ─────────────────────────────────────────────────────

function matchesPattern(url, patterns) {
  for (const pattern of patterns) {
    const escaped = pattern
      .replace(/\*\*/g, '\x00DBLSTAR\x00')
      .replace(/\*/g, '\x00STAR\x00')
      .replace(/[.+?()\[\]{}^$|\\]/g, '\\$&')
      .replace(/\x00DBLSTAR\x00/g, '.*')
      .replace(/\x00STAR\x00/g, '[^/]*');
    if (new RegExp(escaped).test(url)) return true;
  }
  return false;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const result = {
    url: TARGET_URL,
    timestamp: new Date().toISOString(),
    intercepted: [],
    dom: { title: null, url: null, text: null },
    errors: [],
    meta: { chromePort: CDP_PORT },
  };

  let client = null;
  let pageSessionId = null;

  try {
    // 1. Ensure Chrome is running
    await ensureChromeRunning();

    // 2. Connect to page target
    const wsUrl = await getCDPEndpoint();
    client = new CDPClient(wsUrl);
    await client.connect();
    console.error(`[sandbox] Connected to CDP WebSocket`);

    // 3. Enable Network domain for interception
    await client.send('Network.enable');
    console.error(`[sandbox] Network domain enabled`);

    // Track intercepted requests
    const interceptedMap = new Map(); // requestId -> data
    let lastRequestTime = Date.now();

    client.on('Network.requestWillBeSent', (params) => {
      if (!matchesPattern(params.request.url, INTERCEPT_PATTERNS)) return;
      if (interceptedMap.size >= MAX_REQUESTS) return;

      const entry = {
        requestId: params.requestId,
        url: params.request.url,
        method: params.request.method,
        headers: params.request.headers,
        postData: params.request.postData || null,
        timestamp: params.timestamp,
        type: params.type,
        documentURL: params.documentURL || null,
        response: null,
        responseBody: null,
      };
      interceptedMap.set(params.requestId, entry);
      lastRequestTime = Date.now();
    });

    client.on('Network.responseReceived', (params) => {
      const entry = interceptedMap.get(params.requestId);
      if (!entry) return;
      entry.response = {
        status: params.response.status,
        statusText: params.response.statusText,
        headers: params.response.headers,
        mimeType: params.response.mimeType,
        encodedDataLength: params.response.encodedDataLength,
        url: params.response.url,
      };
      entry.responseTimestamp = params.timestamp;
    });

    // Capture response body for JSON/API responses
    client.on('Network.loadingFinished', async (params) => {
      const entry = interceptedMap.get(params.requestId);
      if (!entry || !entry.response) return;
      const mimeType = entry.response.mimeType || '';
      if (
        mimeType.includes('json') ||
        mimeType.includes('javascript') ||
        mimeType.includes('text/') ||
        mimeType.startsWith('application/')
      ) {
        try {
          const body = await client.send('Network.getResponseBody', { requestId: params.requestId });
          if (body.base64Encoded) {
            entry.responseBody = Buffer.from(body.body, 'base64').toString('utf8');
          } else {
            entry.responseBody = body.body;
          }
          // Try to parse as JSON
          try {
            entry.responseJson = JSON.parse(entry.responseBody);
          } catch {}
        } catch (e) {
          entry.responseBodyError = e.message;
        }
      }
    });

    // 4. Enable Page domain to get title and inject scripts
    await client.send('Page.enable');

    // 5. Inject JS interception script (for fetch/XHR in case Network domain misses it)
    const injectScript = `
(function() {
  if (window.__sandboxInterceptorInstalled) return;
  window.__sandboxInterceptorInstalled = true;
  if (!window.__sandboxRequests) window.__sandboxRequests = [];
  var MAX = 200;

  function store(entry) {
    if (window.__sandboxRequests.length < MAX) {
      window.__sandboxRequests.push(entry);
    }
  }

  // fetch interception
  var _fetch = window.fetch;
  window.fetch = function(input, init) {
    var url = typeof input === 'string' ? input : (input && input.url || '');
    var body = (init && init.body) || null;
    var startTime = Date.now();
    return _fetch.apply(this, arguments).then(function(res) {
      var clone = res.clone();
      clone.text().then(function(text) {
        store({ url: url, method: (init && init.method) || 'GET', requestBody: body,
                responseText: text, timestamp: startTime, source: 'sandbox-fetch',
                status: res.status });
      }).catch(function() {});
      return res;
    }).catch(function(e) {
      store({ url: url, method: (init && init.method) || 'GET', requestBody: body,
              error: e.message, timestamp: startTime, source: 'sandbox-fetch' });
      throw e;
    });
  };

  // XHR interception
  var _open = XMLHttpRequest.prototype.open;
  var _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__sandboxUrl = url;
    this.__sandboxMethod = method;
    return _open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    var self = this;
    var startTime = Date.now();
    this.addEventListener('load', function() {
      try {
        store({ url: self.__sandboxUrl, method: self.__sandboxMethod,
                requestBody: body, responseText: self.responseText,
                timestamp: startTime, source: 'sandbox-xhr', status: self.status });
      } catch(e) {}
    });
    this.addEventListener('error', function() {
      store({ url: self.__sandboxUrl, method: self.__sandboxMethod,
              requestBody: body, error: 'network error',
              timestamp: startTime, source: 'sandbox-xhr' });
    });
    return _send.apply(this, arguments);
  };
})();
`;

    // Inject JS interceptor before navigation
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: injectScript });
    console.error(`[sandbox] JS interceptor injected`);

    // 6. Inject cookies if provided
    if (COOKIES_STR) {
      await client.send('Network.enable'); // already enabled, but idempotent
      const pairs = COOKIES_STR.split(';').map(s => s.trim()).filter(Boolean);
      const hostname = new URL(TARGET_URL).hostname;
      for (const pair of pairs) {
        const eq = pair.indexOf('=');
        if (eq < 0) continue;
        const name = pair.substring(0, eq).trim();
        const value = pair.substring(eq + 1).trim();
        try {
          await client.send('Network.setCookie', {
            name, value,
            domain: hostname,
            path: '/',
            secure: true,
          });
          // Also set for parent domain
          const parts = hostname.split('.');
          if (parts.length > 2) {
            const parentDomain = parts.slice(1).join('.');
            await client.send('Network.setCookie', {
              name, value, domain: parentDomain, path: '/', secure: true,
            });
          }
          console.error(`[sandbox] Cookie injected: ${name}`);
        } catch (e) {
          console.error(`[sandbox] Failed to set cookie ${name}: ${e.message}`);
        }
      }
    }

    // 7. Navigate to target URL
    console.error(`[sandbox] Navigating to ${TARGET_URL}...`);
    const navResult = await client.send('Page.navigate', { url: TARGET_URL });
    if (navResult.errorText) {
      throw new Error(`Navigation failed: ${navResult.errorText}`);
    }
    pageSessionId = navResult.frameId;

    // 8. Wait for page load + data stabilization
    console.error(`[sandbox] Waiting up to ${WAIT_MS}ms for data...`);
    const startTime = Date.now();
    let lastStableTime = Date.now();

    await new Promise((resolve) => {
      const check = () => {
        const elapsed = Date.now() - startTime;
        const sinceLast = Date.now() - lastRequestTime;

        if (elapsed >= WAIT_MS) {
          console.error(`\r[sandbox] Timeout (${WAIT_MS}ms), stopping.`);
          resolve();
          return;
        }

        // Update stability timer
        if (interceptedMap.size > 0 && sinceLast < 1000) {
          lastStableTime = Date.now();
        }

        // Check if stable for SETTLE_MS
        const stableFor = Date.now() - lastStableTime;
        const captured = interceptedMap.size;
        process.stderr.write(`\r[sandbox] ${elapsed}ms: captured ${captured} requests, stable for ${stableFor}ms...`);

        if (captured > 0 && stableFor >= SETTLE_MS) {
          console.error(`\r[sandbox] Data stable after ${elapsed}ms.`);
          resolve();
          return;
        }

        setTimeout(check, 500);
      };
      // Give page time to start loading
      setTimeout(check, 3000);
    });

    // 9. Also collect JS-injected requests (fetch/XHR)
    const jsRequests = await client.send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__sandboxRequests || [])',
    });
    let jsIntercepted = [];
    try {
      const val = jsRequests.result?.value || '';
      if (val && val !== 'undefined') {
        jsIntercepted = JSON.parse(val);
      }
    } catch {}

    // 10. Get DOM info
    const domInfo = await client.send('Runtime.evaluate', {
      expression: `JSON.stringify({title: document.title, url: window.location.href, text: document.body?.innerText?.slice(0, 2000) || ''})`,
    });
    try {
      result.dom = JSON.parse(domInfo.result?.value || '{}');
    } catch {}

    // 11. Assemble results
    // Filter CDP intercepted: only keep those matching patterns (already filtered above)
    const cdpIntercepted = Array.from(interceptedMap.values()).filter(e =>
      matchesPattern(e.url, INTERCEPT_PATTERNS)
    );

    // Merge: CDP data takes priority, JS fills gaps
    const allIntercepted = [...cdpIntercepted];
    for (const jsEntry of jsIntercepted) {
      // Avoid duplicates: if we already have this URL, skip
      const alreadyHas = allIntercepted.some(e => e.url === jsEntry.url && Math.abs((e.timestamp || 0) - (jsEntry.timestamp || 0)) < 5000);
      if (!alreadyHas) {
        allIntercepted.push({
          url: jsEntry.url,
          method: jsEntry.method,
          requestBody: jsEntry.requestBody || null,
          responseBody: jsEntry.responseText || null,
          responseJson: (() => { try { return JSON.parse(jsEntry.responseText || ''); } catch { return null; } })(),
          status: jsEntry.status || null,
          timestamp: jsEntry.timestamp || null,
          source: jsEntry.source,
          error: jsEntry.error || null,
        });
      }
    }

    result.intercepted = allIntercepted;
    console.error(`\r[sandbox] Total intercepted: ${result.intercepted.length} (CDP: ${cdpIntercepted.length}, JS: ${jsIntercepted.length})`);

  } catch (e) {
    result.errors.push(e.message);
    console.error(`[sandbox] Error: ${e.message}`);
  } finally {
    if (client) {
      try { await client.send('Network.disable'); } catch {}
      try { await client.send('Page.disable'); } catch {}
      client.close();
    }

    // Cleanup Chrome if we launched it
    if (chromeProcess) {
      try {
        process.kill(-chromeProcess.pid, 'SIGTERM');
        console.error('[sandbox] Chrome terminated');
      } catch {}
    }
  }

  // Output
  if (OUTPUT_FILE) {
    mkdirSync(dirname(OUTPUT_FILE) || '.', { recursive: true });
    writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
    console.error(`[sandbox] Results written to ${OUTPUT_FILE}`);
  } else {
    process.stdout.write(JSON.stringify(result, null, 2));
  }
}

main().catch(e => {
  console.error(`[sandbox] Fatal: ${e.message}`);
  process.exit(1);
});
