/**
 * statusbar.ts — Bottom-pinned status bar, CodeFlicker-style
 *
 * Layout (single line at very bottom of terminal):
 *   [model | thinking: low] | project-name | 1.2K | 76% | ID a1b2c3d4
 *
 * ── Implementation strategy ──────────────────────────────────────────────────
 *
 * We use the ANSI "Set Scrolling Region" escape to permanently reserve the
 * last row of the terminal for the status bar:
 *
 *   \x1b[1;{rows-1}r   ← limit scroll region to rows 1 … (rows-1)
 *
 * After this, ALL readline output, agent output, spinners etc. can only
 * scroll within the top (rows-1) rows.  The last row is untouched by the
 * kernel scroll and stays as our status bar forever.
 *
 * On resize we recalculate the scroll region and redraw.
 * On exit we restore the full scroll region (\x1b[r) and clear the bar.
 *
 * This is the same technique used by vim, tmux, htop, etc.
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

export function initStatusBar(initialState: Partial<StatusBarState>): void {
  _state = { ..._state, ...initialState };
  _enabled = !!(process.stdout.isTTY);
  if (!_enabled) return;

  _applyScrollRegion();
  _drawBar();

  process.stdout.on('resize', () => {
    if (!_enabled) return;
    _applyScrollRegion();
    _drawBar();
  });
}

export function updateStatusBar(patch: Partial<StatusBarState>): void {
  _state = { ..._state, ...patch };
  if (_enabled) _drawBar();
}

export function clearStatusBar(): void {
  if (!_enabled) return;
  _enabled = false;
  const rows = process.stdout.rows || 24;
  process.stdout.write(
    `\x1b[r` +              // restore full scroll region
    `\x1b7` +               // save cursor
    `\x1b[${rows};1H` +     // go to last row
    `\x1b[2K` +             // erase line
    `\x1b8`,                // restore cursor
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Set the terminal scroll region to rows 1…(rows-1) so that normal output
 * can never overwrite the last row (our status bar).
 *
 * Also moves the cursor one line up if it is currently on the last row,
 * so readline won't try to write its prompt there.
 */
function _applyScrollRegion(): void {
  const rows = process.stdout.rows || 24;
  const scrollBottom = Math.max(1, rows - 1);

  process.stdout.write(
    `\x1b[1;${scrollBottom}r` + // set scroll region: row 1 to row (rows-1)
    `\x1b7` +                   // save cursor
    `\x1b[${scrollBottom};1H` + // move cursor to last line of scroll region
    `\x1b8`,                    // restore cursor
  );
}

function _drawBar(): void {
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

  // Draw on the LAST row (outside the scroll region — never overwritten)
  process.stdout.write(
    `\x1b7` +            // save cursor
    `\x1b[${rows};1H` +  // jump to last row col 1
    `\x1b[2K` +          // erase line
    line +
    `\x1b8`,             // restore cursor (back inside scroll region)
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
