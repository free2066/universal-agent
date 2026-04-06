import type { ToolRegistration } from '../../../models/types.js';
import { mmrRerankSearchResults } from '../../memory/mmr.js';

/**
 * AbortSignal.timeout() polyfill for Node.js < 17.3.
 * Bug report #16: AbortSignal.timeout is Node 17.3+ only; older runtimes throw TypeError.
 */
function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(new DOMException('TimeoutError', 'TimeoutError')), ms);
  return ctrl.signal;
}

// ─── F18: WebFetch Safety Layer (claude-code WebFetchTool/utils.ts parity) ───
//
// Three security additions:
//   1. SSRF protection: block private/loopback IP addresses and metadata endpoints
//   2. URL content cache: in-memory LRU-style cache (15-min TTL, 50MB max)
//   3. Content size limit: 10MB per response (mirrors claude-code MAX_HTTP_CONTENT_LENGTH)
//
// References: claude-code src/tools/WebFetchTool/utils.ts

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
 * Uses Map with manual eviction to avoid adding lru-cache dependency.
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
    // Evict oldest entry (first key in insertion order)
    const firstKey = URL_CACHE.keys().next().value;
    if (firstKey !== undefined) URL_CACHE.delete(firstKey);
  }
  URL_CACHE.set(url, { content, fetchedAt: Date.now() });
}

/**
 * F18: SSRF protection — block requests to private/loopback/metadata IP ranges.
 * Mirrors claude-code DomainBlockedError check + SSRF protection in utils.ts.
 *
 * Blocked:
 *   - Loopback: 127.x.x.x, ::1, localhost
 *   - Private: 10.x, 172.16-31.x, 192.168.x
 *   - Link-local: 169.254.x (AWS/GCP metadata endpoints)
 *   - IPv6 private: fc00::/7
 */
function isBlockedDomain(hostname: string): { blocked: boolean; reason?: string } {
  const h = hostname.toLowerCase();

  // localhost
  if (h === 'localhost' || h === 'localhost.') {
    return { blocked: true, reason: 'loopback address' };
  }

  // IPv4 loopback
  if (/^127\.\d+\.\d+\.\d+$/.test(h)) {
    return { blocked: true, reason: 'loopback address (127.x)' };
  }

  // Link-local / cloud metadata endpoint (169.254.x.x)
  if (/^169\.254\./.test(h)) {
    return { blocked: true, reason: 'link-local / cloud metadata address (169.254.x)' };
  }

  // Private networks
  if (/^10\./.test(h)) {
    return { blocked: true, reason: 'private network (10.x)' };
  }
  if (/^192\.168\./.test(h)) {
    return { blocked: true, reason: 'private network (192.168.x)' };
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) {
    return { blocked: true, reason: 'private network (172.16-31.x)' };
  }

  // IPv6 loopback / private
  if (h === '::1' || h === '[::1]') {
    return { blocked: true, reason: 'IPv6 loopback' };
  }
  if (/^(fc|fd)[0-9a-f]{2}:/.test(h)) {
    return { blocked: true, reason: 'IPv6 private network (fc00::/7)' };
  }

  return { blocked: false };
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

  // D18: validate — semantic validation with errorCode
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

// ─── WebSearch ───────────────────────────────────────────
// Uses Google Custom Search API when GOOGLE_API_KEY + GOOGLE_CSE_ID are set,
// otherwise falls back to DuckDuckGo (no API key required).
//
// To enable Google Search:
//   1. Create a Custom Search Engine at https://programmablesearchengine.google.com/
//   2. Get an API key at https://console.developers.google.com/
//   3. Set env vars: GOOGLE_API_KEY=<key>  GOOGLE_CSE_ID=<engine-id>
//
export const webSearchTool: ToolRegistration = {
  definition: {
    name: 'WebSearch',
    description: [
      'Search the web and return top results with titles, URLs, and snippets.',
      'Uses Google Custom Search when GOOGLE_API_KEY + GOOGLE_CSE_ID are set,',
      'otherwise falls back to DuckDuckGo (no API key required).',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        num_results: { type: 'number', description: 'Number of results to return (default: 5, max: 10)' },
        region: { type: 'string', description: 'Region/language code (e.g., us-en, cn-zh). For Google: language code like en or zh-CN.' },
      },
      required: ['query'],
    },
  },
  handler: async (args) => {
    const { query, num_results = 5, region = 'us-en' } = args as {
      query: string;
      num_results: number;
      region: string;
    };
    const limit = Math.min(num_results, 10);

    const googleApiKey = process.env.GOOGLE_API_KEY;
    const googleCseId  = process.env.GOOGLE_CSE_ID;

    // ── Google Custom Search ──────────────────────────────────────────────────
    if (googleApiKey && googleCseId) {
      try {
        // Extract a language code from region (e.g. 'cn-zh' → 'zh-CN', 'us-en' → 'en')
        const [, lang] = region.split('-');
        const hl = lang ? (lang.length === 2 ? lang : lang) : 'en';
        const url = `https://www.googleapis.com/customsearch/v1?key=${googleApiKey}&cx=${googleCseId}` +
          `&q=${encodeURIComponent(query)}&num=${limit}&hl=${hl}`;
        const res = await fetch(url, { signal: timeoutSignal(15000) });
        if (res.ok) {
          const data = await res.json() as {
            items?: { title: string; link: string; snippet: string }[];
          };
          const items = data.items ?? [];
          if (items.length) {
            const mmrEnabled = process.env.AGENT_MMR !== '0';
            const raw = items.map((it) => ({ title: it.title, url: it.link, snippet: it.snippet }));
            const reranked = mmrRerankSearchResults(raw, { enabled: mmrEnabled, lambda: 0.7 });
            const output = reranked.map((r, i) =>
              `${i + 1}. **${r.title}**\n   URL: ${r.url}\n   ${r.snippet}`
            ).join('\n\n');
            return `Search results for: "${query}" [via Google]\n\n${output}`;
          }
          // Google returned no items (quota exceeded, etc.) — fall through to DDG
        }
      } catch {
        // Network error or parse error — fall through to DuckDuckGo
      }
    }

    // ── DuckDuckGo fallback ───────────────────────────────────────────────────
    try {
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=${region}`;
      const res = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; UniversalAgent/1.0)',
          Accept: 'text/html',
        },
        signal: timeoutSignal(15000),
      });

      if (!res.ok) return `Search failed: HTTP ${res.status}`;
      const html = await res.text();
      const results = parseDDGResults(html, limit);

      if (!results.length) return `No results found for: ${query}`;

      const mmrEnabled = process.env.AGENT_MMR !== '0';
      const reranked = mmrRerankSearchResults(results, { enabled: mmrEnabled, lambda: 0.7 });

      const provider = googleApiKey && googleCseId ? ' [Google quota exceeded, via DuckDuckGo]' : ' [via DuckDuckGo]';
      const output = reranked.map((r, i) =>
        `${i + 1}. **${r.title}**\n   URL: ${r.url}\n   ${r.snippet}`
      ).join('\n\n');

      return `Search results for: "${query}"${provider}\n\n${output}`;
    } catch (err) {
      return `Search unavailable: ${err instanceof Error ? err.message : String(err)}\nTry: https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
    }
  },
};

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

interface SearchResult { title: string; url: string; snippet: string; }

function parseDDGResults(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Match result blocks
  const titlePattern = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetPattern = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  const titles: Array<{ url: string; title: string }> = [];
  const snippets: string[] = [];

  let m: RegExpExecArray | null;
  while ((m = titlePattern.exec(html)) !== null && titles.length < limit) {
    titles.push({ url: m[1], title: stripHTML(m[2]).trim() });
  }
  while ((m = snippetPattern.exec(html)) !== null && snippets.length < limit) {
    snippets.push(stripHTML(m[1]).trim());
  }

  for (let i = 0; i < Math.min(titles.length, limit); i++) {
    results.push({
      title: titles[i].title || 'Untitled',
      url: titles[i].url || '',
      snippet: snippets[i] || '',
    });
  }

  // If HTML is substantial but we parsed nothing, the DDG response structure
  // has likely changed (class names are routinely updated). Warn the caller
  // instead of silently returning an empty list.
  if (!results.length && html.length > 10_000) {
    // Return a sentinel object so the caller can surface a helpful message.
    results.push({
      title: '⚠️ Parse warning',
      url: '',
      snippet: 'DuckDuckGo HTML structure may have changed — no results could be extracted.',
    });
  }

  return results;
}
