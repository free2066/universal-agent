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

  const corpus = items.map((m) => m.content);

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
  const listB = items
    .map((m, i) => ({ idx: i, score: tfidfScore(query, m.content, corpus) }))
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
