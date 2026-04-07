/**
 * SessionLogger — 自动会话日志记录模块
 *
 * 将每次 uagent 会话完整记录到 ~/.uagent/logs/session-<timestamp>.log
 *
 * 记录内容：
 *   USER        用户输入
 *   LLM_REQ     LLM 请求开始（model/iteration/tokens）
 *   LLM_RESP    LLM 响应结束（tokens/duration）
 *   LLM_OUTPUT  LLM 文本输出内容
 *   TOOL_START  工具调用开始（name + args）
 *   TOOL_RESULT 工具返回内容（前 500 chars）
 *   TOOL_END    工具调用结束（✓/✗ + duration + 错误信息）
 *   PERMISSION  权限决策（allow/ask/deny）
 *   CONFIRM     用户确认操作
 *   ABORT       用户 Esc 中止
 *   COMPACT     上下文压缩
 *   SESSION_RESTORE  恢复历史会话
 *   SLASH       slash 命令
 *   MODEL_SWAP  模型切换
 *   FALLBACK    模型 fallback
 *   ERROR       错误
 *   INFO        通用信息
 *   SESSION_END 会话结束摘要
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

export const LOGS_DIR = resolve(process.env.HOME ?? '~', '.uagent', 'logs');

const MAX_LOG_FILES = 50;
const MAX_LINE_CHARS = 2000;

function now(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

function truncate(s: string, max = MAX_LINE_CHARS): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `... [+${s.length - max} chars]`;
}

function formatArgs(args: Record<string, unknown>): string {
  try {
    return truncate(JSON.stringify(args), 600);
  } catch {
    return String(args);
  }
}

export interface SessionLoggerOptions {
  model: string;
  domain: string;
  sessionId?: string;
  /** 如果为 true，跳过所有文件 IO（用于初始化失败时的 fallback 模式）*/
  noWrite?: boolean;
}

export class SessionLogger {
  private readonly logPath: string;
  private readonly startMs: number;
  private readonly _noWrite: boolean;
  private turnCount = 0;
  private toolCount = 0;
  private outputChars = 0;
  private _outputBuffer = '';

  constructor(opts: SessionLoggerOptions) {
    this.startMs = Date.now();
    this._noWrite = opts.noWrite ?? false;

    if (this._noWrite) {
      this.logPath = '';
      return;
    }

    mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
    this._rotate();

    const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const short = opts.sessionId?.slice(-6) ?? Math.random().toString(36).slice(2, 8);
    this.logPath = join(LOGS_DIR, `session-${ts}-${short}.log`);

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

  get path(): string {
    return this.logPath;
  }

  // ── 用户输入 ───────────────────────────────────────────────────────────────

  logInput(text: string): void {
    this.turnCount++;
    this._flushOutput();
    this._write(`[${now()}] USER        > ${truncate(text, 800)}`);
    this._write('');
  }

  // ── LLM 请求/响应 ─────────────────────────────────────────────────────────

  logLLMRequest(opts: { model: string; iteration: number; historyLen: number; tools?: number }): void {
    this._write(
      `[${now()}] LLM_REQ     model=${opts.model}  iter=${opts.iteration}  history=${opts.historyLen} msgs${opts.tools !== undefined ? `  tools=${opts.tools}` : ''}`,
    );
  }

  logLLMResponse(opts: { durationMs: number; inputTokens?: number; outputTokens?: number; stopReason?: string }): void {
    const dur = opts.durationMs < 1000 ? `${opts.durationMs}ms` : `${(opts.durationMs / 1000).toFixed(1)}s`;
    const toks = (opts.inputTokens || opts.outputTokens)
      ? `  in=${opts.inputTokens ?? '?'} out=${opts.outputTokens ?? '?'}`
      : '';
    const stop = opts.stopReason ? `  stop=${opts.stopReason}` : '';
    this._write(`[${now()}] LLM_RESP    ${dur}${toks}${stop}`);
  }

  // ── 工具调用 ──────────────────────────────────────────────────────────────

  logToolStart(name: string, args: Record<string, unknown>): void {
    this.toolCount++;
    this._write(`[${now()}] TOOL_START  ${name.padEnd(20)} ${formatArgs(args)}`);
  }

  logToolResult(name: string, result: string): void {
    const preview = truncate(result.trim(), 800);
    const lines = preview.split('\n');
    this._write(`[${now()}] TOOL_RESULT ${name.padEnd(20)} (${result.length} chars)`);
    for (const line of lines.slice(0, 20)) {
      this._write(`             ${truncate(line, 400)}`);
    }
    if (lines.length > 20) {
      this._write(`             ... [${lines.length - 20} more lines]`);
    }
  }

  logToolEnd(name: string, success: boolean, durationMs: number, errorMsg?: string): void {
    const status = success ? '✓' : '✗';
    const dur = durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
    this._write(`[${now()}] TOOL_END    ${name.padEnd(20)} ${status} ${dur}`);
    if (!success && errorMsg) {
      this._write(`             ERROR: ${truncate(errorMsg, 800)}`);
    }
    this._write('');
  }

  // ── 权限 ──────────────────────────────────────────────────────────────────

  logPermission(opts: { tool: string; decision: 'allow' | 'ask' | 'deny'; pattern?: string; mode?: string }): void {
    const pat = opts.pattern ? `  pattern="${opts.pattern}"` : '';
    const mode = opts.mode ? `  mode=${opts.mode}` : '';
    this._write(`[${now()}] PERMISSION  ${opts.decision.toUpperCase().padEnd(6)} tool=${opts.tool}${pat}${mode}`);
  }

  logConfirm(tool: string, approved: boolean, command?: string): void {
    const verdict = approved ? 'APPROVED' : 'REJECTED';
    const cmd = command ? `  cmd=${truncate(command, 200)}` : '';
    this._write(`[${now()}] CONFIRM     ${verdict}  tool=${tool}${cmd}`);
  }

  // ── 控制流 ────────────────────────────────────────────────────────────────

  logAbort(): void {
    this._flushOutput();
    this._write(`[${now()}] ABORT       user pressed Esc — streaming interrupted`);
    this._write('');
  }

  logCompact(opts: { before: number; after: number; method?: string }): void {
    this._flushOutput();
    this._write(
      `[${now()}] COMPACT     ${opts.before} → ${opts.after} msgs  method=${opts.method ?? 'auto'}`,
    );
  }

  logSessionRestore(opts: { sessionId: string; msgCount: number }): void {
    this._write(
      `[${now()}] SESSION_RESTORE  id=${opts.sessionId}  msgs=${opts.msgCount}`,
    );
  }

  logSlash(cmd: string): void {
    this._flushOutput();
    this._write(`[${now()}] SLASH       ${cmd}`);
    this._write('');
  }

  logModelSwitch(from: string, to: string): void {
    this._write(`[${now()}] MODEL_SWAP  ${from} → ${to}`);
  }

  logFallback(opts: { from: string; to: string; reason: string }): void {
    this._write(`[${now()}] FALLBACK    ${opts.from} → ${opts.to}  reason=${truncate(opts.reason, 200)}`);
  }

  logIterationLimit(limit: number): void {
    this._flushOutput();
    this._write(`[${now()}] ITER_LIMIT  max=${limit}  turns=${this.turnCount}  tools=${this.toolCount}`);
    this._write('');
  }

  logInfo(msg: string): void {
    this._write(`[${now()}] INFO        ${truncate(msg, 500)}`);
  }

  logSystemPrompt(prompt: string): void {
    const lines = prompt.split('\n');
    this._write(`[${now()}] SYS_PROMPT  (${prompt.length} chars, ${lines.length} lines)`);
    for (const line of lines.slice(0, 10)) {
      this._write(`             ${truncate(line, 400)}`);
    }
    if (lines.length > 10) {
      this._write(`             ... [${lines.length - 10} more lines]`);
    }
    this._write('');
  }

  // ── LLM 输出缓冲 ──────────────────────────────────────────────────────────

  logChunk(chunk: string): void {
    this._outputBuffer += chunk;
    this.outputChars += chunk.length;
  }

  flushOutput(): void {
    this._flushOutput();
  }

  // ── 错误 ──────────────────────────────────────────────────────────────────

  logError(err: unknown): void {
    this._flushOutput();
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    this._write(`[${now()}] ERROR       ${truncate(msg, 800)}`);
    if (err instanceof Error && err.stack) {
      const stackLines = err.stack.split('\n').slice(0, 8).join('\n             ');
      this._write(`             STACK: ${stackLines}`);
    }
    this._write('');
  }

  // ── 会话结束 ──────────────────────────────────────────────────────────────

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
    if (this._noWrite) return;
    try {
      appendFileSync(this.logPath, line + '\n', 'utf-8');
    } catch { /* non-fatal */ }
  }

  private _flushOutput(): void {
    const buf = this._outputBuffer.trim();
    if (!buf) return;
    this._outputBuffer = '';
    const lines = buf.split('\n');
    this._write(`[${now()}] LLM_OUTPUT  (${this.outputChars} chars)`);
    for (const line of lines.slice(0, 60)) {
      this._write(`             ${truncate(line, 400)}`);
    }
    if (lines.length > 60) {
      this._write(`             ... [${lines.length - 60} more lines]`);
    }
    this._write('');
  }

  private _rotate(): void {
    try {
      const files = readdirSync(LOGS_DIR)
        .filter((f) => f.startsWith('session-') && f.endsWith('.log'))
        .map((f) => {
          try { return { f, mtime: statSync(join(LOGS_DIR, f)).mtimeMs }; } catch { return { f, mtime: 0 }; }
        })
        .sort((a, b) => a.mtime - b.mtime) // 升序：最旧的在前
        .map(({ f }) => f);
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
