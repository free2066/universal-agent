/**
 * Maximal Marginal Relevance (MMR) re-ranking
 *
 * Borrowed from openclaw's src/memory/mmr.ts
 *
 * Prevents duplicate/redundant results when searching code or web results.
 * MMR score = λ * relevance - (1-λ) * max_similarity_to_already_selected
 *
 * λ=1.0 → pure relevance (no diversity)
 * λ=0.0 → pure diversity (no relevance)
 * λ=0.7 → default (mostly relevance, some diversity)
 */

export type MMRItem = {
  id: string;
  score: number;    // relevance score in [0, 1]
  content: string;  // used for Jaccard similarity
};

export type MMRConfig = {
  enabled: boolean;
  /** 0 = max diversity, 1 = max relevance. Default 0.7 */
  lambda: number;
};

export const DEFAULT_MMR_CONFIG: MMRConfig = {
  enabled: false,
  lambda: 0.7,
};

// ── Tokenization ──────────────────────────────────────────────────────────────

/** Tokenize text: lowercase alphanumeric + underscore tokens */
export function tokenize(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  return new Set(tokens);
}

/** Jaccard similarity between two token sets → [0, 1] */
export function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

/** Jaccard similarity between two content strings */
export function textSimilarity(a: string, b: string): number {
  return jaccardSimilarity(tokenize(a), tokenize(b));
}

// ── MMR Core ──────────────────────────────────────────────────────────────────

function maxSimilarityToSelected(
  item: MMRItem,
  selected: MMRItem[],
  cache: Map<string, Set<string>>,
): number {
  if (selected.length === 0) return 0;
  const tokensA = cache.get(item.id) ?? tokenize(item.content);
  if (!cache.has(item.id)) cache.set(item.id, tokensA);

  let max = 0;
  for (const s of selected) {
    const tokensB = cache.get(s.id) ?? tokenize(s.content);
    if (!cache.has(s.id)) cache.set(s.id, tokensB);
    const sim = jaccardSimilarity(tokensA, tokensB);
    if (sim > max) max = sim;
  }
  return max;
}

/** Compute MMR score */
export function computeMMRScore(relevance: number, maxSim: number, lambda: number): number {
  return lambda * relevance - (1 - lambda) * maxSim;
}

/**
 * Re-rank items using MMR.
 * Returns a re-ranked subset that balances relevance with diversity.
 */
export function mmrRerank<T extends MMRItem>(items: T[], config: Partial<MMRConfig> = {}): T[] {
  const { enabled = false, lambda = 0.7 } = { ...DEFAULT_MMR_CONFIG, ...config };
  if (!enabled || items.length <= 1) return items;

  const remaining = [...items];
  const selected: T[] = [];
  const tokenCache = new Map<string, Set<string>>();

  // Precompute tokens
  for (const item of items) {
    tokenCache.set(item.id, tokenize(item.content));
  }

  // Always take the highest-scoring item first
  remaining.sort((a, b) => b.score - a.score);
  selected.push(remaining.shift()!);

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestMMR = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const item = remaining[i];
      const maxSim = maxSimilarityToSelected(item, selected, tokenCache);
      const mmr = computeMMRScore(item.score, maxSim, lambda);
      if (mmr > bestMMR) {
        bestMMR = mmr;
        bestIdx = i;
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0]);
  }

  return selected;
}

// ── Helpers for search results ────────────────────────────────────────────────

export type SearchResult = {
  id?: string;
  score?: number;
  title: string;
  url: string;
  snippet: string;
};

export type GrepResult = {
  file: string;
  line: number;
  content: string;
  score?: number;
};

/**
 * Apply MMR to web search results using snippet as content.
 */
export function mmrRerankSearchResults(
  results: SearchResult[],
  config: Partial<MMRConfig> = {},
): SearchResult[] {
  if (results.length <= 1) return results;
  const items: Array<MMRItem & SearchResult> = results.map((r, i) => ({
    ...r,
    id: r.url || String(i),
    score: r.score ?? (results.length - i) / results.length,
    content: `${r.title} ${r.snippet}`,
  }));
  return mmrRerank(items, config);
}

/**
 * Apply MMR to grep results using file+content as the similarity basis.
 * This avoids returning 50 matches from the same file when one match per file is more useful.
 */
export function mmrRerankGrepResults(
  results: GrepResult[],
  config: Partial<MMRConfig> = {},
): GrepResult[] {
  if (results.length <= 1) return results;
  const items: Array<MMRItem & GrepResult> = results.map((r, i) => ({
    ...r,
    id: `${r.file}:${r.line}`,
    score: r.score ?? (results.length - i) / results.length,
    content: `${r.file} ${r.content}`,
  }));
  return mmrRerank(items, config);
}
