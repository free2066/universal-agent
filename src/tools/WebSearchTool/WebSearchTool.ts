/**
 * WebSearchTool/WebSearchTool.ts — WebSearch: web search tool
 *
 * Uses Google Custom Search API when GOOGLE_API_KEY + GOOGLE_CSE_ID are set,
 * otherwise falls back to DuckDuckGo (no API key required).
 *
 * To enable Google Search:
 *   1. Create a Custom Search Engine at https://programmablesearchengine.google.com/
 *   2. Get an API key at https://console.developers.google.com/
 *   3. Set env vars: GOOGLE_API_KEY=<key>  GOOGLE_CSE_ID=<engine-id>
 */

import type { ToolRegistration } from '../../models/types.js';
import { mmrRerankSearchResults } from '../../core/memory/mmr.js';

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

interface SearchResult { title: string; url: string; snippet: string; }

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

function parseDDGResults(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];

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

  if (!results.length && html.length > 10_000) {
    results.push({
      title: '⚠️ Parse warning',
      url: '',
      snippet: 'DuckDuckGo HTML structure may have changed — no results could be extracted.',
    });
  }

  return results;
}

// ─── WebSearch ───────────────────────────────────────────
export const webSearchTool: ToolRegistration = {
  searchHint: 'search internet web Google information lookup',
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
