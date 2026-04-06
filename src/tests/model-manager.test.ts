/**
 * model-manager.test.ts
 * 测试 ModelManager 类的核心方法（不发网络请求，不写磁盘）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock file system to prevent disk reads/writes during tests
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),    // no disk config
    readFileSync: actual.readFileSync,              // allow reading package.json etc.
    writeFileSync: vi.fn(),                         // prevent disk writes
    mkdirSync: vi.fn(),                             // prevent dir creation
  };
});

// Import AFTER mocking
const { ModelManager } = await import('../models/model-manager.js');

describe('ModelManager - listProfiles', () => {
  let manager: InstanceType<typeof ModelManager>;

  beforeEach(() => {
    manager = new (ModelManager as new () => InstanceType<typeof ModelManager>)();
  });

  it('returns a non-empty array of profiles', () => {
    const profiles = manager.listProfiles();
    expect(profiles.length).toBeGreaterThan(10);
  });

  it('includes gpt-4o profile', () => {
    const profiles = manager.listProfiles();
    const gpt4o = profiles.find(p => p.name === 'gpt-4o');
    expect(gpt4o).toBeDefined();
    expect(gpt4o?.provider).toBe('openai');
  });

  it('includes claude-3-5-sonnet profile', () => {
    const profiles = manager.listProfiles();
    expect(profiles.some(p => p.name === 'claude-3-5-sonnet')).toBe(true);
  });

  it('includes gemini profiles', () => {
    const profiles = manager.listProfiles();
    expect(profiles.some(p => p.provider === 'gemini')).toBe(true);
  });

  it('all profiles have required fields', () => {
    for (const p of manager.listProfiles()) {
      expect(typeof p.name).toBe('string');
      expect(typeof p.provider).toBe('string');
      expect(typeof p.modelName).toBe('string');
      expect(typeof p.contextLength).toBe('number');
      expect(p.contextLength).toBeGreaterThan(0);
    }
  });
});

describe('ModelManager - getCurrentModel', () => {
  let manager: InstanceType<typeof ModelManager>;

  beforeEach(() => {
    manager = new (ModelManager as new () => InstanceType<typeof ModelManager>)();
  });

  it('returns a non-empty string for main', () => {
    const model = manager.getCurrentModel('main');
    expect(typeof model).toBe('string');
    expect(model.length).toBeGreaterThan(0);
  });

  it('returns same pointer for all valid pointer keys', () => {
    for (const key of ['main', 'task', 'compact', 'quick'] as const) {
      const model = manager.getCurrentModel(key);
      expect(typeof model).toBe('string');
    }
  });
});

describe('ModelManager - setPointer', () => {
  let manager: InstanceType<typeof ModelManager>;

  beforeEach(() => {
    manager = new (ModelManager as new () => InstanceType<typeof ModelManager>)();
  });

  it('updates main model pointer', () => {
    manager.setPointer('main', 'gpt-4o');
    expect(manager.getCurrentModel('main')).toBe('gpt-4o');
  });

  it('updates task model pointer', () => {
    manager.setPointer('task', 'gpt-4o-mini');
    expect(manager.getCurrentModel('task')).toBe('gpt-4o-mini');
  });

  it('creates a profile for unknown models', () => {
    manager.setPointer('main', 'some-new-model');
    const profiles = manager.listProfiles();
    expect(profiles.some(p => p.name === 'some-new-model')).toBe(true);
  });
});

describe('ModelManager - getPointers', () => {
  let manager: InstanceType<typeof ModelManager>;

  beforeEach(() => {
    manager = new (ModelManager as new () => InstanceType<typeof ModelManager>)();
  });

  it('returns object with main/task/compact/quick keys', () => {
    const pointers = manager.getPointers();
    expect(pointers).toHaveProperty('main');
    expect(pointers).toHaveProperty('task');
    expect(pointers).toHaveProperty('compact');
    expect(pointers).toHaveProperty('quick');
  });

  it('all pointer values are non-empty strings', () => {
    const pointers = manager.getPointers();
    for (const v of Object.values(pointers)) {
      expect(typeof v).toBe('string');
      expect((v as string).length).toBeGreaterThan(0);
    }
  });
});

describe('ModelManager - trackUsage / getCostSummary', () => {
  let manager: InstanceType<typeof ModelManager>;

  beforeEach(() => {
    manager = new (ModelManager as new () => InstanceType<typeof ModelManager>)();
  });

  it('getCostSummary returns a non-empty string', () => {
    const summary = manager.getCostSummary();
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
  });

  it('recordUsage does not throw', () => {
    expect(() => manager.recordUsage({ inputTokens: 100, outputTokens: 50 }, 'gpt-4o')).not.toThrow();
  });

  it('getCostSummary reflects usage after recordUsage', () => {
    manager.recordUsage({ inputTokens: 1000, outputTokens: 500 }, 'gpt-4o');
    const summary = manager.getCostSummary();
    // Summary should mention tokens
    expect(summary).toMatch(/token|cost|Token|Cost/i);
  });

  it('recordUsage with cache tokens does not throw', () => {
    expect(() => manager.recordUsage({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 5000,
      cacheWriteTokens: 2000,
      webSearchRequests: 1,
    }, 'gpt-4o')).not.toThrow();
  });
});

describe('ModelManager - getClient', () => {
  let manager: InstanceType<typeof ModelManager>;

  beforeEach(() => {
    manager = new (ModelManager as new () => InstanceType<typeof ModelManager>)();
  });

  it('returns a client with chat/streamChat methods for main', () => {
    const client = manager.getClient('main');
    expect(typeof client.chat).toBe('function');
    expect(typeof client.streamChat).toBe('function');
  });

  it('returns a client for compact role', () => {
    const client = manager.getClient('compact');
    expect(typeof client.chat).toBe('function');
  });
});
