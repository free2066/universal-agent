/**
 * Unit Tests: memory-store.ts
 *
 * Covers: add / get / list / update / delete / clear / gc / getRecentIterations
 * Skips: recall (tested in memory-search.test.ts) and ingest (requires LLM)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../core/memory/memory-store.js';
import type { MemoryItem, MemoryType } from '../core/memory/memory-store.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// Test infrastructure — isolated temp dir per test
// ─────────────────────────────────────────────────────────────────────────────

let tmpDir: string;
let store: MemoryStore;

beforeEach(() => {
  // Each test gets a fresh isolated store
  tmpDir = mkdtempSync(join(tmpdir(), 'uagent-test-'));
  store = new MemoryStore(tmpDir);
  store.clear(); // defensive
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. add()
// ─────────────────────────────────────────────────────────────────────────────
describe('MemoryStore — add()', () => {
  it('returns a non-empty string ID', () => {
    const id = store.add({ type: 'fact', content: 'hello', tags: [], source: 'user' });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('returned IDs are unique', () => {
    const ids = new Set(
      Array.from({ length: 50 }, () => store.add({ type: 'fact', content: 'x', tags: [], source: 'user' })),
    );
    expect(ids.size).toBe(50);
  });

  it('added fact has correct fields', () => {
    const before = Date.now();
    const id = store.add({ type: 'fact', content: 'JWT auth RS256', tags: ['auth'], source: 'user' });
    const item = store.get(id);
    expect(item).toBeDefined();
    expect(item!.type).toBe('fact');
    expect(item!.content).toBe('JWT auth RS256');
    expect(item!.tags).toEqual(['auth']);
    expect(item!.source).toBe('user');
    expect(item!.accessCount).toBe(0);
    expect(item!.createdAt).toBeGreaterThanOrEqual(before);
    expect(item!.id).toBe(id);
  });

  it('fact type auto-assigns TTL (7 days)', () => {
    const id = store.add({ type: 'fact', content: 'test', tags: [], source: 'user' });
    const item = store.get(id)!;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(item.ttl).toBeDefined();
    expect(item.ttl!).toBeGreaterThan(Date.now() + sevenDaysMs - 60_000); // allow 1min slack
  });

  it('iteration type auto-assigns TTL (90 days)', () => {
    const id = store.add({ type: 'iteration', content: 'task done', tags: [], source: 'agent' });
    const item = store.get(id)!;
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    expect(item.ttl).toBeDefined();
    expect(item.ttl!).toBeGreaterThan(Date.now() + ninetyDaysMs - 60_000);
  });

  it('pinned type has no TTL', () => {
    const id = store.add({ type: 'pinned', content: 'always include this', tags: [], source: 'user' });
    const item = store.get(id)!;
    expect(item.ttl).toBeUndefined();
  });

  it('insight type has no TTL', () => {
    const id = store.add({ type: 'insight', content: 'DB uses PG', tags: ['db'], source: 'ingest' });
    const item = store.get(id)!;
    expect(item.ttl).toBeUndefined();
  });

  it('custom TTL overrides default', () => {
    const customTtl = Date.now() + 1000;
    const id = store.add({ type: 'fact', content: 'x', tags: [], source: 'user', ttl: customTtl });
    expect(store.get(id)!.ttl).toBe(customTtl);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. get()
// ─────────────────────────────────────────────────────────────────────────────
describe('MemoryStore — get()', () => {
  it('returns item by ID', () => {
    const id = store.add({ type: 'insight', content: 'API uses REST', tags: [], source: 'user' });
    const item = store.get(id);
    expect(item).toBeDefined();
    expect(item!.content).toBe('API uses REST');
  });

  it('returns undefined for unknown ID', () => {
    expect(store.get('nonexistent-id-000')).toBeUndefined();
  });

  it('finds items across all 4 memory types', () => {
    const types: MemoryType[] = ['pinned', 'insight', 'fact', 'iteration'];
    const ids = types.map((type) =>
      store.add({ type, content: `${type} content`, tags: [], source: 'user' }),
    );
    for (let i = 0; i < ids.length; i++) {
      const item = store.get(ids[i]);
      expect(item).toBeDefined();
      expect(item!.type).toBe(types[i]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. list()
// ─────────────────────────────────────────────────────────────────────────────
describe('MemoryStore — list()', () => {
  it('returns empty array for empty store', () => {
    expect(store.list()).toEqual([]);
  });

  it('returns all items across all types', () => {
    store.add({ type: 'pinned', content: 'p1', tags: [], source: 'user' });
    store.add({ type: 'insight', content: 'i1', tags: [], source: 'user' });
    store.add({ type: 'fact', content: 'f1', tags: [], source: 'user' });
    store.add({ type: 'iteration', content: 'it1', tags: [], source: 'agent' });
    expect(store.list().length).toBe(4);
  });

  it('returns only specified types when types filter is passed', () => {
    store.add({ type: 'pinned', content: 'p1', tags: [], source: 'user' });
    store.add({ type: 'insight', content: 'i1', tags: [], source: 'user' });
    store.add({ type: 'fact', content: 'f1', tags: [], source: 'user' });

    const facts = store.list({ types: ['fact'] });
    expect(facts.length).toBe(1);
    expect(facts[0].type).toBe('fact');

    const pinAndInsight = store.list({ types: ['pinned', 'insight'] });
    expect(pinAndInsight.length).toBe(2);
  });

  it('items have correct project path', () => {
    store.add({ type: 'fact', content: 'test', tags: [], source: 'user' });
    const items = store.list();
    expect(items[0].project).toBe(store['project']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. update()
// ─────────────────────────────────────────────────────────────────────────────
describe('MemoryStore — update()', () => {
  it('updates content and tags', () => {
    const id = store.add({ type: 'insight', content: 'old content', tags: ['old'], source: 'user' });
    store.update(id, { content: 'new content', tags: ['new', 'updated'] });
    const item = store.get(id)!;
    expect(item.content).toBe('new content');
    expect(item.tags).toEqual(['new', 'updated']);
  });

  it('updates updatedAt timestamp', async () => {
    const id = store.add({ type: 'insight', content: 'test', tags: [], source: 'user' });
    const before = store.get(id)!.updatedAt;
    await new Promise((r) => setTimeout(r, 5)); // wait 5ms
    store.update(id, { content: 'changed' });
    const after = store.get(id)!.updatedAt;
    expect(after).toBeGreaterThan(before);
  });

  it('returns true when item found and updated', () => {
    const id = store.add({ type: 'fact', content: 'x', tags: [], source: 'user' });
    expect(store.update(id, { content: 'y' })).toBe(true);
  });

  it('returns false for unknown ID', () => {
    expect(store.update('nonexistent', { content: 'x' })).toBe(false);
  });

  it('partial update preserves unchanged fields', () => {
    const id = store.add({ type: 'pinned', content: 'original', tags: ['keep'], source: 'user' });
    store.update(id, { content: 'changed' });
    const item = store.get(id)!;
    expect(item.tags).toEqual(['keep']); // tags unchanged
  });

  it('updates ttl field', () => {
    const id = store.add({ type: 'fact', content: 'x', tags: [], source: 'user' });
    const newTtl = Date.now() + 999_999;
    store.update(id, { ttl: newTtl });
    expect(store.get(id)!.ttl).toBe(newTtl);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. delete()
// ─────────────────────────────────────────────────────────────────────────────
describe('MemoryStore — delete()', () => {
  it('removes item and returns true', () => {
    const id = store.add({ type: 'fact', content: 'delete me', tags: [], source: 'user' });
    expect(store.delete(id)).toBe(true);
    expect(store.get(id)).toBeUndefined();
  });

  it('returns false for unknown ID', () => {
    expect(store.delete('nonexistent')).toBe(false);
  });

  it('list() returns fewer items after delete', () => {
    const id1 = store.add({ type: 'fact', content: 'a', tags: [], source: 'user' });
    store.add({ type: 'fact', content: 'b', tags: [], source: 'user' });
    store.delete(id1);
    const items = store.list({ types: ['fact'] });
    expect(items.length).toBe(1);
    expect(items[0].content).toBe('b');
  });

  it('can delete across all 4 types', () => {
    const types: MemoryType[] = ['pinned', 'insight', 'fact', 'iteration'];
    for (const type of types) {
      const id = store.add({ type, content: 'delete me', tags: [], source: 'user' });
      expect(store.delete(id)).toBe(true);
    }
    expect(store.list().length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. clear()
// ─────────────────────────────────────────────────────────────────────────────
describe('MemoryStore — clear()', () => {
  it('removes all items', () => {
    store.add({ type: 'pinned', content: 'p', tags: [], source: 'user' });
    store.add({ type: 'insight', content: 'i', tags: [], source: 'user' });
    store.add({ type: 'fact', content: 'f', tags: [], source: 'user' });
    store.clear();
    expect(store.list().length).toBe(0);
  });

  it('clear with specific types only removes those types', () => {
    store.add({ type: 'pinned', content: 'keep', tags: [], source: 'user' });
    store.add({ type: 'fact', content: 'remove', tags: [], source: 'user' });
    store.clear(['fact']);
    expect(store.list({ types: ['pinned'] }).length).toBe(1);
    expect(store.list({ types: ['fact'] }).length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. gc() — Garbage Collection
// ─────────────────────────────────────────────────────────────────────────────
describe('MemoryStore — gc()', () => {
  it('removes expired fact memories', () => {
    // Add an already-expired fact (TTL = 1 second in the past)
    const expiredTtl = Date.now() - 1;
    store.add({ type: 'fact', content: 'expired fact', tags: [], source: 'user', ttl: expiredTtl });

    // Add a valid fact
    store.add({ type: 'fact', content: 'valid fact', tags: [], source: 'user' });

    const removed = store.gc();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(store.list({ types: ['fact'] }).length).toBe(1);
    expect(store.list({ types: ['fact'] })[0].content).toBe('valid fact');
  });

  it('removes expired iteration memories', () => {
    store.add({ type: 'iteration', content: 'expired', tags: [], source: 'agent', ttl: Date.now() - 1 });
    store.add({ type: 'iteration', content: 'valid', tags: [], source: 'agent' });
    const removed = store.gc();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(store.list({ types: ['iteration'] }).some((i) => i.content === 'expired')).toBe(false);
  });

  it('does not remove pinned or insight memories (no TTL by default)', () => {
    store.add({ type: 'pinned', content: 'permanent', tags: [], source: 'user' });
    store.add({ type: 'insight', content: 'project knowledge', tags: [], source: 'ingest' });
    const before = store.list().length;
    store.gc();
    expect(store.list().length).toBe(before);
  });

  it('returns 0 when no expired items', () => {
    store.add({ type: 'fact', content: 'fresh', tags: [], source: 'user' });
    const removed = store.gc();
    expect(removed).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. getRecentIterations()
// ─────────────────────────────────────────────────────────────────────────────
describe('MemoryStore — getRecentIterations()', () => {
  it('returns empty array when no iterations', () => {
    expect(store.getRecentIterations()).toEqual([]);
  });

  it('returns iterations sorted by createdAt descending', async () => {
    store.add({ type: 'iteration', content: 'first', tags: [], source: 'agent' });
    await new Promise((r) => setTimeout(r, 10));
    store.add({ type: 'iteration', content: 'second', tags: [], source: 'agent' });
    await new Promise((r) => setTimeout(r, 10));
    store.add({ type: 'iteration', content: 'third', tags: [], source: 'agent' });

    const recent = store.getRecentIterations(3);
    expect(recent[0].content).toBe('third'); // newest first
    expect(recent[1].content).toBe('second');
    expect(recent[2].content).toBe('first');
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      store.add({ type: 'iteration', content: `iter-${i}`, tags: [], source: 'agent' });
    }
    expect(store.getRecentIterations(3).length).toBe(3);
    expect(store.getRecentIterations(1).length).toBe(1);
  });

  it('default limit is 5', () => {
    for (let i = 0; i < 10; i++) {
      store.add({ type: 'iteration', content: `iter-${i}`, tags: [], source: 'agent' });
    }
    expect(store.getRecentIterations().length).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Persistence (data survives store re-instantiation)
// ─────────────────────────────────────────────────────────────────────────────
describe('MemoryStore — persistence', () => {
  it('data persists across store instances pointing to same project', () => {
    const id1 = store.add({ type: 'pinned', content: 'persistent rule', tags: [], source: 'user' });
    const id2 = store.add({ type: 'fact', content: 'ephemeral fact', tags: [], source: 'agent' });

    // Create new store pointing to same dir
    const store2 = new MemoryStore(tmpDir);
    expect(store2.get(id1)?.content).toBe('persistent rule');
    expect(store2.get(id2)?.content).toBe('ephemeral fact');
    expect(store2.list().length).toBe(2);
  });

  it('different project dirs are isolated', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'uagent-test2-'));
    try {
      const store2 = new MemoryStore(dir2);
      store.add({ type: 'fact', content: 'project 1 fact', tags: [], source: 'user' });
      expect(store2.list().length).toBe(0); // isolation
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
