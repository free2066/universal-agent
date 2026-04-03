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

let _enabled  = false;
let _isTTY    = false;
let _onUpdate: (() => void) | null = null;

function _rows() { return process.stdout.rows    ?? process.stderr.rows    ?? 24; }
function _cols() { return process.stdout.columns ?? process.stderr.columns ?? 80; }

function _drawBar() {
  const row  = _rows();
  const info = _statusLine();
  process.stdout.write(
    '\x1b[?25l'       +
    '\x1b[s'          +
    `\x1b[${row};1H`  +
    '\x1b[2K' + info  +
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
  _state  = { ..._state, ...initialState };
  _isTTY  = Boolean(process.stdout.isTTY) || Boolean((process.stdout as NodeJS.WriteStream & { fd?: number }).fd === 1 && process.env.TERM && process.env.TERM !== 'dumb');
  if (onUpdate !== undefined) _onUpdate = onUpdate;

  if (_enabled) {
    if (_isTTY) _drawBar();
    return;
  }

  _enabled = true;

  if (_isTTY) {
    const scrollBottom = _rows() - 1;
    // Set scroll region so last row is reserved for status bar
    process.stdout.write(`\x1b[1;${scrollBottom}r`);
    // Move cursor to bottom of scroll region
    process.stdout.write(`\x1b[${scrollBottom};1H`);
    _drawBar();
    process.stdout.on('resize', () => {
      const nb = _rows() - 1;
      process.stdout.write(`\x1b[1;${nb}r`);
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
      '\x1b[s'         +
      `\x1b[${rows};1H` + '\x1b[2K' +
      '\x1b[u'          +
      `\x1b[1;${rows}r`,
    );
  }
  _enabled = false;
}

export function printStatusBar(): void {}

export function buildStatusPrompt(domain: string, _model?: string): string {
  const chevron = `${chalk.dim(`[${domain}]`)} ${chalk.bold.green('❯')} `;
  if (_isTTY || !_enabled) return chevron;
  // Non-TTY fallback: embed status above ❯
  return _statusLine() + '\n' + chevron;
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
