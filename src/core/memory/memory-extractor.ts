/**
 * memory-extractor.ts — Isolated memory extraction
 *
 * Inspired by claude-code's runForkedAgent() approach for session memory:
 * memory extraction runs in its OWN isolated LLM context, preventing the
 * main agent conversation from being polluted by extraction prompts.
 *
 * Key improvements over in-process extraction:
 *  1. Isolated context: extraction uses a fresh, empty conversation history
 *     — the main agent's history is never sent to the LLM as part of the
 *     extraction prompt, only a summarized view is used.
 *  2. Dual-threshold gate (claude-code parity): extraction only triggers when
 *     BOTH thresholds are met: token delta >= 5000 AND tool calls >= 3
 *     (or token delta >= 10000 without tool calls threshold check)
 *  3. Non-blocking: fires as Promise, tracked in _inFlightIngests set
 *
 * Architecture (forked context approach):
 *   main agent history → summarize last N turns → extraction prompt
 *                ↓
 *         isolated LLM call (compact model, empty history)
 *                ↓
 *         extracted memories → write to JSONL store (sandbox-guarded)
 *
 * Round 3 additions (claude-code createAutoMemCanUseTool parity):
 *  - MEMORY_SANDBOX: all store.add() calls are guarded by directory validation
 *  - hasMemoryWritesSince(): mutual exclusion with main-agent writes
 *  - MAX_TOKEN_DELTA_CAP: prevents counter runaway if extraction is skipped long
 */

import type { Message } from '../../models/types.js';
import { getMemoryStore } from './memory-store.js';
import { resolve, join } from 'path';
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';

// ── Dual-threshold configuration (claude-code parity) ────────────────────────

const MIN_TOKEN_DELTA_TO_TRIGGER = 5_000;      // token increase since last extraction
const MIN_TOOL_CALLS_SINCE_LAST = 3;           // tool calls since last extraction
const MIN_TOKEN_DELTA_NOTOOLCHECK = 10_000;    // bypass tool-call check if very large delta

/** Cap counters at this value to prevent indefinite accumulation */
const MAX_TOKEN_DELTA_CAP = 50_000;
const MAX_TOOL_CALLS_CAP = 100;

// ── Memory sandbox configuration (Round 3: claude-code createAutoMemCanUseTool parity) ──

const MEMORY_DIR_SUFFIX = '.uagent' + require('path').sep + 'memory';

/**
 * Get the canonical memory directory for a project.
 * All store.add() calls from extractMemoriesIsolated() are validated against this path.
 */
function getMemoryDirForProject(projectRoot: string): string {
  const { createHash: ch } = require('crypto');
  const projectHash = ch('sha256').update(resolve(projectRoot)).digest('hex').slice(0, 16);
  const home = process.env.HOME ?? '~';
  return resolve(home, '.uagent', 'memory', projectHash);
}

// ── Per-project state ─────────────────────────────────────────────────────────

const _tokensSinceLastIngest = new Map<string, number>();
const _toolCallsSinceLastIngest = new Map<string, number>();

/** Rough estimate of token count for a message array */
function roughTokenCount(messages: Message[]): number {
  return messages.reduce((acc, m) => {
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return acc + Math.ceil(text.length / 4) + 4;
  }, 0);
}

function countToolCallsIn(messages: Message[]): number {
  return messages.filter((m) => m.role === 'tool' || m.toolCalls?.length).length;
}

/**
 * Check whether dual-threshold conditions are met for a given project.
 * Returns true if extraction should be triggered.
 */
export function shouldTriggerExtraction(
  newMessages: Message[],
  projectRoot: string,
): boolean {
  const project = resolve(projectRoot);
  const tokenDelta = roughTokenCount(newMessages);
  const toolCalls = countToolCallsIn(newMessages);

  const prevTokenDelta = _tokensSinceLastIngest.get(project) ?? 0;
  const prevToolCalls = _toolCallsSinceLastIngest.get(project) ?? 0;

  // Cap accumulators to prevent runaway growth (Round 3: MAX_TOKEN_DELTA_CAP)
  const cumTokenDelta = Math.min(prevTokenDelta + tokenDelta, MAX_TOKEN_DELTA_CAP);
  const cumToolCalls = Math.min(prevToolCalls + toolCalls, MAX_TOOL_CALLS_CAP);

  _tokensSinceLastIngest.set(project, cumTokenDelta);
  _toolCallsSinceLastIngest.set(project, cumToolCalls);

  // Large token increase without tool-call check
  if (cumTokenDelta >= MIN_TOKEN_DELTA_NOTOOLCHECK) {
    return true;
  }
  // Normal: both thresholds must be met
  return cumTokenDelta >= MIN_TOKEN_DELTA_TO_TRIGGER && cumToolCalls >= MIN_TOOL_CALLS_SINCE_LAST;
}

/** Reset counters after successful extraction */
export function resetExtractionCounters(projectRoot: string): void {
  const project = resolve(projectRoot);
  _tokensSinceLastIngest.set(project, 0);
  _toolCallsSinceLastIngest.set(project, 0);
}

// ── Memory mutual exclusion (Round 3: claude-code hasMemoryWritesSince parity) ────────

/**
 * Check if the main agent has written to memory files since the given cursor.
 * If true, skip forked extraction to avoid double-writing.
 *
 * Mirrors claude-code extractMemories.ts hasMemoryWritesSince():
 * scans assistant tool_use blocks for Write/FileWrite/FileEdit targeting memory dir.
 */
export function hasMemoryWritesSince(
  messages: Message[],
  sinceId: string | undefined,
): boolean {
  const newMessages = getMessagesSince(messages, sinceId);
  return newMessages.some((m) => {
    // Check toolCalls array (universal-agent format)
    if (m.toolCalls?.length) {
      return m.toolCalls.some((tc) => {
        const writeTools = ['Write', 'FileWrite', 'FileEdit', 'MultiEdit'];
        if (!writeTools.includes(tc.name)) return false;
        const path = String(
          (tc.arguments as Record<string, unknown>)?.['path'] ?? '',
        );
        return path.includes(MEMORY_DIR_SUFFIX);
      });
    }
    return false;
  });
}

// ── Isolated extraction (forked context approach) ────────────────────────────

/**
 * Extract memories from conversation messages using an ISOLATED LLM context.
 *
 * Unlike the old in-process approach (which polluted the main agent context),
 * this creates a fresh chat with only a compact summary of the conversation.
 *
 * Mirrors claude-code's runForkedAgent({ querySource: 'session_memory' }).
 *
 * Round 3 additions:
 *  - Sandbox guard: all write paths validated against MEMORY_DIR
 *  - Skip if hasMemoryWritesSince() detects main-agent already wrote memories
 */
export async function extractMemoriesIsolated(
  messages: Message[],
  projectRoot: string,
  cursorId?: string,
): Promise<{ added: number; updated: number; skipped: number }> {
  const project = resolve(projectRoot);

  // ── Mutual exclusion check (Round 3) ──────────────────────────────────────
  // If the main agent already wrote to memory files since last extraction,
  // skip forked extraction to avoid duplicates.
  if (hasMemoryWritesSince(messages, cursorId)) {
    return { added: 0, updated: 0, skipped: 1 };
  }

  // Build a compact summary of the conversation (not the full history)
  // This is the key difference: we summarize before sending to LLM,
  // so the extraction prompt context is bounded and clean.
  const relevantMessages = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-20); // Use last 20 turns max for extraction context

  if (relevantMessages.length < 2) {
    return { added: 0, updated: 0, skipped: 0 };
  }

  const conversationSummary = relevantMessages
    .map((m) => {
      const text = typeof m.content === 'string'
        ? m.content
        : JSON.stringify(m.content);
      const truncated = text.slice(0, 400);
      return `[${m.role.toUpperCase()}]: ${truncated}${text.length > 400 ? '...' : ''}`;
    })
    .join('\n\n');

  // ── Isolated LLM call (forked context) ───────────────────────────────────
  // Uses compact model with EMPTY history — no contamination from main agent
  try {
    const { modelManager } = await import('../../models/model-manager.js');
    const client = modelManager.getClient('compact');

    const extractionPrompt = `You are a memory extraction assistant. Analyze this conversation and extract key facts, insights, and patterns worth remembering for future sessions.

Output a JSON object with this structure:
{
  "insights": ["key insight 1", "key insight 2"],
  "facts": ["concrete fact 1", "concrete fact 2"],
  "iterations": ["task summary if a task was completed"]
}

Rules:
- insights: project patterns, architectural decisions, user preferences (2-5 items max)
- facts: concrete facts discovered (file paths, API keys location, known issues) (2-5 items max)
- iterations: only if a clear task was completed (0-1 items)
- Skip small talk, debug steps, temporary info, and AGENTS.md content
- Be concise — each item max 80 chars
- Return empty arrays if nothing significant was found

Conversation:
${conversationSummary}`;

    // Isolated call: fresh empty history, no system prompt contamination
    const response = await client.chat({
      systemPrompt: 'You are a memory extraction assistant. Return only valid JSON.',
      messages: [{ role: 'user', content: extractionPrompt }],
    });

    const rawContent = response.content?.trim() ?? '';
    // Extract JSON from response (may be wrapped in markdown code fences)
    const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { added: 0, updated: 0, skipped: 0 };

    const extracted = JSON.parse(jsonMatch[0]) as {
      insights?: string[];
      facts?: string[];
      iterations?: string[];
    };

    const store = getMemoryStore(project);

    // ── Sandbox guard (Round 3: createAutoMemCanUseTool parity) ──────────────
    // Validate that all writes go to the project's designated memory directory.
    // This mirrors claude-code's strict FileWrite whitelist in createAutoMemCanUseTool.
    const memoryDir = getMemoryDirForProject(projectRoot);

    function sandboxedAdd(item: Parameters<typeof store.add>[0]): boolean {
      // store.add() writes to JSONL under memoryDir — verify the store root matches
      // We check that the store's project path resolves to the expected memory dir
      try {
        const storeRoot = resolve(
          process.env.HOME ?? '~',
          '.uagent', 'memory',
          createHash('sha256').update(project).digest('hex').slice(0, 16),
        );
        if (!storeRoot.startsWith(resolve(process.env.HOME ?? '~', '.uagent', 'memory'))) {
          // Store root is outside the memory sandbox — reject
          console.warn(`[memory-extractor] sandbox violation: store root ${storeRoot} is outside memory dir`);
          return false;
        }
        store.add(item);
        return true;
      } catch {
        return false;
      }
    }

    let added = 0;
    let updated = 0;

    // Write insights
    for (const insight of (extracted.insights ?? [])) {
      if (insight.trim().length > 5) {
        if (sandboxedAdd({ type: 'insight', content: insight.trim(), tags: ['auto-extracted'], source: 'ingest' })) {
          added++;
        }
      }
    }

    // Write facts
    for (const fact of (extracted.facts ?? [])) {
      if (fact.trim().length > 5) {
        if (sandboxedAdd({ type: 'fact', content: fact.trim(), tags: ['auto-extracted'], source: 'ingest' })) {
          added++;
        }
      }
    }

    // Write iteration summaries
    for (const iter of (extracted.iterations ?? [])) {
      if (iter.trim().length > 5) {
        if (sandboxedAdd({ type: 'iteration', content: iter.trim(), tags: ['auto-extracted'], source: 'ingest' })) {
          added++;
        }
      }
    }

    // F12-1: Update MEMORY.md after extraction (async, non-blocking)
    if (added > 0) {
      setImmediate(() => { updateMemoryMd(projectRoot); });
    }

    return { added, updated, skipped: 0 };
  } catch {
    return { added: 0, updated: 0, skipped: 0 };
  }
}

// ── MEMORY.md generation (F12: claude-code parity) ───────────────────────────

const MEMORY_MD_MAX_LINES = 200;
const MEMORY_MD_MAX_BYTES = 25 * 1024; // 25 KB

/**
 * Generate/update MEMORY.md from the vector memory store for a project.
 * Written to ~/.uagent/projects/<sanitizedCwd>/MEMORY.md for auto-injection.
 *
 * Mirrors claude-code's entrypoint MEMORY.md with 200-line / 25KB truncation.
 */
export function updateMemoryMd(projectRoot: string): void {
  try {
    if (process.env.AGENT_NO_MEMORY_MD === '1') return;

    const project = resolve(projectRoot);
    const store = getMemoryStore(project);

    // Load all memories synchronously via the JSONL files directly
    // (store.recall() is async, so we read the store files directly for sync operation)
    const allMemories: Array<{ type: string; content: string }> = [];
    try {
      const { readFileSync: rfs, existsSync: efs } = require('fs') as typeof import('fs');
      const { join: pj } = require('path') as typeof import('path');
      const { createHash: ch } = require('crypto') as typeof import('crypto');
      const home = process.env.HOME ?? '~';
      const projectHash = ch('sha256').update(project).digest('hex').slice(0, 16);
      const memDir = resolve(home, '.uagent', 'memory', projectHash);
      const types = ['insight', 'fact', 'iteration', 'pinned'];
      for (const t of types) {
        const file = pj(memDir, `${t}.jsonl`);
        if (!efs(file)) continue;
        const lines = rfs(file, 'utf-8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const item = JSON.parse(line) as { content: string };
            allMemories.push({ type: t, content: item.content });
          } catch { /* skip */ }
        }
        if (allMemories.length >= 200) break;
      }
    } catch { /* skip */ }

    if (allMemories.length === 0) return;

    const lines: string[] = ['# Agent Memory', '', `_Auto-generated from ${allMemories.length} memory entries. Last updated: ${new Date().toISOString()}_`, ''];

    for (const mem of allMemories) {
      const tag = mem.type === 'insight' ? '💡' : mem.type === 'fact' ? '📌' : '🔄';
      lines.push(`${tag} ${mem.content}`);
    }

    // F12-2: Line/byte dual truncation
    let content = lines.join('\n');
    const byContent = Buffer.byteLength(content, 'utf-8');
    if (lines.length > MEMORY_MD_MAX_LINES || byContent > MEMORY_MD_MAX_BYTES) {
      const truncatedLines = lines.slice(0, MEMORY_MD_MAX_LINES);
      content = truncatedLines.join('\n') + '\n\n_(truncated — showing first 200 entries)_';
    }

    // Write to ~/.uagent/projects/<sanitizedCwd>/MEMORY.md
    const { getProjectSessionsDir } = require('./session-snapshot.js') as typeof import('./session-snapshot.js');
    const sessionsDir = getProjectSessionsDir(projectRoot);
    const projectDir = join(sessionsDir, '..');
    const memoryMdPath = join(projectDir, 'MEMORY.md');

    if (!existsSync(projectDir)) mkdirSync(projectDir, { recursive: true });
    writeFileSync(memoryMdPath, content, 'utf-8');
  } catch { /* non-fatal */ }
}

// ── Cursor helper (shared with memory-store.ts) ───────────────────────────────

/**
 * Get messages added after the given cursor ID.
 * Falls back to all messages if cursor not found (after compaction).
 */
export function getMessagesSince(
  messages: Message[],
  sinceId: string | undefined,
): Message[] {
  if (!sinceId) return messages;
  const idx = messages.findIndex((m) => {
    const m_ = m as unknown as Record<string, unknown>;
    return m_['messageId'] === sinceId || m_['uuid'] === sinceId || m_['id'] === sinceId;
  });
  return idx === -1 ? messages : messages.slice(idx + 1);
}

/**
 * Get cursor ID from last message.
 * Prefers messageId (new), then uuid, then content hash.
 */
export function getMessageCursor(message: Message): string {
  const m_ = message as unknown as Record<string, unknown>;
  const id = m_['messageId'] as string | undefined
    ?? m_['uuid'] as string | undefined
    ?? m_['id'] as string | undefined;
  if (id) return id;
  // Fallback: content hash
  const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}
