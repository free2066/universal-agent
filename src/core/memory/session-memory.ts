/**
 * Session Memory — Layer 4 Compression (kstack #15375)
 *
 * Inspired by Claude Code's SessionMemory service:
 *   src/services/SessionMemory/  (3 files)
 *
 * Purpose: Maintain a rolling 10-chapter summary of the CURRENT session.
 * This summary can be used as a cheap alternative to full LLM compaction —
 * it is updated incrementally (no LLM call) and costs <10ms to retrieve.
 *
 * Layer 4 in the compression hierarchy:
 *   Layer 1: Tool Result Budget      (sync, zero cost)
 *   Layer 2: Snip Compact            (zero cost)
 *   Layer 3: Microcompact            (zero cost, <1ms)
 *   Layer 4: Session Memory Compact  (THIS FILE — use existing summary, <10ms)
 *   Layer 5: Auto-Compact            (LLM, expensive, 5-30s)
 *   Layer 7: Reactive Compact        (LLM, emergency)
 *
 * Configuration (matches Claude Code observed values):
 *   minimumMessageTokensToInit: 10_000  — don't activate below 10K tokens
 *   minimumTokensBetweenUpdate: 5_000   — update every 5K tokens growth
 *   toolCallsBetweenUpdates: 3          — and at least 3 tool calls
 *
 * 10 Fixed Chapters (identical to Claude Code's structure):
 *   1. Session Title
 *   2. Current State
 *   3. Task Specification
 *   4. Files and Functions
 *   5. Workflow
 *   6. Errors & Corrections
 *   7. Codebase and System Documentation
 *   8. Learnings
 *   9. Key Results
 *  10. Worklog
 *
 * Size Limits:
 *   maxChapterTokens: 2_000   — per chapter
 *   maxTotalTokens:  12_000   — whole document
 *
 * Integration:
 *   - trySessionMemoryCompaction() is called BEFORE autoCompact in agent.ts
 *   - If it succeeds, autoCompact is skipped (avoiding expensive LLM call)
 *   - After-sampling hook updates the summary every toolCallsBetweenUpdates
 */

import type { Message } from '../../models/types.js';

// ── Configuration ─────────────────────────────────────────────────────────────

/** Minimum estimated tokens in history before Session Memory is activated */
export const SM_MINIMUM_TOKENS_TO_INIT = 10_000;

/** Minimum token growth between summary updates */
export const SM_MINIMUM_TOKENS_BETWEEN_UPDATE = 5_000;

/** Minimum tool calls between summary updates (AND condition with token growth) */
export const SM_TOOL_CALLS_BETWEEN_UPDATES = 3;

/** Maximum tokens per chapter (Claude Code: 2K) */
const SM_MAX_CHAPTER_TOKENS = 2_000;

/** Maximum total tokens for the whole Session Memory document (Claude Code: 12K) */
const SM_MAX_TOTAL_TOKENS = 12_000;

/** Characters per token estimate (conservative) */
const CHARS_PER_TOKEN = 4;

// ── State ─────────────────────────────────────────────────────────────────────

export interface SessionMemoryState {
  /** The current 10-chapter summary text */
  summary: string;
  /** Estimated token count of the summary */
  estimatedTokens: number;
  /** Number of history messages covered by this summary */
  messagesCovered: number;
  /** Total estimated tokens of history at last update */
  tokenCountAtLastUpdate: number;
  /** Tool call count at last update */
  toolCallCountAtLastUpdate: number;
  /** Whether session memory has been initialized */
  initialized: boolean;
}

/** Session-level state — resets when a new agent session starts */
let _state: SessionMemoryState = createEmptyState();

function createEmptyState(): SessionMemoryState {
  return {
    summary: '',
    estimatedTokens: 0,
    messagesCovered: 0,
    tokenCountAtLastUpdate: 0,
    toolCallCountAtLastUpdate: 0,
    initialized: false,
  };
}

/** Reset session memory (call at session start) */
export function resetSessionMemory(): void {
  _state = createEmptyState();
}

/** Get current session memory state (read-only copy) */
export function getSessionMemoryState(): Readonly<SessionMemoryState> {
  return _state;
}

// ── Token Estimation ──────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimateHistoryTokens(history: Message[]): number {
  return history.reduce((sum, m) => {
    const content = typeof m.content === 'string' ? m.content : '';
    return sum + estimateTokens(content);
  }, 0);
}

function countToolCalls(history: Message[]): number {
  return history.filter((m) => m.role === 'tool').length;
}

// ── The 10-Chapter Structure ───────────────────────────────────────────────────

const CHAPTER_NAMES = [
  'Session Title',
  'Current State',
  'Task Specification',
  'Files and Functions',
  'Workflow',
  'Errors & Corrections',
  'Codebase and System Documentation',
  'Learnings',
  'Key Results',
  'Worklog',
] as const;

/**
 * Build a Session Memory document from a history.
 * This is a lightweight in-process summarizer — NO LLM call.
 * It extracts structured information from the message history deterministically.
 */
export function buildSessionMemory(history: Message[]): string {
  const userMessages = history.filter((m) => m.role === 'user');
  const assistantMessages = history.filter((m) => m.role === 'assistant');
  const toolMessages = history.filter((m) => m.role === 'tool');

  // Chapter 1: Session Title — first user message (truncated)
  const firstUserMsg = userMessages[0]?.content?.slice(0, 150) ?? 'Untitled Session';

  // Chapter 2: Current State — last assistant message
  const lastAssistant = assistantMessages[assistantMessages.length - 1]?.content ?? '';
  const currentState = lastAssistant.slice(0, SM_MAX_CHAPTER_TOKENS * CHARS_PER_TOKEN);

  // Chapter 3: Task Specification — all user messages (condensed)
  const taskSpec = userMessages
    .filter((m) => !m.content.startsWith('[SYSTEM]') && !m.content.startsWith('<'))
    .map((m) => `• ${m.content.slice(0, 200)}`)
    .slice(-10) // last 10 user messages
    .join('\n');

  // Chapter 4: Files and Functions — extract file paths from tool results
  const filePatterns = /(?:\/[^\s"'`]+\.[a-zA-Z]{1,6}|[a-zA-Z_][a-zA-Z0-9_]*\.(ts|js|py|go|rs|java|md|json|yaml|yml))/g;
  const filesSet = new Set<string>();
  for (const msg of toolMessages.slice(-30)) {
    const matches = msg.content.match(filePatterns) ?? [];
    for (const m of matches.slice(0, 5)) filesSet.add(m);
    if (filesSet.size >= 30) break;
  }
  const filesSection = Array.from(filesSet).slice(0, 20).join('\n');

  // Chapter 5: Workflow — recent tool calls
  const recentTools = history
    .filter((m) => m.role === 'assistant' && m.toolCalls?.length)
    .slice(-5)
    .flatMap((m) => m.toolCalls?.map((tc) => `• ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 80)})`) ?? []);
  const workflow = recentTools.join('\n');

  // Chapter 6: Errors & Corrections — error patterns
  const errorPattern = /(?:error|failed|exception|traceback|TypeError|SyntaxError)[::\s][^\n]{0,200}/gi;
  const errors: string[] = [];
  for (const msg of toolMessages.slice(-20)) {
    const matches = msg.content.match(errorPattern) ?? [];
    errors.push(...matches.slice(0, 2));
    if (errors.length >= 10) break;
  }
  const errorsSection = errors.slice(0, 8).map((e) => `• ${e.trim()}`).join('\n');

  // Chapter 7: Codebase Documentation — minimal (detected tech stack)
  const techPatterns: string[] = [];
  const allContent = history.map((m) => m.content).join('\n');
  if (allContent.includes('package.json') || allContent.includes('node_modules')) techPatterns.push('Node.js/TypeScript');
  if (allContent.includes('requirements.txt') || allContent.includes('.py')) techPatterns.push('Python');
  if (allContent.includes('go.mod') || allContent.includes('.go')) techPatterns.push('Go');
  if (allContent.includes('Cargo.toml') || allContent.includes('.rs')) techPatterns.push('Rust');
  const techSection = techPatterns.join(', ') || 'Not detected';

  // Chapter 8: Learnings — from assistant mentions of "note:", "important:", "remember:"
  const learningPattern = /(?:note:|important:|remember:|key insight:|learned:)[^\n]{0,300}/gi;
  const learnings: string[] = [];
  for (const msg of assistantMessages.slice(-10)) {
    const matches = msg.content.match(learningPattern) ?? [];
    learnings.push(...matches.slice(0, 2));
  }
  const learningsSection = learnings.slice(0, 5).map((l) => `• ${l.trim()}`).join('\n');

  // Chapter 9: Key Results — last assistant message summary (brief)
  const keyResults = lastAssistant
    .split('\n')
    .filter((l) => l.match(/^[•✓✅⚡🔧📝]/))
    .slice(0, 8)
    .join('\n');

  // Chapter 10: Worklog — timestamp + brief of each turn
  const worklog = history
    .filter((m) => m.role === 'assistant')
    .slice(-5)
    .map((m, i) => `Turn ${i + 1}: ${m.content.slice(0, 100)}`)
    .join('\n');

  // Assemble chapters
  const chapters = [
    `## 1. ${CHAPTER_NAMES[0]}\n${firstUserMsg}`,
    `## 2. ${CHAPTER_NAMES[1]}\n${currentState.slice(0, SM_MAX_CHAPTER_TOKENS * CHARS_PER_TOKEN) || 'In progress'}`,
    `## 3. ${CHAPTER_NAMES[2]}\n${taskSpec || 'See user messages above'}`,
    `## 4. ${CHAPTER_NAMES[3]}\n${filesSection || 'None detected'}`,
    `## 5. ${CHAPTER_NAMES[4]}\n${workflow || 'No tool calls yet'}`,
    `## 6. ${CHAPTER_NAMES[5]}\n${errorsSection || 'No errors recorded'}`,
    `## 7. ${CHAPTER_NAMES[6]}\n${techSection}`,
    `## 8. ${CHAPTER_NAMES[7]}\n${learningsSection || 'None recorded'}`,
    `## 9. ${CHAPTER_NAMES[8]}\n${keyResults || 'In progress'}`,
    `## 10. ${CHAPTER_NAMES[9]}\n${worklog || 'Session just started'}`,
  ];

  // Apply per-chapter token limit
  const limitedChapters = chapters.map((chapter) => {
    const maxChars = SM_MAX_CHAPTER_TOKENS * CHARS_PER_TOKEN;
    if (chapter.length > maxChars) {
      return chapter.slice(0, maxChars) + '\n...(truncated)';
    }
    return chapter;
  });

  const doc = `<session_memory>\n${limitedChapters.join('\n\n')}\n</session_memory>`;

  // Apply total token limit
  const maxTotalChars = SM_MAX_TOTAL_TOKENS * CHARS_PER_TOKEN;
  if (doc.length > maxTotalChars) {
    return doc.slice(0, maxTotalChars) + '\n...(session memory truncated at 12K token limit)';
  }

  return doc;
}

// ── Update Decision ───────────────────────────────────────────────────────────

/**
 * Decide if session memory should be updated based on growth thresholds.
 * Returns true when BOTH conditions are met:
 *   1. Token growth >= SM_MINIMUM_TOKENS_BETWEEN_UPDATE
 *   2. Tool call count increase >= SM_TOOL_CALLS_BETWEEN_UPDATES
 *
 * This prevents excessive updates for short turns.
 */
export function shouldUpdateSessionMemory(history: Message[]): boolean {
  const currentTokens = estimateHistoryTokens(history);
  const currentToolCalls = countToolCalls(history);

  // Not initialized yet — check minimum threshold
  if (!_state.initialized) {
    return currentTokens >= SM_MINIMUM_TOKENS_TO_INIT;
  }

  const tokenGrowth = currentTokens - _state.tokenCountAtLastUpdate;
  const toolCallGrowth = currentToolCalls - _state.toolCallCountAtLastUpdate;

  return (
    tokenGrowth >= SM_MINIMUM_TOKENS_BETWEEN_UPDATE &&
    toolCallGrowth >= SM_TOOL_CALLS_BETWEEN_UPDATES
  );
}

/**
 * Update session memory in-place from current history.
 * Non-blocking and non-fatal: failures are silently ignored.
 *
 * @returns true if updated, false if skipped
 */
export function updateSessionMemory(history: Message[]): boolean {
  try {
    if (!shouldUpdateSessionMemory(history)) return false;

    const summary = buildSessionMemory(history);
    const estimatedTokens = estimateTokens(summary);
    const currentTokens = estimateHistoryTokens(history);
    const currentToolCalls = countToolCalls(history);

    _state = {
      summary,
      estimatedTokens,
      messagesCovered: history.length,
      tokenCountAtLastUpdate: currentTokens,
      toolCallCountAtLastUpdate: currentToolCalls,
      initialized: true,
    };

    return true;
  } catch {
    return false; // Never surface Session Memory failures
  }
}

// ── Layer 4: Session Memory Compaction ────────────────────────────────────────

/**
 * Try to compact history using existing Session Memory (Layer 4).
 *
 * This is the "cheap path" before falling back to LLM-based Auto-Compact (Layer 5).
 * Cost: <10ms (no LLM call — uses pre-built summary).
 *
 * Algorithm:
 *   1. Check if session memory exists and is valid
 *   2. Check if history is over the threshold
 *   3. Replace old messages with the summary + keep recent messages
 *      - minTokens: 10_000 tokens of recent messages preserved
 *      - minMessages: 5 messages preserved
 *      - maxTokens: 40_000 token hard cap on kept tail
 *
 * Returns true if compaction was applied, false if skipped.
 */
export function trySessionMemoryCompaction(
  history: Message[],
  onProgress?: (msg: string) => void,
): boolean {
  if (!_state.initialized || !_state.summary) return false;

  const currentTokens = estimateHistoryTokens(history);

  // Only apply if summary is substantially smaller than current history
  if (_state.estimatedTokens >= currentTokens * 0.8) return false;

  // Find a safe split: keep recent messages that total at least 10K tokens
  const MIN_KEEP_TOKENS = 10_000;
  const MAX_KEEP_TOKENS = 40_000;
  const MIN_KEEP_MESSAGES = 5;

  let keepFrom = history.length;
  let keptTokens = 0;
  let keptMessages = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(
      typeof history[i].content === 'string' ? history[i].content : ''
    );
    keptTokens += msgTokens;
    keptMessages++;
    keepFrom = i;

    // Stop when we've kept enough messages and enough tokens
    if (keptMessages >= MIN_KEEP_MESSAGES && keptTokens >= MIN_KEEP_TOKENS) break;
    if (keptTokens >= MAX_KEEP_TOKENS) break;
  }

  // Must actually compact something
  if (keepFrom === 0) return false;

  // Check that we can't break tool_use/tool_result pairs
  // Advance keepFrom forward if needed to avoid splitting a pair
  while (keepFrom < history.length && history[keepFrom].role === 'tool') {
    keepFrom++;
  }
  if (keepFrom >= history.length) return false;

  const summaryMessage: Message = {
    role: 'user',
    content:
      `[Session Memory Compaction — ${keepFrom} messages summarized, ${history.length - keepFrom} messages retained]\n\n` +
      _state.summary,
  };

  const tail = history.slice(keepFrom);
  history.splice(0, history.length, summaryMessage, ...tail);

  onProgress?.(
    `\n📋 Session Memory Layer 4: replaced ${keepFrom} messages with 10-chapter summary ` +
    `(~${_state.estimatedTokens} tokens → saved ${currentTokens - _state.estimatedTokens - estimateHistoryTokens(tail)} tokens)\n`
  );

  return true;
}
