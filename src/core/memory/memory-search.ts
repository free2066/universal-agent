/**
 * Memory Search Utilities — Hybrid Retrieval Pipeline
 *
 * Pipeline: TF-IDF (sparse) + Semantic Embedding (dense) → 3-way RRF → Time Decay → MMR
 *
 * Design:
 *   Tier 1 (exact):    tag/keyword match  → List A
 *   Tier 2 (sparse):   TF-IDF full-text   → List B
 *   Tier 3 (semantic): embedding cosine   → List C
 *   Merge:             RRF(A, B, C)        → ranked result
 *   Post:              time decay + MMR dedup
 *
 * Semantic tier auto-selects embedding provider:
 *   OPENAI_API_KEY   → text-embedding-3-small (1536 dim)
 *   GEMINI_API_KEY   → embedding-001 (768 dim)
 *   (neither)        → local n-gram hashing (384 dim, <1ms, zero deps)
 *
 * Fail-safe: if embedding fails for any reason, falls back silently to 2-way RRF(A, B).
 */

import type { MemoryItem } from './memory-store.js';
import { cosineSimilarity, embedQuery, embedDocs } from './embedding.js';

// ─── TF-IDF ──────────────────────────────────────────────────────────────────

/**
 * Tokenise text into lowercase words (strips punctuation).
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')  // keep CJK and ASCII word chars
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * Term Frequency: count(term in doc) / totalTermsInDoc
 */
function tf(term: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const count = tokens.filter((t) => t === term).length;
  return count / tokens.length;
}

/**
 * Build a document-frequency map from a pre-tokenised corpus.
 *
 * Complexity: O(N × D) — one pass over all docs, where N = corpus size and
 * D = average doc length.  This replaces the previous O(Q × N × D) pattern
 * where `idf()` was called for every query term, each doing a full corpus scan.
 *
 * Each entry maps `term → number of documents containing that term`.
 */
export function buildDocFrequency(tokenisedCorpus: string[][]): Map<string, number> {
  const df = new Map<string, number>();
  for (const doc of tokenisedCorpus) {
    const seen = new Set<string>();
    for (const token of doc) {
      if (!seen.has(token)) {
        df.set(token, (df.get(token) ?? 0) + 1);
        seen.add(token);
      }
    }
  }
  return df;
}

/**
 * Inverse Document Frequency using a pre-built frequency map.
 * O(1) per term — no corpus scan needed.
 */
function idfFromMap(term: string, docFreq: Map<string, number>, corpusSize: number): number {
  const df = docFreq.get(term) ?? 0;
  return Math.log((corpusSize + 1) / (df + 1)) + 1; // smoothed BM25-style
}

/**
 * Compute TF-IDF similarity score between a query and a document.
 *
 * @param query        Raw query string
 * @param doc          Raw document string
 * @param docFreq      Pre-built document-frequency map (from buildDocFrequency)
 * @param corpusSize   Total number of documents in the corpus
 *
 * Accepts the pre-computed `docFreq` map so callers can build it once and
 * reuse it across multiple documents, reducing complexity from O(Q×N×D) to
 * O(Q×D) for a full corpus ranking pass.
 */
export function tfidfScore(
  query: string,
  doc: string,
  docFreq: Map<string, number>,
  corpusSize: number,
): number {
  const queryTokens = tokenize(query);
  const docTokens = tokenize(doc);

  let score = 0;
  for (const term of queryTokens) {
    score += tf(term, docTokens) * idfFromMap(term, docFreq, corpusSize);
  }
  return score;
}

/**
 * Convenience overload: accepts a raw string corpus and builds the docFreq
 * map internally.  Use for one-off scoring; for bulk ranking prefer building
 * the map once with buildDocFrequency().
 *
 * @deprecated Prefer the (query, doc, docFreq, corpusSize) overload for
 *   repeated calls — this one rebuilds the frequency map on every invocation.
 */
export function tfidfScoreOnce(query: string, doc: string, corpus: string[]): number {
  const allTokens = [tokenize(doc), ...corpus.map(tokenize)];
  const df = buildDocFrequency(allTokens);
  return tfidfScore(query, doc, df, allTokens.length);
}

/**
 * Quick keyword containment check (no IDF weighting).
 * Returns fraction of query terms found in the document.
 */
export function keywordScore(query: string, doc: string): number {
  const qTokens = [...new Set(tokenize(query))];
  if (qTokens.length === 0) return 0;
  const dTokens = new Set(tokenize(doc));
  const hits = qTokens.filter((t) => dTokens.has(t)).length;
  return hits / qTokens.length;
}

// ─── Time Decay ──────────────────────────────────────────────────────────────

/**
 * Apply temporal decay to a base score.
 *
 * Decay rates (per day):
 *   pinned:    0     (no decay — permanent)
 *   insight:   0.02  (half-life ≈ 35 days)
 *   fact:      0.1   (half-life ≈ 7 days)
 *   iteration: 0.01  (half-life ≈ 70 days)
 */
export function applyDecay(baseScore: number, item: MemoryItem): number {
  const decayRate: Record<MemoryItem['type'], number> = {
    pinned: 0,
    insight: 0.02,
    fact: 0.1,
    iteration: 0.01,
  };
  const rate = decayRate[item.type] ?? 0.05;
  const daysSince = (Date.now() - item.updatedAt) / (1000 * 60 * 60 * 24);
  return baseScore * Math.exp(-rate * daysSince);
}

// ─── Reciprocal Rank Fusion ───────────────────────────────────────────────────

/**
 * Merge multiple ranked lists using Reciprocal Rank Fusion (RRF).
 *
 * RRF formula: score(d) = Σ 1 / (k + rank(d))
 * k = 60 is the standard constant (Cormack et al. 2009).
 *
 * `lists`: array of arrays of item IDs in ranked order (best first)
 * Returns: array of { id, score } sorted by descending RRF score
 */
export function rrfMerge(
  lists: string[][],
  k = 60,
): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();

  for (const list of lists) {
    list.forEach((id, idx) => {
      const prev = scores.get(id) ?? 0;
      scores.set(id, prev + 1 / (k + idx + 1));
    });
  }

  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

// ─── Semantic Ranking (List C) ────────────────────────────────────────────────

/**
 * Compute cosine similarity rankings for all items against the query embedding.
 * Returns item IDs sorted by cosine similarity (highest first).
 *
 * Fails silently: returns empty list if embedding is unavailable.
 */
async function semanticRank(
  query: string,
  items: MemoryItem[],
): Promise<string[]> {
  if (items.length === 0) return [];

  // Embed query
  const queryVec = await embedQuery(query);
  if (!queryVec) return []; // embedding unavailable → silent fallback

  // Embed all items (batch)
  const docTexts = items.map((m) => `${m.tags.join(' ')} ${m.content}`);
  const docVecs = await embedDocs(docTexts);
  if (!docVecs) return []; // embedding unavailable → silent fallback

  // Compute cosine similarities and rank
  return items
    .map((m, i) => ({
      id: m.id,
      sim: cosineSimilarity(queryVec, docVecs[i] ?? []),
    }))
    .sort((a, b) => b.sim - a.sim)
    .map((r) => r.id);
}

// ─── Main Ranking Function ────────────────────────────────────────────────────

export interface RankedMemory {
  item: MemoryItem;
  score: number;
}

/**
 * Rank memory items against a query using hybrid retrieval.
 *
 * Pipeline (3-way RRF):
 *   List A: Tag/keyword exact match    (always runs, <1ms)
 *   List B: TF-IDF full-text match     (always runs, <1ms)
 *   List C: Semantic embedding cosine  (async, auto-selected provider)
 *             → OpenAI / Gemini embedding (if API key available)
 *             → Local n-gram (if no API key, <1ms, zero deps)
 *   Merge:  RRF(A, B, C)
 *   Post:   time decay + top-K
 *
 * @param query  Search query string
 * @param items  Candidate memory items
 * @param topK   Maximum results to return (default 10)
 */
export async function rankMemories(
  query: string,
  items: MemoryItem[],
  topK = 10,
): Promise<RankedMemory[]> {
  if (items.length === 0) return [];

  // ── List A: tag / keyword exact match ──────────────────────────────────────
  const listA = items
    .map((m, i) => {
      const tagHit = m.tags.some((t) =>
        query.toLowerCase().includes(t.toLowerCase()) ||
        t.toLowerCase().includes(query.toLowerCase().split(' ')[0]),
      );
      const kwScore = keywordScore(query, m.content);
      return { idx: i, score: (tagHit ? 0.5 : 0) + kwScore };
    })
    .sort((a, b) => b.score - a.score)
    .map((r) => items[r.idx].id);

  // ── List B: TF-IDF full-text ───────────────────────────────────────────────
  // Pre-compute document-frequency map once (O(N×D)) so each per-item tfidfScore
  // call is O(Q×D) rather than O(Q×N×D), reducing overall complexity from
  // O(Q×N²×D) to O(N×D + Q×N×D).
  const corpusTokenised = items.map((m) => tokenize(m.content));
  const corpusDocFreq = buildDocFrequency(corpusTokenised);
  const corpusSize = corpusTokenised.length;

  const listB = items
    .map((m, i) => ({ idx: i, score: tfidfScore(query, m.content, corpusDocFreq, corpusSize) }))
    .sort((a, b) => b.score - a.score)
    .map((r) => items[r.idx].id);

  // ── List C: Semantic embedding cosine (async, fail-safe) ───────────────────
  // Runs concurrently with A and B (both are sync, so effectively parallel).
  const listC = await semanticRank(query, items);

  // ── 3-way RRF merge ────────────────────────────────────────────────────────
  // If List C is empty (embedding failed), falls back to 2-way RRF automatically.
  const lists = listC.length > 0 ? [listA, listB, listC] : [listA, listB];
  const merged = rrfMerge(lists);

  // ── Apply time decay & return top-K ───────────────────────────────────────
  const idToItem = new Map(items.map((m) => [m.id, m]));

  return merged
    .slice(0, topK * 3) // over-fetch before decay filter
    .map(({ id, score }) => {
      const item = idToItem.get(id)!;
      return { item, score: applyDecay(score, item) };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
