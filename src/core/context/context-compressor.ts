/**
 * Context Auto-Compactor
 *
 * Upgraded from basic LLM summarization to a Claude Code-inspired 9-chapter
 * structured summary with a circuit breaker (kstack article #15375).
 *
 * Key improvements over original:
 *   1. 9-chapter structured summary — preserves all critical info across compact
 *   2. Circuit breaker — stops after 3 consecutive failures to avoid wasting LLM calls
 *      (Claude Code data: 1,279 sessions had 50+ consecutive failures, wasting ~250K API calls/day)
 *   3. Anti-recursion guard — compact calls from within compact are rejected
 *   4. Tool/user message pairing protection — never splits a tool_use/tool_result pair
 *   5. Smarter keep window — always keeps at least 6 recent turns after compaction
 */

import type { Message } from '../../models/types.js';
import { modelManager } from '../../models/model-manager.js';

/** Fraction of context window that triggers compaction */
const COMPACT_THRESHOLD = 0.75;

/** Always keep at least this many recent turns intact */
const KEEP_LAST_TURNS = 6;

/**
 * Circuit breaker: max consecutive autocompact failures per session.
 * After this many failures, stop attempting autocompact for the rest of the session.
 * Inspired by Claude Code's MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3 pattern.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

/** Session-level circuit breaker state */
let consecutiveFailures = 0;
let circuitOpen = false;

/**
 * Anti-recursion guard: compact calls triggered from within compact are rejected.
 * Prevents recursive deadlock when the compact LLM call itself triggers another compact.
 */
let isCompacting = false;

/** Reset circuit breaker (called at session start / manually) */
export function resetCompactCircuitBreaker(): void {
  consecutiveFailures = 0;
  circuitOpen = false;
}

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
  // 2.0 is a more accurate midpoint (confirmed via GPT tokenizer on Chinese text)
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

// ── 9-Chapter Structured Summary ─────────────────────────────────────────────

/**
 * System prompt for 9-chapter structured summary.
 * Inspired by Claude Code's autoCompact prompt structure (kstack #15375).
 *
 * The 9 chapters ensure all critical information survives compaction:
 * 1. Primary Request / Intent
 * 2. Key Technical Concepts
 * 3. Files and Code sections
 * 4. Errors and Fixes
 * 5. Problem Solving approach
 * 6. All User Messages (verbatim)
 * 7. Pending Tasks
 * 8. Current Work
 * 9. Optional Next Step
 */
const COMPACT_SYSTEM =
  'You are a conversation summarizer for an AI coding assistant session. ' +
  'Given a list of conversation turns, produce a structured summary using EXACTLY these 9 chapters. ' +
  'Be dense, factual, and preserve ALL important decisions, file edits, tool results, and conclusions. ' +
  'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools. Tool calls will be REJECTED.\n\n' +
  'Output format:\n' +
  '<summary>\n' +
  '## 1. Primary Request and Intent\n' +
  '[What the user originally asked for and the overall goal]\n\n' +
  '## 2. Key Technical Concepts\n' +
  '[Languages, frameworks, patterns, architectures discussed]\n\n' +
  '## 3. Files and Code\n' +
  '[Specific files read/edited, functions modified, code snippets]\n\n' +
  '## 4. Errors and Fixes\n' +
  '[Errors encountered and how they were resolved]\n\n' +
  '## 5. Problem Solving\n' +
  '[Approaches tried, decisions made, trade-offs]\n\n' +
  '## 6. All User Messages\n' +
  '[Verbatim list of every user message — do NOT summarize or omit any]\n\n' +
  '## 7. Pending Tasks\n' +
  '[Incomplete work, TODO items, blocked items]\n\n' +
  '## 8. Current Work\n' +
  '[The most recent thing being worked on, last state]\n\n' +
  '## 9. Optional Next Step\n' +
  '[What should happen next, if clear from context]\n' +
  '</summary>';

/** Max chars to include from a single tool result in the compaction prompt */
const MAX_TOOL_RESULT_CHARS = 1500;

/**
 * Serialize history turns for the compaction prompt.
 * Long tool results are truncated to prevent the summary prompt itself from
 * exceeding context limits on large grep/read outputs.
 */
function serializeTurns(turns: Message[]): string {
  return turns
    .map((m) => {
      if (m.role === 'tool') {
        const content = m.content.length > MAX_TOOL_RESULT_CHARS
          ? m.content.slice(0, MAX_TOOL_RESULT_CHARS) + `\n...(truncated, ${m.content.length - MAX_TOOL_RESULT_CHARS} chars omitted)`
          : m.content;
        return `[Tool result id=${m.toolCallId}]\n${content}`;
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
 * Find a safe split point that doesn't break tool_use/tool_result pairs.
 * Returns the largest index ≤ `targetIdx` where splitting is safe.
 *
 * A split is UNSAFE if:
 * - The message at `targetIdx` is a tool result (role === 'tool')
 * - The message at `targetIdx - 1` has toolCalls but the result is after `targetIdx`
 *
 * This prevents invalid histories where an assistant tool_call has no matching result.
 */
function findSafeSplitPoint(history: Message[], targetIdx: number): number {
  let idx = targetIdx;
  // Walk backward until we find a safe boundary
  while (idx > 0) {
    const msg = history[idx];
    // A 'tool' role message must come after its matching assistant message
    if (msg?.role === 'tool') {
      idx--;
      continue;
    }
    // An assistant message with toolCalls must be followed by all its results
    if (msg?.role === 'assistant' && msg.toolCalls?.length) {
      // Check if all tool results are within [0, idx]
      const callIds = new Set(msg.toolCalls.map((tc) => tc.id));
      let allResultsBeforeIdx = true;
      for (let i = idx + 1; i < history.length; i++) {
        if (history[i].role === 'tool' && history[i].toolCallId) {
          if (callIds.has(history[i].toolCallId!)) {
            if (i > targetIdx) {
              allResultsBeforeIdx = false;
              break;
            }
          }
        }
      }
      if (!allResultsBeforeIdx) {
        idx--;
        continue;
      }
    }
    break;
  }
  return idx;
}

/**
 * Auto-compact the history in-place.
 * Returns the number of turns that were compacted (0 if nothing happened).
 *
 * Improvements over original:
 * - Circuit breaker: stops after 3 consecutive failures
 * - Anti-recursion guard: rejects compact calls from within compact
 * - Tool pair safety: never splits assistant tool_call / tool result pairs
 * - 9-chapter structured summary for better context preservation
 */
export async function autoCompact(
  history: Message[],
  onProgress?: (msg: string) => void,
): Promise<number> {
  // ── Circuit breaker ──────────────────────────────────────────────────────
  if (circuitOpen) {
    // Don't spam the user — only log at debug level
    return 0;
  }

  // ── Anti-recursion guard ─────────────────────────────────────────────────
  // Prevents recursive deadlock: if compact is called while already compacting
  // (e.g. the compact LLM call itself triggers another compact), reject silently.
  if (isCompacting) return 0;

  const decision = shouldCompact(history);
  if (!decision.shouldCompact) return 0;

  // Split: keep the last KEEP_LAST_TURNS, compact the rest
  const targetSplit = history.length - KEEP_LAST_TURNS;
  if (targetSplit <= 0) return 0;

  // Find safe split point that doesn't break tool pairs
  const safeSplit = findSafeSplitPoint(history, targetSplit);
  if (safeSplit <= 0) return 0;

  const toCompact = history.slice(0, safeSplit);
  const toKeep = history.slice(safeSplit);

  if (toCompact.length === 0) return 0;

  onProgress?.(
    `\n🗜️  Auto-compact: ${decision.estimatedTokens.toLocaleString()} tokens` +
    ` > threshold ${decision.threshold.toLocaleString()} — summarizing ${toCompact.length} turns…\n`,
  );

  const serialized = serializeTurns(toCompact);
  const summaryPrompt =
    'Please summarize the following conversation turns using the 9-chapter format:\n\n' +
    serialized;

  let summary = '';
  isCompacting = true;
  try {
    const client = modelManager.getClient('quick');
    const response = await client.chat({
      systemPrompt: COMPACT_SYSTEM,
      messages: [{ role: 'user', content: summaryPrompt }],
      tools: [],
    });
    summary = response.content;

    // Success — reset failure counter
    consecutiveFailures = 0;
  } catch (err) {
    // ── Circuit breaker update ──────────────────────────────────────────────
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      circuitOpen = true;
      onProgress?.(
        `\n⚡ Auto-compact circuit breaker opened after ${consecutiveFailures} consecutive failures — ` +
        `stopping compact attempts for this session to avoid wasting API calls.\n`,
      );
    } else {
      onProgress?.(
        `\n⚠️  Auto-compact failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    return 0;
  } finally {
    isCompacting = false;
  }

  // Replace history in-place
  const summaryMessage: Message = {
    role: 'user',
    content:
      `[Context summary — ${toCompact.length} earlier turns compressed using 9-chapter structure]\n\n` +
      summary,
  };

  history.splice(0, history.length, summaryMessage, ...toKeep);

  onProgress?.(
    `\n✅  Compacted ${toCompact.length} turns → 1 structured summary (9 chapters).\n`,
  );

  return toCompact.length;
}
