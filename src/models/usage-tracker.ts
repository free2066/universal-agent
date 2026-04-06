/**
 * UsageTracker — Persistent cross-session token & cost tracking with daily limits.
 *
 * Features:
 *   1. Persists usage data to ~/.uagent/usage/YYYY-MM-DD.json (one file per day)
 *   2. Tracks: input tokens, output tokens, USD cost, per-model breakdown, session count
 *   3. Daily limits: configurable via env vars or ~/.uagent/limits.json
 *   4. Limit enforcement: warn at 80%, block at 100% (configurable)
 *   5. CLI query: getSummary(days) returns human-readable multi-day report
 *
 * Configuration (env vars):
 *   UAGENT_DAILY_TOKEN_LIMIT=100000     max input+output tokens per day
 *   UAGENT_DAILY_COST_LIMIT=1.0         max USD cost per day
 *   UAGENT_LIMIT_WARN_PCT=80            warn when usage reaches this % (default 80)
 *   UAGENT_LIMIT_BLOCK_PCT=100          block when usage reaches this % (default 100)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { resolve, join } from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ModelUsage {
  input: number;
  output: number;
  cacheRead: number;                         // prompt_cache_read tokens
  cacheWrite: number;                        // prompt_cache_creation tokens
  webSearchRequests: number;
  costUSD: number;
  calls: number;
}

export interface DailyUsage {
  date: string;                              // "YYYY-MM-DD"
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalWebSearchRequests: number;
  totalCostUSD: number;
  byModel: Record<string, ModelUsage>;
  sessions: number;
  lastUpdated: number;                       // Unix timestamp
}

export interface UsageLimits {
  dailyTokenLimit?: number;                  // total input+output per day
  dailyCostLimitUSD?: number;               // USD per day
  warnAtPercent: number;                     // default 80
  blockAtPercent: number;                    // default 100
}

export type LimitStatus = 'ok' | 'warn' | 'block';

export interface LimitCheckResult {
  status: LimitStatus;
  message?: string;
  usagePct?: number;                         // % of whichever limit is closest
}

// ── Constants ─────────────────────────────────────────────────────────────────

const USAGE_DIR = resolve(process.env.HOME || '~', '.uagent', 'usage');
const LIMITS_FILE = resolve(process.env.HOME || '~', '.uagent', 'limits.json');

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

// ── UsageTracker ──────────────────────────────────────────────────────────────

export class UsageTracker {
  private limits: UsageLimits;
  private _todayCache: DailyUsage | null = null;
  private _todayCacheDate: string = '';

  constructor() {
    this.limits = this.loadLimits();
  }

  // ── Limits ──────────────────────────────────────────────────────────────────

  private loadLimits(): UsageLimits {
    const defaults: UsageLimits = {
      dailyTokenLimit: process.env.UAGENT_DAILY_TOKEN_LIMIT
        ? parseInt(process.env.UAGENT_DAILY_TOKEN_LIMIT) : undefined,
      dailyCostLimitUSD: process.env.UAGENT_DAILY_COST_LIMIT
        ? parseFloat(process.env.UAGENT_DAILY_COST_LIMIT) : undefined,
      warnAtPercent: parseInt(process.env.UAGENT_LIMIT_WARN_PCT || '80'),
      blockAtPercent: parseInt(process.env.UAGENT_LIMIT_BLOCK_PCT || '100'),
    };

    if (existsSync(LIMITS_FILE)) {
      try {
        const fromFile = JSON.parse(readFileSync(LIMITS_FILE, 'utf-8'));
        return { ...defaults, ...fromFile };
      } catch (err) {
        // Limits config is corrupt — fall back to defaults but warn so users know
        // their manually configured budget caps (dailyCostLimitUSD etc.) are NOT active.
        console.warn(`[usage-tracker] Failed to parse limits config at ${LIMITS_FILE}, using defaults. Error: ${String(err)}`);
      }
    }
    return defaults;
  }

  getLimits(): UsageLimits {
    return { ...this.limits };
  }

  setLimits(limits: Partial<UsageLimits>): void {
    this.limits = { ...this.limits, ...limits };
    mkdirSync(resolve(process.env.HOME || '~', '.uagent'), { recursive: true });
    writeFileSync(LIMITS_FILE, JSON.stringify(this.limits, null, 2));
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  private usagePath(date: string): string {
    return join(USAGE_DIR, `${date}.json`);
  }

  private loadDay(date: string): DailyUsage {
    const path = this.usagePath(date);
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        // Defensive check: must have the required numeric fields before trusting persisted data
        if (
          typeof raw === 'object' && raw !== null &&
          typeof raw.totalInputTokens === 'number' &&
          typeof raw.totalOutputTokens === 'number' &&
          typeof raw.totalCostUSD === 'number'
        ) {
          return raw as DailyUsage;
        }
      } catch (err) {
        // Usage file is corrupt — start fresh for today, but warn so users know
        // accumulated token counts were lost (relevant for daily limit enforcement).
        console.warn(`[usage-tracker] Usage file at ${path} is corrupt, resetting today's usage. Error: ${String(err)}`);
      }
    }
    return {
      date,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalWebSearchRequests: 0,
      totalCostUSD: 0,
      byModel: {},
      sessions: 0,
      lastUpdated: Date.now(),
    };
  }

  private saveDay(usage: DailyUsage): void {
    mkdirSync(USAGE_DIR, { recursive: true });
    usage.lastUpdated = Date.now();
    writeFileSync(this.usagePath(usage.date), JSON.stringify(usage, null, 2));
  }

  loadTodayUsage(): DailyUsage {
    const today = todayKey();
    if (this._todayCacheDate !== today) {
      this._todayCache = null;
      this._todayCacheDate = today;
    }
    if (!this._todayCache) {
      this._todayCache = this.loadDay(today);
    }
    return this._todayCache;
  }

  // ── Record ───────────────────────────────────────────────────────────────────

  /**
   * Record a model API call and return the current limit check result.
   * Call this AFTER a successful API call to track usage.
   * @param cacheReadTokens   Tokens served from prompt cache (cheaper than input)
   * @param cacheWriteTokens  Tokens written to prompt cache (slightly costlier than input)
   * @param webSearchRequests Number of web search tool invocations billed in this call
   */
  recordCall(
    inputTokens: number,
    outputTokens: number,
    model: string,
    costUSD: number,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
    webSearchRequests = 0,
  ): LimitCheckResult {
    const today = this.loadTodayUsage();

    today.totalInputTokens += inputTokens;
    today.totalOutputTokens += outputTokens;
    today.totalCacheReadTokens = (today.totalCacheReadTokens ?? 0) + cacheReadTokens;
    today.totalCacheWriteTokens = (today.totalCacheWriteTokens ?? 0) + cacheWriteTokens;
    today.totalWebSearchRequests = (today.totalWebSearchRequests ?? 0) + webSearchRequests;
    today.totalCostUSD += costUSD;

    if (!today.byModel[model]) {
      today.byModel[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearchRequests: 0, costUSD: 0, calls: 0 };
    }
    const m = today.byModel[model];
    m.input += inputTokens;
    m.output += outputTokens;
    m.cacheRead = (m.cacheRead ?? 0) + cacheReadTokens;
    m.cacheWrite = (m.cacheWrite ?? 0) + cacheWriteTokens;
    m.webSearchRequests = (m.webSearchRequests ?? 0) + webSearchRequests;
    m.costUSD += costUSD;
    m.calls += 1;

    this.saveDay(today);

    return this.checkLimits();
  }

  /** Increment session count (call once at startup) */
  incrementSessionCount(): void {
    const today = this.loadTodayUsage();
    today.sessions += 1;
    this.saveDay(today);
    this._todayCache = today; // update cache
  }

  // ── Limit Check ──────────────────────────────────────────────────────────────

  /**
   * Check whether current usage is within configured limits.
   * Returns 'ok', 'warn', or 'block'.
   */
  checkLimits(): LimitCheckResult {
    const today = this.loadTodayUsage();
    const { dailyTokenLimit, dailyCostLimitUSD, warnAtPercent, blockAtPercent } = this.limits;

    let maxPct = 0;
    const parts: string[] = [];

    if (dailyTokenLimit) {
      const totalTokens = today.totalInputTokens + today.totalOutputTokens;
      const pct = (totalTokens / dailyTokenLimit) * 100;
      maxPct = Math.max(maxPct, pct);
      if (pct >= warnAtPercent) {
        parts.push(`tokens: ${totalTokens.toLocaleString()}/${dailyTokenLimit.toLocaleString()} (${pct.toFixed(0)}%)`);
      }
    }

    if (dailyCostLimitUSD) {
      const pct = (today.totalCostUSD / dailyCostLimitUSD) * 100;
      maxPct = Math.max(maxPct, pct);
      if (pct >= warnAtPercent) {
        parts.push(`cost: $${today.totalCostUSD.toFixed(4)}/$${dailyCostLimitUSD} (${pct.toFixed(0)}%)`);
      }
    }

    if (maxPct >= blockAtPercent) {
      return {
        status: 'block',
        usagePct: maxPct,
        message: `🚫 Daily limit reached! ${parts.join(' | ')}\n   Reset at midnight or run: uagent limits --reset`,
      };
    }

    if (maxPct >= warnAtPercent) {
      return {
        status: 'warn',
        usagePct: maxPct,
        message: `⚠️  Approaching daily limit: ${parts.join(' | ')}`,
      };
    }

    return { status: 'ok', usagePct: maxPct };
  }

  // ── Summary ───────────────────────────────────────────────────────────────────

  /**
   * Get a human-readable usage summary for the last N days.
   * If days=0 or 1, shows only today.
   */
  getSummary(days = 7): string {
    const lines: string[] = [];
    const today = todayKey();

    // Collect dates to show
    const dates: string[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }

    // Today detailed
    const todayUsage = this.loadTodayUsage();
    lines.push(`📊 Usage Statistics\n`);
    lines.push(`Today (${today}):`);
    lines.push(`  Input:        ${todayUsage.totalInputTokens.toLocaleString()} tokens`);
    lines.push(`  Output:       ${todayUsage.totalOutputTokens.toLocaleString()} tokens`);
    if ((todayUsage.totalCacheReadTokens ?? 0) > 0 || (todayUsage.totalCacheWriteTokens ?? 0) > 0) {
      lines.push(`  Cache read:   ${(todayUsage.totalCacheReadTokens ?? 0).toLocaleString()} tokens`);
      lines.push(`  Cache write:  ${(todayUsage.totalCacheWriteTokens ?? 0).toLocaleString()} tokens`);
    }
    if ((todayUsage.totalWebSearchRequests ?? 0) > 0) {
      lines.push(`  Web searches: ${(todayUsage.totalWebSearchRequests ?? 0).toLocaleString()}`);
    }
    lines.push(`  Cost:         $${todayUsage.totalCostUSD.toFixed(4)} USD`);
    lines.push(`  Sessions:     ${todayUsage.sessions}`);

    // Per-model breakdown for today
    const modelEntries = Object.entries(todayUsage.byModel);
    if (modelEntries.length > 0) {
      lines.push(`  Models:`);
      for (const [model, mu] of modelEntries) {
        const shortModel = model.length > 40 ? '...' + model.slice(-37) : model;
        const extras: string[] = [];
        if ((mu.cacheRead ?? 0) > 0)  extras.push(`cache_r: ${(mu.cacheRead ?? 0).toLocaleString()}`);
        if ((mu.cacheWrite ?? 0) > 0) extras.push(`cache_w: ${(mu.cacheWrite ?? 0).toLocaleString()}`);
        if ((mu.webSearchRequests ?? 0) > 0) extras.push(`search: ${(mu.webSearchRequests ?? 0)}×`);
        const extrasStr = extras.length > 0 ? `  [${extras.join(', ')}]` : '';
        lines.push(`    ${shortModel.padEnd(40)}  ${mu.input.toLocaleString()} in + ${mu.output.toLocaleString()} out  ($${mu.costUSD.toFixed(4)}) × ${mu.calls} calls${extrasStr}`);
      }
    }

    // Limits status
    const { dailyTokenLimit, dailyCostLimitUSD } = this.limits;
    if (dailyTokenLimit || dailyCostLimitUSD) {
      lines.push(`  Limits:`);
      if (dailyTokenLimit) {
        const totalTokens = todayUsage.totalInputTokens + todayUsage.totalOutputTokens;
        const pct = ((totalTokens / dailyTokenLimit) * 100).toFixed(1);
        lines.push(`    Tokens: ${totalTokens.toLocaleString()} / ${dailyTokenLimit.toLocaleString()} (${pct}%)`);
      }
      if (dailyCostLimitUSD) {
        const pct = ((todayUsage.totalCostUSD / dailyCostLimitUSD) * 100).toFixed(1);
        lines.push(`    Cost:   $${todayUsage.totalCostUSD.toFixed(4)} / $${dailyCostLimitUSD} (${pct}%)`);
      }
    }

    // Historical summary
    if (days > 1) {
      const pastDates = dates.slice(1); // exclude today
      const available = pastDates.filter((d) => existsSync(this.usagePath(d)));

      if (available.length > 0) {
        let histInput = 0, histOutput = 0, histCost = 0, histSessions = 0;
        for (const d of available) {
          const u = this.loadDay(d);
          histInput += u.totalInputTokens;
          histOutput += u.totalOutputTokens;
          histCost += u.totalCostUSD;
          histSessions += u.sessions;
        }
        lines.push(`\nLast ${days} days (including today):`);
        lines.push(`  Input:    ${(histInput + todayUsage.totalInputTokens).toLocaleString()} tokens`);
        lines.push(`  Output:   ${(histOutput + todayUsage.totalOutputTokens).toLocaleString()} tokens`);
        lines.push(`  Cost:     $${(histCost + todayUsage.totalCostUSD).toFixed(4)} USD`);
        lines.push(`  Sessions: ${histSessions + todayUsage.sessions}`);
      }
    }

    lines.push(`\n  Tip: uagent usage --days 30  — see last 30 days`);
    lines.push(`       uagent limits            — view/set daily limits`);

    return lines.join('\n');
  }

  /**
   * Get raw daily usage records for the last N days.
   */
  getRawHistory(days = 7): DailyUsage[] {
    const result: DailyUsage[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const date = d.toISOString().slice(0, 10);
      result.push(this.loadDay(date));
    }
    return result;
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const usageTracker = new UsageTracker();
