/**
 * statusbar.ts — Status bar printed below the readline prompt
 *
 * Layout after each rl.prompt():
 *
 *   [domain] model ❯ _
 *   ──────────────────────────────────────────────────────────────────────────
 *    model │ thinking… │ project │ tokens │ ctx% │  ID  xxxxxxxx
 *
 * The ❯ line is the actual readline prompt (cursor sits here).
 * The two lines below are written by printStatusBar() right after rl.prompt().
 * Then we move the cursor back up two lines so readline keeps the cursor on ❯.
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

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export function initStatusBar(
  initialState: Partial<StatusBarState>,
  onUpdate?: () => void,
): void {
  _state = { ..._state, ...initialState };
  _enabled = true;
  // onUpdate is no longer used — status bar is printed by printStatusBar()
  void onUpdate;
}

export function updateStatusBar(patch: Partial<StatusBarState>): void {
  _state = { ..._state, ...patch };
}

export function clearStatusBar(): void {
  _enabled = false;
}

/**
 * Returns the single-line ❯ prompt for rl.setPrompt().
 * Call printStatusBar() right after rl.prompt() to show the status below.
 */
export function buildStatusPrompt(domain: string, model?: string): string {
  return _inputLine(domain, model);
}

/**
 * Write the status bar (separator + info line) below the current cursor,
 * then move the cursor back up so readline keeps it on the ❯ line.
 *
 * Call this immediately after every rl.prompt() call.
 */
export function printStatusBar(): void {
  if (!_enabled) return;
  const cols = process.stdout.columns ?? process.stderr.columns ?? 80;
  const sep  = chalk.dim('─'.repeat(cols));
  const info = _statusLine();
  // Print two lines below, then move cursor back up two lines
  process.stdout.write(`\n${sep}\n${info}\x1b[2A\r`);
  // Re-draw the ❯ prompt text so the cursor is visually correct
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function _inputLine(domain: string, model?: string): string {
  const domainTag = chalk.dim(`[${domain}]`);
  const modelTag  = model
    ? chalk.dim(` ${(model.split('/').pop() ?? model).slice(0, 22)}`)
    : '';
  return `${domainTag}${modelTag} ${chalk.bold.green('❯')} `;
}

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
