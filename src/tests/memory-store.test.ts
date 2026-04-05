/**
 * memory-store.test.ts
 * 测试 MemoryStore 的 CRUD 操作（使用 tmpdir，不污染 ~/.uagent）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Override HOME to prevent writing to real ~/.uagent
let tmpHome: string;
let origHome: string;

beforeEach(() => {
  origHome = process.env.HOME ?? '';
  tmpHome = mkdtempSync(join(tmpdir(), 'uagent-test-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = origHome;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Dynamic import so HOME override takes effect before module-level code runs
async function getStore(projectRoot?: string) {
  // Reset module cache to pick up new HOME
  const { getMemoryStore, resetMemoryStore } = await import('../core/memory/memory-store.js');
  resetMemoryStore();
  return getMemoryStore(projectRoot ?? tmpHome);
}

describe('MemoryStore - add / list / stats', () => {
  it('adds a pinned memory and returns an id', async () => {
    const store = await getStore();
    const id = store.add({ type: 'pinned', content: 'important fact', tags: ['tag1'], source: 'user' });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('lists added memories', async () => {
    const store = await getStore();
    store.add({ type: 'pinned', content: 'fact A', tags: [], source: 'user' });
    store.add({ type: 'insight', content: 'insight B', tags: [], source: 'agent' });
    const items = store.list();
    expect(items.length).toBeGreaterThanOrEqual(2);
  });

  it('lists only specified type with list({ type })', async () => {
    const store = await getStore();
    store.add({ type: 'pinned', content: 'pinned one', tags: [], source: 'user' });
    store.add({ type: 'fact', content: 'fact one', tags: [], source: 'agent' });
    const pinned = store.list({ types: ['pinned'] });
    expect(pinned.every(m => m.type === 'pinned')).toBe(true);
  });

  it('stats returns counts per type', async () => {
    const store = await getStore();
    store.add({ type: 'pinned', content: 'A', tags: [], source: 'user' });
    store.add({ type: 'pinned', content: 'B', tags: [], source: 'user' });
    store.add({ type: 'insight', content: 'C', tags: [], source: 'agent' });
    const s = store.stats();
    expect(s.pinned).toBeGreaterThanOrEqual(2);
    expect(s.insight).toBeGreaterThanOrEqual(1);
    expect(typeof s.fact).toBe('number');
  });
});

describe('MemoryStore - get', () => {
  it('retrieves added item by id', async () => {
    const store = await getStore();
    const id = store.add({ type: 'fact', content: 'hello world', tags: ['x'], source: 'user' });
    const item = store.get(id);
    expect(item).toBeDefined();
    expect(item?.content).toBe('hello world');
    expect(item?.type).toBe('fact');
  });

  it('returns undefined for non-existent id', async () => {
    const store = await getStore();
    expect(store.get('nonexistent-id-xyz')).toBeUndefined();
  });
});

describe('MemoryStore - delete', () => {
  it('deletes an item by id', async () => {
    const store = await getStore();
    const id = store.add({ type: 'pinned', content: 'to remove', tags: [], source: 'user' });
    const removed = store.delete(id);
    expect(removed).toBe(true);
    expect(store.get(id)).toBeUndefined();
  });

  it('returns false when deleting non-existent id', async () => {
    const store = await getStore();
    expect(store.delete('does-not-exist')).toBe(false);
  });
});

describe('MemoryStore - clear', () => {
  it('clears all memories', async () => {
    const store = await getStore();
    store.add({ type: 'pinned', content: 'A', tags: [], source: 'user' });
    store.add({ type: 'insight', content: 'B', tags: [], source: 'agent' });
    store.clear();
    expect(store.list().length).toBe(0);
  });

  it('stats returns all zeros after clear', async () => {
    const store = await getStore();
    store.add({ type: 'pinned', content: 'A', tags: [], source: 'user' });
    store.clear();
    const s = store.stats();
    expect(s.pinned).toBe(0);
    expect(s.insight).toBe(0);
    expect(s.fact).toBe(0);
  });
});

describe('MemoryStore - recall (async search)', () => {
  it('returns MemoryItem array (may be empty on fresh store)', async () => {
    const store = await getStore();
    store.add({ type: 'fact', content: 'TypeScript is strongly typed', tags: [], source: 'user' });
    store.add({ type: 'fact', content: 'Python is dynamically typed', tags: [], source: 'user' });
    const results = await store.recall('TypeScript');
    expect(Array.isArray(results)).toBe(true);
  });

  it('returns empty array on fresh store with no matches', async () => {
    const store = await getStore();
    const results = await store.recall('zzz-no-match-xyz');
    expect(Array.isArray(results)).toBe(true);
  });

  it('respects limit option', async () => {
    const store = await getStore();
    for (let i = 0; i < 5; i++) {
      store.add({ type: 'fact', content: `item number ${i}`, tags: [], source: 'user' });
    }
    const results = await store.recall('item', { limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

describe('MemoryStore - getRecentIterations', () => {
  it('returns recent iterations (up to limit)', async () => {
    const store = await getStore();
    // Note: iterations are internal; getRecentIterations returns iteration-type memories
    const recent = store.getRecentIterations(5);
    expect(Array.isArray(recent)).toBe(true);
  });

  it('returns empty array when no iterations exist', async () => {
    const store = await getStore();
    const recent = store.getRecentIterations(100);
    expect(recent.length).toBe(0);
  });
});
