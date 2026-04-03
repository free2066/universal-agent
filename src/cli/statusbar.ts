import chalk from 'chalk';
import { basename } from 'path';
import { execFileSync } from 'child_process';
import { openSync, writeSync } from 'fs';

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

let _enabled  = false;
let _ttyFd    = -1;
let _onUpdate: (() => void) | null = null;

function _openTTY(): number {
  try { return openSync('/dev/tty', 'r+'); } catch { return -1; }
}

function _ttyWrite(s: string) {
  if (_ttyFd >= 0) {
    writeSync(_ttyFd, s);
  } else {
    process.stdout.write(s);
  }
}

function _rows(): number {
  try {
    const v = parseInt(execFileSync('tput', ['lines'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim(), 10);
    if (v > 0) return v;
  } catch {}
  return process.stdout.rows ?? 24;
}

function _cols(): number {
  try {
    const v = parseInt(execFileSync('tput', ['cols'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim(), 10);
    if (v > 0) return v;
  } catch {}
  return process.stdout.columns ?? 80;
}

function _drawBar() {
  const row = _rows();
  if (row <= 0) return;
  _ttyWrite(
    '\x1b[?25l'       +
    '\x1b[s'          +
    `\x1b[${row};1H`  +
    '\x1b[2K'         +
    _statusLine()     +
    '\x1b[u'          +
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

  _enabled = true;
  _ttyFd   = _openTTY();

  const scrollBottom = _rows() - 1;
  _ttyWrite(`\x1b[1;${scrollBottom}r`);
  _ttyWrite(`\x1b[${scrollBottom};1H`);
  _drawBar();

  process.stdout.on('resize', () => {
    const nb = _rows() - 1;
    _ttyWrite(`\x1b[1;${nb}r`);
    _drawBar();
  });
}

export function updateStatusBar(patch: Partial<StatusBarState>): void {
  _state = { ..._state, ...patch };
  if (!_enabled) return;
  _drawBar();
  if (_onUpdate) {
    const onlyThinking = Object.keys(patch).length === 1 && 'isThinking' in patch;
    if (!onlyThinking) _onUpdate();
  }
}

export function clearStatusBar(): void {
  if (_enabled) {
    const row = _rows();
    _ttyWrite(`\x1b[s\x1b[${row};1H\x1b[2K\x1b[u\x1b[1;${row}r`);
  }
  _enabled = false;
}

/** Called after every rl.prompt() — redraws the bar in case readline scrolled over it */
export function printStatusBar(): void {
  if (_enabled) _drawBar();
}

export function buildStatusPrompt(domain: string, _model?: string): string {
  return `${chalk.dim(`[${domain}]`)} ${chalk.bold.green('❯')} `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal
// ─────────────────────────────────────────────────────────────────────────────

function _statusLine(): string {
  const cols = _cols();
  const pct  = _state.contextLength > 0
    ? Math.round((_state.estimatedTokens / _state.contextLength) * 100)
    : 0;
  const pctCapped   = Math.min(pct, 100);
  const projectName = basename(process.cwd());
  const modelShort  = (_state.model.split('/').pop() ?? _state.model).slice(0, 28);
  const tokensPart  = _fmtTokens(_state.estimatedTokens);
  const idPart      = _state.sessionId.slice(0, 8);

  const bg  = chalk.bgHex('#1e1b4b');
  const sep = bg.dim(' │ ');
  const thinking = _thinkingPart(_state.isThinking);

  const parts: string[] = [
    bg.white(modelShort),
    ...(thinking ? [thinking] : []),
    bg.dim(projectName),
    bg.dim(tokensPart),
    bg(_ctxColor(pctCapped)(`${pctCapped}%`)),
    chalk.bgHex('#7c3aed').white(' ID ') + bg.dim(` ${idPart}`),
  ];

  const content = bg(' ') + parts.join(sep);
  const visLen  = content.replace(/\x1b\[[0-9;]*m/g, '').length;
  return content + bg(' '.repeat(Math.max(0, cols - visLen)));
}

function _thinkingPart(t: ThinkingLevel): string | null {
  const bg = chalk.bgHex('#1e1b4b');
  if (t === false || t === 'none') return null;
  if (t === true  || t === 'low')  return bg.dim('thinking…');
  if (t === 'medium')              return bg.yellow('thinking…');
  if (t === 'high')                return bg.magenta('thinking…');
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
