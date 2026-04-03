/**
 * log.ts — uagent log subcommand
 *
 * Aligns with `flickcli log`:
 *   uagent log [-n 10] [--json] [--id <session_id>]
 *
 * Shows session history from ~/.uagent/sessions/
 */

import chalk from 'chalk';
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { resolve, join } from 'path';

const SESSIONS_DIR = resolve(process.env.HOME || '~', '.uagent', 'sessions');

interface SessionEntry {
  sessionId: string;
  savedAt: number;
  messages: Array<{ role: string; content: unknown }>;
}

function formatAge(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return 'just now';
}

function getFirstPrompt(messages: Array<{ role: string; content: unknown }>): string {
  for (const m of messages) {
    if (m.role === 'user') {
      const c = m.content;
      const text = typeof c === 'string' ? c :
        Array.isArray(c) ? c.find((x: { type: string; text?: string }) => x.type === 'text')?.text ?? '' : '';
      if (text.trim()) return text.trim().slice(0, 80);
    }
  }
  return '(no user messages)';
}

export interface LogOptions {
  n?: string;
  json?: boolean;
  id?: string;
}

export function runLog(opts: LogOptions): void {
  if (!existsSync(SESSIONS_DIR)) {
    console.log(chalk.dim('\n  No sessions found.\n'));
    return;
  }

  const files = readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const fp = join(SESSIONS_DIR, f);
      return { file: fp, mtime: statSync(fp).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  const limit = parseInt(opts.n ?? '10', 10);
  const entries: SessionEntry[] = [];

  for (const { file } of files.slice(0, limit * 2)) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf-8')) as SessionEntry;
      if (opts.id && !data.sessionId.includes(opts.id)) continue;
      entries.push(data);
      if (entries.length >= limit) break;
    } catch { /* skip corrupt files */ }
  }

  if (opts.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  if (entries.length === 0) {
    console.log(chalk.dim('\n  No sessions found.\n'));
    return;
  }

  process.stdout.write('\n');
  process.stdout.write(
    chalk.bold.white('  Session Log') +
    chalk.dim(` — ${entries.length} sessions`) +
    '\n\n',
  );

  const W = Math.min(process.stdout.columns || 80, 100);
  process.stdout.write(chalk.dim('  ' + '─'.repeat(W - 4)) + '\n');

  for (const entry of entries) {
    const shortId = entry.sessionId.replace('session-', '').slice(-8);
    const date = new Date(entry.savedAt).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
    const turns = Math.floor(entry.messages.length / 2);
    const preview = getFirstPrompt(entry.messages);
    const age = formatAge(entry.savedAt);

    process.stdout.write(
      '  ' +
      chalk.bgHex('#7c3aed').white(` ${shortId} `) +
      '  ' +
      chalk.dim(date) +
      chalk.dim(`  ${age}`) +
      chalk.dim(`  ${turns} turn${turns !== 1 ? 's' : ''}`) +
      '\n',
    );
    process.stdout.write(
      '  ' +
      chalk.dim('  ') +
      chalk.white(preview) +
      (preview.length >= 80 ? chalk.dim('…') : '') +
      '\n\n',
    );
  }

  process.stdout.write(chalk.dim(`  Sessions stored in: ${SESSIONS_DIR}\n`));
  process.stdout.write(chalk.dim('  Tip: uagent log -n 20  — show more\n\n'));
}
