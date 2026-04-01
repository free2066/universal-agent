import type { ToolRegistration } from '../../models/types.js';
import { mmrRerankSearchResults } from '../mmr.js';

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
  handler: async (args) => {
    const { url, extract = 'text' } = args as { url: string; extract: string };

    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; UniversalAgent/1.0)',
          Accept: 'text/html,application/xhtml+xml,*/*',
        },
        signal: timeoutSignal(15000),
      });

      if (!res.ok) return `Error: HTTP ${res.status} ${res.statusText}`;

      const contentType = res.headers.get('content-type') || '';
      const text = await res.text();

      // JSON response
      if (contentType.includes('application/json')) {
        try {
          return JSON.stringify(JSON.parse(text), null, 2).slice(0, 8000);
        } catch { return text.slice(0, 8000); }
      }

      // HTML — strip tags
      const stripped = stripHTML(text);
      const links = extract !== 'text' ? extractLinks(text, url) : [];

      if (extract === 'links') return links.slice(0, 50).join('\n');
      if (extract === 'both') return `Content:\n${stripped.slice(0, 5000)}\n\nLinks:\n${links.slice(0, 20).join('\n')}`;
      return stripped.slice(0, 8000);
    } catch (err) {
      return `Error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

// ─── WebSearch ───────────────────────────────────────────
export const webSearchTool: ToolRegistration = {
  definition: {
    name: 'WebSearch',
    description: 'Search the web using DuckDuckGo (no API key required). Returns top search results with titles, URLs, and snippets.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        num_results: { type: 'number', description: 'Number of results to return (default: 5, max: 10)' },
        region: { type: 'string', description: 'Region code (e.g., us-en, cn-zh, uk-en)' },
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

    try {
      // DuckDuckGo HTML search (no API key needed)
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

      // Parse results from DuckDuckGo HTML
      const results = parseDDGResults(html, limit);

      if (!results.length) return `No results found for: ${query}`;

      // Apply MMR re-ranking to reduce duplicate/redundant search results
      const mmrEnabled = process.env.AGENT_MMR !== '0';
      const reranked = mmrRerankSearchResults(results, { enabled: mmrEnabled, lambda: 0.7 });

      const output = reranked.map((r, i) =>
        `${i + 1}. **${r.title}**\n   URL: ${r.url}\n   ${r.snippet}`
      ).join('\n\n');

      return `Search results for: "${query}"\n\n${output}`;
    } catch (err) {
      // Fallback to suggest search
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

  return results;
}
