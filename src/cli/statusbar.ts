/**
 * statusbar.ts — Bottom-pinned status bar, CodeFlicker-style
 *
 * Layout (single line at very bottom of terminal):
 *   [model | thinking: low] | project-name | 1.2K | 76% | ID a1b2c3d4
 *
 * Context % color:  0–60% green · 60–85% yellow · 85–100% red
 *
 * Implementation:
 *   Uses a "wrapping stdout" strategy: all writes to process.stdout are
 *   intercepted. Before each write we erase the status bar line; after
 *   the write we redraw it. This keeps the bar pinned regardless of how
 *   much output readline or the agent produces.
 *
 * Thinking levels:
 *   false / 'none'   → not shown
 *   'low'            → shown as dim
 *   'medium'         → shown in yellow
 *   'high'           → shown in magenta
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
// Whether we have patched process.stdout.write
let _patched = false;
// The original write function
let _origWrite: typeof process.stdout.write;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/** Call once at startup to enable the status bar */
export function initStatusBar(initialState: Partial<StatusBarState>): void {
  _state = { ..._state, ...initialState };
  _enabled = !!(process.stdout.isTTY || process.env.FORCE_COLOR);
  if (!_enabled) return;

  _patchStdout();
  process.stdout.on('resize', () => _drawBar());
  _drawBar();
}

/** Update state and re-render */
export function updateStatusBar(patch: Partial<StatusBarState>): void {
  _state = { ..._state, ...patch };
  if (_enabled) {
    _eraseBar();
    _drawBar();
  }
}

/** Clear the status bar permanently (call on exit) */
export function clearStatusBar(): void {
  if (!_enabled) return;
  _eraseBar();
  _enabled = false;
}

// ─────────────────────────────────────────────────────────────────────────────
// stdout patching — intercept all writes so we can erase/redraw around them
// ─────────────────────────────────────────────────────────────────────────────

function _patchStdout(): void {
  if (_patched) return;
  _patched = true;
  _origWrite = process.stdout.write.bind(process.stdout);

  // Override write: erase bar → write real content → redraw bar
  // We must NOT intercept our own bar writes (guard with _inBarWrite flag).
  let _inBarWrite = false;

  (process.stdout as NodeJS.WriteStream).write = function (
    chunk: Uint8Array | string,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean {
    if (_inBarWrite) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return _origWrite(chunk as any, encodingOrCb as any, cb as any);
    }
    _inBarWrite = true;
    _eraseBarRaw();                                   // erase bar before content
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = _origWrite(chunk as any, encodingOrCb as any, cb as any);
    _drawBarRaw();                                    // redraw bar after content
    _inBarWrite = false;
    return result;
  } as typeof process.stdout.write;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bar rendering helpers
// ─────────────────────────────────────────────────────────────────────────────

function _eraseBar(): void {
  if (!_enabled || !_patched) return;
  _eraseBarRaw();
}

/** Erase the last row (status bar). Uses the real write to avoid recursion. */
function _eraseBarRaw(): void {
  const rows = process.stdout.rows || 24;
  _origWrite(
    '\x1b7' +             // save cursor
    `\x1b[${rows};1H` +   // move to last row, col 1
    '\x1b[2K' +           // erase line
    '\x1b8',              // restore cursor
  );
}

function _drawBar(): void {
  if (!_enabled || !_patched) return;
  _drawBarRaw();
}

/** Draw the status bar on the last row. Uses the real write to avoid recursion. */
function _drawBarRaw(): void {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows    || 24;

  const pct = _state.contextLength > 0
    ? Math.round((_state.estimatedTokens / _state.contextLength) * 100)
    : 0;
  const pctCapped = Math.min(pct, 100);

  const projectName = basename(process.cwd());
  const modelRaw    = _state.model;
  const modelShort  = modelRaw.split('/').pop()?.slice(0, 28) ?? modelRaw;

  const tokensPart = fmtTokens(_state.estimatedTokens);
  const pctPart    = `${pctCapped}%`;
  const idPart     = _state.sessionId.slice(0, 8);

  // Colored
  const colored =
    chalk.dim(' [') +
    chalk.white(modelShort) +
    _thinkingLabel(_state.isThinking) +
    chalk.dim('] | ') +
    chalk.dim(projectName) +
    chalk.dim(' | ') +
    chalk.dim(tokensPart) +
    chalk.dim(' | ') +
    ctxColor(pctCapped)(pctPart) +
    chalk.dim(' | ') +
    chalk.bgHex('#7c3aed').white(' ID ') +
    ' ' +
    chalk.dim(idPart) +
    chalk.dim(' ');

  // Plain-text width (no ANSI codes)
  const plainWidth =
    2 + modelShort.length +
    _thinkingLabelPlain(_state.isThinking).length +
    4 +
    projectName.length + 3 +
    tokensPart.length + 3 +
    pctPart.length + 3 +
    5 +
    idPart.length + 1;

  const padLen = Math.max(0, cols - plainWidth);
  const line   = colored + ' '.repeat(padLen);

  _origWrite(
    '\x1b7' +             // save cursor
    `\x1b[${rows};1H` +   // move to last row, col 1
    '\x1b[2K' +           // erase line
    line +
    '\x1b8',              // restore cursor
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
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

function ctxColor(pct: number): (s: string) => string {
  if (pct >= 85) return chalk.red;
  if (pct >= 60) return chalk.yellow;
  return chalk.green;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}
