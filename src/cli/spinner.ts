/**
 * CliSpinner — 精美的 CLI Spinner，对齐 claude-code 风格
 *
 * 交互流程：
 *
 *  1. user 发送消息后 → start('thinking') → 显示紫色旋转帧 + "Thinking···"
 *  2. agent 发起工具调用 → setMode('tool-use') + addToolLine(name, args)
 *     → 主行变黄色"Using tools"，工具行依次追加（● dim 圆点）
 *  3. 工具完成 → updateToolLine(idx, 'done'/'error', duration)
 *     → 对应行圆点变绿✓或红✗，显示耗时
 *  4. LLM 开始输出文本 → stop(true) （保留工具行打印到终端）
 *     → 打印分隔线，正常流式输出文字
 *  5. 本轮结束 → 打印结尾分隔线，回到 prompt
 *
 * 设计约束：
 *  - 不写入终端最后一行（状态栏区域）
 *  - 向后兼容：stop() 默认清除（verbose 场景可传 false）
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

  // Fallback: 第一个非空 string 值
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

  /**
   * 上次渲染时写出的实际行数（主 spinner 行 + 工具行）
   * 用于下次渲染前正确清除
   */
  private linesRendered = 0;

  // ── Public API ─────────────────────────────────────────────────────────────

  /** 启动 spinner（自动打一个换行让 spinner 与 prompt 分开） */
  start(mode: SpinnerMode = 'thinking', message?: string): void {
    if (this.timer) this._kill();
    this.mode        = mode;
    this.mainMsg     = message ?? this._defaultMsg(mode);
    this.frameIdx    = 0;
    this.dotIdx      = 0;
    this.toolLines   = [];
    this.linesRendered = 0;

    process.stdout.write('\n'); // 与 prompt 分隔
    this.timer = setInterval(() => this._render(), 100);
    this._render();
  }

  /** 切换模式（不重置工具行） */
  setMode(mode: SpinnerMode, message?: string): void {
    this.mode    = mode;
    this.mainMsg = message ?? this._defaultMsg(mode);
  }

  /**
   * 添加工具调用行
   * @returns 行索引，传给 updateToolLine 用
   */
  addToolLine(name: string, argsSummary: string): number {
    const idx = this.toolLines.length;
    this.toolLines.push({ name, argsSummary, status: 'running', startMs: Date.now() });
    return idx;
  }

  /** 更新工具调用行状态（成功/失败 + 耗时） */
  updateToolLine(idx: number, status: 'done' | 'error', durationMs: number): void {
    if (idx >= 0 && idx < this.toolLines.length) {
      this.toolLines[idx]!.status     = status;
      this.toolLines[idx]!.durationMs = durationMs;
    }
  }

  /**
   * 停止 spinner
   * @param printFinalState 若为 true，把最终渲染状态保留在终端（工具行 + 状态）；
   *                        若为 false（默认），清除所有内容（不留痕迹）
   */
  stop(printFinalState = false): void {
    this._kill();

    if (printFinalState && this.toolLines.length > 0) {
      // 清除动画主行，只保留工具行
      this._clearRendered();

      // 打印工具行的最终状态（不带 spinner 帧，静态展示）
      const toolLineStrs = this._buildToolLineStrs();
      if (toolLineStrs.length > 0) {
        process.stdout.write(toolLineStrs.join('\n') + '\n');
      }
    } else {
      this._clearRendered();
    }

    this.linesRendered = 0;
    this.toolLines     = [];
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _kill(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private _defaultMsg(mode: SpinnerMode): string {
    if (mode === 'thinking')  return 'Thinking';
    if (mode === 'tool-use')  return 'Using tools';
    return 'Responding';
  }

  /** 向上清除 linesRendered 行 */
  private _clearRendered(): void {
    if (this.linesRendered === 0) return;
    let seq = '\r\x1b[2K'; // 清当前行
    for (let i = 1; i < this.linesRendered; i++) {
      seq += '\x1b[1A\x1b[2K'; // 上移 + 清行
    }
    process.stdout.write(seq);
    this.linesRendered = 0;
  }

  private _buildToolLineStrs(): string[] {
    return this.toolLines.map((tl) => {
      const circle =
        tl.status === 'running' ? chalk.hex(COLOR_DIM)(CIRCLE)
        : tl.status === 'done'  ? chalk.hex(COLOR_TOOL_DONE)(CIRCLE)
        :                         chalk.hex(COLOR_TOOL_ERR)(CIRCLE);

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
      // responding
      spinnerColor = COLOR_RESPOND;
      msgColor     = (s) => chalk.hex(COLOR_RESPOND).dim(s);
    }

    const frame   = chalk.hex(spinnerColor)(frameChar);
    const dotsStr = this.mode === 'thinking' ? chalk.hex(COLOR_DIM)(dots) : '   ';
    const mainLine = `${frame} ${msgColor(this.mainMsg)}${dotsStr}`;

    // ── 工具调用行 ────────────────────────────────────────────────────────
    const toolLineStrs = this._buildToolLineStrs();

    // ── 清除上次渲染 → 写新内容 ─────────────────────────────────────────
    this._clearRendered();

    const allLines = [mainLine, ...toolLineStrs];
    process.stdout.write(allLines.join('\n'));
    this.linesRendered = allLines.length;
  }
}
