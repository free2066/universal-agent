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
