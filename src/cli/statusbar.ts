/**
 * statusbar.ts — Pinned bottom status bar via ANSI scroll-region
 *
 * Strategy:
 *   1. On init, reserve the last terminal row by setting the scroll region to
 *      rows [1 .. (rows-1)], then draw the status bar on the last row.
 *   2. All normal output (including readline) stays inside the scroll region,
 *      so it never overwrites the status line.
 *   3. On every state update we redraw only the last row.
 *   4. On teardown we restore the full scroll region and clear the last row.
 *
 * ANSI sequences used:
 *   \x1b[{top};{bottom}r   — set scroll region
 *   \x1b[s / \x1b[u        — save / restore cursor position
 *   \x1b[{row};1H          — move cursor to row
 *   \x1b[2K                — erase entire line
 *   \x1b[?25l / \x1b[?25h  — hide / show cursor (avoids flicker)
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
let _tty = false;
let _onUpdate: (() => void) | null = null;

function _rows(): number {
  return process.stdout.rows ?? 24;
}

function _cols(): number {
  return process.stdout.columns ?? 80;
}

function _setScrollRegion(top: number, bottom: number) {
  process.stdout.write(`\x1b[${top};${bottom}r`);
}

function _drawBar() {
  if (!_tty) return;
  const row = _rows();
  const line = _buildStatusLine();
  process.stdout.write(
    '\x1b[?25l' +
    '\x1b[s' +
    `\x1b[${row};1H` +
    '\x1b[2K' +
    line +
    '\x1b[u' +
    '\x1b[?25h',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export function initStatusBar(
  initialState: Partial<StatusBarState>,
  onUpdate?: () => void,
): void {
  _state = { ..._state, ...initialState };
  if (onUpdate !== undefined) _onUpdate = onUpdate;

  if (_enabled) {
    _drawBar();
    return;
  }

  _tty = Boolean(process.stdout.isTTY);
  _enabled = true;

  if (_tty) {
    const bottom = _rows() - 1;
    _setScrollRegion(1, bottom);
    _drawBar();

    process.stdout.on('resize', () => {
      const newBottom = _rows() - 1;
      _setScrollRegion(1, newBottom);
      _drawBar();
    });
  }
}

export function updateStatusBar(patch: Partial<StatusBarState>): void {
  _state = { ..._state, ...patch };
  if (_enabled) {
    _drawBar();
    if (_onUpdate) _onUpdate();
  }
}

export function clearStatusBar(): void {
  if (!_tty || !_enabled) { _enabled = false; return; }
  const row = _rows();
  process.stdout.write(
    '\x1b[?25l' +
    '\x1b[s' +
    `\x1b[${row};1H` +
    '\x1b[2K' +
    '\x1b[u' +
    '\x1b[?25h' +
    `\x1b[1;${row}r`,
  );
  _enabled = false;
}

/**
 * Returns a plain single-line prompt (no status line embedded).
 * The status bar is drawn independently on the last terminal row.
 */
export function buildStatusPrompt(domain: string, model?: string): string {
  return _plainPrompt(domain, model);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function _plainPrompt(domain: string, model?: string): string {
  const domainTag = chalk.dim(`[${domain}]`);
  const modelTag  = model
    ? chalk.dim(` ${(model.split('/').pop() ?? model).slice(0, 22)}`)
    : '';
  return `${domainTag}${modelTag} ${chalk.bold.green('❯')} `;
}

function _buildStatusLine(): string {
  const cols = _cols();
  const pct = _state.contextLength > 0
    ? Math.round((_state.estimatedTokens / _state.contextLength) * 100)
    : 0;
  const pctCapped   = Math.min(pct, 100);
  const projectName = basename(process.cwd());
  const modelShort  = (_state.model.split('/').pop() ?? _state.model).slice(0, 28);
  const tokensPart  = _fmtTokens(_state.estimatedTokens);
  const pctPart     = `${pctCapped}%`;
  const idPart      = _state.sessionId.slice(0, 8);

  const content =
    chalk.bgHex('#1e1b4b').dim(' ') +
    chalk.bgHex('#1e1b4b').white(modelShort) +
    _thinkingLabel(_state.isThinking) +
    chalk.bgHex('#1e1b4b').dim(' │ ') +
    chalk.bgHex('#1e1b4b').dim(projectName) +
    chalk.bgHex('#1e1b4b').dim(' │ ') +
    chalk.bgHex('#1e1b4b').dim(tokensPart) +
    chalk.bgHex('#1e1b4b').dim(' │ ') +
    chalk.bgHex('#1e1b4b')(_ctxColor(pctCapped)(pctPart)) +
    chalk.bgHex('#1e1b4b').dim(' │ ') +
    chalk.bgHex('#7c3aed').white(' ID ') +
    chalk.bgHex('#1e1b4b').dim(` ${idPart} `);

  const padding = ' '.repeat(Math.max(0, cols - _stripAnsi(content).length));
  return chalk.bgHex('#1e1b4b')(content + padding);
}

function _stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function _thinkingLabel(t: ThinkingLevel): string {
  if (t === false || t === 'none') return chalk.bgHex('#1e1b4b')('');
  if (t === true  || t === 'low')  return chalk.bgHex('#1e1b4b').dim(' │ ') + chalk.bgHex('#1e1b4b').dim('thinking…');
  if (t === 'medium')              return chalk.bgHex('#1e1b4b').dim(' │ ') + chalk.bgHex('#1e1b4b').yellow('thinking…');
  if (t === 'high')                return chalk.bgHex('#1e1b4b').dim(' │ ') + chalk.bgHex('#1e1b4b').magenta('thinking…');
  return '';
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
