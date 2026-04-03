/**
 * statusbar.ts — Bottom-pinned status bar, CodeFlicker-style
 *
 * Layout (single line at very bottom of terminal):
 *   [model | thinking: low] | project-name | 1.2K | 76% | ID a1b2c3d4
 *
 * Strategy:
 *   The status bar occupies the LAST row of the terminal exclusively.
 *   All other content (readline prompt, agent output) stays in rows 1..(rows-1).
 *
 *   We intercept process.stdout.write:
 *     1. Before each write  → erase the status bar line (last row)
 *     2. Perform the write normally
 *     3. After each write   → redraw the status bar on the last row
 *
 *   Additionally, on init we print a blank line to push the readline prompt
 *   UP by one row, so it never sits on top of the status bar.
 *
 * Thinking levels:
 *   false / 'none'   → not shown
 *   'low'            → dim
 *   'medium'         → yellow
 *   'high'           → magenta
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
let _patched = false;
let _inBarOp = false; // prevent re-entrant bar writes
let _origWrite: ((chunk: Uint8Array | string, enc?: unknown, cb?: unknown) => boolean);

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export function initStatusBar(initialState: Partial<StatusBarState>): void {
  _state = { ..._state, ...initialState };
  _enabled = !!(process.stdout.isTTY);
  if (!_enabled) return;

  _patchStdout();
  process.stdout.on('resize', () => {
    if (_enabled) _rawDrawBar();
  });

  // Push cursor up by one line so readline prompt is NOT on the last row.
  // The last row is reserved for the status bar.
  _origWrite('\n');
  _rawDrawBar();
}

export function updateStatusBar(patch: Partial<StatusBarState>): void {
  _state = { ..._state, ...patch };
  if (_enabled) _rawDrawBar();
}

export function clearStatusBar(): void {
  if (!_enabled) return;
  _enabled = false;
  _rawEraseBar();
}

// ─────────────────────────────────────────────────────────────────────────────
// stdout patching
// ─────────────────────────────────────────────────────────────────────────────

function _patchStdout(): void {
  if (_patched) return;
  _patched = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _origWrite = (process.stdout.write as any).bind(process.stdout);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = function (
    chunk: Uint8Array | string,
    enc?: unknown,
    cb?: unknown,
  ): boolean {
    if (_inBarOp || !_enabled) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return _origWrite(chunk, enc as any, cb as any);
    }
    _inBarOp = true;
    _rawEraseBar();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = _origWrite(chunk, enc as any, cb as any);
    _rawDrawBar();
    _inBarOp = false;
    return r;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Low-level bar operations (use _origWrite to avoid recursion)
// ─────────────────────────────────────────────────────────────────────────────

function _rawEraseBar(): void {
  const rows = process.stdout.rows || 24;
  _origWrite(
    `\x1b7` +            // save cursor
    `\x1b[${rows};1H` +  // move to last row col 1
    `\x1b[2K` +          // erase entire line
    `\x1b8`,             // restore cursor
  );
}

function _rawDrawBar(): void {
  if (!_enabled) return;
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows    || 24;

  const pct = _state.contextLength > 0
    ? Math.round((_state.estimatedTokens / _state.contextLength) * 100)
    : 0;
  const pctCapped = Math.min(pct, 100);

  const projectName = basename(process.cwd());
  const modelShort  = (_state.model.split('/').pop() ?? _state.model).slice(0, 28);
  const tokensPart  = _fmtTokens(_state.estimatedTokens);
  const pctPart     = `${pctCapped}%`;
  const idPart      = _state.sessionId.slice(0, 8);

  const colored =
    chalk.dim(' [') +
    chalk.white(modelShort) +
    _thinkingLabel(_state.isThinking) +
    chalk.dim('] | ') +
    chalk.dim(projectName) +
    chalk.dim(' | ') +
    chalk.dim(tokensPart) +
    chalk.dim(' | ') +
    _ctxColor(pctCapped)(pctPart) +
    chalk.dim(' | ') +
    chalk.bgHex('#7c3aed').white(' ID ') +
    ' ' +
    chalk.dim(idPart) +
    ' ';

  const plainLen =
    2 + modelShort.length +
    _thinkingLabelPlain(_state.isThinking).length +
    4 + projectName.length +
    3 + tokensPart.length +
    3 + pctPart.length +
    3 + 4 + 1 + idPart.length + 1;

  const pad  = Math.max(0, cols - plainLen);
  const line = colored + ' '.repeat(pad);

  _origWrite(
    `\x1b7` +            // save cursor
    `\x1b[${rows};1H` +  // move to LAST row col 1
    `\x1b[2K` +          // erase line
    line +
    `\x1b8`,             // restore cursor (back to input area)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function _thinkingLabel(t: ThinkingLevel): string {
  if (t === false || t === 'none') return '';
  if (t === true  || t === 'low')  return chalk.dim(' | thinking: ') + chalk.dim('low');
  if (t === 'medium')              return chalk.dim(' | thinking: ') + chalk.yellow('medium');
  if (t === 'high')                return chalk.dim(' | thinking: ') + chalk.magenta('high');
  return '';
}

function _thinkingLabelPlain(t: ThinkingLevel): string {
  if (t === false || t === 'none') return '';
  if (t === true  || t === 'low')  return ' | thinking: low';
  if (t === 'medium')              return ' | thinking: medium';
  if (t === 'high')                return ' | thinking: high';
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
