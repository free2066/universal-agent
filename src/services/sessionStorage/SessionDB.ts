// @ts-nocheck
/**
 * R4: Lightweight session persistence using JSON files.
 *
 * Stores session history in ~/.uagent/sessions/ as JSONL files.
 * Each session gets its own directory:
 *   ~/.uagent/sessions/<sessionId>/
 *     meta.json       — title, model, createdAt, updatedAt, messageCount
 *     messages.jsonl  — one JSON message per line (append-only)
 *
 * This is a pragmatic alternative to SQLite — no additional dependencies,
 * works with Bun's native file I/O, and is human-readable for debugging.
 *
 * For heavier workloads, migrate to better-sqlite3 (add as dependency then
 * replace the implementation here — the interface remains the same).
 */

import fs from 'fs'
import path from 'path'
import { logForDebugging } from '../../utils/debug.js'
import { HOME_DIR } from '../../utils/env.js'

// ──────────────────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────────────────

export interface SessionMeta {
  id: string
  title: string
  model: string
  createdAt: string  // ISO 8601
  updatedAt: string  // ISO 8601
  messageCount: number
  /** Approximate token usage */
  totalTokens?: number
}

export interface StoredMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'tool'
  /** Serialized message content (string or JSON) */
  content: string
  createdAt: string  // ISO 8601
  tokens?: number
}

// ──────────────────────────────────────────────────────────
//  SessionDB
// ──────────────────────────────────────────────────────────

export class SessionDB {
  private readonly sessionsDir: string

  constructor(baseDir?: string) {
    this.sessionsDir = baseDir ?? path.join(HOME_DIR, '.uagent', 'sessions')
    fs.mkdirSync(this.sessionsDir, { recursive: true })
  }

  // ── Session lifecycle ──────────────────────────────────

  /**
   * Create or update a session's metadata file.
   */
  saveSession(session: SessionMeta): void {
    const dir = this._sessionDir(session.id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify({ ...session, updatedAt: new Date().toISOString() }, null, 2),
    )
  }

  /**
   * Load session metadata (without messages).
   */
  loadSession(sessionId: string): SessionMeta | null {
    const metaPath = path.join(this._sessionDir(sessionId), 'meta.json')
    if (!fs.existsSync(metaPath)) return null
    try {
      return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as SessionMeta
    } catch {
      return null
    }
  }

  /**
   * List sessions sorted by updatedAt descending.
   */
  listSessions(limit = 50): SessionMeta[] {
    if (!fs.existsSync(this.sessionsDir)) return []

    const entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true })
    const metas: SessionMeta[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const meta = this.loadSession(entry.name)
      if (meta) metas.push(meta)
    }

    // Sort newest first
    metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return metas.slice(0, limit)
  }

  /**
   * Delete a session and all its messages.
   */
  deleteSession(sessionId: string): void {
    const dir = this._sessionDir(sessionId)
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  // ── Message operations ─────────────────────────────────

  /**
   * Append a message to the session's JSONL file (fast, append-only).
   */
  appendMessage(msg: StoredMessage): void {
    const dir = this._sessionDir(msg.sessionId)
    fs.mkdirSync(dir, { recursive: true })

    const line = JSON.stringify({
      ...msg,
      createdAt: msg.createdAt ?? new Date().toISOString(),
    })

    // Update meta first so messageCount stays consistent even if append crashes
    const meta = this.loadSession(msg.sessionId)
    if (meta) {
      meta.messageCount = (meta.messageCount ?? 0) + 1
      meta.updatedAt = new Date().toISOString()
      this.saveSession(meta)
    }

    fs.appendFileSync(path.join(dir, 'messages.jsonl'), line + '\n')
  }

  /**
   * Load all messages for a session (read entire JSONL file).
   */
  getMessages(sessionId: string): StoredMessage[] {
    const filePath = path.join(this._sessionDir(sessionId), 'messages.jsonl')
    if (!fs.existsSync(filePath)) return []

    try {
      const messages: StoredMessage[] = []
      let invalidLineCount = 0

      for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
        if (!line) continue
        try {
          messages.push(JSON.parse(line) as StoredMessage)
        } catch {
          invalidLineCount++
        }
      }

      if (invalidLineCount > 0) {
        logForDebugging(
          `[SessionDB] Skipped ${invalidLineCount} invalid message line(s) while reading session ${sessionId}`,
          { level: 'warn' },
        )
      }

      return messages
    } catch {
      return []
    }
  }

  /**
   * Get the last N messages for a session (efficient tail read).
   */
  getRecentMessages(sessionId: string, n = 20): StoredMessage[] {
    const all = this.getMessages(sessionId)
    return all.slice(-n)
  }

  // ── Utilities ─────────────────────────────────────────

  /**
   * Format a session list as a readable Markdown table.
   */
  static formatSessionList(sessions: SessionMeta[]): string {
    if (sessions.length === 0) return 'No saved sessions found.'

    const lines = [
      '| # | ID (first 8) | Title | Model | Date | Messages |',
      '|---|-------------|-------|-------|------|----------|',
    ]
    sessions.forEach((s, i) => {
      const date = s.updatedAt.slice(0, 10)
      const shortId = s.id.slice(0, 8)
      const title = (s.title ?? 'untitled').slice(0, 40)
      lines.push(`| ${i + 1} | \`${shortId}\` | ${title} | ${s.model} | ${date} | ${s.messageCount} |`)
    })
    return lines.join('\n')
  }

  private _sessionDir(sessionId: string): string {
    return path.join(this.sessionsDir, sessionId)
  }

  /**
   * Fork an existing session: copy messages up to an optional cutoff,
   * creating a new independent session.
   *
   * @param sourceSessionId  The session to fork from
   * @param newSessionId     ID for the forked session
   * @param upToMessageId    If provided, only copy messages before this ID
   * @returns The new session's metadata
   */
  forkSession(
    sourceSessionId: string,
    newSessionId: string,
    upToMessageId?: string,
  ): SessionMeta | null {
    const sourceMeta = this.loadSession(sourceSessionId)
    if (!sourceMeta) return null

    let messages = this.getMessages(sourceSessionId)
    if (upToMessageId) {
      const cutoff = messages.findIndex(m => m.id === upToMessageId)
      if (cutoff !== -1) messages = messages.slice(0, cutoff + 1)
    }

    // Create new session with forked metadata
    const forkedMeta: SessionMeta = {
      id: newSessionId,
      title: `Fork of ${sourceMeta.title || sourceSessionId.slice(0, 8)}`,
      model: sourceMeta.model,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: messages.length,
      totalTokens: sourceMeta.totalTokens,
    }
    this.saveSession(forkedMeta)

    // Copy messages with updated sessionId
    const dir = this._sessionDir(newSessionId)
    fs.mkdirSync(dir, { recursive: true })
    const lines = messages
      .map(m => JSON.stringify({ ...m, sessionId: newSessionId }))
      .join('\n')
    if (lines) {
      fs.writeFileSync(path.join(dir, 'messages.jsonl'), lines + '\n')
    }

    return forkedMeta
  }
}

// ── Singleton ─────────────────────────────────────────────

let _db: SessionDB | undefined

export function getSessionDB(): SessionDB {
  if (!_db) _db = new SessionDB()
  return _db
}
