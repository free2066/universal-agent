/**
 * CliSpinner — 固定行 spinner，与底部状态栏协调
 *
 * 设计约束（修订版）：
 *  - spinner 专用行 = 倒数第 2 行（rows - 1），status bar 在最后一行（rows）
 *  - 渲染走 /dev/tty（与 statusbar 使用同一 fd 序列，避免 stdout ANSI 状态撕裂）
 *  - 用 \x1b[s → 跳到 rows-1 → 写内容 → \x1b[u 恢复，与 statusbar 同策略
 *  - statusbar.ts 的滚动区域设为 1..(rows-2)，为 spinner 行腾出位置
 *
 * 交互流程：
 *  1. start('thinking')     → spinner 行：⠋ Thinking···
 *  2. setMode('tool-use')   → spinner 行：⠋ Using tools  ✓ LS  ● Read …
 *  3. stop(true)            → 清除 spinner 行，在 stdout 打印工具调用结果（静态）
 *  4. stop(false)           → 仅清除 spinner 行
 */

import chalk from 'chalk';
import { openSync, writeSync } from 'fs';
import { execFileSync } from 'child_process';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const DOTS   = ['   ', '·  ', '·· ', '···'];
const CIRCLE = '●';

const COLOR_THINKING  = '#a78bfa'; // violet-400
const COLOR_TOOL_USE  = '#fbbf24'; // amber-400
const COLOR_TOOL_DONE = '#10b981'; // emerald-500
const COLOR_TOOL_ERR  = '#ef4444'; // red-500
const COLOR_DIM       = '#6b7280'; // gray-500

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SpinnerMode = 'thinking' | 'tool-use' | 'responding';

interface ToolLine {
  name:        string;
  argsSummary: string;
  status:      'running' | 'done' | 'error';
  durationMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** 将 args 对象精简为单行摘要（≤50 字符） */
export function summarizeArgs(args: Record<string, unknown>): string {
  const PRIO_KEYS = [
    'path', 'file', 'filepath', 'filename', 'dir', 'directory',
    'command', 'cmd', 'script', 'query', 'url', 'text', 'content',
  ];
  for (const k of PRIO_KEYS) {
    const v = args[k];
    if (typeof v === 'string' && v.length > 0) {
      return v.length > 50 ? v.slice(0, 48) + '…' : v;
    }
  }
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v.length > 0) {
      return v.length > 50 ? v.slice(0, 48) + '…' : v;
    }
  }
  return '';
}

/** 格式化耗时 */
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function cols(): number {
  try {
    const v = parseInt(execFileSync('tput', ['cols'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim(), 10);
    if (v > 0) return v;
  } catch {}
  return process.stdout.columns ?? 80;
}

function rows(): number {
  try {
    const v = parseInt(execFileSync('tput', ['lines'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim(), 10);
    if (v > 0) return v;
  } catch {}
  return process.stdout.rows ?? 24;
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton TTY fd (shared with statusbar logic pattern)
// ─────────────────────────────────────────────────────────────────────────────

let _ttyFd = -1;
function _getTTY(): number {
  if (_ttyFd >= 0) return _ttyFd;
  try { _ttyFd = openSync('/dev/tty', 'r+'); } catch { _ttyFd = -1; }
  return _ttyFd;
}

function _ttyWrite(s: string): void {
  const fd = _getTTY();
  if (fd >= 0) {
    writeSync(fd, s);
  } else {
    process.stdout.write(s);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CliSpinner
// ─────────────────────────────────────────────────────────────────────────────

export class CliSpinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frameIdx = 0;
  private dotIdx   = 0;
  private mode: SpinnerMode = 'thinking';
  private mainMsg  = 'Thinking';
  private toolLines: ToolLine[] = [];
  private active   = false;

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * 启动 spinner。
   * spinner 渲染在 rows-1 行（status bar 占 rows 行），不写 stdout。
   */
  start(mode: SpinnerMode = 'thinking', message?: string): void {
    if (this.timer) this._kill();
    this.mode      = mode;
    this.mainMsg   = message ?? this._defaultMsg(mode);
    this.frameIdx  = 0;
    this.dotIdx    = 0;
    this.toolLines = [];
    this.active    = true;

    this.timer = setInterval(() => this._render(), 100);
    this._render();
  }

  /** 切换模式（不重置工具行） */
  setMode(mode: SpinnerMode, message?: string): void {
    this.mode    = mode;
    this.mainMsg = message ?? this._defaultMsg(mode);
  }

  /** 添加工具调用记录，返回行索引 */
  addToolLine(name: string, argsSummary: string): number {
    const idx = this.toolLines.length;
    this.toolLines.push({ name, argsSummary, status: 'running' });
    return idx;
  }

  /** 更新工具调用状态 */
  updateToolLine(idx: number, status: 'done' | 'error', durationMs: number): void {
    if (idx >= 0 && idx < this.toolLines.length) {
      this.toolLines[idx]!.status     = status;
      this.toolLines[idx]!.durationMs = durationMs;
    }
  }

  /**
   * 停止 spinner
   * @param printFinalState
   *   true  — 清除 spinner 行，将工具调用结果静态打印到 stdout（每行一条）
   *   false — 仅清除 spinner 行
   */
  stop(printFinalState = false): void {
    this._kill();
    if (!this.active) return;
    this.active = false;

    // 清除 spinner 专用行（跳到 rows-1，清行内容，恢复光标）
    this._clearSpinnerRow();

    if (printFinalState && this.toolLines.length > 0) {
      const lines = this._buildFinalLines();
      if (lines.length > 0) {
        process.stdout.write(lines.join('\n') + '\n');
      }
    }

    this.toolLines = [];
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _kill(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private _defaultMsg(mode: SpinnerMode): string {
    if (mode === 'thinking') return 'Thinking';
    if (mode === 'tool-use') return 'Using tools';
    return 'Responding';
  }

  /** 清除 spinner 专用行（rows-1），光标还原 */
  private _clearSpinnerRow(): void {
    const r = rows();
    if (r <= 1) {
      // 终端极小，fallback 到行内清除
      process.stdout.write('\r\x1b[2K');
      return;
    }
    const spinnerRow = r - 1;
    _ttyWrite(
      '\x1b[?25l'              +   // 隐藏光标
      '\x1b[s'                 +   // 保存光标（readline 管理的位置）
      `\x1b[${spinnerRow};1H`  +   // 跳到 spinner 行
      '\x1b[2K'                +   // 清行
      '\x1b[u'                 +   // 恢复光标
      '\x1b[?25h',                 // 恢复光标显示
    );
  }

  /** 构建工具调用的最终静态显示行（用于 stop(true)） */
  private _buildFinalLines(): string[] {
    return this.toolLines.map((tl) => {
      const circle =
        tl.status === 'done'  ? chalk.hex(COLOR_TOOL_DONE)(CIRCLE)
        : tl.status === 'error' ? chalk.hex(COLOR_TOOL_ERR)(CIRCLE)
        :                         chalk.hex(COLOR_DIM)(CIRCLE);

      const nameStr = chalk.hex('#e2e8f0')(tl.name);
      const maxArgLen = Math.max(0, cols() - tl.name.length - 24);
      const argStr = tl.argsSummary.length > 0
        ? chalk.hex(COLOR_DIM)(' ' + tl.argsSummary.slice(0, maxArgLen))
        : '';

      let suffix = '';
      if (tl.status === 'done') {
        suffix = chalk.hex(COLOR_TOOL_DONE)(` ✓ (${fmtDuration(tl.durationMs ?? 0)})`);
      } else if (tl.status === 'error') {
        suffix = chalk.hex(COLOR_TOOL_ERR)(` ✗`);
      }

      return `  ${circle} ${nameStr}${argStr}${suffix}`;
    });
  }

  /**
   * 每 100ms 渲染一次。
   *
   * 渲染策略：走 /dev/tty，固定跳到 rows-1 行（spinner 专用）写内容，然后恢复光标。
   * 这样完全不影响 readline 管理的当前输入行，也不干扰 statusbar 的 \x1b[s]/\x1b[u。
   */
  private _render(): void {
    const frame = FRAMES[this.frameIdx++ % FRAMES.length]!;
    const dots  = DOTS[this.dotIdx++   % DOTS.length]!;
    const r     = rows();

    if (r <= 1) {
      // 终端极小（如 CI），静默不渲染
      return;
    }

    const spinnerRow = r - 1; // spinner 专用行（status bar 在 r 行）

    // ── 主 spinner 帧颜色 ──────────────────────────────────────────────────
    let spinnerColor: string;
    let msgStr: string;

    if (this.mode === 'thinking') {
      spinnerColor = COLOR_THINKING;
      msgStr = chalk.hex(COLOR_THINKING).dim(this.mainMsg) + chalk.hex(COLOR_DIM)(dots);
    } else if (this.mode === 'tool-use') {
      spinnerColor = COLOR_TOOL_USE;
      msgStr = chalk.hex(COLOR_DIM)(this.mainMsg) + '   ';
    } else {
      spinnerColor = '#67e8f9';
      msgStr = chalk.hex('#67e8f9').dim(this.mainMsg) + '   ';
    }

    const frameStr = chalk.hex(spinnerColor)(frame);

    // ── 工具调用摘要（末尾，单行，超长截断） ─────────────────────────────
    let toolSuffix = '';
    if (this.toolLines.length > 0) {
      const parts: string[] = [];
      for (const tl of this.toolLines) {
        if (tl.status === 'running') {
          parts.push(chalk.hex(COLOR_DIM)(`${CIRCLE} ${tl.name}`));
        } else if (tl.status === 'done') {
          parts.push(chalk.hex(COLOR_TOOL_DONE)(`✓ ${tl.name}`));
        } else {
          parts.push(chalk.hex(COLOR_TOOL_ERR)(`✗ ${tl.name}`));
        }
      }
      const raw = parts.join('  ');
      const maxLen = Math.max(0, cols() - this.mainMsg.length - 12);
      toolSuffix = '  ' + raw.slice(0, maxLen);
    }

    const content = `${frameStr} ${msgStr}${toolSuffix}`;

    // 跳到 spinner 专用行写内容，然后恢复到 readline 管理的光标位置
    _ttyWrite(
      '\x1b[?25l'              +   // 隐藏光标
      '\x1b[s'                 +   // 保存光标（readline ❯ 后面）
      `\x1b[${spinnerRow};1H`  +   // 跳到 spinner 行
      '\x1b[2K'                +   // 清该行
      content                  +   // 写 spinner 内容
      '\x1b[u'                 +   // 恢复到 readline 位置
      '\x1b[?25h',                 // 恢复光标
    );
  }
}
