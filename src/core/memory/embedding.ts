/**
 * Embedding Provider — hybrid semantic vector layer for memory search
 *
 * Two-tier design (auto-detected from environment):
 *
 *   Tier 1 (API, ~200ms first call, cached): OpenAI text-embedding-3-small
 *     or Gemini embedding-001 — full semantic understanding
 *   Tier 2 (Local, <1ms, zero deps): character n-gram hashing into 256-dim
 *     unit vector — no API key needed, reasonable semantic approximation
 *
 * Switching logic:
 *   OPENAI_API_KEY present  →  OpenAI embedding
 *   GEMINI_API_KEY present   →  Gemini embedding
 *   Neither                  →  Local n-gram embedding
 *
 * Embedding cache:
 *   Results are stored in an in-process LRU cache (max 2000 entries).
 *   Cache key = sha1(text). On process restart the cache is cold — this is
 *   intentional: embedding model versions may change across restarts.
 *
 * Cosine similarity:
 *   All vectors are L2-normalised so dot-product == cosine similarity.
 *   Use cosineSimilarity(a, b) for direct comparison.
 */

import { createHash } from 'crypto';
import { createLogger } from '../logger.js';

const log = createLogger('embedding');

// ── Vector Math ───────────────────────────────────────────────────────────────

/** L2-normalise a float array in-place. Returns the same array. */
export function l2normalize(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

/**
 * Dot-product of two equal-length unit vectors == cosine similarity.
 * Returns value in [-1, 1].
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

// ── EmbeddingProvider Interface ───────────────────────────────────────────────

export interface EmbeddingProvider {
  /** Embed a batch of texts. Returns L2-normalised vectors. */
  embed(texts: string[]): Promise<number[][]>;
  /** Dimensionality of the vectors produced */
  readonly dim: number;
  /** Provider type for logging / metrics */
  readonly type: 'api-openai' | 'api-gemini' | 'local-ngram';
}

// ── LRU Cache ─────────────────────────────────────────────────────────────────

const MAX_CACHE_SIZE = 2000;
const _cache = new Map<string, number[]>(); // sha1(text) → vector

function cacheKey(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

function cacheGet(text: string): number[] | undefined {
  const k = cacheKey(text);
  const v = _cache.get(k);
  if (v) {
    // Move to end (LRU bump)
    _cache.delete(k);
    _cache.set(k, v);
  }
  return v;
}

function cacheSet(text: string, vec: number[]): void {
  const k = cacheKey(text);
  if (_cache.size >= MAX_CACHE_SIZE) {
    // Evict oldest entry
    _cache.delete(_cache.keys().next().value ?? '');
  }
  _cache.set(k, vec);
}

/** Clear embedding cache (useful in tests) */
export function clearEmbeddingCache(): void {
  _cache.clear();
}

// ── Local N-gram Embedding (zero dependencies) ────────────────────────────────

/**
 * Local character n-gram embedding.
 *
 * Algorithm:
 *   1. Normalise text (lowercase, strip excess whitespace)
 *   2. Sliding window: extract all 2-grams and 3-grams
 *   3. Hash each n-gram to a bucket in [0, DIM) using djb2-style hash
 *   4. Accumulate TF counts in the bucket array
 *   5. L2-normalise → unit vector
 *
 * DIM = 384 (chosen to match sentence-transformers/all-MiniLM output dim,
 * so if you later swap to a real model the scores remain comparable).
 *
 * Quality characteristics:
 *   - Works for: spelling variations, sub-word morphology, CJK (each char = 1-gram)
 *   - Weaker for: true synonyms across different words ("bug" vs "error")
 *   - Better than pure bag-of-words; worse than transformer embeddings
 */
export const LOCAL_NGRAM_DIM = 384;

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; // uint32
  }
  return h;
}

export function localNgramEmbed(text: string): number[] {
  const vec = new Array<number>(LOCAL_NGRAM_DIM).fill(0);

  // Normalise
  const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!norm) return l2normalize(vec);

  // Unigrams (word-level)
  const words = norm.split(/\s+/);
  for (const w of words) {
    const idx = djb2(w) % LOCAL_NGRAM_DIM;
    vec[idx] += 1;
  }

  // Character bigrams + trigrams (sliding window over full text)
  for (let i = 0; i < norm.length - 1; i++) {
    const bg = norm.slice(i, i + 2);
    vec[djb2(bg) % LOCAL_NGRAM_DIM] += 0.5;
    if (i < norm.length - 2) {
      const tg = norm.slice(i, i + 3);
      vec[djb2(tg) % LOCAL_NGRAM_DIM] += 0.25;
    }
  }

  return l2normalize(vec);
}

class LocalNgramProvider implements EmbeddingProvider {
  readonly dim = LOCAL_NGRAM_DIM;
  readonly type = 'local-ngram' as const;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const cached = cacheGet(t);
      if (cached) return cached;
      const vec = localNgramEmbed(t);
      cacheSet(t, vec);
      return vec;
    });
  }
}

// ── OpenAI Embedding Provider ─────────────────────────────────────────────────

/** OpenAI text-embedding-3-small: 1536 dim, $0.02/1M tokens */
const OPENAI_EMBED_DIM = 1536;
const OPENAI_EMBED_MODEL = 'text-embedding-3-small';

class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dim = OPENAI_EMBED_DIM;
  readonly type = 'api-openai' as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com';
  }

  async embed(texts: string[]): Promise<number[][]> {
    // Partition into cached + uncached
    const results: (number[] | null)[] = texts.map((t) => cacheGet(t) ?? null);
    const missing = texts.filter((_, i) => !results[i]);

    if (missing.length > 0) {
      const fetched = await this._fetchBatch(missing);
      let mi = 0;
      for (let i = 0; i < results.length; i++) {
        if (!results[i]) {
          const vec = l2normalize(fetched[mi++]);
          results[i] = vec;
          cacheSet(texts[i], vec);
        }
      }
    }

    return results as number[][];
  }

  private async _fetchBatch(texts: string[]): Promise<number[][]> {
    const body = JSON.stringify({ model: OPENAI_EMBED_MODEL, input: texts });
    const resp = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body,
    });

    if (!resp.ok) {
      throw new Error(`OpenAI embedding API error: ${resp.status} ${await resp.text()}`);
    }

    const json = await resp.json() as {
      data: Array<{ embedding: number[]; index: number }>;
    };
    // Sort by index to maintain order
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  }
}

// ── Gemini Embedding Provider ─────────────────────────────────────────────────

/** Google Gemini embedding-001: 768 dim */
const GEMINI_EMBED_DIM = 768;

class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly dim = GEMINI_EMBED_DIM;
  readonly type = 'api-gemini' as const;
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async embed(texts: string[]): Promise<number[][]> {
    // Gemini doesn't support batch — send individually, parallel
    const results = await Promise.all(texts.map((t) => this._embedOne(t)));
    return results;
  }

  private async _embedOne(text: string): Promise<number[]> {
    const cached = cacheGet(text);
    if (cached) return cached;

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/embedding-001:embedContent?key=${this.apiKey}`;
    const body = JSON.stringify({
      model: 'models/embedding-001',
      content: { parts: [{ text }] },
    });

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!resp.ok) {
      throw new Error(`Gemini embedding API error: ${resp.status} ${await resp.text()}`);
    }

    const json = await resp.json() as { embedding: { values: number[] } };
    const vec = l2normalize(json.embedding.values);
    cacheSet(text, vec);
    return vec;
  }
}

// ── Provider Selection ────────────────────────────────────────────────────────

let _cachedProvider: EmbeddingProvider | null = null;

/**
 * Get the best available EmbeddingProvider.
 *
 * Selection priority:
 *   1. OPENAI_API_KEY present   → OpenAI text-embedding-3-small
 *   2. GEMINI_API_KEY present   → Gemini embedding-001
 *   3. Otherwise               → Local n-gram (zero deps, <1ms)
 *
 * The result is cached for the process lifetime.
 * Call resetEmbeddingProvider() in tests to force re-detection.
 */
export function getEmbeddingProvider(): EmbeddingProvider {
  if (_cachedProvider) return _cachedProvider;

  const openaiKey = process.env.OPENAI_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (openaiKey && openaiKey.startsWith('sk-')) {
    log.info('Using OpenAI embedding provider (text-embedding-3-small)');
    _cachedProvider = new OpenAIEmbeddingProvider(openaiKey);
  } else if (geminiKey) {
    log.info('Using Gemini embedding provider (embedding-001)');
    _cachedProvider = new GeminiEmbeddingProvider(geminiKey);
  } else {
    log.info('No API key detected — using local n-gram embedding provider (dim=384)');
    _cachedProvider = new LocalNgramProvider();
  }

  return _cachedProvider;
}

/** Force re-detection of embedding provider (useful after env var changes / tests) */
export function resetEmbeddingProvider(): void {
  _cachedProvider = null;
}

// ── Top-level helpers ─────────────────────────────────────────────────────────

/**
 * Embed a single query string using the active provider.
 * Returns null if embedding fails (caller should fall back to TF-IDF only).
 */
export async function embedQuery(query: string): Promise<number[] | null> {
  try {
    const provider = getEmbeddingProvider();
    const [vec] = await provider.embed([query]);
    return vec ?? null;
  } catch (err) {
    log.debug(`embedQuery failed — falling back to TF-IDF only: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Embed a batch of document strings using the active provider.
 * Returns null on failure.
 */
export async function embedDocs(texts: string[]): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  try {
    const provider = getEmbeddingProvider();
    return await provider.embed(texts);
  } catch (err) {
    log.debug(`embedDocs failed — falling back to TF-IDF only: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
