/**
 * statusbar.ts
 *
 * TTY mode  (real terminal, isTTY=true):
 *   prompt  = plain ❯ line
 *   After rl.prompt(), printStatusBar() writes the separator + info line,
 *   then moves cursor back up one row (\x1b[1A\r) so readline input stays
 *   on the ❯ line.
 *
 *   Visual result:
 *     [auto] GLM-5 ❯ _          ← cursor here
 *     ──────────────────────────
 *      GLM-5 │ project │ 0 │ 0% │  ID  a1b2c3d4
 *
 * Non-TTY fallback (pipes, codeflicker sandbox, etc.):
 *   Status line is embedded as the first line of the prompt string so it
 *   still shows up without any cursor tricks.
 *
 *     GLM-5 │ project │ 0 │ 0% │  ID  a1b2c3d4
 *     [auto] GLM-5 ❯ _
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
let _isTTY   = false;
let _onUpdate: (() => void) | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export function initStatusBar(
  initialState: Partial<StatusBarState>,
  onUpdate?: () => void,
): void {
  _state   = { ..._state, ...initialState };
  _isTTY   = Boolean(process.stdout.isTTY);
  _enabled = true;
  if (onUpdate !== undefined) _onUpdate = onUpdate;
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
 * In TTY mode  → plain ❯ line (status is printed by printStatusBar below).
 * In non-TTY   → status line \n ❯ line (embedded, no cursor tricks needed).
 */
export function buildStatusPrompt(domain: string, model?: string): string {
  if (!_enabled)  return _inputLine(domain, model);
  if (_isTTY)     return _inputLine(domain, model);
  return _statusLine() + '\n' + _inputLine(domain, model);
}

/**
 * Call this immediately after every rl.prompt() call.
 *
 * In TTY mode: writes separator + status below the ❯ line, then moves
 * the cursor back up so readline input stays on ❯.
 * In non-TTY: no-op (status already embedded in the prompt string).
 */
export function printStatusBar(): void {
  if (!_enabled || !_isTTY) return;
  const cols = process.stdout.columns ?? 80;
  const sep  = chalk.dim('─'.repeat(cols));
  const info = _statusLine();
  // Write two lines below current cursor, then jump back up two lines.
  process.stdout.write(`\n${sep}\n${info}\x1b[2A\r`);
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
