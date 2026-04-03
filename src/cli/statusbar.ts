/**
 * statusbar.ts — Status info embedded in readline prompt (reliable approach)
 *
 * Instead of fighting readline with ANSI cursor tricks, we expose a function
 * that builds the prompt string containing the status info. The caller
 * (index.ts) calls rl.setPrompt(buildPrompt(...)) + rl.prompt() whenever
 * state changes.  This way the status is always shown at the input line,
 * which readline already manages correctly.
 *
 * Visual layout (the prompt itself):
 *   [GLM-5] | kwaibi | 1.2K | 76% | ID a1b2c3d4
 *   [auto] ❯
 *
 * The status line is printed ABOVE the ❯ cursor line as part of the prompt.
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
/** Called by index.ts whenever the prompt needs to be refreshed */
let _onUpdate: (() => void) | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/** Call once at startup. onUpdate is called whenever state changes so the
 *  caller can do rl.setPrompt(buildStatusPrompt(...)) + rl.prompt() */
export function initStatusBar(
  initialState: Partial<StatusBarState>,
  onUpdate?: () => void,
): void {
  _state = { ..._state, ...initialState };
  _enabled = true; // always enabled — no TTY tricks needed
  _onUpdate = onUpdate ?? null;
}

export function updateStatusBar(patch: Partial<StatusBarState>): void {
  _state = { ..._state, ...patch };
  if (_enabled && _onUpdate) _onUpdate();
}

/** No-op — kept for API compatibility */
export function clearStatusBar(): void {
  _enabled = false;
}

/**
 * Build the full readline prompt string that contains both the status line
 * and the input chevron.  Use this with rl.setPrompt().
 *
 * Example output (two lines joined by \n):
 *   \x1b[2m [GLM-5] | project | 1.2K | 0% | ID abc12345\x1b[0m
 *   \x1b[2m[auto]\x1b[0m \x1b[1;32m❯\x1b[0m 
 */
export function buildStatusPrompt(domain: string, model?: string): string {
  if (!_enabled) return _plainPrompt(domain, model);

  const statusLine = _buildStatusLine();
  const inputLine  = _plainPrompt(domain, model);
  return statusLine + '\n' + inputLine;
}

/** Just the ❯ line, no status */
function _plainPrompt(domain: string, model?: string): string {
  const domainTag = chalk.dim(`[${domain}]`);
  const modelTag  = model
    ? chalk.dim(` ${(model.split('/').pop() ?? model).slice(0, 22)}`)
    : '';
  return `${domainTag}${modelTag} ${chalk.bold.green('❯')} `;
}

function _buildStatusLine(): string {
  const pct = _state.contextLength > 0
    ? Math.round((_state.estimatedTokens / _state.contextLength) * 100)
    : 0;
  const pctCapped   = Math.min(pct, 100);
  const projectName = basename(process.cwd());
  const modelShort  = (_state.model.split('/').pop() ?? _state.model).slice(0, 28);
  const tokensPart  = _fmtTokens(_state.estimatedTokens);
  const pctPart     = `${pctCapped}%`;
  const idPart      = _state.sessionId.slice(0, 8);

  return (
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
    chalk.dim(idPart)
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
