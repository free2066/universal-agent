/**
 * Memory Search Utilities
 *
 * Provides keyword-based TF-IDF scoring, Reciprocal Rank Fusion (RRF) merging,
 * and time-decay scoring for the MemoryStore recall pipeline.
 *
 * Design follows mem9's two-tier retrieval philosophy:
 *   Tier 1: exact tag/keyword match
 *   Tier 2: full-text TF-IDF similarity
 * Results are merged with RRF so both signals contribute to final ranking.
 */

import type { MemoryItem } from './memory-store.js';

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
 * Inverse Document Frequency: log(N / (1 + df))
 * `docs` is the full corpus of tokenised documents.
 */
function idf(term: string, docs: string[][]): number {
  const df = docs.filter((d) => d.includes(term)).length;
  return Math.log((docs.length + 1) / (df + 1)) + 1; // smoothed
}

/**
 * Compute TF-IDF similarity score between a query and a document.
 * Returns a non-negative float; higher = more similar.
 */
export function tfidfScore(query: string, doc: string, corpus: string[]): number {
  const queryTokens = tokenize(query);
  const docTokens = tokenize(doc);
  const corpusTokens = [docTokens, ...corpus.map(tokenize)];

  let score = 0;
  for (const term of queryTokens) {
    const termTf = tf(term, docTokens);
    const termIdf = idf(term, corpusTokens);
    score += termTf * termIdf;
  }
  return score;
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
 *   pinned:  0     (no decay — permanent)
 *   insight: 0.02  (half-life ≈ 35 days)
 *   fact:    0.1   (half-life ≈ 7 days)
 */
export function applyDecay(baseScore: number, item: MemoryItem): number {
  const decayRate: Record<MemoryItem['type'], number> = {
    pinned: 0,
    insight: 0.02,
    fact: 0.1,
  };
  const rate = decayRate[item.type] ?? 0.05;
  const daysSince = (Date.now() - item.updatedAt) / (1000 * 60 * 60 * 24);
  return baseScore * Math.exp(-rate * daysSince);
}

// ─── Reciprocal Rank Fusion ───────────────────────────────────────────────────

/**
 * Merge two ranked lists using Reciprocal Rank Fusion (RRF).
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

// ─── Main Ranking Function ────────────────────────────────────────────────────

export interface RankedMemory {
  item: MemoryItem;
  score: number;
}

/**
 * Rank a list of memory items against a query string.
 *
 * Pipeline:
 *   1. Tag/keyword exact match → ranked list A
 *   2. TF-IDF full-text match  → ranked list B
 *   3. RRF merge A + B
 *   4. Apply per-item time decay
 *   5. Return top-K results
 */
export function rankMemories(
  query: string,
  items: MemoryItem[],
  topK = 10,
): RankedMemory[] {
  if (items.length === 0) return [];

  const corpus = items.map((m) => m.content);

  // ── List A: tag / keyword exact match ──
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

  // ── List B: TF-IDF full-text ──
  const listB = items
    .map((m, i) => ({ idx: i, score: tfidfScore(query, m.content, corpus) }))
    .sort((a, b) => b.score - a.score)
    .map((r) => items[r.idx].id);

  // ── RRF merge ──
  const merged = rrfMerge([listA, listB]);

  // ── Apply time decay & return top-K ──
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
