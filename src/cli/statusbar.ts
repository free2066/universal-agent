/**
 * statusbar.ts
 *
 * Status bar is printed as a block between the AI response and the next prompt:
 *
 *   ❯ your input
 *   ...AI response...
 *   ──────────────────────────────────────────────────────
 *    MiMo-V2-Pro │ project │ 34 │ 0% │  ID  a1b2c3d4
 *   ❯ _
 *
 * No cursor tricks — printStatusBar() just writes two lines normally before
 * rl.prompt() is called.  readline always owns the ❯ line cleanly.
 */

import chalk from 'chalk';
import { basename } from 'path';

export type ThinkingLevel = boolean | 'none' | 'low' | 'medium' | 'high';

export interface StatusBarState {
  model: string;
  domain: string;
  sessionId: string;
  estimatedTokens: number;
  contextLength: number;
  isThinking: ThinkingLevel;
}

let _state: StatusBarState = {
  model: '',
  domain: 'auto',
  sessionId: '',
  estimatedTokens: 0,
  contextLength: 128000,
  isThinking: false,
};

let _enabled = false;
let _onUpdate: (() => void) | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export function initStatusBar(
  initialState: Partial<StatusBarState>,
  onUpdate?: () => void,
): void {
  _state = { ..._state, ...initialState };
  if (onUpdate !== undefined) _onUpdate = onUpdate;
  _enabled = true;
}

export function updateStatusBar(patch: Partial<StatusBarState>): void {
  _state = { ..._state, ...patch };
  if (_enabled && _onUpdate) {
    const onlyThinking = Object.keys(patch).length === 1 && 'isThinking' in patch;
    if (!onlyThinking) _onUpdate();
  }
}

export function clearStatusBar(): void {
  _enabled = false;
}

/**
 * Print separator + status line.
 * Call this BEFORE rl.prompt() so the status appears above the new ❯ line.
 */
export function printStatusBar(): void {
  if (!_enabled) return;
  const cols = process.stdout.columns ?? process.stderr.columns ?? 80;
  const sep  = chalk.dim('─'.repeat(cols));
  process.stdout.write(`${sep}\n${_statusLine()}\n`);
}

/** Plain single-line ❯ prompt — no status embedded. */
export function buildStatusPrompt(domain: string, _model?: string): string {
  return `${chalk.dim(`[${domain}]`)} ${chalk.bold.green('❯')} `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal
// ─────────────────────────────────────────────────────────────────────────────

function _statusLine(): string {
  const pct = _state.contextLength > 0
    ? Math.round((_state.estimatedTokens / _state.contextLength) * 100)
    : 0;
  const pctCapped   = Math.min(pct, 100);
  const projectName = basename(process.cwd());
  const modelShort  = (_state.model.split('/').pop() ?? _state.model).slice(0, 28);
  const tokensPart  = _fmtTokens(_state.estimatedTokens);
  const idPart      = _state.sessionId.slice(0, 8);

  const sep = chalk.dim(' │ ');
  const thinking = _thinkingPart(_state.isThinking);
  const parts: string[] = [
    chalk.white(modelShort),
    ...(thinking ? [thinking] : []),
    chalk.dim(projectName),
    chalk.dim(tokensPart),
    _ctxColor(pctCapped)(`${pctCapped}%`),
    chalk.bgHex('#7c3aed').white(' ID ') + ' ' + chalk.dim(idPart),
  ];

  return chalk.dim(' ') + parts.join(sep);
}

function _thinkingPart(t: ThinkingLevel): string | null {
  if (t === false || t === 'none') return null;
  if (t === true  || t === 'low')  return chalk.dim('thinking…');
  if (t === 'medium')              return chalk.yellow('thinking…');
  if (t === 'high')                return chalk.magenta('thinking…');
  return null;
}

function _ctxColor(pct: number): (s: string) => string {
  if (pct >= 85) return chalk.red;
  if (pct >= 60) return chalk.yellow;
  return chalk.green;
}

function _fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}
