/**
 * session-snapshot.ts — Save / restore full Message[] between sessions.
 *
 * Round 10 (A10): claude-code sessionStorage.ts parity
 *   - CWD-isolated project directories: ~/.uagent/projects/<sanitizedCwd>/sessions/
 *   - JSONL append-per-turn (not full overwrite) with typed entry lines
 *   - Lite fast read: only read head/tail 64KB for list views
 *   - 50MB file size protection
 *   - MAX_MESSAGES raised to 500
 *   - Backward compat: loadSnapshot() falls back to legacy .json files
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  appendFileSync,
  openSync,
  readSync,
  closeSync,
} from 'fs';
import { resolve } from 'path';
import type { Message } from '../../models/types.js';

const MAX_MESSAGES = 500;
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
const LITE_BUF_SIZE = 65536; // 64 KB head/tail for lite reads

// ── Project directory helpers ─────────────────────────────────────────────────

/**
 * Sanitize a CWD path into a filesystem-safe directory name.
 * Mirrors claude-code's sanitizePath() logic.
 */
function sanitizePath(p: string): string {
  return p.replace(/[^a-zA-Z0-9\-_]/g, '-').slice(0, 100);
}

/**
 * Return the sessions directory for a given CWD.
 * Format: ~/.uagent/projects/<sanitizedCwd>/sessions/
 */
export function getProjectSessionsDir(cwd?: string): string {
  const projectDir = resolve(cwd ?? process.cwd());
  const sanitized = sanitizePath(projectDir);
  return resolve(process.env.HOME ?? '~', '.uagent', 'projects', sanitized, 'sessions');
}

/** Legacy flat sessions directory (Round 10: kept for backward compat) */
const LEGACY_SESSIONS_DIR = resolve(process.env.HOME ?? '~', '.uagent', 'sessions');

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ── JSONL entry types ─────────────────────────────────────────────────────────

type EntryType = 'header' | 'message' | 'title' | 'meta';

interface HeaderEntry {
  type: 'header';
  sessionId: string;
  savedAt: number;
  cwd: string;
}

interface MessageEntry {
  type: 'message';
  message: Message;
}

interface TitleEntry {
  type: 'title';
  titleType: 'custom' | 'ai';
  title: string;
  savedAt: number;
}

interface MetaEntry {
  type: 'meta';
  lastPrompt?: string;
  savedAt: number;
}

type JournalEntry = HeaderEntry | MessageEntry | TitleEntry | MetaEntry;

// ── Public interface ──────────────────────────────────────────────────────────

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

// ── JSONL file path helpers ───────────────────────────────────────────────────

function jsonlPath(sessionId: string, cwd?: string): string {
  return resolve(getProjectSessionsDir(cwd), `${sessionId}.jsonl`);
}

function legacyJsonPath(sessionId: string): string {
  return resolve(LEGACY_SESSIONS_DIR, `${sessionId}.json`);
}

// ── Append a single typed entry ───────────────────────────────────────────────

function appendEntry(filePath: string, entry: JournalEntry): void {
  try {
    const stat = existsSync(filePath) ? statSync(filePath) : null;
    if (stat && stat.size >= MAX_FILE_BYTES) {
      console.warn(`[session-snapshot] File ${filePath} exceeds 50MB, skipping write.`);
      return;
    }
    appendFileSync(filePath, JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });
  } catch { /* non-fatal */ }
}

// ── Save / append ─────────────────────────────────────────────────────────────

/**
 * Persist the current message array as JSONL.
 * On first call for a session: writes header + all messages.
 * On subsequent calls (per-turn): appends only the new messages.
 *
 * Falls back to legacy full-write for callers that don't pass cwd.
 */
export function saveSnapshot(sessionId: string, messages: Message[], cwd?: string): void {
  try {
    const sessionsDir = getProjectSessionsDir(cwd);
    ensureDir(sessionsDir);
    const filePath = jsonlPath(sessionId, cwd);
    // E27: filter isMeta=true messages before persisting
    // (compact boundary markers, interrupt messages, system annotations)
    // Mirrors claude-code sessionStorage.ts L2403, L4832: skip isMeta:true on save
    const filteredMessages = messages.filter((m) => !m.isMeta);
    const toSave = filteredMessages.slice(-MAX_MESSAGES);

    if (!existsSync(filePath)) {
      const header: HeaderEntry = {
        type: 'header',
        sessionId,
        savedAt: Date.now(),
        cwd: cwd ?? process.cwd(),
      };
      appendEntry(filePath, header);
      for (const msg of toSave) {
        appendEntry(filePath, { type: 'message', message: msg });
      }
    } else {
      // Append only new messages (detect by reading existing count)
      const existing = _loadMessagesFromJsonl(filePath);
      const newMessages = toSave.slice(existing.length);
      for (const msg of newMessages) {
        appendEntry(filePath, { type: 'message', message: msg });
      }
    }

    // Update meta (last prompt)
    const lastUserMsg = [...toSave].reverse().find((m) => m.role === 'user');
    if (lastUserMsg) {
      const text = typeof lastUserMsg.content === 'string'
        ? lastUserMsg.content
        : JSON.stringify(lastUserMsg.content);
      appendEntry(filePath, { type: 'meta', lastPrompt: text.slice(0, 300), savedAt: Date.now() });
    }

    // B10-5: cleanupPeriodDays — async cleanup after write
    try {
      const { getCleanupPeriodDays } = require('../agent/permission-manager.js') as typeof import('../agent/permission-manager.js');
      const days = getCleanupPeriodDays(cwd);
      maybeCleanOldSessions(sessionsDir, days);
    } catch { /* non-fatal */ }
  } catch { /* non-fatal */ }
}

// ── Load ──────────────────────────────────────────────────────────────────────

function _loadMessagesFromJsonl(filePath: string): Message[] {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const messages: Message[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as JournalEntry;
        if (entry.type === 'message') messages.push(entry.message);
      } catch { /* skip malformed */ }
    }
    return messages;
  } catch { return []; }
}

function _parseSnapshotFromJsonl(filePath: string): SessionSnapshot | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    let sessionId = '';
    let savedAt = 0;
    let customTitle: string | undefined;
    let aiTitle: string | undefined;
    const messages: Message[] = [];

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as JournalEntry;
        if (entry.type === 'header') {
          sessionId = entry.sessionId;
          savedAt = entry.savedAt;
        } else if (entry.type === 'message') {
          messages.push(entry.message);
        } else if (entry.type === 'title') {
          if (entry.titleType === 'custom') customTitle = entry.title;
          else aiTitle = entry.title;
        }
      } catch { /* skip */ }
    }

    if (!sessionId) return null;
    return { sessionId, savedAt, messages, customTitle, aiTitle };
  } catch { return null; }
}

/**
 * Load a session snapshot.
 * Tries .jsonl first, then falls back to legacy .json.
 */
export function loadSnapshot(sessionId: string, cwd?: string): SessionSnapshot | null {
  const jl = jsonlPath(sessionId, cwd);
  if (existsSync(jl)) return _parseSnapshotFromJsonl(jl);

  // Also try searching all project dirs for the sessionId
  const globalProjectsDir = resolve(process.env.HOME ?? '~', '.uagent', 'projects');
  if (existsSync(globalProjectsDir)) {
    for (const proj of readdirSync(globalProjectsDir)) {
      const candidate = resolve(globalProjectsDir, proj, 'sessions', `${sessionId}.jsonl`);
      if (existsSync(candidate)) return _parseSnapshotFromJsonl(candidate);
    }
  }

  // Legacy .json fallback
  const legacyPath = legacyJsonPath(sessionId);
  if (existsSync(legacyPath)) {
    try {
      return JSON.parse(readFileSync(legacyPath, 'utf-8')) as SessionSnapshot;
    } catch { return null; }
  }
  return null;
}

// ── Lite read for list view ───────────────────────────────────────────────────

/**
 * Read only the head and tail of a JSONL file (64KB each) for fast metadata extraction.
 * Mirrors claude-code's lite read approach.
 */
function readHeadTail(filePath: string, bufSize = LITE_BUF_SIZE): { head: string; tail: string } {
  try {
    const fd = openSync(filePath, 'r');
    const stat = statSync(filePath);
    const fileSize = stat.size;

    const headBuf = Buffer.alloc(Math.min(bufSize, fileSize));
    readSync(fd, headBuf, 0, headBuf.length, 0);
    const head = headBuf.toString('utf-8');

    let tail = head;
    if (fileSize > bufSize) {
      const tailBuf = Buffer.alloc(Math.min(bufSize, fileSize));
      readSync(fd, tailBuf, 0, tailBuf.length, Math.max(0, fileSize - bufSize));
      tail = tailBuf.toString('utf-8');
    }

    closeSync(fd);
    return { head, tail };
  } catch {
    return { head: '', tail: '' };
  }
}

/**
 * Extract metadata from JSONL file using lite head/tail read.
 * Fast path for list views — avoids loading all messages.
 */
function extractLiteMetadata(filePath: string): {
  sessionId: string;
  savedAt: number;
  messageCount: number;
  customTitle?: string;
  aiTitle?: string;
  firstPrompt?: string;
  lastPrompt?: string;
} | null {
  try {
    const { head, tail } = readHeadTail(filePath);
    let sessionId = '';
    let savedAt = 0;
    let customTitle: string | undefined;
    let aiTitle: string | undefined;
    let firstPrompt: string | undefined;
    let lastPrompt: string | undefined;
    let messageCount = 0;

    // Parse head for header + first messages
    for (const line of head.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as JournalEntry;
        if (entry.type === 'header') {
          sessionId = entry.sessionId;
          savedAt = entry.savedAt;
        } else if (entry.type === 'message') {
          messageCount++;
          if (!firstPrompt && entry.message.role === 'user') {
            const txt = typeof entry.message.content === 'string'
              ? entry.message.content
              : JSON.stringify(entry.message.content);
            firstPrompt = txt.slice(0, 100);
          }
        } else if (entry.type === 'title') {
          if (entry.titleType === 'custom') customTitle = entry.title;
          else aiTitle = entry.title;
        }
      } catch { /* skip */ }
    }

    // Parse tail for latest title/meta
    if (tail !== head) {
      for (const line of tail.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as JournalEntry;
          if (entry.type === 'title') {
            if (entry.titleType === 'custom') customTitle = entry.title;
            else if (!customTitle) aiTitle = entry.title;
          } else if (entry.type === 'meta' && entry.lastPrompt) {
            lastPrompt = entry.lastPrompt;
          }
        } catch { /* skip */ }
      }
    }

    if (!sessionId) return null;
    return { sessionId, savedAt, messageCount, customTitle, aiTitle, firstPrompt, lastPrompt };
  } catch { return null; }
}

// ── List all snapshots ────────────────────────────────────────────────────────

/** Return all snapshots sorted by mtime descending (newest first), up to limit. */
export function listAllSnapshots(limit = 15, cwd?: string): Array<{
  sessionId: string;
  savedAt: number;
  messageCount: number;
  mtime: number;
  displayTitle?: string;
  firstPrompt?: string;
}> {
  try {
    const results: Array<{
      sessionId: string;
      savedAt: number;
      messageCount: number;
      mtime: number;
      displayTitle?: string;
      firstPrompt?: string;
    }> = [];

    // Collect from CWD-specific project dir
    const sessionsDir = getProjectSessionsDir(cwd);
    ensureDir(sessionsDir);
    _collectFromDir(sessionsDir, results);

    // Also collect from legacy flat dir
    if (existsSync(LEGACY_SESSIONS_DIR)) {
      _collectFromDirLegacy(LEGACY_SESSIONS_DIR, results);
    }

    // Deduplicate by sessionId
    const seen = new Set<string>();
    const deduped = results.filter((r) => {
      if (seen.has(r.sessionId)) return false;
      seen.add(r.sessionId);
      return true;
    });

    return deduped.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  } catch { return []; }
}

function _collectFromDir(dir: string, out: ReturnType<typeof listAllSnapshots>) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    try {
      const p = resolve(dir, f);
      const mtime = statSync(p).mtimeMs;
      const meta = extractLiteMetadata(p);
      if (!meta) continue;
      const displayTitle = meta.customTitle ?? meta.aiTitle ?? meta.firstPrompt;
      out.push({
        sessionId: meta.sessionId,
        savedAt: meta.savedAt,
        messageCount: meta.messageCount,
        mtime,
        displayTitle,
        firstPrompt: meta.firstPrompt,
      });
    } catch { /* skip */ }
  }
}

function _collectFromDirLegacy(dir: string, out: ReturnType<typeof listAllSnapshots>) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const p = resolve(dir, f);
      const mtime = statSync(p).mtimeMs;
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as SessionSnapshot;
      const displayTitle = raw.customTitle ?? raw.aiTitle;
      out.push({
        sessionId: raw.sessionId,
        savedAt: raw.savedAt,
        messageCount: raw.messages.length,
        mtime,
        displayTitle,
      });
    } catch { /* skip */ }
  }
}

/** Return the most recently modified snapshot (any session). */
export function loadLastSnapshot(cwd?: string): SessionSnapshot | null {
  const list = listAllSnapshots(1, cwd);
  if (!list.length) return null;
  return loadSnapshot(list[0]!.sessionId, cwd);
}

export function formatAge(savedAt: number): string {
  const ms = Date.now() - savedAt;
  if (ms < 60_000) return '刚刚';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟前`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} 小时前`;
  return `${Math.round(ms / 86_400_000)} 天前`;
}

// ── Title helpers (claude-code parity) ───────────────────────────────────────

function _findSnapshotFile(sessionId: string, cwd?: string): string | undefined {
  const sessionsDir = getProjectSessionsDir(cwd);
  ensureDir(sessionsDir);

  const jl = resolve(sessionsDir, `${sessionId}.jsonl`);
  if (existsSync(jl)) return jl;

  // Search all project dirs
  const globalProjectsDir = resolve(process.env.HOME ?? '~', '.uagent', 'projects');
  if (existsSync(globalProjectsDir)) {
    for (const proj of readdirSync(globalProjectsDir)) {
      const candidate = resolve(globalProjectsDir, proj, 'sessions', `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  }

  // Legacy .json
  const legacy = legacyJsonPath(sessionId);
  if (existsSync(legacy)) return legacy;
  return undefined;
}

/**
 * Set a user-explicit title for a session snapshot.
 * Appends a 'title' entry to the JSONL file.
 */
export function setCustomTitle(sessionId: string, title: string, cwd?: string): boolean {
  try {
    const file = _findSnapshotFile(sessionId, cwd);
    if (!file) return false;

    if (file.endsWith('.jsonl')) {
      const entry: TitleEntry = { type: 'title', titleType: 'custom', title, savedAt: Date.now() };
      appendEntry(file, entry);
      return true;
    }

    // Legacy .json fallback
    const snap = JSON.parse(readFileSync(file, 'utf-8')) as SessionSnapshot;
    snap.customTitle = title;
    snap.aiTitle = undefined;
    writeFileSync(file, JSON.stringify(snap, null, 2), 'utf-8');
    return true;
  } catch { return false; }
}

/**
 * Set an AI-generated title for a session snapshot.
 * Silently ignored if customTitle is already set.
 */
export function setAiGeneratedTitle(sessionId: string, title: string, cwd?: string): boolean {
  try {
    const file = _findSnapshotFile(sessionId, cwd);
    if (!file) return false;

    if (file.endsWith('.jsonl')) {
      // Check if custom title already exists via lite read
      const { head, tail } = readHeadTail(file);
      const combined = head + tail;
      for (const line of combined.split('\n')) {
        try {
          const entry = JSON.parse(line) as JournalEntry;
          if (entry.type === 'title' && entry.titleType === 'custom') return true; // skip
        } catch { /* skip */ }
      }
      const entry: TitleEntry = { type: 'title', titleType: 'ai', title, savedAt: Date.now() };
      appendEntry(file, entry);
      return true;
    }

    // Legacy .json fallback
    const snap = JSON.parse(readFileSync(file, 'utf-8')) as SessionSnapshot;
    if (snap.customTitle) return true;
    snap.aiTitle = title;
    writeFileSync(file, JSON.stringify(snap, null, 2), 'utf-8');
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

// ── Session cleanup ───────────────────────────────────────────────────────────

/**
 * Remove JSONL session files older than cleanupPeriodDays from the given sessions dir.
 * Called asynchronously after saveSnapshot() to avoid blocking the write path.
 */
export function maybeCleanOldSessions(sessionsDir: string, cleanupPeriodDays: number): void {
  if (cleanupPeriodDays <= 0) return;
  setImmediate(() => {
    try {
      if (!existsSync(sessionsDir)) return;
      const cutoff = Date.now() - cleanupPeriodDays * 86400_000;
      for (const f of readdirSync(sessionsDir)) {
        if (!f.endsWith('.jsonl') && !f.endsWith('.json')) continue;
        const p = resolve(sessionsDir, f);
        try {
          const mtime = statSync(p).mtimeMs;
          if (mtime < cutoff) {
            // Use unlinkSync via dynamic import to avoid top-level import
            const { unlinkSync } = require('fs') as typeof import('fs');
            unlinkSync(p);
          }
        } catch { /* skip individual file errors */ }
      }
    } catch { /* non-fatal */ }
  });
}

// ── Global search ─────────────────────────────────────────────────────────────

export interface SearchResult {
  sessionId: string;
  savedAt: number;
  messageCount: number;
  role: string;
  snippet: string;
  messageIndex: number;
}

/**
 * Search all session snapshots for messages matching query.
 * Returns up to maxResults results sorted by recency (newest first).
 */
export function searchSnapshots(query: string, maxResults = 20, cwd?: string): SearchResult[] {
  if (!query.trim()) return [];
  const q = query.toLowerCase();
  const results: SearchResult[] = [];

  const dirsToSearch: string[] = [getProjectSessionsDir(cwd)];

  // Also search legacy dir
  if (existsSync(LEGACY_SESSIONS_DIR)) dirsToSearch.push(LEGACY_SESSIONS_DIR);

  for (const dir of dirsToSearch) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl') || f.endsWith('.json'))
      .sort((a, b) =>
        statSync(resolve(dir, b)).mtimeMs - statSync(resolve(dir, a)).mtimeMs,
      );

    for (const f of files) {
      if (results.length >= maxResults) break;
      try {
        const snap = loadSnapshot(f.replace(/\.(jsonl|json)$/, ''), cwd);
        if (!snap) continue;
        for (let i = 0; i < snap.messages.length && results.length < maxResults; i++) {
          const m = snap.messages[i]!;
          const text = typeof m.content === 'string'
            ? m.content
            : JSON.stringify(m.content);
          const lower = text.toLowerCase();
          const idx = lower.indexOf(q);
          if (idx === -1) continue;
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
      } catch { /* skip */ }
    }
  }

  return results;
}
