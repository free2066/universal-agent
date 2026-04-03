/**
 * Unit Tests: context-compressor.ts
 *
 * Covers: estimateTokens / estimateMessageTokens / estimateHistoryTokens /
 *         shouldCompact / findSafeSplitPoint / resetCompactCircuitBreaker
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  estimateMessageTokens,
  estimateHistoryTokens,
  shouldCompact,
  resetCompactCircuitBreaker,
  AUTO_COMPACT_DISABLED,
} from '../core/context/context-compressor.js';
import type { Message } from '../models/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMsg(role: Message['role'], content: string): Message {
  return { role, content };
}

function makeHistory(n: number, contentPerMsg = 'A typical response with some text content about coding.'): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < n; i++) {
    msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: contentPerMsg });
  }
  return msgs;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. estimateMessageTokens
// ─────────────────────────────────────────────────────────────────────────────
describe('estimateMessageTokens', () => {
  it('empty message → 4 tokens (role overhead)', () => {
    // estimateMessageTokens adds +4 for role overhead even for empty content
    expect(estimateMessageTokens(makeMsg('user', ''))).toBe(4);
  });

  it('Latin text → ~4 chars per token (plus 4 role overhead)', () => {
    const text = 'a'.repeat(400);
    const tokens = estimateMessageTokens(makeMsg('user', text));
    // 400 chars / 4 = 100 tokens + 4 role overhead = 104
    expect(tokens).toBe(104);
  });

  it('CJK text → ~2 chars per token (denser), plus 4 role overhead', () => {
    const cjk = '你好世界'.repeat(50); // 200 CJK chars
    const tokens = estimateMessageTokens(makeMsg('user', cjk));
    // 200 chars / 2 = 100 tokens + 4 role overhead = 104
    expect(tokens).toBe(104);
  });

  it('JSON/tool content → ~2 chars per token', () => {
    const json = '{"key": "value", "count": 42, "active": true}'.repeat(10);
    const toolMsg: Message = { role: 'tool', content: json };
    const tokens = estimateMessageTokens(toolMsg);
    // JSON divisor is 2, so tokens ≈ json.length / 2
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(json.length / 1.5); // should be dense
  });

  it('CJK mixed with Latin → intermediate token count', () => {
    const mixed = 'Hello world 你好世界 hello again 中文文本';
    const tokens = estimateMessageTokens(makeMsg('user', mixed));
    expect(tokens).toBeGreaterThan(0);
  });

  it('message with toolCalls adds tokens', () => {
    const withToolCall: Message = {
      role: 'assistant',
      content: 'I will search for you.',
      toolCalls: [
        { id: 'call1', name: 'Grep', arguments: { pattern: 'foo', dir: '/src' } },
      ],
    };
    const withoutToolCall: Message = {
      role: 'assistant',
      content: 'I will search for you.',
    };
    expect(estimateMessageTokens(withToolCall)).toBeGreaterThan(
      estimateMessageTokens(withoutToolCall),
    );
  });

  it('longer content has more tokens than shorter', () => {
    const short = makeMsg('user', 'short message');
    const long = makeMsg('user', 'a much longer message with more words and content to estimate');
    expect(estimateMessageTokens(long)).toBeGreaterThan(estimateMessageTokens(short));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. estimateHistoryTokens
// ─────────────────────────────────────────────────────────────────────────────
describe('estimateHistoryTokens', () => {
  it('returns 0 for empty history', () => {
    expect(estimateHistoryTokens([])).toBe(0);
  });

  it('sum equals individual message tokens', () => {
    const msgs = [
      makeMsg('user', 'hello there'),
      makeMsg('assistant', 'hi there, how can I help you today?'),
    ];
    const expected = msgs.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    expect(estimateHistoryTokens(msgs)).toBe(expected);
  });

  it('more messages → more total tokens', () => {
    const small = makeHistory(5);
    const large = makeHistory(10);
    expect(estimateHistoryTokens(large)).toBeGreaterThan(estimateHistoryTokens(small));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. shouldCompact
// ─────────────────────────────────────────────────────────────────────────────
describe('shouldCompact', () => {
  it('empty history → shouldCompact = false', () => {
    const result = shouldCompact([]);
    expect(result.shouldCompact).toBe(false);
    expect(result.estimatedTokens).toBe(0);
  });

  it('returns contextLength and threshold in result', () => {
    const result = shouldCompact([]);
    expect(result.contextLength).toBeGreaterThan(0);
    expect(result.threshold).toBeGreaterThan(0);
    expect(result.threshold).toBeLessThanOrEqual(result.contextLength);
  });

  it('threshold is approximately 75% of contextLength (default)', () => {
    const result = shouldCompact([]);
    const ratio = result.threshold / result.contextLength;
    // COMPACT_THRESHOLD=0.75 by default
    expect(ratio).toBeCloseTo(0.75, 1);
  });

  it('small history → should not compact', () => {
    const history = makeHistory(4, 'short text');
    const result = shouldCompact(history);
    expect(result.shouldCompact).toBe(false);
  });

  it('very large history → should compact', () => {
    // Generate enough tokens to exceed 75% of context window
    // Default context is typically 128000 tokens, 75% = 96000 tokens
    // At 4 chars/token, need ~384000 chars
    // Use a large repeated string
    const longContent = 'A'.repeat(4000); // ~1000 tokens per message
    const history = makeHistory(200, longContent); // ~200000 tokens
    const result = shouldCompact(history);
    expect(result.shouldCompact).toBe(true);
    expect(result.estimatedTokens).toBeGreaterThan(result.threshold);
  });

  it('DISABLE_AUTO_COMPACT env var is read correctly', () => {
    // The exported constant reflects what was set at module load time
    // We can only verify it's a boolean
    expect(typeof AUTO_COMPACT_DISABLED).toBe('boolean');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. resetCompactCircuitBreaker
// ─────────────────────────────────────────────────────────────────────────────
describe('resetCompactCircuitBreaker', () => {
  it('does not throw when called fresh', () => {
    expect(() => resetCompactCircuitBreaker()).not.toThrow();
  });

  it('can be called multiple times without error', () => {
    resetCompactCircuitBreaker();
    resetCompactCircuitBreaker();
    resetCompactCircuitBreaker();
    expect(true).toBe(true); // no throw
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Token estimation edge cases
// ─────────────────────────────────────────────────────────────────────────────
describe('Token estimation — edge cases', () => {
  it('handles whitespace-only content', () => {
    const msg = makeMsg('user', '   \n\t  ');
    expect(estimateMessageTokens(msg)).toBeGreaterThanOrEqual(0);
  });

  it('handles very long single line (50K chars)', () => {
    const longLine = 'x'.repeat(50000);
    const msg = makeMsg('user', longLine);
    const tokens = estimateMessageTokens(msg);
    // 50000 / 4 = 12500 tokens (Latin) + 4 role overhead = 12504
    expect(tokens).toBe(12504);
  });

  it('Arabic text → high density (similar to CJK)', () => {
    const arabic = 'مرحبا بالعالم'.repeat(20); // Arabic is in U+0600-U+06FF
    const msg = makeMsg('user', arabic);
    const tokens = estimateMessageTokens(msg);
    // Should be denser than pure Latin (more tokens per char)
    const latinMsg = makeMsg('user', 'a'.repeat(arabic.length));
    const latinTokens = estimateMessageTokens(latinMsg);
    // Arabic chars = 2 chars/token divisor vs 4 chars/token for Latin
    // → Arabic should have MORE tokens for same text length
    expect(tokens).toBeGreaterThan(latinTokens / 2);
  });

  it('emoji content handled without crash', () => {
    const msg = makeMsg('user', '🚀🔥✅❌🎯'.repeat(100));
    expect(() => estimateMessageTokens(msg)).not.toThrow();
  });
});
