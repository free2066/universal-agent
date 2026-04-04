/**
 * CliSpinner — 单行 spinner，兼容底部状态栏
 *
 * 设计约束：
 *  - 只写一行，用 \r\x1b[2K 覆写，不上移光标
 *  - 不与 statusbar 的 \x1b[s]/\x1b[u] 产生冲突
 *  - 工具调用信息显示在同一行末尾（超长截断）
 *
 * 交互流程：
 *  1. start('thinking')  → ⠋ Thinking···
 *  2. setMode('tool-use') + addToolLine  → ⠋ Using tools  ● read_file src/…
 *     多个工具时只显示最新那个（最多一行）
 *  3. updateToolLine(done)  → ⠋ Using tools  ✓ read_file (0.3s)  ● bash …
 *  4. stop(true)  → 清除 spinner 行，打印所有工具行的最终状态（静态，每行一条）
 *  5. stop(false) → 清除 spinner 行（不留痕迹）
 */

import chalk from 'chalk';

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
  private active   = false;

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * 启动 spinner
   * 注意：调用方负责在此之前已经换行（避免和 prompt 粘在一起）
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
   *   true  — 清除 spinner 行后，将所有工具调用结果静态打印出来（每行一条）
   *   false — 仅清除 spinner 行，不留痕迹
   */
  stop(printFinalState = false): void {
    this._kill();
    if (!this.active) return;
    this.active = false;

    // 清除 spinner 行（单行 \r 覆写，不影响光标上下位置）
    process.stdout.write('\r\x1b[2K');

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
   * 每 100ms 渲染一次 — 单行覆写（\r 回到行首，\x1b[2K 清行，不上移）
   * 这样不会干扰 statusbar 保存的光标位置（\x1b[s）
   */
  private _render(): void {
    const frame = FRAMES[this.frameIdx++ % FRAMES.length]!;
    const dots  = DOTS[this.dotIdx++   % DOTS.length]!;

    // ── 主 spinner 帧颜色 ─────────────────────────────────────────────────
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

    // ── 工具调用摘要（末尾显示，单行） ──────────────────────────────────
    // 只显示最后几个工具状态（截断到一行内）
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
      // 限制长度，避免超出终端宽度
      const maxLen = Math.max(0, cols() - this.mainMsg.length - 12);
      toolSuffix = '  ' + raw.slice(0, maxLen);
    }

    // 单行覆写：\r 回行首，\x1b[2K 清行，写新内容
    process.stdout.write(`\r\x1b[2K${frameStr} ${msgStr}${toolSuffix}`);
  }
}
