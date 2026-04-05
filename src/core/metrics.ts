/**
 * core/metrics.ts — 轻量 LLM 调用指标收集器
 *
 * 不依赖 OpenTelemetry 或外部 SDK，只做三件事：
 *  1. 内存中维护 session 级别的调用统计
 *  2. 追加写入 ~/.uagent/metrics/YYYY-MM-DD.jsonl（按天滚动）
 *  3. 提供 getSummary() 供 /metrics 命令展示
 *
 * 写入格式（JSONL，每行一条事件）：
 *   {"ts":1700000000000,"event":"llm.call","model":"gemini-2.5-flash",
 *    "durationMs":2341,"inputTokens":450,"outputTokens":120,"success":true}
 *
 * 错误写入是静默的 — metrics 失败不影响主流程。
 */

import { mkdirSync, appendFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LlmCallEvent {
  ts: number;
  event: 'llm.call';
  model: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  success: boolean;
  error?: string;
}

export type MetricEvent = LlmCallEvent;

export interface SessionStats {
  calls: number;
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  failedCalls: number;
  byModel: Record<string, { calls: number; durationMs: number; inputTokens: number; outputTokens: number }>;
  startedAt: number;
}

// ── Storage ───────────────────────────────────────────────────────────────────

const METRICS_DIR = resolve(process.env.HOME ?? '~', '.uagent', 'metrics');

/** Max number of daily metric files to retain */
const MAX_RETENTION_DAYS = 30;

function getMetricsFile(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return join(METRICS_DIR, `${date}.jsonl`);
}

function ensureDir(): void {
  try {
    mkdirSync(METRICS_DIR, { recursive: true, mode: 0o700 });
  } catch { /* ignore */ }
}

function gcOldFiles(): void {
  try {
    const files = readdirSync(METRICS_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ name: f, mtime: statSync(join(METRICS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const f of files.slice(MAX_RETENTION_DAYS)) {
      try { unlinkSync(join(METRICS_DIR, f.name)); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

// ── MetricsCollector ──────────────────────────────────────────────────────────

export class MetricsCollector {
  private stats: SessionStats = {
    calls: 0,
    totalDurationMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    failedCalls: 0,
    byModel: {},
    startedAt: Date.now(),
  };
  private initialized = false;

  private init(): void {
    if (this.initialized) return;
    ensureDir();
    gcOldFiles();
    this.initialized = true;
  }

  /**
   * Record a completed LLM call.
   * Call at the end of each streamChat / chat invocation.
   */
  record(event: Omit<LlmCallEvent, 'ts' | 'event'>): void {
    const full: LlmCallEvent = { ts: Date.now(), event: 'llm.call', ...event };

    // Update in-memory stats
    this.stats.calls++;
    this.stats.totalDurationMs += event.durationMs;
    this.stats.totalInputTokens += event.inputTokens;
    this.stats.totalOutputTokens += event.outputTokens;
    if (!event.success) this.stats.failedCalls++;

    if (!this.stats.byModel[event.model]) {
      this.stats.byModel[event.model] = { calls: 0, durationMs: 0, inputTokens: 0, outputTokens: 0 };
    }
    const m = this.stats.byModel[event.model]!;
    m.calls++;
    m.durationMs += event.durationMs;
    m.inputTokens += event.inputTokens;
    m.outputTokens += event.outputTokens;

    // Persist to disk (non-blocking, errors are silent)
    try {
      this.init();
      appendFileSync(getMetricsFile(), JSON.stringify(full) + '\n', { encoding: 'utf-8', mode: 0o600 });
    } catch { /* never interrupt main flow */ }
  }

  /** Get current session stats */
  getStats(): Readonly<SessionStats> {
    return this.stats;
  }

  /**
   * Format a human-readable summary for /metrics command.
   */
  getSummary(): string {
    const s = this.stats;
    if (s.calls === 0) {
      return '  No LLM calls recorded this session yet.\n';
    }

    const avgMs = Math.round(s.totalDurationMs / s.calls);
    const sessionDuration = Math.round((Date.now() - s.startedAt) / 1000);
    const lines: string[] = [
      `  Calls      : ${s.calls}${s.failedCalls > 0 ? ` (${s.failedCalls} failed)` : ''}`,
      `  Total time : ${(s.totalDurationMs / 1000).toFixed(1)}s`,
      `  Avg latency: ${(avgMs / 1000).toFixed(2)}s/call`,
      `  Input toks : ${s.totalInputTokens.toLocaleString()}`,
      `  Output toks: ${s.totalOutputTokens.toLocaleString()}`,
      `  Session age: ${sessionDuration}s`,
    ];

    const modelLines = Object.entries(s.byModel)
      .sort((a, b) => b[1].calls - a[1].calls)
      .map(([model, m]) => {
        const avg = Math.round(m.durationMs / m.calls);
        return `    ${model.padEnd(28)} ${String(m.calls).padStart(3)} calls  avg ${(avg / 1000).toFixed(2)}s`;
      });

    if (modelLines.length > 0) {
      lines.push('', '  By model:');
      lines.push(...modelLines);
    }

    lines.push('', `  Log file: ${getMetricsFile()}`);
    return lines.join('\n') + '\n';
  }

  /** Reset session stats (e.g. on /clear) */
  reset(): void {
    this.stats = {
      calls: 0,
      totalDurationMs: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      failedCalls: 0,
      byModel: {},
      startedAt: Date.now(),
    };
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const sessionMetrics = new MetricsCollector();
