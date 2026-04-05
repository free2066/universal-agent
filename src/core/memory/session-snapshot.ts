/**
 * session-snapshot.ts — Save / restore full Message[] between sessions.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import type { Message } from '../../models/types.js';

const SESSIONS_DIR = resolve(process.env.HOME || '~', '.uagent', 'sessions');
const MAX_MESSAGES = 60;

export interface SessionSnapshot {
  sessionId: string;
  savedAt: number;
  messages: Message[];
  /**
   * User-explicitly-set title (highest priority).
   * Corresponds to claude-code's 'custom-title' entry type.
   * Once set by the user, AI-generated titles can never overwrite this.
   */
  customTitle?: string;
  /**
   * AI-auto-generated title (lower priority than customTitle).
   * Corresponds to claude-code's 'ai-title' entry type.
   * AI can update this freely, but it will never show if customTitle is set.
   */
  aiTitle?: string;
}

function ensureDir(): void {
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
}

export function saveSnapshot(sessionId: string, messages: Message[]): void {
  try {
    ensureDir();
    const toSave = messages.slice(-MAX_MESSAGES);
    const snapshot: SessionSnapshot = { sessionId, savedAt: Date.now(), messages: toSave };
    writeFileSync(resolve(SESSIONS_DIR, `${sessionId}.json`), JSON.stringify(snapshot, null, 2), 'utf-8');
  } catch { /* non-fatal */ }
}

export function loadSnapshot(sessionId: string): SessionSnapshot | null {
  try {
    const p = resolve(SESSIONS_DIR, `${sessionId}.json`);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8')) as SessionSnapshot;
  } catch { return null; }
}

/** Return all snapshots sorted by mtime descending (newest first), up to limit. */
export function listAllSnapshots(limit = 15): Array<{ sessionId: string; savedAt: number; messageCount: number; mtime: number; displayTitle?: string }> {
  try {
    ensureDir();
    const files = readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith('.json'));
    const items = files.map((f) => {
      try {
        const p = resolve(SESSIONS_DIR, f);
        const mtime = statSync(p).mtimeMs;
        const raw = JSON.parse(readFileSync(p, 'utf-8')) as SessionSnapshot;
        // customTitle (user) always wins over aiTitle (AI-generated)
        const displayTitle = raw.customTitle ?? raw.aiTitle;
        return { sessionId: raw.sessionId, savedAt: raw.savedAt, messageCount: raw.messages.length, mtime, displayTitle };
      } catch { return null; }
    }).filter(Boolean) as Array<{ sessionId: string; savedAt: number; messageCount: number; mtime: number; displayTitle?: string }>;
    return items.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  } catch { return []; }
}

/** Return the most recently modified snapshot (any session). */
export function loadLastSnapshot(): SessionSnapshot | null {
  try {
    ensureDir();
    const files = readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort(
        (a, b) =>
          statSync(resolve(SESSIONS_DIR, b)).mtimeMs -
          statSync(resolve(SESSIONS_DIR, a)).mtimeMs,
      );
    if (!files.length) return null;
    return JSON.parse(readFileSync(resolve(SESSIONS_DIR, files[0]), 'utf-8')) as SessionSnapshot;
  } catch { return null; }
}

export function formatAge(savedAt: number): string {
  const ms = Date.now() - savedAt;
  if (ms < 60_000) return '刚刚';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟前`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} 小时前`;
  return `${Math.round(ms / 86_400_000)} 天前`;
}

// ── Title helpers (claude-code parity) ───────────────────────────────────────
//
// Two distinct title types, mirroring claude-code's 'custom-title' / 'ai-title' entry separation:
//   customTitle — set explicitly by the user via /rename <name>; highest priority; AI can never overwrite
//   aiTitle     — generated automatically by AI via /rename (no args); lower priority; silently overwritten when user renames

function _findSnapshotFile(sessionId: string): string | undefined {
  ensureDir();
  const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  return files.find((f) => f === `${sessionId}.json`) ?? files.find((f) => f.startsWith(sessionId));
}

/**
 * Set a user-explicit title for a session snapshot.
 * Corresponds to claude-code's saveCustomTitle(source='user').
 * This title has HIGHEST priority — AI-generated titles can never overwrite it.
 *
 * @param sessionId  The session ID to rename
 * @param title      The user-provided title
 * @returns true if the snapshot was found and updated
 */
export function setCustomTitle(sessionId: string, title: string): boolean {
  try {
    const file = _findSnapshotFile(sessionId);
    if (!file) return false;
    const p = resolve(SESSIONS_DIR, file);
    const snap = JSON.parse(readFileSync(p, 'utf-8')) as SessionSnapshot;
    snap.customTitle = title;
    // When user explicitly renames, also clear any stale aiTitle
    // to avoid confusion in the display layer
    snap.aiTitle = undefined;
    writeFileSync(p, JSON.stringify(snap, null, 2), 'utf-8');
    return true;
  } catch { return false; }
}

/**
 * Set an AI-generated title for a session snapshot.
 * Corresponds to claude-code's saveAiGeneratedTitle().
 * Has LOWER priority — if customTitle already exists, this is silently ignored.
 * AI titles can freely overwrite each other (most recent wins).
 *
 * @param sessionId  The session ID to title
 * @param title      The AI-generated title
 * @returns true if the snapshot was found and updated
 */
export function setAiGeneratedTitle(sessionId: string, title: string): boolean {
  try {
    const file = _findSnapshotFile(sessionId);
    if (!file) return false;
    const p = resolve(SESSIONS_DIR, file);
    const snap = JSON.parse(readFileSync(p, 'utf-8')) as SessionSnapshot;
    // Respect user title: if customTitle is already set, don't overwrite it
    if (snap.customTitle) return true; // already has user title — skip silently
    snap.aiTitle = title;
    writeFileSync(p, JSON.stringify(snap, null, 2), 'utf-8');
    return true;
  } catch { return false; }
}

/**
 * Generate a session title from the conversation using an LLM.
 * Returns null on failure — caller should fall back to a manual name.
 */
export async function generateSessionTitle(messages: Message[]): Promise<string | null> {
  if (messages.length < 2) return null;
  try {
    const { modelManager } = await import('../../models/model-manager.js');
    const client = modelManager.getClient('compact');
    // Use last 4 turns for context
    const lastTurns = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-4)
      .map((m) => {
        const text = typeof m.content === 'string'
          ? m.content
          : JSON.stringify(m.content);
        return `[${m.role.toUpperCase()}]: ${text.slice(0, 200)}`;
      })
      .join('\n');
    const response = await client.chat({
      systemPrompt:
        'You are a session naming assistant. Generate a short, descriptive title ' +
        'for this conversation in 2-4 kebab-case words (e.g. "fix-login-bug", "add-auth-api"). ' +
        'Return ONLY the title, nothing else.',
      messages: [{ role: 'user', content: `Conversation:\n${lastTurns}\n\nGenerate a title:` }],
    });
    const raw = (response.content ?? '').trim()
      .toLowerCase()
      .replace(/[^a-z0-9\-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    return raw || null;
  } catch { return null; }
}

// ── Global search (Batch 3) ───────────────────────────────────────────────────

export interface SearchResult {
  sessionId: string;
  savedAt: number;
  messageCount: number;
  /** The matched message role */
  role: string;
  /** The matched text snippet (up to 200 chars around the match) */
  snippet: string;
  /** Zero-based index of the matched message within this snapshot */
  messageIndex: number;
}

/**
 * Search all session snapshots for messages matching query.
 * Returns up to maxResults results sorted by recency (newest first).
 *
 * @param query       Case-insensitive search string
 * @param maxResults  Max results to return (default 20)
 */
export function searchSnapshots(query: string, maxResults = 20): SearchResult[] {
  if (!query.trim()) return [];
  const q = query.toLowerCase();
  const results: SearchResult[] = [];

  try {
    ensureDir();
    const files = readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort(
        (a, b) =>
          statSync(resolve(SESSIONS_DIR, b)).mtimeMs -
          statSync(resolve(SESSIONS_DIR, a)).mtimeMs,
      );

    for (const f of files) {
      if (results.length >= maxResults) break;
      try {
        const snap = JSON.parse(readFileSync(resolve(SESSIONS_DIR, f), 'utf-8')) as SessionSnapshot;
        for (let i = 0; i < snap.messages.length && results.length < maxResults; i++) {
          const m = snap.messages[i];
          const text = typeof m.content === 'string'
            ? m.content
            : JSON.stringify(m.content);
          const lower = text.toLowerCase();
          const idx = lower.indexOf(q);
          if (idx === -1) continue;
          // Extract snippet centered on match
          const start = Math.max(0, idx - 60);
          const end = Math.min(text.length, idx + q.length + 140);
          let snippet = text.slice(start, end).replace(/\n+/g, ' ').trim();
          if (start > 0) snippet = '…' + snippet;
          if (end < text.length) snippet = snippet + '…';
          results.push({
            sessionId: snap.sessionId,
            savedAt: snap.savedAt,
            messageCount: snap.messages.length,
            role: m.role,
            snippet,
            messageIndex: i,
          });
        }
      } catch { /* skip malformed snapshot */ }
    }
  } catch { /* SESSIONS_DIR doesn't exist yet */ }

  return results;
}
