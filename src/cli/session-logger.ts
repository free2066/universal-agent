/**
 * SessionLogger — 自动会话日志记录模块
 *
 * 将每次 uagent 会话（输入、工具调用、LLM 输出、错误）结构化记录到
 * ~/.uagent/logs/session-<timestamp>.log 文件中。
 *
 * 日志格式为纯文本，方便直接粘贴给 AI 分析：
 *
 *   [2026-04-04 13:30:01] SESSION_START  model=gemini-2.0-flash  domain=auto
 *   [2026-04-04 13:30:02] USER_INPUT     "帮我做代码审查"
 *   [2026-04-04 13:30:03] TOOL_START     Read                  {"path":"src/cli/index.ts"}
 *   [2026-04-04 13:30:03] TOOL_END       Read                  ✓ 312ms
 *   [2026-04-04 13:30:05] LLM_OUTPUT     (1234 chars)
 *                          代码审查结果如下...
 *   [2026-04-04 13:30:05] ERROR          429 Too Many Requests
 *   [2026-04-04 13:30:30] SESSION_END    turns=3  tools=12  duration=29s
 */

import {
  mkdirSync,
  appendFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  statSync,
} from 'fs';
import { join, resolve } from 'path';

// ── 配置 ─────────────────────────────────────────────────────────────────────

export const LOGS_DIR = resolve(process.env.HOME ?? '~', '.uagent', 'logs');

/** 最多保留最近 N 个日志文件，超出后自动删除最旧的 */
const MAX_LOG_FILES = 20;

/** 单行最大字符（LLM 输出可能很长，截断避免日志文件过大） */
const MAX_LINE_CHARS = 2000;

// ── 工具函数 ──────────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

function truncate(s: string, max = MAX_LINE_CHARS): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `... [+${s.length - max} chars truncated]`;
}

function formatArgs(args: Record<string, unknown>): string {
  try {
    return truncate(JSON.stringify(args), 400);
  } catch {
    return String(args);
  }
}

// ── SessionLogger ─────────────────────────────────────────────────────────────

export interface SessionLoggerOptions {
  model: string;
  domain: string;
  sessionId?: string;
}

export class SessionLogger {
  private readonly logPath: string;
  private readonly startMs: number;
  private turnCount = 0;
  private toolCount = 0;
  private outputChars = 0;
  /** Buffer pending LLM output chunks — flush on next separator or session end */
  private _outputBuffer = '';

  constructor(opts: SessionLoggerOptions) {
    this.startMs = Date.now();

    // 确保日志目录存在（权限 700：只有当前用户可读）
    mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });

    // 轮转旧日志
    this._rotate();

    // 构建日志文件路径：session-YYYYMMDD-HHmmss-<shortId>.log
    const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const short = opts.sessionId?.slice(-6) ?? Math.random().toString(36).slice(2, 8);
    this.logPath = join(LOGS_DIR, `session-${ts}-${short}.log`);

    // 写入文件头
    writeFileSync(
      this.logPath,
      [
        `═══════════════════════════════════════════════════════════════`,
        `  uagent session log`,
        `  Started : ${now()}`,
        `  Model   : ${opts.model}`,
        `  Domain  : ${opts.domain}`,
        `  Cwd     : ${process.cwd()}`,
        `  File    : ${this.logPath}`,
        `═══════════════════════════════════════════════════════════════`,
        '',
      ].join('\n'),
      'utf-8',
    );
  }

  /** 当前日志文件的绝对路径 */
  get path(): string {
    return this.logPath;
  }

  // ── 公开 API ────────────────────────────────────────────────────────────────

  /** 用户输入了一条消息 */
  logInput(text: string): void {
    this.turnCount++;
    this._flushOutput();
    this._write(`[${now()}] USER        > ${truncate(text, 500)}`);
    this._write('');
  }

  /** 工具调用开始 */
  logToolStart(name: string, args: Record<string, unknown>): void {
    this.toolCount++;
    this._write(`[${now()}] TOOL_START  ${name.padEnd(20)} ${formatArgs(args)}`);
  }

  /** 工具调用结束 */
  logToolEnd(name: string, success: boolean, durationMs: number, errorMsg?: string): void {
    const status = success ? '✓' : '✗';
    this._write(`[${now()}] TOOL_END    ${name.padEnd(20)} ${status} ${durationMs}ms`);
    if (!success && errorMsg) {
      this._write(`             ERROR: ${truncate(errorMsg, 500)}`);
    }
  }

  /** 接收一个 LLM 文本 chunk（内部缓冲，避免每个 chunk 都写磁盘） */
  logChunk(chunk: string): void {
    this._outputBuffer += chunk;
    this.outputChars += chunk.length;
  }

  /** 一轮 LLM 输出结束 — flush 缓冲到日志 */
  flushOutput(): void {
    this._flushOutput();
  }

  /** 记录错误 */
  logError(err: unknown): void {
    this._flushOutput();
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    this._write(`[${now()}] ERROR       ${truncate(msg, 800)}`);
    if (err instanceof Error && err.stack) {
      const stackLines = err.stack.split('\n').slice(0, 5).join('\n             ');
      this._write(`             STACK: ${stackLines}`);
    }
    this._write('');
  }

  /** 记录 slash 命令（/continue、/compact 等） */
  logSlash(cmd: string): void {
    this._flushOutput();
    this._write(`[${now()}] SLASH       ${cmd}`);
  }

  /** 记录迭代上限命中 */
  logIterationLimit(limit: number): void {
    this._flushOutput();
    this._write(`[${now()}] ITER_LIMIT  max=${limit}  turns_so_far=${this.turnCount}  tools_so_far=${this.toolCount}`);
    this._write('');
  }

  /** 记录模型切换 */
  logModelSwitch(from: string, to: string): void {
    this._write(`[${now()}] MODEL_SWAP  ${from} → ${to}`);
  }

  /** 记录一条通用信息（适合记录特殊事件） */
  logInfo(msg: string): void {
    this._write(`[${now()}] INFO        ${truncate(msg, 500)}`);
  }

  /** 会话结束 — 写入摘要 */
  close(): void {
    this._flushOutput();
    const durationSec = Math.round((Date.now() - this.startMs) / 1000);
    const m = Math.floor(durationSec / 60);
    const s = durationSec % 60;
    const dur = m > 0 ? `${m}m ${s}s` : `${s}s`;
    this._write('');
    this._write('───────────────────────────────────────────────────────────────');
    this._write(`[${now()}] SESSION_END`);
    this._write(`             turns=${this.turnCount}  tools=${this.toolCount}  output_chars=${this.outputChars}  duration=${dur}`);
    this._write(`             log=${this.logPath}`);
    this._write('═══════════════════════════════════════════════════════════════');
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _write(line: string): void {
    try {
      appendFileSync(this.logPath, line + '\n', 'utf-8');
    } catch { /* non-fatal — 日志失败不能让 agent 崩溃 */ }
  }

  private _flushOutput(): void {
    const buf = this._outputBuffer.trim();
    if (!buf) return;
    this._outputBuffer = '';
    const lines = buf.split('\n');
    this._write(`[${now()}] LLM_OUTPUT  (${this.outputChars} chars total)`);
    const preview = lines.slice(0, 40);
    for (const line of preview) {
      this._write(`             ${truncate(line, 400)}`);
    }
    if (lines.length > 40) {
      this._write(`             ... [${lines.length - 40} more lines]`);
    }
    this._write('');
  }

  /** 删除最旧的日志文件，保留最近 MAX_LOG_FILES 个 */
  private _rotate(): void {
    try {
      const files = readdirSync(LOGS_DIR)
        .filter((f) => f.startsWith('session-') && f.endsWith('.log'))
        .sort(); // ISO 时间前缀 → 字母序 = 时间序
      const extra = files.length - MAX_LOG_FILES + 1;
      if (extra > 0) {
        for (const f of files.slice(0, extra)) {
          try { unlinkSync(join(LOGS_DIR, f)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }
}

// ── 便捷函数 ──────────────────────────────────────────────────────────────────

export interface LogEntry {
  name: string;
  path: string;
  size: number;
  mtime: string;
}

/** 列出所有日志文件（最新的在前） */
export function listLogs(): LogEntry[] {
  if (!existsSync(LOGS_DIR)) return [];
  return readdirSync(LOGS_DIR)
    .filter((f) => f.startsWith('session-') && f.endsWith('.log'))
    .sort()
    .reverse()
    .map((f) => {
      const p = join(LOGS_DIR, f);
      try {
        const st = statSync(p);
        return { name: f, path: p, size: st.size, mtime: st.mtime.toISOString() };
      } catch {
        return { name: f, path: p, size: 0, mtime: '' };
      }
    });
}
