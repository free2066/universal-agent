/**
 * statusbar.ts — Status embedded in the readline prompt string
 *
 * ANSI cursor-positioning does not work in all terminal emulators (e.g. the
 * codeflicker sandbox strips cursor-movement sequences).  The only reliable
 * way to show persistent status is to bake it into the readline prompt itself.
 *
 * Layout — two lines joined with \n so readline renders them as one prompt:
 *
 *   ╭─ GLM-5 │ thinking… │ project │ 1.2K │ 76% │ ID a1b2c3d4
 *   ╰❯ _
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
let _onUpdate: (() => void) | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export function initStatusBar(
  initialState: Partial<StatusBarState>,
  onUpdate?: () => void,
): void {
  _state = { ..._state, ...initialState };
  if (onUpdate !== undefined) _onUpdate = onUpdate;
  _enabled = true;
}

export function updateStatusBar(patch: Partial<StatusBarState>): void {
  const wasThinking = _state.isThinking;
  _state = { ..._state, ...patch };
  if (_enabled && _onUpdate) {
    const onlyThinkingChanged =
      Object.keys(patch).length === 1 &&
      'isThinking' in patch &&
      wasThinking !== patch.isThinking;
    if (!onlyThinkingChanged) _onUpdate();
  }
}

export function clearStatusBar(): void {
  _enabled = false;
}

/**
 * Build the two-line prompt string to pass to rl.setPrompt().
 * Line 1: status bar   Line 2: input chevron
 */
export function buildStatusPrompt(domain: string, model?: string): string {
  if (!_enabled) return _inputLine(domain, model);
  return _statusLine() + '\n' + _inputLine(domain, model);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal
// ─────────────────────────────────────────────────────────────────────────────

function _inputLine(domain: string, model?: string): string {
  const domainTag = chalk.dim(`[${domain}]`);
  const modelTag  = model
    ? chalk.dim(` ${(model.split('/').pop() ?? model).slice(0, 22)}`)
    : '';
  return `${domainTag}${modelTag} ${chalk.bold.green('❯')} `;
}

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
  const parts: string[] = [
    chalk.white(modelShort),
    ...(_thinkingPart(_state.isThinking) ? [_thinkingPart(_state.isThinking)!] : []),
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
