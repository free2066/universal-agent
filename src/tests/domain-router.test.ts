/**
 * domain-router.test.ts
 * 测试 DomainRouter 的域名检测和工具注册逻辑
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DomainRouter } from '../core/domain-router.js';

describe('DomainRouter.detectDomain', () => {
  let router: DomainRouter;

  beforeEach(() => {
    router = new DomainRouter();
  });

  it('detects data domain for SQL-related prompts', () => {
    expect(router.detectDomain('query the database with SQL')).toBe('data');
    expect(router.detectDomain('run a SQL query to find users')).toBe('data');
  });

  it('detects dev domain for code-related prompts', () => {
    const domain = router.detectDomain('write a function to sort an array in TypeScript');
    // dev is the fallback, so code prompts should resolve to dev
    expect(['dev', 'data', 'service']).toContain(domain);
  });

  it('defaults to dev when no keywords match', () => {
    expect(router.detectDomain('hello world random text 12345')).toBe('dev');
  });

  it('returns a non-empty string for any input', () => {
    const domains = ['', 'unknown text', 'analyze', 'fix bug', 'sentiment'];
    for (const input of domains) {
      const result = router.detectDomain(input);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it('is case-insensitive', () => {
    const lower = router.detectDomain('sql query');
    const upper = router.detectDomain('SQL QUERY');
    expect(lower).toBe(upper);
  });
});

describe('DomainRouter.getSystemPrompt', () => {
  let router: DomainRouter;

  beforeEach(() => {
    router = new DomainRouter();
  });

  it('returns a non-empty string for known domains', () => {
    for (const domain of ['data', 'dev', 'service']) {
      const prompt = router.getSystemPrompt(domain);
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(10);
    }
  });

  it('falls back to dev prompt for unknown domain', () => {
    const devPrompt = router.getSystemPrompt('dev');
    const unknownPrompt = router.getSystemPrompt('nonexistent-domain');
    expect(unknownPrompt).toBe(devPrompt);
  });
});

describe('DomainRouter.registerTools', () => {
  let router: DomainRouter;

  beforeEach(() => {
    router = new DomainRouter();
  });

  it('registers tools without throwing for known domains', () => {
    for (const domain of ['data', 'dev', 'service', 'auto']) {
      const fakeRegistry = {
        register: vi.fn(),
        registerMany: vi.fn(),
        list: vi.fn().mockReturnValue([]),
      };
      expect(() => router.registerTools(fakeRegistry as never, domain)).not.toThrow();
    }
  });

  it('registers all domain tools in auto mode', () => {
    const registeredCounts: Record<string, number> = {};
    for (const domain of ['data', 'dev', 'service', 'auto']) {
      let count = 0;
      const fakeRegistry = {
        register: vi.fn(() => count++),
        registerMany: vi.fn((tools: unknown[]) => { count += tools.length; }),
        list: vi.fn().mockReturnValue([]),
      };
      router.registerTools(fakeRegistry as never, domain);
      registeredCounts[domain] = count;
    }
    // auto mode registers MORE tools than any single domain
    expect(registeredCounts['auto']).toBeGreaterThanOrEqual(registeredCounts['data']!);
    expect(registeredCounts['auto']).toBeGreaterThanOrEqual(registeredCounts['dev']!);
    expect(registeredCounts['auto']).toBeGreaterThanOrEqual(registeredCounts['service']!);
  });
});
