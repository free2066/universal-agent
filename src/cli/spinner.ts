/**
 * CliSpinner — 精美的 CLI Spinner，对齐 claude-code 风格
 *
 * 特性：
 * - 多模式：thinking / tool-use / responding
 * - 工具调用行追踪（每个工具独立行，带状态圆点）
 * - 兼容底部状态栏（不写入最后一行滚动区域）
 * - 100ms 动画帧率，适配终端
 */

import chalk from 'chalk';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const DOTS   = ['   ', '·  ', '·· ', '···'];

/** 黑色实心圆点 — 和 claude-code ToolUseLoader 对齐 */
const CIRCLE = '●';

// 颜色
const COLOR_THINKING  = '#a78bfa'; // violet-400
const COLOR_TOOL_USE  = '#fbbf24'; // amber-400
const COLOR_TOOL_DONE = '#10b981'; // emerald-500
const COLOR_TOOL_ERR  = '#ef4444'; // red-500
const COLOR_RESPOND   = '#67e8f9'; // cyan-300
const COLOR_DIM       = '#6b7280'; // gray-500

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SpinnerMode = 'thinking' | 'tool-use' | 'responding';

interface ToolLine {
  name:        string;
  argsSummary: string;
  status:      'running' | 'done' | 'error';
  startMs:     number;
  durationMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** 将 args 对象精简为单行摘要（≤50 字符） */
export function summarizeArgs(args: Record<string, unknown>): string {
  // 优先展示最有意义的参数
  const PATH_KEYS  = ['path', 'file', 'filepath', 'filename', 'dir', 'directory'];
  const CMD_KEYS   = ['command', 'cmd', 'script', 'query', 'url', 'text'];
  const PRIO_KEYS  = [...PATH_KEYS, ...CMD_KEYS];

  for (const k of PRIO_KEYS) {
    const v = args[k];
    if (typeof v === 'string' && v.length > 0) {
      const truncated = v.length > 50 ? v.slice(0, 48) + '…' : v;
      return truncated;
    }
  }

  // Fallback: 第一个 string 值
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v.length > 0) {
      return v.length > 50 ? v.slice(0, 48) + '…' : v;
    }
  }

  return '';
}

/** 格式化耗时（ms → "0.3s" / "2.1s"）*/
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 获取当前终端列数 */
function cols(): number {
  return process.stdout.columns ?? 80;
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
  /** 上次渲染时实际写出的行数（主行 + 工具行） */
  private linesRendered = 0;

  // ── Public API ─────────────────────────────────────────────────────────────

  /** 启动 spinner */
  start(mode: SpinnerMode = 'thinking', message?: string): void {
    if (this.timer) this.stop();
    this.mode    = mode;
    this.mainMsg = message ?? this._defaultMsg(mode);
    this.frameIdx = 0;
    this.dotIdx   = 0;
    this.toolLines = [];
    this.linesRendered = 0;

    // 先输出一个空行占位（避免 spinner 和 prompt 粘连）
    process.stdout.write('\n');

    this.timer = setInterval(() => this._render(), 100);
    this._render();
  }

  /** 切换模式 */
  setMode(mode: SpinnerMode, message?: string): void {
    this.mode    = mode;
    this.mainMsg = message ?? this._defaultMsg(mode);
  }

  /** 添加一条工具调用行，返回行索引（用于后续 updateToolLine） */
  addToolLine(name: string, argsSummary: string): number {
    const idx = this.toolLines.length;
    this.toolLines.push({ name, argsSummary, status: 'running', startMs: Date.now() });
    return idx;
  }

  /** 更新工具调用行状态 */
  updateToolLine(idx: number, status: 'done' | 'error', durationMs: number): void {
    if (idx >= 0 && idx < this.toolLines.length) {
      this.toolLines[idx]!.status     = status;
      this.toolLines[idx]!.durationMs = durationMs;
    }
  }

  /** 停止 spinner，清除已渲染内容 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this._clearRendered();
    this.linesRendered = 0;
    this.toolLines     = [];
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _defaultMsg(mode: SpinnerMode): string {
    if (mode === 'thinking')  return 'Thinking';
    if (mode === 'tool-use')  return 'Using tools';
    return 'Responding';
  }

  private _clearRendered(): void {
    if (this.linesRendered === 0) return;
    // 清除 linesRendered 行：每行都 \x1b[2K\x1b[1A（上移 + 清行），最后 \r
    let seq = '\r\x1b[2K'; // 清当前行
    for (let i = 1; i < this.linesRendered; i++) {
      seq += '\x1b[1A\x1b[2K'; // 上移一行 + 清行
    }
    process.stdout.write(seq);
    this.linesRendered = 0;
  }

  private _render(): void {
    const frameChar = FRAMES[this.frameIdx++ % FRAMES.length]!;
    const dots      = DOTS[this.dotIdx++ % DOTS.length]!;

    // ── 主 spinner 行 ─────────────────────────────────────────────────────
    let spinnerColor: string;
    let msgColor: (s: string) => string;
    if (this.mode === 'thinking') {
      spinnerColor = COLOR_THINKING;
      msgColor     = (s) => chalk.hex(COLOR_THINKING).dim(s);
    } else if (this.mode === 'tool-use') {
      spinnerColor = COLOR_TOOL_USE;
      msgColor     = (s) => chalk.hex(COLOR_DIM)(s);
    } else {
      spinnerColor = COLOR_RESPOND;
      msgColor     = (s) => chalk.hex(COLOR_RESPOND).dim(s);
    }

    const frame  = chalk.hex(spinnerColor)(frameChar);
    const dotsStr = this.mode === 'thinking'
      ? chalk.hex(COLOR_DIM)(dots)
      : '   ';
    const mainLine = `${frame} ${msgColor(this.mainMsg)}${dotsStr}`;

    // ── 工具调用行 ────────────────────────────────────────────────────────
    const toolLineStrs: string[] = this.toolLines.map((tl) => {
      const circle = tl.status === 'running'
        ? chalk.hex(COLOR_DIM)(CIRCLE)
        : tl.status === 'done'
          ? chalk.hex(COLOR_TOOL_DONE)(CIRCLE)
          : chalk.hex(COLOR_TOOL_ERR)(CIRCLE);

      const nameStr = chalk.hex('#e2e8f0')(tl.name);
      const maxArgLen = Math.max(0, cols() - tl.name.length - 20);
      const argStr = tl.argsSummary.length > 0
        ? chalk.hex(COLOR_DIM)(tl.argsSummary.slice(0, maxArgLen))
        : '';

      let suffix = '';
      if (tl.status === 'done') {
        suffix = chalk.hex(COLOR_TOOL_DONE)(` ✓ (${fmtDuration(tl.durationMs ?? 0)})`);
      } else if (tl.status === 'error') {
        suffix = chalk.hex(COLOR_TOOL_ERR)(` ✗`);
      }

      return `  ${circle} ${nameStr}${argStr ? '  ' + argStr : ''}${suffix}`;
    });

    // ── 清除上次渲染，写入新内容 ──────────────────────────────────────────
    this._clearRendered();

    const allLines = [mainLine, ...toolLineStrs];
    process.stdout.write(allLines.join('\n'));
    this.linesRendered = allLines.length;
  }
}
