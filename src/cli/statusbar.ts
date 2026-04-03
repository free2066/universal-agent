/**
 * statusbar.ts — Bottom-pinned status bar, CodeFlicker-style
 *
 * Layout (single line at very bottom of terminal):
 *   [model | thinking: low] | project-name | 1.2K | 76% | ID a1b2c3d4
 *
 * Context % color:  0–60% green · 60–85% yellow · 85–100% red
 *
 * Implementation: ANSI escape codes to save/restore cursor.
 * The bar is redrawn on startup, after each LLM response, and on terminal resize.
 *
 * Thinking levels (align with codeflicker):
 *   false / 'none'   → not shown
 *   'low'            → shown as dim
 *   'medium'         → shown in yellow
 *   'high'           → shown in magenta
 *   true             → shown as 'low' (legacy boolean)
 */

import chalk from 'chalk';
import { basename } from 'path';

export type ThinkingLevel = boolean | 'none' | 'low' | 'medium' | 'high';

export interface StatusBarState {
  model: string;           // e.g. "GLM-5" or "ep-vquxqj-..."
  domain: string;          // e.g. "auto"
  sessionId: string;       // short 8-char hex suffix
  estimatedTokens: number; // current history token estimate
  contextLength: number;   // model context window size
  isThinking: ThinkingLevel; // false/'none' = idle, 'low'/'medium'/'high' = thinking
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
let _lastRenderedWidth = 0;

/** Call once at startup to enable the status bar */
export function initStatusBar(initialState: Partial<StatusBarState>): void {
  _state = { ..._state, ...initialState };
  // Accept both strict TTY and pipe-forwarded TTY environments
  _enabled = !!(process.stdout.isTTY || process.env.FORCE_COLOR);
  if (!_enabled) return;

  // Reserve bottom line by scrolling up once, then restore
  _reserveBottomLine();

  process.stdout.on('resize', () => render());
  render();
}

/** Update state and re-render */
export function updateStatusBar(patch: Partial<StatusBarState>): void {
  _state = { ..._state, ...patch };
  if (_enabled) render();
}

/** Clear the status bar (call on exit) */
export function clearStatusBar(): void {
  if (!_enabled) return;
  const rows = process.stdout.rows || 24;
  process.stdout.write(
    '\x1b7' +                    // save cursor
    `\x1b[${rows};0H` +          // move to last row
    '\x1b[2K' +                  // clear line
    '\x1b8',                     // restore cursor
  );
}

// ─── Internal ────────────────────────────────────────────────────────────────

/**
 * Scroll the terminal up by 1 line to reserve space at the bottom.
 * This prevents the status bar from being overwritten by readline's prompt.
 */
function _reserveBottomLine(): void {
  // Save cursor, move to last row, print empty line (causes scroll), restore
  const rows = process.stdout.rows || 24;
  process.stdout.write(
    '\x1b7' +
    `\x1b[${rows};0H` +
    '\x1b[2K' +
    '\x1b8',
  );
}

function _thinkingLabel(t: ThinkingLevel): string {
  if (t === false || t === 'none') return '';
  if (t === true  || t === 'low')    return chalk.dim(' | thinking: ') + chalk.dim('low');
  if (t === 'medium')                return chalk.dim(' | thinking: ') + chalk.yellow('medium');
  if (t === 'high')                  return chalk.dim(' | thinking: ') + chalk.magenta('high');
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

function render(): void {
  if (!_enabled) return;
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows    || 24;

  const pct = _state.contextLength > 0
    ? Math.round((_state.estimatedTokens / _state.contextLength) * 100)
    : 0;
  const pctCapped = Math.min(pct, 100);

  const projectName = basename(process.cwd());
  const modelRaw    = _state.model;
  // Show at most 28 chars: prefer last path segment (e.g. "claude-4.6-sonnet")
  const modelShort  = modelRaw.split('/').pop()?.slice(0, 28) ?? modelRaw;

  const tokensPart  = fmtTokens(_state.estimatedTokens);
  const pctPart     = `${pctCapped}%`;
  const idPart      = _state.sessionId.slice(0, 8);

  // ── Colored render ──────────────────────────────────────────────────────
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

  // ── Plain-text width (no ANSI codes) ────────────────────────────────────
  const plainWidth =
    2 + modelShort.length +                          // ' [model'
    _thinkingLabelPlain(_state.isThinking).length +  // ' | thinking: low'
    4 +                                              // '] | '
    projectName.length + 3 +                         // 'project | '
    tokensPart.length + 3 +                          // '1.2K | '
    pctPart.length + 3 +                             // '76% | '
    4 + 1 +                                          // ' ID  '
    idPart.length + 1;                               // 'abc12345 '

  const padLen = Math.max(0, cols - plainWidth);
  const line   = colored + ' '.repeat(padLen);

  // ── Write: save cursor → bottom row → clear → write → restore ───────────
  process.stdout.write(
    '\x1b7' +                       // save cursor
    `\x1b[${rows};0H` +             // move to last row, col 0
    '\x1b[2K' +                     // clear line
    line +
    '\x1b8',                        // restore cursor
  );

  _lastRenderedWidth = cols;
}
