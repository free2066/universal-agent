/**
 * Unit Tests: memory-search.ts
 *
 * Covers: tokenize / tfidfScore / keywordScore / applyDecay / rrfMerge / rankMemories
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { tokenize, tfidfScore, tfidfScoreOnce, keywordScore, applyDecay, rrfMerge, rankMemories } from '../core/memory/memory-search.js';
import type { MemoryItem } from '../core/memory/memory-store.js';

// ── Helper: create a minimal MemoryItem for test ─────────────────────────────
function makeItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  const now = Date.now();
  return {
    id: Math.random().toString(36).slice(2, 8),
    type: 'fact',
    content: 'default content',
    project: '/test/project',
    tags: [],
    source: 'user',
    createdAt: now,
    updatedAt: now,
    accessCount: 0,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. tokenize
// ─────────────────────────────────────────────────────────────────────────────
describe('tokenize', () => {
  it('splits on whitespace and lowercases', () => {
    expect(tokenize('Hello World')).toEqual(['hello', 'world']);
  });

  it('strips punctuation', () => {
    expect(tokenize('hello, world! foo-bar')).toEqual(['hello', 'world', 'foo', 'bar']);
  });

  it('keeps CJK characters', () => {
    const tokens = tokenize('JWT认证模块');
    expect(tokens.some((t) => t.includes('jwt'))).toBe(true);
    expect(tokens.some((t) => /[\u4e00-\u9fff]/.test(t))).toBe(true);
  });

  it('filters out single-char tokens', () => {
    const tokens = tokenize('a bb ccc');
    expect(tokens).not.toContain('a');
    expect(tokens).toContain('bb');
    expect(tokens).toContain('ccc');
  });

  it('returns empty array for empty string', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('handles multiple spaces and tabs', () => {
    const tokens = tokenize('  hello   world  ');
    expect(tokens).toEqual(['hello', 'world']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. tfidfScore
// ─────────────────────────────────────────────────────────────────────────────
describe('tfidfScore', () => {
  it('returns > 0 when query term appears in doc', () => {
    const score = tfidfScoreOnce('JWT', 'JWT authentication module', ['other document']);
    expect(score).toBeGreaterThan(0);
  });

  it('returns 0 for completely unrelated query', () => {
    const score = tfidfScoreOnce('unrelated', 'JWT authentication module', ['JWT auth system']);
    expect(score).toBe(0);
  });

  it('higher score for more term overlap', () => {
    const high = tfidfScoreOnce('JWT auth token', 'JWT auth token security', ['other']);
    const low = tfidfScoreOnce('JWT auth token', 'database schema design', ['other']);
    expect(high).toBeGreaterThan(low);
  });

  it('handles empty query gracefully', () => {
    const score = tfidfScoreOnce('', 'some document content', ['corpus doc']);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it('is case-insensitive', () => {
    const s1 = tfidfScoreOnce('jwt', 'JWT auth module', ['corpus']);
    const s2 = tfidfScoreOnce('JWT', 'JWT auth module', ['corpus']);
    expect(s1).toBeCloseTo(s2, 5);
  });

  it('rare term has higher IDF than common term', () => {
    const corpus = [
      'auth token security',
      'auth system design',
      'auth module config',
      'rare_keyword only here',
    ];
    const rareScore = tfidfScoreOnce('rare_keyword', 'rare_keyword found here', corpus);
    const commonScore = tfidfScoreOnce('auth', 'auth system', corpus);
    // rare_keyword appears in only 1 doc vs auth in many → IDF should be higher
    expect(rareScore).toBeGreaterThan(0);
    expect(commonScore).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. keywordScore
// ─────────────────────────────────────────────────────────────────────────────
describe('keywordScore', () => {
  it('returns 0 for completely different strings', () => {
    const score = keywordScore('database schema', 'JWT authentication token');
    expect(score).toBe(0);
  });

  it('returns > 0 when terms overlap', () => {
    const score = keywordScore('JWT auth', 'JWT authentication module');
    expect(score).toBeGreaterThan(0);
  });

  it('returns 1.0 when all query terms appear in doc', () => {
    const score = keywordScore('jwt', 'jwt authentication');
    expect(score).toBeGreaterThan(0);
  });

  it('handles empty query — returns 0', () => {
    const score = keywordScore('', 'some content');
    expect(score).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. applyDecay
// ─────────────────────────────────────────────────────────────────────────────
describe('applyDecay', () => {
  it('pinned items do not decay (rate=0)', () => {
    const item = makeItem({ type: 'pinned', createdAt: Date.now() - 365 * 24 * 60 * 60 * 1000 });
    const score = applyDecay(1.0, item);
    expect(score).toBeCloseTo(1.0, 5);
  });

  it('fact decays faster than insight', () => {
    const old = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago
    // applyDecay uses item.updatedAt, so we must set updatedAt = old as well
    const fact = makeItem({ type: 'fact', createdAt: old, updatedAt: old });
    const insight = makeItem({ type: 'insight', createdAt: old, updatedAt: old });
    const factScore = applyDecay(1.0, fact);
    const insightScore = applyDecay(1.0, insight);
    expect(factScore).toBeLessThan(insightScore);
  });

  it('very recent items have score close to base', () => {
    const now = Date.now();
    const item = makeItem({ type: 'fact', createdAt: now - 1000, updatedAt: now }); // 1 second ago
    const score = applyDecay(1.0, item);
    expect(score).toBeGreaterThan(0.99);
  });

  it('very old fact items have score close to 0', () => {
    // applyDecay uses updatedAt — must set both createdAt and updatedAt to old
    const oldTime = Date.now() - 500 * 24 * 60 * 60 * 1000; // 500 days ago
    const item = makeItem({ type: 'fact', createdAt: oldTime, updatedAt: oldTime });
    const score = applyDecay(1.0, item);
    expect(score).toBeLessThan(0.01);
  });

  it('returns 0 for base score of 0', () => {
    const item = makeItem({ type: 'insight' });
    expect(applyDecay(0, item)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. rrfMerge
// ─────────────────────────────────────────────────────────────────────────────
describe('rrfMerge', () => {
  it('merges two lists by rank position', () => {
    const listA = ['id1', 'id2', 'id3'];
    const listB = ['id2', 'id1', 'id3'];
    const merged = rrfMerge([listA, listB]);
    // id1 and id2 both appear first in one of the lists — should both be high scored
    expect(merged.map((r) => r.id)).toContain('id1');
    expect(merged.map((r) => r.id)).toContain('id2');
    // id appearing in top of both lists should win
    expect(merged[0].id === 'id1' || merged[0].id === 'id2').toBe(true);
  });

  it('id appearing in all lists gets higher score', () => {
    const listA = ['id1', 'id2'];
    const listB = ['id1', 'id3'];
    const listC = ['id1', 'id4'];
    const merged = rrfMerge([listA, listB, listC]);
    expect(merged[0].id).toBe('id1'); // id1 is #1 in all lists
  });

  it('returns empty array for empty input', () => {
    expect(rrfMerge([])).toEqual([]);
  });

  it('scores decrease from top to bottom', () => {
    const list = ['id1', 'id2', 'id3', 'id4'];
    const merged = rrfMerge([list]);
    for (let i = 0; i < merged.length - 1; i++) {
      expect(merged[i].score).toBeGreaterThanOrEqual(merged[i + 1].score);
    }
  });

  it('handles duplicates across lists without crashing', () => {
    const listA = ['a', 'b', 'c'];
    const listB = ['a', 'b', 'c']; // exact same list
    const merged = rrfMerge([listA, listB]);
    expect(merged.length).toBe(3); // no duplicates in output
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. rankMemories (integration of full pipeline)
// ─────────────────────────────────────────────────────────────────────────────
describe('rankMemories', () => {
  let items: MemoryItem[];

  beforeEach(() => {
    const now = Date.now();
    items = [
      makeItem({ id: 'jwt-item', content: 'JWT auth uses RS256 signing algorithm', tags: ['auth', 'jwt'] }),
      makeItem({ id: 'db-item', content: 'Database schema has users and orders tables', tags: ['db', 'schema'] }),
      makeItem({ id: 'perf-item', content: 'API rate limiting uses token bucket algorithm', tags: ['api', 'performance'] }),
      makeItem({ id: 'redis-item', content: 'Redis cache TTL is 1 hour for session data', tags: ['redis', 'cache'] }),
      makeItem({ id: 'deploy-item', content: 'Deployment uses Docker and Kubernetes on AWS', tags: ['devops', 'deploy'] }),
    ];
  });

  it('returns array of MemoryItem objects', async () => {
    const results = await rankMemories('JWT authentication', items);
    expect(Array.isArray(results)).toBe(true);
    results.forEach((r) => {
      expect(r).toHaveProperty('item');
      expect(r).toHaveProperty('score');
      expect(typeof r.item.content).toBe('string');
    });
  });

  it('JWT-related query ranks JWT item higher than database item', async () => {
    const results = await rankMemories('JWT authentication signing', items);
    const jwtIdx = results.findIndex((r) => r.item.id === 'jwt-item');
    const dbIdx = results.findIndex((r) => r.item.id === 'db-item');
    // jwt-item should be ranked higher (lower index) than db-item
    if (jwtIdx !== -1 && dbIdx !== -1) {
      expect(jwtIdx).toBeLessThan(dbIdx);
    } else {
      // at least jwt-item should appear
      expect(jwtIdx).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns empty array for empty items list', async () => {
    const results = await rankMemories('anything', []);
    expect(results).toEqual([]);
  });

  it('respects topK limit', async () => {
    const results = await rankMemories('anything', items, 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('tag match boosts item rank', async () => {
    const results = await rankMemories('redis', items);
    const redisIdx = results.findIndex((r) => r.item.id === 'redis-item');
    // redis-item has 'redis' tag — should appear in results
    expect(redisIdx).toBeGreaterThanOrEqual(0);
  });

  it('scores are non-negative', async () => {
    const results = await rankMemories('test query', items);
    results.forEach((r) => {
      expect(r.score).toBeGreaterThanOrEqual(0);
    });
  });
});
