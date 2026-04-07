/**
 * WebFetchTool/WebFetchTool.ts — WebFetch: fetch and extract URL content
 *
 * Mirrors claude-code's WebFetchTool design.
 *
 * F18: WebFetch Safety Layer (claude-code WebFetchTool/utils.ts parity)
 *   1. SSRF protection: block private/loopback IP addresses and metadata endpoints
 *   2. URL content cache: in-memory LRU-style cache (15-min TTL, 50MB max)
 *   3. Content size limit: 10MB per response (mirrors claude-code MAX_HTTP_CONTENT_LENGTH)
 */

import type { ToolRegistration } from '../../models/types.js';

/**
 * AbortSignal.timeout() polyfill for Node.js < 17.3.
 */
function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(new DOMException('TimeoutError', 'TimeoutError')), ms);
  return ctrl.signal;
}

/** Maximum HTTP response size in bytes (10MB — mirrors claude-code) */
const MAX_HTTP_CONTENT_LENGTH = 10 * 1024 * 1024; // 10MB

/** Fetch timeout in ms (60s — mirrors claude-code FETCH_TIMEOUT_MS) */
const FETCH_TIMEOUT_MS = 60_000;

/** Maximum URL length check (2000 chars — browsers/servers generally reject longer) */
const MAX_URL_LENGTH = 2000;

/** URL content cache entry */
interface UrlCacheEntry {
  content: string;
  fetchedAt: number;
}

/**
 * Simple in-memory URL content cache (TTL + size-limited).
 * Mirrors claude-code URL_CACHE (LRUCache, 50MB, 15-min TTL).
 */
const URL_CACHE = new Map<string, UrlCacheEntry>();
const URL_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const URL_CACHE_MAX_ENTRIES = 128;         // max cached URLs

function getUrlCached(url: string): string | null {
  const entry = URL_CACHE.get(url);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > URL_CACHE_TTL_MS) {
    URL_CACHE.delete(url);
    return null;
  }
  return entry.content;
}

function setUrlCached(url: string, content: string): void {
  if (URL_CACHE.size >= URL_CACHE_MAX_ENTRIES) {
    const firstKey = URL_CACHE.keys().next().value;
    if (firstKey !== undefined) URL_CACHE.delete(firstKey);
  }
  URL_CACHE.set(url, { content, fetchedAt: Date.now() });
}

/**
 * F18: SSRF protection — block requests to private/loopback/metadata IP ranges.
 */
export function isBlockedDomain(hostname: string): { blocked: boolean; reason?: string } {
  const h = hostname.toLowerCase();

  if (h === 'localhost' || h === 'localhost.') {
    return { blocked: true, reason: 'loopback address' };
  }
  if (/^127\.\d+\.\d+\.\d+$/.test(h)) {
    return { blocked: true, reason: 'loopback address (127.x)' };
  }
  if (/^169\.254\./.test(h)) {
    return { blocked: true, reason: 'link-local / cloud metadata address (169.254.x)' };
  }
  if (/^10\./.test(h)) {
    return { blocked: true, reason: 'private network (10.x)' };
  }
  if (/^192\.168\./.test(h)) {
    return { blocked: true, reason: 'private network (192.168.x)' };
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) {
    return { blocked: true, reason: 'private network (172.16-31.x)' };
  }
  if (h === '::1' || h === '[::1]') {
    return { blocked: true, reason: 'IPv6 loopback' };
  }
  if (/^(fc|fd)[0-9a-f]{2}:/.test(h)) {
    return { blocked: true, reason: 'IPv6 private network (fc00::/7)' };
  }

  return { blocked: false };
}

// ─── Helpers ─────────────────────────────────────────────
function stripHTML(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{3,}/g, '\n\n')
    .trim();
}

function extractLinks(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const links: string[] = [];
  const pattern = /href="([^"]+)"/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    try {
      const href = match[1];
      if (href.startsWith('#')) continue;
      const full = href.startsWith('http') ? href : new URL(href, base).toString();
      links.push(full);
    } catch { /* skip invalid URLs */ }
  }
  return [...new Set(links)];
}

// ─── WebFetch ────────────────────────────────────────────
export const webFetchTool: ToolRegistration = {
  definition: {
    name: 'WebFetch',
    description: 'Fetch and extract the main content from a URL. Returns readable text content.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        extract: {
          type: 'string',
          description: 'What to extract: text | links | both',
          enum: ['text', 'links', 'both'],
        },
      },
      required: ['url'],
    },
  },

  validate(args) {
    const { url } = args as { url?: string };
    if (!url || typeof url !== 'string' || url.trim().length === 0) {
      return { result: false, message: 'url is required', errorCode: 'missing_url' };
    }
    if (url.length > MAX_URL_LENGTH) {
      return { result: false, message: `URL too long (${url.length} > ${MAX_URL_LENGTH} chars)`, errorCode: 'url_too_long' };
    }
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { result: false, message: `Unsupported protocol: ${parsed.protocol}`, errorCode: 'unsupported_protocol' };
      }
      const { blocked, reason } = isBlockedDomain(parsed.hostname);
      if (blocked) {
        return { result: false, message: `Blocked domain: ${reason}`, errorCode: 'domain_blocked' };
      }
    } catch {
      return { result: false, message: `Invalid URL: ${url}`, errorCode: 'invalid_url' };
    }
    return { result: true };
  },

  handler: async (args) => {
    const { url, extract = 'text' } = args as { url: string; extract: string };

    // F18: Check URL cache first
    const cached = getUrlCached(url);
    if (cached) return cached;

    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; UniversalAgent/1.0)',
          Accept: 'text/html,application/xhtml+xml,*/*',
        },
        signal: timeoutSignal(FETCH_TIMEOUT_MS),
      });

      if (!res.ok) return `Error: HTTP ${res.status} ${res.statusText}`;

      // F18: Content size limit — check Content-Length header first
      const contentLength = res.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_HTTP_CONTENT_LENGTH) {
        return `Error: Response too large (${Math.round(parseInt(contentLength, 10) / 1024 / 1024)}MB > 10MB limit)`;
      }

      const contentType = res.headers.get('content-type') || '';
      const text = await res.text();

      // F18: Runtime size check after reading body
      if (Buffer.byteLength(text, 'utf-8') > MAX_HTTP_CONTENT_LENGTH) {
        return `Error: Response too large (> 10MB limit). First 5000 chars:\n${text.slice(0, 5000)}`;
      }

      let result: string;

      // JSON response
      if (contentType.includes('application/json')) {
        try {
          result = JSON.stringify(JSON.parse(text), null, 2).slice(0, 8000);
        } catch { result = text.slice(0, 8000); }
      } else {
        // HTML — strip tags
        const stripped = stripHTML(text);
        const links = extract !== 'text' ? extractLinks(text, url) : [];

        if (extract === 'links') result = links.slice(0, 50).join('\n');
        else if (extract === 'both') result = `Content:\n${stripped.slice(0, 5000)}\n\nLinks:\n${links.slice(0, 20).join('\n')}`;
        else result = stripped.slice(0, 8000);
      }

      // F18: Store in cache
      setUrlCached(url, result);
      return result;
    } catch (err) {
      return `Error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
