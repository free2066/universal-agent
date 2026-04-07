/**
 * Session History Persistence
 *
 * Inspired by claude-code's history.ts
 *
 * Round 11 (D11): Enhancements:
 *   - pendingEntries[] buffer + setImmediate async flush (avoid blocking writes)
 *   - Simple lockfile-based concurrent write protection (multi-window safe)
 *   - removeLastFromHistory() for SIGINT undo support
 *   - getProjectHistory() sorts current-session entries first
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from 'fs';
import { resolve, join } from 'path';

const CONFIG_DIR = resolve(process.env.HOME ?? '~', '.uagent');
const HISTORY_FILE = join(CONFIG_DIR, 'history.jsonl');
const LOCK_FILE = join(CONFIG_DIR, 'history.lock');
const MAX_ENTRIES = 200;
const LOCK_RETRY_INTERVAL_MS = 50;
const LOCK_MAX_RETRIES = 10;

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

// ── Directory init ─────────────────────────────────────────────────────────────

let initialized = false;

function ensureDir() {
  if (!initialized) {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    initialized = true;
  }
}

// ── Lockfile-based write protection ───────────────────────────────────────────
//
// Uses O_EXCL to atomically create a lock file. On failure, retries up to
// LOCK_MAX_RETRIES times with LOCK_RETRY_INTERVAL_MS delays.
// Stale locks (pid no longer running) are broken automatically.

/**
 * Async lock acquisition — avoids busy-wait that blocks the Node.js event loop.
 * Mirrors the intent of claude-code's proper-lockfile usage but without the dependency.
 * Uses O_EXCL atomic create + async setTimeout backoff instead of synchronous spin-wait.
 */
async function acquireLockAsync(retries = LOCK_MAX_RETRIES): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    try {
      const fd = openSync(LOCK_FILE, 'wx');
      // Write PID so stale-lock detection can check if holder is still alive
      writeFileSync(LOCK_FILE, String(process.pid));
      closeSync(fd);
      return true;
    } catch {
      // Lock held — check for stale lock
      try {
        const pid = parseInt(readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
        if (pid && pid !== process.pid) {
          try {
            process.kill(pid, 0); // throws if pid is dead
          } catch {
            // Stale lock — break it and retry immediately (no sleep needed)
            try { unlinkSync(LOCK_FILE); } catch { /* already gone */ }
            continue;
          }
        }
      } catch { /* lock file read failed — owner may have just released, retry */ }

      // Yield to event loop (async sleep) instead of busy-waiting
      // This prevents blocking the Node.js event loop for LOCK_RETRY_INTERVAL_MS × LOCK_MAX_RETRIES
      await new Promise<void>(resolve => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS));
    }
  }
  return false; // Failed to acquire lock after all retries
}

function releaseLock(): void {
  try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}

// ── pendingEntries buffer ──────────────────────────────────────────────────────
//
// Entries are first pushed to pendingEntries[].
// A setImmediate flush writes them to disk, protecting the hot path from I/O latency.
// Multiple addToHistory() calls in the same tick are batched into one write.

const pendingEntries: HistoryEntry[] = [];
let flushScheduled = false;
let flushInProgress = false; // 防止并发 flush

/**
 * Async flush: drains pendingEntries to disk with lock protection.
 * Non-blocking — uses acquireLockAsync() which yields to event loop between retries.
 */
async function scheduledFlush(): Promise<void> {
  flushScheduled = false;
  if (flushInProgress) return; // 已有 flush 在进行，本次跳过（pending 会被下一次 flush 处理）
  if (pendingEntries.length === 0) return;

  flushInProgress = true;
  const toFlush = pendingEntries.splice(0);
  try {
    ensureDir();
    const locked = await acquireLockAsync();
    try {
      const lines = toFlush.map((e) => JSON.stringify(e)).join('\n') + '\n';
      appendFileSync(HISTORY_FILE, lines, { encoding: 'utf8', mode: 0o600 });
    } finally {
      if (locked) releaseLock();
    }
  } catch {
    // History write failure is non-fatal; silently discard
  } finally {
    flushInProgress = false;
    // 如果在 flush 期间有新的 pending 条目但没有调度新的 flush，补调度一次
    if (pendingEntries.length > 0 && !flushScheduled) {
      flushScheduled = true;
      setImmediate(() => { void scheduledFlush(); });
    }
  }
}

// ── Write ──────────────────────────────────────────────────────────────────────

/**
 * Append a user prompt to the history file (buffered, async).
 * Fire-and-forget — never throws.
 */
export function addToHistory(prompt: string, projectRoot?: string): void {
  try {
    const entry: HistoryEntry = {
      display: prompt.slice(0, 500),
      prompt,
      project: projectRoot ?? process.cwd(),
      sessionId: SESSION_ID,
      timestamp: Date.now(),
    };
    pendingEntries.push(entry);
    if (!flushScheduled) {
      flushScheduled = true;
      // scheduledFlush is async — use void to explicitly discard the promise (fire-and-forget)
      setImmediate(() => { void scheduledFlush(); });
    }
  } catch {
    // Non-fatal
  }
}

/**
 * Remove the last history entry for this session (SIGINT undo support).
 * Mirrors claude-code's removeLastFromHistory().
 * Called by SIGINT handler when user cancels a prompt mid-execution.
 */
export function removeLastFromHistory(projectRoot?: string): void {
  // First, remove from pending buffer (not yet flushed)
  const project = resolve(projectRoot ?? process.cwd());
  for (let i = pendingEntries.length - 1; i >= 0; i--) {
    if (pendingEntries[i]!.sessionId === SESSION_ID && pendingEntries[i]!.project === project) {
      pendingEntries.splice(i, 1);
      return;
    }
  }

  // If already flushed, rewrite history file without the last matching entry
  if (!existsSync(HISTORY_FILE)) return;
  try {
    const lines = readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
    let removed = false;
    for (let i = lines.length - 1; i >= 0 && !removed; i--) {
      try {
        const entry = JSON.parse(lines[i]!) as HistoryEntry;
        if (entry.sessionId === SESSION_ID && entry.project === project) {
          lines.splice(i, 1);
          removed = true;
        }
      } catch { /* skip malformed */ }
    }
    if (removed) {
      // Note: removeLastFromHistory is called from SIGINT handler (synchronous context).
      // We use a best-effort synchronous write here — no async lock to avoid complexity
      // in signal handlers. The risk is low: SIGINT is single-threaded and history writes
      // are rare, making lock contention extremely unlikely.
      writeFileSync(HISTORY_FILE, lines.join('\n') + (lines.length > 0 ? '\n' : ''), { encoding: 'utf8', mode: 0o600 });
    }
  } catch { /* non-fatal */ }
}

// ── Read ───────────────────────────────────────────────────────────────────────

/**
 * Read history entries for a given project, newest first.
 * D11: Current session entries sorted before other sessions (claude-code parity).
 * Returns at most MAX_ENTRIES items.
 */
export function getProjectHistory(projectRoot?: string): HistoryEntry[] {
  const project = resolve(projectRoot ?? process.cwd());

  if (!existsSync(HISTORY_FILE)) return [];

  try {
    const raw = readFileSync(HISTORY_FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const seen = new Set<string>();
    const sessionEntries: HistoryEntry[] = [];
    const otherEntries: HistoryEntry[] = [];

    // Scan newest-first by iterating in reverse
    for (let i = lines.length - 1; i >= 0; i--) {
      if (sessionEntries.length + otherEntries.length >= MAX_ENTRIES) break;
      try {
        const entry = JSON.parse(lines[i]!) as HistoryEntry;
        if (entry.project !== project) continue;
        if (seen.has(entry.display)) continue;
        seen.add(entry.display);
        // D11: current session entries first
        if (entry.sessionId === SESSION_ID) {
          sessionEntries.push(entry);
        } else {
          otherEntries.push(entry);
        }
      } catch {
        // Skip malformed lines
      }
    }

    return [...sessionEntries, ...otherEntries];
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
    // clearHistory is an admin operation (called from /clear command), not on the hot path.
    // Best-effort synchronous write — acceptable here as it's an infrequent user-initiated action.
    writeFileSync(HISTORY_FILE, outContent, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Non-fatal
  }
}
