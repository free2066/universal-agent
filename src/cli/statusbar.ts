/**
 * statusbar.ts — Bottom-pinned status bar, CodeFlicker-style
 *
 * Layout (single line at bottom of terminal):
 *   [model | thinking: low] | project-name | 1.2K | 76% | ░ID░ abc12345
 *
 * Context % color:  0–60% green · 60–85% yellow · 85–100% red
 *
 * Implementation: uses ANSI escape codes to save/restore cursor position
 * so we can draw the status bar at the bottom without disrupting readline.
 *
 * The bar is redrawn:
 *   - on startup
 *   - after each LLM response (call update())
 *   - on terminal resize
 */

import chalk from 'chalk';
import { basename } from 'path';

export interface StatusBarState {
  model: string;           // e.g. "GLM-5" or "ep-vquxqj-..."
  domain: string;          // e.g. "auto"
  sessionId: string;       // short 8-char hex suffix
  estimatedTokens: number; // current history token estimate
  contextLength: number;   // model context window size
  isThinking: boolean;     // true while LLM is streaming
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
  _enabled = process.stdout.isTTY === true;
  if (!_enabled) return;

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
  // Move to last row, clear line
  process.stdout.write(`\x1b[${rows};0H\x1b[2K`);
}

// ─── Rendering ────────────────────────────────────────────────────────────────

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
  const modelShort   = _state.model.split('/').pop()?.slice(0, 28) ?? _state.model;

  // Build segments (plain text first, then apply chalk for width calc)
  const modelPart   = `[${modelShort}]`;
  const projectPart = projectName;
  const tokensPart  = fmtTokens(_state.estimatedTokens);
  const pctPart     = `${pctCapped}%`;
  const idLabel     = 'ID';
  const idPart      = _state.sessionId.slice(0, 8);

  // Colored segments
  const colored =
    chalk.dim(' ') +
    chalk.dim('[') + chalk.white(modelShort) + chalk.dim(']') +
    chalk.dim(' | ') +
    chalk.dim(projectPart) +
    chalk.dim(' | ') +
    chalk.dim(tokensPart) +
    chalk.dim(' | ') +
    ctxColor(pctCapped)(pctPart) +
    chalk.dim(' | ') +
    chalk.bgHex('#7c3aed').white(` ${idLabel} `) +   // purple ID badge
    ' ' +
    chalk.dim(idPart) +
    chalk.dim(' ');

  // Plain-text width (strip ANSI)
  const plainWidth =
    1 + modelPart.length + 3 + projectPart.length + 3 +
    tokensPart.length + 3 + pctPart.length + 3 +
    idLabel.length + 2 + 1 + idPart.length + 1;

  const padLen = Math.max(0, cols - plainWidth);
  const line   = colored + ' '.repeat(padLen);

  // Save cursor → move to bottom row → write → restore cursor
  process.stdout.write(
    '\x1b7' +                       // save cursor
    `\x1b[${rows};0H` +             // move to last row, col 0
    '\x1b[2K' +                     // clear line
    line +
    '\x1b8',                        // restore cursor
  );

  _lastRenderedWidth = cols;
}
