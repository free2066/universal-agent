/**
 * statusbar.ts — Fixed bottom status bar via ANSI scroll region (TTY only)
 *
 * When running in a real TTY (isTTY = true):
 *   - Reserve the last 2 rows by setting scroll region to [1 .. rows-2]
 *   - Draw separator + status on the last 2 rows
 *   - All readline output stays inside the scroll region → never touches the bar
 *   - On resize, redraw the bar
 *   - On exit, restore full scroll region and clear the bar
 *
 *   Visual result (status bar is ALWAYS at the bottom, unaffected by typing):
 *
 *     [auto] ❯ your input here
 *     ──────────────────────────────────────────────────────────
 *      MiMo-V2-Pro │ project │ 34 │ 0% │  ID  a1b2c3d4
 *
 * Non-TTY fallback (pipes / CI):
 *   Status line is embedded as the first line of the prompt string.
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

function _rows() { return process.stdout.rows  ?? 24; }
function _cols() { return process.stdout.columns ?? 80; }

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

/** Set terminal scroll region to rows [top..bottom] (1-indexed). */
function _setScroll(top: number, bottom: number) {
  process.stdout.write(`\x1b[${top};${bottom}r`);
}

/** Draw separator + status on the last 2 rows without disturbing the cursor. */
function _drawBar() {
  const rows = _rows();
  const cols = _cols();
  const sep  = chalk.dim('─'.repeat(cols));
  const info = _statusLine();

  process.stdout.write(
    '\x1b[?25l'            +   // hide cursor
    '\x1b[s'               +   // save cursor
    `\x1b[${rows - 1};1H`  +   // row rows-1: separator
    '\x1b[2K' + sep        +
    `\x1b[${rows};1H`      +   // row rows: status
    '\x1b[2K' + info       +
    '\x1b[u'               +   // restore cursor
    '\x1b[?25h',               // show cursor
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

  if (_enabled) { _drawBar(); return; }

  _isTTY   = Boolean(process.stdout.isTTY);
  _enabled = true;

  if (_isTTY) {
    const scrollBottom = _rows() - 2;
    _setScroll(1, scrollBottom);
    // Move cursor to bottom of scroll region so subsequent output scrolls up inside it
    process.stdout.write(`\x1b[${scrollBottom};1H`);
    _drawBar();
    process.stdout.on('resize', () => {
      const newBottom = _rows() - 2;
      _setScroll(1, newBottom);
      _drawBar();
    });
  }
}

export function updateStatusBar(patch: Partial<StatusBarState>): void {
  _state = { ..._state, ...patch };
  if (!_enabled) return;
  if (_isTTY) _drawBar();
  if (_onUpdate) {
    const onlyThinking = Object.keys(patch).length === 1 && 'isThinking' in patch;
    if (!onlyThinking) _onUpdate();
  }
}

export function clearStatusBar(): void {
  if (_isTTY && _enabled) {
    const rows = _rows();
    process.stdout.write(
      '\x1b[s'               +
      `\x1b[${rows - 1};1H`  +  '\x1b[2K' +
      `\x1b[${rows};1H`      +  '\x1b[2K' +
      '\x1b[u'               +
      `\x1b[1;${rows}r`,         // restore full scroll region
    );
  }
  _enabled = false;
}

/** No-op in TTY mode (bar drawn independently). In non-TTY, also no-op since
 *  status is embedded in the prompt string via buildStatusPrompt. */
export function printStatusBar(): void {}

/**
 * In TTY mode   → plain ❯ prompt (status bar drawn on reserved bottom rows).
 * In non-TTY    → status line \n ❯ prompt (embedded fallback).
 */
export function buildStatusPrompt(domain: string, _model?: string): string {
  const inputLine = `${chalk.dim(`[${domain}]`)} ${chalk.bold.green('❯')} `;
  if (_isTTY || !_enabled) return inputLine;
  return _statusLine() + '\n' + inputLine;
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
