/**
 * Context Auto-Compactor — Claude Code 7-layer defence alignment
 *
 * Layers implemented here:
 *   Layer 5 (AutoCompact)  — LLM 9-chapter summary + circuit breaker + anti-recursion
 *   Layer 6 (Blocking)     — Hard stop when circuit open (no infinite loops)
 *
 * Layers in context-editor.ts:
 *   Layer 2 (Snip)         — Selective tool result clearing (editContextIfNeeded)
 *   Layer 3 (Microcompact) — Time-based stale tool result replacement (microcompact)
 *
 * Layer 7 (Reactive)       — 413/context-overflow emergency compact (reactiveCompact, in agent.ts)
 *
 * Environment overrides:
 *   DISABLE_AUTO_COMPACT=1          — Skip AutoCompact entirely (e.g. for CI)
 *   AGENT_COMPACT_PCT_OVERRIDE=0.6  — Override threshold fraction (default 0.75)
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import type { Message } from '../../models/types.js';
import { modelManager } from '../../models/model-manager.js';

// ── Environment overrides ──────────────────────────────────────────────────────

/** Set DISABLE_AUTO_COMPACT=1 to skip all LLM-based compaction (e.g. in CI or batch mode)
 *  or set `autoCompact: false` in .codeflicker/config.json */
export const AUTO_COMPACT_DISABLED = (() => {
  if (process.env.DISABLE_AUTO_COMPACT === '1') return true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadConfig } = require('../../cli/config-store.js') as typeof import('../../cli/config-store.js');
    return loadConfig().autoCompact === false;
  } catch { return false; }
})();

/**
 * Override the compaction threshold fraction via AGENT_COMPACT_PCT_OVERRIDE.
 * Values: 0.0–1.0. Default: 0.75.
 * Example: AGENT_COMPACT_PCT_OVERRIDE=0.6 triggers compact earlier (60% of context window).
 */
const COMPACT_THRESHOLD_OVERRIDE = (() => {
  const v = parseFloat(process.env.AGENT_COMPACT_PCT_OVERRIDE ?? '');
  if (!isNaN(v) && v > 0 && v <= 1.0) return v;
  return null;
})();

/** Fraction of context window that triggers compaction (default: 75%) */
const COMPACT_THRESHOLD = COMPACT_THRESHOLD_OVERRIDE ?? 0.75;

/** Always keep at least this many recent turns intact after compaction */
const KEEP_LAST_TURNS = 6;

/**
 * Circuit breaker: max consecutive autocompact failures per session.
 * After this many failures, stop attempting autocompact for the rest of the session.
 * Inspired by Claude Code's MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3 pattern.
 * (Production data: 1,279 sessions had 50+ consecutive failures, ~250K wasted API calls/day)
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
 *   - CJK / full-width / emoji codepoints  → 2.0 chars/token  (divisor 2.0)
 *   - Latin + JSON                          → 2.0 chars/token  (divisor 2)
 *   - Latin text                            → 4.0 chars/token  (divisor 4)
 */
function estimateTokens(text: string, isJson = false): number {
  if (!text) return 0;
  // Count non-Latin characters: CJK, Arabic, Devanagari, Korean, and emoji.
  // Emoji (U+1F300-U+1F9FF) live in the Supplementary Multilingual Plane and
  // each codepoint encodes to ~1-2 tokens but takes 2 UTF-16 code units (surrogate
  // pair). Without the /u flag + explicit SMP range, emojis would be counted as
  // latin chars (divisor 4) and their token count would be underestimated by ~4x,
  // potentially delaying compaction when users paste emoji-heavy content.
  const nonLatinCount = (
    text.match(/[\u0600-\u06FF\u0900-\u097F\u3000-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\u{1F300}-\u{1F9FF}]/gu) ?? []
  ).length;
  const nonLatinRatio = nonLatinCount / Math.max(text.length, 1);

  const latinDivisor = isJson ? 2 : 4;
  const nonLatinDivisor = 2.0;
  const effectiveDivisor = latinDivisor * (1 - nonLatinRatio) + nonLatinDivisor * nonLatinRatio;

  return Math.ceil(text.length / effectiveDivisor);
}

// Export estimateMessageTokens so context-editor.ts can reuse it
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
 */
function findSafeSplitPoint(history: Message[], targetIdx: number): number {
  let idx = targetIdx;
  while (idx > 0) {
    const msg = history[idx];
    if (msg?.role === 'tool') { idx--; continue; }
    if (msg?.role === 'assistant' && msg.toolCalls?.length) {
      const callIds = new Set(msg.toolCalls.map((tc) => tc.id));
      let allResultsBeforeIdx = true;
      for (let i = idx + 1; i < history.length; i++) {
        if (history[i].role === 'tool' && history[i].toolCallId) {
          if (callIds.has(history[i].toolCallId!) && i > targetIdx) {
            allResultsBeforeIdx = false;
            break;
          }
        }
      }
      if (!allResultsBeforeIdx) { idx--; continue; }
    }
    break;
  }
  return idx;
}

// ── Layer 5: AutoCompact ──────────────────────────────────────────────────────

/**
 * Auto-compact the history in-place using LLM 9-chapter summarization.
 * Returns the number of turns compacted (0 if nothing happened).
 *
 * Respects:
 *   DISABLE_AUTO_COMPACT=1          — skip entirely
 *   AGENT_COMPACT_PCT_OVERRIDE=0.x  — override threshold fraction
 */
export async function autoCompact(
  history: Message[],
  onProgress?: (msg: string) => void,
): Promise<number> {
  // Environment kill switch
  if (AUTO_COMPACT_DISABLED) return 0;

  // Circuit breaker — stop after MAX_CONSECUTIVE_FAILURES failures
  if (circuitOpen) return 0;

  // Anti-recursion guard
  if (isCompacting) return 0;

  const decision = shouldCompact(history);
  if (!decision.shouldCompact) return 0;

  const targetSplit = history.length - KEEP_LAST_TURNS;
  if (targetSplit <= 0) return 0;

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
  const summaryPrompt = 'Please summarize the following conversation turns using the 9-chapter format:\n\n' + serialized;

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
    consecutiveFailures = 0; // Reset on success
  } catch (err) {
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      circuitOpen = true;
      onProgress?.(
        `\n⚡ Auto-compact circuit breaker opened after ${consecutiveFailures} consecutive failures — ` +
        `stopping compact attempts for this session.\n`,
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

  const summaryMessage: Message = {
    role: 'user',
    content: `[Context summary — ${toCompact.length} earlier turns compressed using 9-chapter structure]\n\n` + summary,
  };

  history.splice(0, history.length, summaryMessage, ...toKeep);
  onProgress?.(`\n✅  Compacted ${toCompact.length} turns → 1 structured summary (9 chapters).\n`);

  // ── Post-Compact File Recovery (kstack #15375) ─────────────────────────────
  // After compacting, re-inject the most recently read files (up to 5 files,
  // each truncated to 5K tokens = 20K chars) so the agent doesn't lose
  // file context that was active just before compaction.
  //
  // Inspired by Claude Code's post-compact file re-injection:
  //   "压缩后自动恢复最多5个最近读取的文件 (每个5K tokens)"
  //
  // Algorithm:
  //   1. Scan the compacted turns for Read tool calls
  //   2. Collect unique file paths (newest first)
  //   3. For each file: read it from disk and inject as a system note
  // Non-blocking: file read failures are silently ignored.
  try {
    const MAX_RECOVERY_FILES = 5;
    const MAX_CHARS_PER_FILE = 5_000 * 4; // 5K tokens × 4 chars/token

    // Extract recently read file paths from compacted turns
    const readFilePaths: string[] = [];
    const seenPaths = new Set<string>();

    for (let i = toCompact.length - 1; i >= 0 && readFilePaths.length < MAX_RECOVERY_FILES; i--) {
      const msg = toCompact[i];
      if (msg.role !== 'assistant' || !msg.toolCalls?.length) continue;
      for (const tc of msg.toolCalls) {
        if (tc.name === 'Read' || tc.name === 'read_file' || tc.name === 'readFile') {
          const filePath = (tc.arguments.file_path ?? tc.arguments.path ?? tc.arguments.filePath) as string | undefined;
          if (filePath && typeof filePath === 'string' && !seenPaths.has(filePath)) {
            seenPaths.add(filePath);
            readFilePaths.push(filePath);
            if (readFilePaths.length >= MAX_RECOVERY_FILES) break;
          }
        }
      }
    }

    if (readFilePaths.length > 0) {
      const recoveryParts: string[] = [];
      const cwdResolved = resolve(process.cwd());
      for (const filePath of readFilePaths) {
        try {
          const absPath = resolve(cwdResolved, filePath);
          // CWE-22: reject path traversal attempts — recovered files must stay
          // within the current working directory. A filePath like '../../etc/passwd'
          // could otherwise escape to arbitrary locations on disk.
          if (!absPath.startsWith(cwdResolved + '/') && absPath !== cwdResolved) continue;
          if (!existsSync(absPath)) continue;
          const content = readFileSync(absPath, 'utf-8');
          const truncated = content.length > MAX_CHARS_PER_FILE
            ? content.slice(0, MAX_CHARS_PER_FILE) + `\n...(truncated at 5K token limit)`
            : content;
          recoveryParts.push(`### File: ${filePath}\n\`\`\`\n${truncated}\n\`\`\``);
        } catch { /* skip unreadable files */ }
      }

      if (recoveryParts.length > 0) {
        const recoveryMsg: Message = {
          role: 'user',
          content:
            `[Post-Compact File Recovery — restoring ${recoveryParts.length} recently read files]\n\n` +
            recoveryParts.join('\n\n'),
        };
        // Inject after the summary, before the kept tail
        history.splice(1, 0, recoveryMsg);
        onProgress?.(
          `\n📂 Post-compact file recovery: restored ${recoveryParts.length} file(s) to context.\n`
        );
      }
    }
  } catch { /* file recovery is non-fatal */ }

  return toCompact.length;
}

// ── Layer 7: Reactive Compact (emergency compaction on 413 / context overflow) ──

/**
 * Reactive compact: triggered when the LLM returns a 413 or context-overflow error.
 *
 * Strategy (Claude Code-inspired):
 *   1. Immediately try microcompact (zero LLM cost — replace stale tool results)
 *   2. If still over limit, do an emergency LLM compact with 50% retention target
 *   3. If compact also fails, throw to surface the error (no infinite retry)
 *
 * Returns true if recovery was successful, false if it could not recover.
 */
export async function reactiveCompact(
  history: Message[],
  onProgress?: (msg: string) => void,
): Promise<boolean> {
  onProgress?.('\n🚨 Context overflow detected — triggering reactive compact (Layer 7)…\n');

  // Step 1: Microcompact (zero cost, immediate)
  const { microcompact } = await import('./context-editor.js');
  const microdCleared = microcompact(history);
  if (microdCleared > 0) {
    onProgress?.(`  ✂️  Microcompact cleared ${microdCleared} stale tool results.\n`);
  }

  // Step 2: Check if that was enough
  const dec = shouldCompact(history);
  if (!dec.shouldCompact) {
    onProgress?.('  ✅ Context recovered via microcompact — no LLM call needed.\n');
    return true;
  }

  // Step 3: Emergency LLM compact — compress aggressively (keep only last 3 turns)
  const emergencySafeSplit = findSafeSplitPoint(history, Math.max(0, history.length - 3));
  if (emergencySafeSplit <= 0) {
    onProgress?.('  ⚠️  Cannot compact further — too few turns to split safely.\n');
    return false;
  }

  const toCompact = history.slice(0, emergencySafeSplit);
  const toKeep = history.slice(emergencySafeSplit);

  onProgress?.(`  🗜️  Emergency compact: summarizing ${toCompact.length} turns (keeping last 3)…\n`);

  const serialized = serializeTurns(toCompact);
  const emergencyPrompt =
    'EMERGENCY: Produce the most compact possible 9-chapter summary of these turns. ' +
    'Be extremely terse — every token counts. The context window is nearly full.\n\n' +
    serialized;

  try {
    // Use the fast/cheap model for emergency compact — speed over quality
    const client = modelManager.getClient('quick');
    const response = await client.chat({
      systemPrompt: COMPACT_SYSTEM,
      messages: [{ role: 'user', content: emergencyPrompt }],
      tools: [],
    });

    const summaryMessage: Message = {
      role: 'user',
      content: `[Emergency compact — ${toCompact.length} turns compressed]\n\n` + response.content,
    };
    history.splice(0, history.length, summaryMessage, ...toKeep);
    onProgress?.('  ✅ Emergency compact complete.\n');
    return true;
  } catch (err) {
    onProgress?.(`  ❌ Emergency compact failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return false;
  }
}
