/**
 * Context Auto-Compactor
 *
 * Inspired by claude-code's services/compact/autoCompact.ts
 *
 * When the conversation history grows beyond a threshold (fraction of model
 * context window), automatically summarize older turns to free up tokens.
 * Strategy:
 *   1. Estimate current token usage (chars / 4 heuristic, JSON = chars / 2)
 *   2. If usage > COMPACT_THRESHOLD * contextLength → trigger compact
 *   3. Use the "quick" model pointer (cheap/fast) to produce a summary of all
 *      turns except the most recent KEEP_LAST turns
 *   4. Replace the compacted turns with a single "summary" user message
 */

import type { Message } from '../models/types.js';
import { modelManager } from '../models/model-manager.js';

/** Fraction of context window that triggers compaction */
const COMPACT_THRESHOLD = 0.75;

/** Always keep at least this many recent turns intact */
const KEEP_LAST_TURNS = 6;

/** System prompt used for the compaction LLM call */
const COMPACT_SYSTEM =
  'You are a conversation summarizer. Given a list of conversation turns, ' +
  'produce a dense, factual summary that preserves all important decisions, ' +
  'file edits, tool results, and conclusions. ' +
  'Output only the summary text, no meta-commentary.';

// ── Token estimation ──────────────────────────────────────────────────────────

/**
 * Rough token estimate from a string.
 *
 * Accounts for non-Latin scripts (CJK, Arabic, etc.) which typically encode
 * as 1-2 chars per token rather than the 4-chars-per-token Latin heuristic.
 * Without this correction, a conversation in Chinese would be estimated at
 * ~4× fewer tokens than reality, causing missed compaction triggers.
 *
 * Heuristic:
 *   - CJK / full-width / emoji codepoints  → 1.5 chars/token  (divisor 1.5)
 *   - Latin + JSON                          → 2 chars/token    (divisor 2)
 *   - Latin text                            → 4 chars/token    (divisor 4)
 */
function estimateTokens(text: string, isJson = false): number {
  if (!text) return 0;
  // Count non-ASCII characters that are likely to be CJK/Arabic/etc.
  // Unicode ranges: CJK Unified (4E00-9FFF), CJK Extension A (3400-4DBF),
  // Hangul (AC00-D7AF), Arabic (0600-06FF), etc.
  const nonLatinCount = (text.match(/[\u0600-\u06FF\u0900-\u097F\u3000-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/g) ?? []).length;
  const nonLatinRatio = nonLatinCount / Math.max(text.length, 1);

  // Weighted divisor: blend Latin divisor and non-Latin divisor
  const latinDivisor = isJson ? 2 : 4;
  // CJK characters are typically 1.5–2.5 chars/token in most tokenizers (mean ~2.0).
  // Using 1.5 over-estimates tokens → compaction triggers too early → wastes LLM calls.
  // 2.0 is a more accurate midpoint (confirmed via GPT tokenizer on Chinese text).
  const nonLatinDivisor = 2.0;
  const effectiveDivisor = latinDivisor * (1 - nonLatinRatio) + nonLatinDivisor * nonLatinRatio;

  return Math.ceil(text.length / effectiveDivisor);
}

// Export estimateMessageTokens so context-editor.ts can reuse it (avoids duplicating the CJK correction logic)
export function estimateMessageTokens(msg: Message): number {
  const contentTokens = estimateTokens(msg.content, msg.role === 'tool');
  const toolCallTokens = msg.toolCalls
    ? msg.toolCalls.reduce(
        (sum, tc) => sum + estimateTokens(JSON.stringify(tc.arguments), true) + 10,
        0,
      )
    : 0;
  return contentTokens + toolCallTokens + 4; // role overhead
}

export function estimateHistoryTokens(history: Message[]): number {
  return history.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

// ── Compact decision ──────────────────────────────────────────────────────────

export interface CompactDecision {
  shouldCompact: boolean;
  estimatedTokens: number;
  contextLength: number;
  threshold: number;
}

export function shouldCompact(
  history: Message[],
  model = modelManager.getCurrentModel('main'),
): CompactDecision {
  const profile = [...modelManager.listProfiles()].find(
    (p) => p.name === model || p.modelName === model,
  );
  const contextLength = profile?.contextLength ?? 128000;
  const threshold = Math.floor(contextLength * COMPACT_THRESHOLD);
  const estimatedTokens = estimateHistoryTokens(history);

  return {
    shouldCompact: estimatedTokens > threshold,
    estimatedTokens,
    contextLength,
    threshold,
  };
}

// ── Compaction ────────────────────────────────────────────────────────────────

/**
 * Serialize history turns for the compaction prompt.
 */
function serializeTurns(turns: Message[]): string {
  return turns
    .map((m) => {
      if (m.role === 'tool') {
        return `[Tool result id=${m.toolCallId}]\n${m.content}`;
      }
      if (m.toolCalls?.length) {
        const calls = m.toolCalls
          .map((tc) => `  ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 200)})`)
          .join('\n');
        return `[${m.role}]\n${m.content || ''}\n[Tool calls]\n${calls}`;
      }
      return `[${m.role}]\n${m.content}`;
    })
    .join('\n\n---\n\n');
}

/**
 * Auto-compact the history in-place.
 * Returns the number of turns that were compacted (0 if nothing happened).
 */
export async function autoCompact(
  history: Message[],
  onProgress?: (msg: string) => void,
): Promise<number> {
  const decision = shouldCompact(history);
  if (!decision.shouldCompact) return 0;

  // Split: keep the last KEEP_LAST_TURNS, compact the rest
  const keepCount = Math.min(KEEP_LAST_TURNS, history.length);
  const toCompact = history.slice(0, history.length - keepCount);
  const toKeep = history.slice(history.length - keepCount);

  if (toCompact.length === 0) return 0;

  onProgress?.(
    `\n🗜️  Auto-compact: ${decision.estimatedTokens.toLocaleString()} tokens` +
    ` > threshold ${decision.threshold.toLocaleString()} — summarizing ${toCompact.length} turns…\n`,
  );

  const serialized = serializeTurns(toCompact);
  const summaryPrompt =
    'Please summarize the following conversation turns concisely:\n\n' +
    serialized;

  let summary = '';
  try {
    const client = modelManager.getClient('quick');
    const response = await client.chat({
      systemPrompt: COMPACT_SYSTEM,
      messages: [{ role: 'user', content: summaryPrompt }],
      tools: [],
    });
    summary = response.content;
  } catch (err) {
    // Compact failed — leave history untouched, just warn
    onProgress?.(
      `\n⚠️  Auto-compact failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 0;
  }

  // Replace history in-place
  const summaryMessage: Message = {
    role: 'user',
    content:
      `[Context summary — ${toCompact.length} earlier turns compressed]\n\n` +
      summary,
  };

  history.splice(0, history.length, summaryMessage, ...toKeep);

  onProgress?.(
    `\n✅  Compacted ${toCompact.length} turns → 1 summary message.\n`,
  );

  return toCompact.length;
}
