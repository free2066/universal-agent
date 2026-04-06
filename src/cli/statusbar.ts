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
  /** D26: API 精确 token 数（含 cache tokens），来自最后一次 API response */
  apiTokensUsed?: number;
  /** D26: cache_creation_input_tokens（写入新 cache 的 token 数） */
  cacheCreationTokens?: number;
  /** D26: cache_read_input_tokens（命中 cache 的 token 数） */
  cacheReadTokens?: number;
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

/**
 * 绘制底部状态栏
 *
 * 策略：\x1b[s 保存光标 → 跳到状态栏行画 → \x1b[u 恢复光标
 *
 * 之前用 \x1b[s/\x1b[u 时出现状态栏叠加，是因为 spinner 用了 \x1b[1A（向上移动光标），
 * 导致 \x1b[s 保存的位置错乱。现在 spinner 已改为单行 \r\x1b[2K 覆写（不移动光标），
 * \x1b[s/\x1b[u 可以安全使用 —— 恢复后光标精确回到 readline 管理的位置（❯ 后面）。
 */
function _drawBar() {
  const row = _rows();
  if (row <= 0) return;
  _ttyWrite(
    '\x1b[?25l'      +   // 隐藏光标（防闪烁）
    '\x1b[s'         +   // 保存当前光标位置（readline 管理的 ❯ 后面）
    `\x1b[${row};1H` +   // 绝对跳到最后一行（状态栏专用行）
    '\x1b[2K'        +   // 清行
    _statusLine()    +   // 状态栏内容
    '\x1b[u'         +   // 恢复光标到 ❯ 后面
    '\x1b[?25h',         // 恢复光标显示
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

  const totalRows   = _rows();
  // 布局（从下往上）：
  //   row totalRows   — 状态栏（statusbar 专用）
  //   row totalRows-1 — spinner 专用行（CliSpinner 写这里）
  //   row 1 .. totalRows-2 — 滚动区（readline + LLM 输出）
  const scrollBottom = Math.max(1, totalRows - 2);
  _ttyWrite(`\x1b[1;${scrollBottom}r`);
  // 把光标定位到滚动区底部（readline 将从这里开始 prompt）
  _ttyWrite(`\x1b[${scrollBottom};1H`);
  _drawBar();

  process.stdout.on('resize', () => {
    const totalR = _rows();
    const nb = Math.max(1, totalR - 2);
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
    // 清除状态栏行 + spinner 行，恢复全屏滚动区域
    _ttyWrite(
      `\x1b[${row - 1};1H\x1b[2K` +   // 清 spinner 行
      `\x1b[${row};1H\x1b[2K`     +   // 清 statusbar 行
      `\x1b[1;${row}r`,                // 恢复全屏滚动
    );
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

  // D26: 优先使用 API 精确 token 数（含 cache tokens）；fallback 到估算值
  // Mirrors claude-code calculateContextPercentages() src/utils/context.ts L118-144.
  const displayTokens = _state.apiTokensUsed !== undefined
    ? _state.apiTokensUsed   // API response 精确值（含 cache_creation + cache_read）
    : _state.estimatedTokens;

  const pct  = _state.contextLength > 0
    ? Math.round((displayTokens / _state.contextLength) * 100)
    : 0;
  const pctCapped   = Math.min(pct, 100);
  const projectName = basename(process.cwd());
  const modelShort  = (_state.model.split('/').pop() ?? _state.model).slice(0, 28);
  const tokensPart  = _fmtTokens(displayTokens);
  const idPart      = _state.sessionId.slice(0, 8);

  // D26: cache 命中率显示（cache_read / total * 100）
  const totalRaw = (_state.cacheCreationTokens ?? 0) + (_state.cacheReadTokens ?? 0);
  const cacheHitPct = totalRaw > 0 && _state.apiTokensUsed
    ? Math.round((_state.cacheReadTokens ?? 0) / _state.apiTokensUsed * 100)
    : null;

  const bg  = chalk.bgHex('#1e1b4b');
  const sep = bg.dim(' │ ');
  const thinking = _thinkingPart(_state.isThinking);

  const parts: string[] = [
    bg.white(modelShort),
    ...(thinking ? [thinking] : []),
    bg.dim(projectName),
    bg.dim(`${tokensPart}${cacheHitPct !== null ? chalk.bgHex('#1e1b4b').dim(` (cache:${cacheHitPct}%)`) : ''}`),
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
  if (t === true)                  return bg.dim('🧠 thinking: low');
  if (t === 'low')                 return bg.cyan('🧠 thinking: low');
  if (t === 'medium')              return bg.yellow('🧠 thinking: medium');
  if (t === 'high')                return bg.magenta('🧠 thinking: high');
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
