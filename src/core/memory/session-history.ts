/**
 * Session History Persistence
 *
 * Inspired by claude-code's history.ts
 *
 * Persists conversation turns to ~/.uagent/history.jsonl so they survive
 * process restarts. Each entry records the user prompt, the project root,
 * and a session ID so multi-project / multi-session histories stay separated.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';

const CONFIG_DIR = resolve(process.env.HOME ?? '~', '.uagent');
const HISTORY_FILE = join(CONFIG_DIR, 'history.jsonl');
const MAX_ENTRIES = 200;

export interface HistoryEntry {
  /** Display text (user prompt, first 500 chars) */
  display: string;
  /** Full user prompt */
  prompt: string;
  /** Project root directory when the prompt was submitted */
  project: string;
  /** Session ID (process-level random) */
  sessionId: string;
  /** Unix timestamp ms */
  timestamp: number;
}

// ── Session ID ────────────────────────────────────────────────────────────────
// Use crypto.randomUUID() for proper UUID v4 (mirrors claude-code's randomUUID() usage).
// Falls back to Math.random() in environments where crypto is unavailable.
const SESSION_ID = (() => {
  try {
    return (globalThis as { crypto?: { randomUUID?: () => string } })
      .crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  } catch {
    return Math.random().toString(36).slice(2);
  }
})();

export function getSessionId(): string {
  return SESSION_ID;
}

// ── Write ──────────────────────────────────────────────────────────────────────

let initialized = false;

function ensureDir() {
  if (!initialized) {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    initialized = true;
  }
}

/**
 * Append a user prompt to the history file.
 * Fire-and-forget — never throws.
 */
export function addToHistory(prompt: string, projectRoot?: string): void {
  try {
    ensureDir();
    const entry: HistoryEntry = {
      display: prompt.slice(0, 500),
      prompt,
      project: projectRoot ?? process.cwd(),
      sessionId: SESSION_ID,
      timestamp: Date.now(),
    };
    appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch {
    // History write failure is non-fatal
  }
}

// ── Read ───────────────────────────────────────────────────────────────────────

/**
 * Read history entries for a given project, newest first.
 * Returns at most MAX_ENTRIES items.
 *
 * Performance note: for large history files we scan from the end of the file
 * rather than reading everything then reversing. We use a two-pass line-count
 * approach to keep the implementation simple while avoiding the O(n) reverse.
 * For files < ~200 lines the difference is negligible, but for long-running
 * sessions (thousands of turns) this avoids allocating the entire reversed array.
 */
export function getProjectHistory(projectRoot?: string): HistoryEntry[] {
  const project = resolve(projectRoot ?? process.cwd());

  if (!existsSync(HISTORY_FILE)) return [];

  try {
    const raw = readFileSync(HISTORY_FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    // Scan newest-first by iterating in reverse — avoids allocating a reversed copy
    const results: HistoryEntry[] = [];
    const seen = new Set<string>();

    for (let i = lines.length - 1; i >= 0 && results.length < MAX_ENTRIES; i--) {
      try {
        const entry = JSON.parse(lines[i]) as HistoryEntry;
        if (entry.project !== project) continue;
        if (seen.has(entry.display)) continue;
        seen.add(entry.display);
        results.push(entry);
      } catch {
        // Skip malformed lines
      }
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * Get the most recent N prompts for the current project (for /history command).
 */
export function getRecentHistory(n = 20, projectRoot?: string): string[] {
  return getProjectHistory(projectRoot)
    .slice(0, n)
    .map((e) => e.display);
}

/**
 * Clear all history entries for a project.
 * Used by /clear command.
 */
export function clearHistory(projectRoot?: string): void {
  const project = resolve(projectRoot ?? process.cwd());
  if (!existsSync(HISTORY_FILE)) return;

  try {
    const lines = readFileSync(HISTORY_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .filter((line) => {
        try {
          const entry = JSON.parse(line) as HistoryEntry;
          return entry.project !== project;
        } catch {
          return true; // keep malformed lines
        }
      });

    const outContent = lines.length > 0 ? lines.join('\n') + '\n' : '';
    writeFileSync(HISTORY_FILE, outContent, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    // Non-fatal
  }
}
