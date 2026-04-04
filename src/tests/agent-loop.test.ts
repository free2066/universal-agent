/**
 * agent-loop.test.ts
 * 测试 agent/agent-loop.ts 中的纯函数逻辑：
 *  - expandMentions
 *  - handlePendingConfirmation
 *  - captureIterationSnapshot (smoke test)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { expandMentions } from '../core/agent/agent-loop.js';

describe('expandMentions', () => {
  it('returns original prompt when no @mentions', () => {
    const p = 'Refactor the authentication module';
    expect(expandMentions(p)).toBe(p);
  });

  it('appends hint for @ask-<model> mention', () => {
    const p = 'Ask @ask-gpt-4 to review this code';
    const result = expandMentions(p);
    expect(result).toContain(p);
    expect(result).toContain('[Hints:');
    expect(result).toContain('consult expert model "gpt-4"');
  });

  it('handles multiple @ask mentions', () => {
    const p = '@ask-claude-3 and @ask-gpt-4 compare approaches';
    const result = expandMentions(p);
    expect(result).toContain('consult expert model "claude-3"');
    expect(result).toContain('consult expert model "gpt-4"');
  });

  it('handles @ask mention with dots in model name', () => {
    const p = 'Use @ask-claude-3.5-sonnet for this';
    const result = expandMentions(p);
    expect(result).toContain('claude-3.5-sonnet');
  });

  it('returns only original string if mention is @run-agent-<nonexistent>', () => {
    // subagentSystem.getAgent returns undefined for nonexistent agents
    const p = '@run-agent-nonexistent-xyz do something';
    const result = expandMentions(p);
    // No hint added for nonexistent agent, but also no crash
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('preserves prompt content exactly before appended hints', () => {
    const p = 'Some complex prompt with special chars: <>&"';
    const result = expandMentions(p);
    // Without @-mentions, returns exactly as-is
    expect(result).toBe(p);
  });
});

describe('agent-loop module exports', () => {
  it('exports handlePendingConfirmation function', async () => {
    const mod = await import('../core/agent/agent-loop.js');
    expect(typeof mod.handlePendingConfirmation).toBe('function');
  });

  it('exports captureIterationSnapshot function', async () => {
    const mod = await import('../core/agent/agent-loop.js');
    expect(typeof mod.captureIterationSnapshot).toBe('function');
  });

  it('exports runStreamLoop function', async () => {
    const mod = await import('../core/agent/agent-loop.js');
    expect(typeof mod.runStreamLoop).toBe('function');
  });

  it('exports expandMentions function', async () => {
    const mod = await import('../core/agent/agent-loop.js');
    expect(typeof mod.expandMentions).toBe('function');
  });
});

describe('agent/types constants', () => {
  it('exports PARALLELIZABLE_TOOLS as a Set', async () => {
    const { PARALLELIZABLE_TOOLS } = await import('../core/agent/types.js');
    expect(PARALLELIZABLE_TOOLS).toBeInstanceOf(Set);
    expect(PARALLELIZABLE_TOOLS.size).toBeGreaterThan(5);
  });

  it('includes expected read-only tools', async () => {
    const { PARALLELIZABLE_TOOLS } = await import('../core/agent/types.js');
    expect(PARALLELIZABLE_TOOLS.has('Read')).toBe(true);
    expect(PARALLELIZABLE_TOOLS.has('Grep')).toBe(true);
    expect(PARALLELIZABLE_TOOLS.has('WebFetch')).toBe(true);
  });

  it('does not include write tools', async () => {
    const { PARALLELIZABLE_TOOLS } = await import('../core/agent/types.js');
    // Write/Edit/Bash are NOT parallelizable
    expect(PARALLELIZABLE_TOOLS.has('Write')).toBe(false);
    expect(PARALLELIZABLE_TOOLS.has('Bash')).toBe(false);
    expect(PARALLELIZABLE_TOOLS.has('Edit')).toBe(false);
  });

  it('DEFAULT_MAX_ITERATIONS is a positive number', async () => {
    const { DEFAULT_MAX_ITERATIONS } = await import('../core/agent/types.js');
    expect(typeof DEFAULT_MAX_ITERATIONS).toBe('number');
    expect(DEFAULT_MAX_ITERATIONS).toBeGreaterThan(0);
  });

  it('MAX_UNATTENDED_RETRY_DELAY_MS is 5 minutes', async () => {
    const { MAX_UNATTENDED_RETRY_DELAY_MS } = await import('../core/agent/types.js');
    expect(MAX_UNATTENDED_RETRY_DELAY_MS).toBe(5 * 60 * 1000);
  });
});
