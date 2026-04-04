/**
 * /insights — Usage Analytics Report
 *
 * Inspired by CodeFlicker CLI's /insights command (kstack #15201)
 *
 * Analyzes usage history and session data to generate:
 *   - Usage statistics (tokens, cost, models, sessions)
 *   - Session pattern analysis (when, how often, how long)
 *   - AI-powered behavioral insights and workflow suggestions
 *   - Markdown report (optional HTML output)
 *
 * Data sources:
 *   1. ~/.uagent/usage/YYYY-MM-DD.json  — token/cost stats per day
 *   2. ~/.uagent/history.jsonl           — session prompts with timestamps
 *
 * LLM analysis (optional):
 *   - Extracts patterns from recent prompts
 *   - Identifies friction points (retries, errors)
 *   - Suggests AGENTS.md improvements
 *   - Recommends tools/workflows based on usage patterns
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

interface DailyUsage {
  date: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUSD: number;
  byModel: Record<string, { input: number; output: number; costUSD: number; calls: number }>;
  sessions: number;
}

interface HistoryEntry {
  display: string;
  prompt: string;
  project: string;
  sessionId: string;
  timestamp: number;
}

interface InsightsReport {
  markdown: string;
  html?: string;
  stats: InsightsStats;
}

interface InsightsStats {
  days: number;
  totalSessions: number;
  totalPrompts: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUSD: number;
  topModels: Array<{ model: string; calls: number; costUSD: number }>;
  peakHour: number;
  avgPromptsPerSession: number;
  projectCount: number;
}

// ── Data Collection ───────────────────────────────────────────────────────────

const USAGE_DIR = resolve(process.env.HOME || '~', '.uagent', 'usage');
const HISTORY_FILE = resolve(process.env.HOME || '~', '.uagent', 'history.jsonl');

function loadUsageHistory(days: number): DailyUsage[] {
  if (!existsSync(USAGE_DIR)) return [];
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  try {
    const files = readdirSync(USAGE_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse();

    const results: DailyUsage[] = [];
    for (const file of files) {
      const dateStr = file.replace('.json', '');
      const fileDate = new Date(dateStr).getTime();
      if (fileDate < cutoff) break;
      try {
        const raw = readFileSync(join(USAGE_DIR, file), 'utf-8');
        results.push(JSON.parse(raw) as DailyUsage);
      } catch (err) { /* skip corrupt — a bad daily file should not abort the whole report */
        process.stderr.write(`[insights] Failed to parse usage file ${file}: ${String(err)}\n`);
      }
    }
    return results;
  } catch (err) {
    process.stderr.write(`[insights] Failed to read usage directory: ${String(err)}\n`);
    return [];
  }
}

function loadHistoryEntries(days: number, projectRoot?: string): HistoryEntry[] {
  if (!existsSync(HISTORY_FILE)) return [];
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const project = projectRoot ? resolve(projectRoot) : null;

  try {
    const raw = readFileSync(HISTORY_FILE, 'utf-8');
    const entries: HistoryEntry[] = [];
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const entry = JSON.parse(line) as HistoryEntry;
        if (entry.timestamp < cutoff) continue;
        if (project && entry.project !== project) continue;
        entries.push(entry);
      } catch (err) { /* skip malformed JSONL line */
        process.stderr.write(`[insights] Malformed history entry: ${String(err)}\n`);
      }
    }
    return entries;
  } catch (err) {
    process.stderr.write(`[insights] Failed to read history file: ${String(err)}\n`);
    return [];
  }
}

// ── Stats Computation ─────────────────────────────────────────────────────────

function computeStats(
  usageHistory: DailyUsage[],
  historyEntries: HistoryEntry[],
  days: number,
): InsightsStats {
  // Aggregate usage stats
  let totalInputTokens = 0, totalOutputTokens = 0, totalCostUSD = 0, totalSessions = 0;
  const modelAgg: Record<string, { calls: number; costUSD: number }> = {};

  for (const day of usageHistory) {
    totalInputTokens += day.totalInputTokens;
    totalOutputTokens += day.totalOutputTokens;
    totalCostUSD += day.totalCostUSD;
    totalSessions += day.sessions;

    for (const [model, usage] of Object.entries(day.byModel)) {
      if (!modelAgg[model]) modelAgg[model] = { calls: 0, costUSD: 0 };
      modelAgg[model].calls += usage.calls;
      modelAgg[model].costUSD += usage.costUSD;
    }
  }

  // Top models
  const topModels = Object.entries(modelAgg)
    .map(([model, { calls, costUSD }]) => ({ model, calls, costUSD }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 5);

  // Hourly distribution for peak hour
  const hourCounts: number[] = new Array(24).fill(0);
  const projects = new Set<string>();
  const sessions = new Set<string>();

  for (const entry of historyEntries) {
    const hour = new Date(entry.timestamp).getHours();
    hourCounts[hour]++;
    projects.add(entry.project);
    sessions.add(entry.sessionId);
  }

  const peakHour = hourCounts.indexOf(Math.max(...hourCounts));
  const totalPrompts = historyEntries.length;
  const sessionCount = Math.max(sessions.size, totalSessions);

  return {
    days,
    totalSessions: sessionCount,
    totalPrompts,
    totalInputTokens,
    totalOutputTokens,
    totalCostUSD,
    topModels,
    peakHour,
    avgPromptsPerSession: sessionCount > 0 ? Math.round(totalPrompts / sessionCount) : 0,
    projectCount: projects.size,
  };
}

// ── Prompt Pattern Analysis ───────────────────────────────────────────────────

function analyzePromptPatterns(entries: HistoryEntry[]): {
  taskCategories: Record<string, number>;
  avgPromptLength: number;
  recentTopics: string[];
} {
  // Simple heuristic categorization
  const categories: Record<string, number> = {
    'Code generation': 0,
    'Bug fixing': 0,
    'Refactoring': 0,
    'Code review': 0,
    'Analysis/research': 0,
    'Testing': 0,
    'Deployment': 0,
    'Other': 0,
  };

  const codeGen = /\b(write|create|implement|generate|add|build)\b/i;
  const bugFix = /\b(fix|bug|error|issue|crash|fail|broken|debug)\b/i;
  const refactor = /\b(refactor|optimize|clean|improve|extract|rename)\b/i;
  const review = /\b(review|check|inspect|analyze|audit)\b/i;
  const testing = /\b(test|spec|unit|e2e|coverage|mock)\b/i;
  const deploy = /\b(deploy|build|publish|release|docker|ci|cd)\b/i;

  let totalLength = 0;
  const topicWords: Record<string, number> = {};

  for (const entry of entries) {
    const p = entry.prompt;
    totalLength += p.length;

    if (bugFix.test(p)) categories['Bug fixing']++;
    else if (refactor.test(p)) categories['Refactoring']++;
    else if (review.test(p)) categories['Code review']++;
    else if (testing.test(p)) categories['Testing']++;
    else if (deploy.test(p)) categories['Deployment']++;
    else if (codeGen.test(p)) categories['Code generation']++;
    else categories['Other']++;

    // Extract topic words (nouns/technical terms > 4 chars)
    const words = p.match(/\b[a-zA-Z]{4,20}\b/g) ?? [];
    for (const word of words) {
      const lower = word.toLowerCase();
      if (['that', 'this', 'with', 'from', 'have', 'been', 'will', 'what',
           'when', 'then', 'your', 'make', 'code', 'file', 'please'].includes(lower)) continue;
      topicWords[lower] = (topicWords[lower] ?? 0) + 1;
    }
  }

  const recentTopics = Object.entries(topicWords)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([word]) => word);

  return {
    taskCategories: categories,
    avgPromptLength: entries.length > 0 ? Math.round(totalLength / entries.length) : 0,
    recentTopics,
  };
}

// ── Markdown Report ───────────────────────────────────────────────────────────

function formatHour(hour: number): string {
  if (hour === 0) return '12am';
  if (hour < 12) return `${hour}am`;
  if (hour === 12) return '12pm';
  return `${hour - 12}pm`;
}

function buildMarkdownReport(
  stats: InsightsStats,
  patterns: ReturnType<typeof analyzePromptPatterns>,
  usageHistory: DailyUsage[],
  llmAnalysis?: string,
): string {
  const lines: string[] = [];
  const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  lines.push(`# Usage Insights Report`);
  lines.push(`> Generated on ${now} | Analyzing last ${stats.days} days`);
  lines.push('');

  // ── Summary Stats ────────────────────────────────────────────────────────
  lines.push('## Summary');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Sessions | ${stats.totalSessions.toLocaleString()} |`);
  lines.push(`| Prompts | ${stats.totalPrompts.toLocaleString()} |`);
  lines.push(`| Avg Prompts/Session | ${stats.avgPromptsPerSession} |`);
  lines.push(`| Projects | ${stats.projectCount} |`);
  lines.push(`| Input Tokens | ${stats.totalInputTokens.toLocaleString()} |`);
  lines.push(`| Output Tokens | ${stats.totalOutputTokens.toLocaleString()} |`);
  lines.push(`| Total Cost | $${stats.totalCostUSD.toFixed(4)} USD |`);
  lines.push(`| Peak Activity | ${formatHour(stats.peakHour)} |`);
  lines.push('');

  // ── Daily Trend ──────────────────────────────────────────────────────────
  if (usageHistory.length > 0) {
    lines.push('## Daily Activity (recent days)');
    lines.push('');
    lines.push('| Date | Sessions | Tokens (in/out) | Cost |');
    lines.push('|------|----------|-----------------|------|');
    for (const day of usageHistory.slice(0, 14)) {
      const tokens = `${day.totalInputTokens.toLocaleString()}/${day.totalOutputTokens.toLocaleString()}`;
      lines.push(`| ${day.date} | ${day.sessions} | ${tokens} | $${day.totalCostUSD.toFixed(4)} |`);
    }
    lines.push('');
  }

  // ── Model Usage ──────────────────────────────────────────────────────────
  if (stats.topModels.length > 0) {
    lines.push('## Model Usage');
    lines.push('');
    lines.push('| Model | Calls | Cost |');
    lines.push('|-------|-------|------|');
    for (const m of stats.topModels) {
      lines.push(`| ${m.model} | ${m.calls} | $${m.costUSD.toFixed(4)} |`);
    }
    lines.push('');
  }

  // ── Task Breakdown ───────────────────────────────────────────────────────
  const nonZero = Object.entries(patterns.taskCategories).filter(([, v]) => v > 0);
  if (nonZero.length > 0) {
    lines.push('## Task Categories');
    lines.push('');
    const total = nonZero.reduce((s, [, v]) => s + v, 0);
    for (const [cat, count] of nonZero.sort((a, b) => b[1] - a[1])) {
      const pct = total > 0 ? Math.round((count / total) * 100) : 0;
      const bar = '█'.repeat(Math.round(pct / 5));
      lines.push(`- **${cat}**: ${count} (${pct}%) ${bar}`);
    }
    lines.push('');
    lines.push(`> Average prompt length: ${patterns.avgPromptLength} characters`);
    lines.push('');
  }

  // ── Recent Topics ────────────────────────────────────────────────────────
  if (patterns.recentTopics.length > 0) {
    lines.push('## Frequent Topics');
    lines.push('');
    lines.push(patterns.recentTopics.map((t) => `\`${t}\``).join('  '));
    lines.push('');
  }

  // ── LLM Analysis ─────────────────────────────────────────────────────────
  if (llmAnalysis) {
    lines.push('## AI Insights & Recommendations');
    lines.push('');
    lines.push(llmAnalysis);
    lines.push('');
  }

  // ── Tips ─────────────────────────────────────────────────────────────────
  lines.push('## Quick Tips');
  lines.push('');
  if (stats.totalCostUSD > 0.5) {
    lines.push('- 💡 **Cost optimization**: Try `uagent models set main <cheaper-model>` for routine tasks');
  }
  if (stats.avgPromptsPerSession < 3) {
    lines.push('- 💡 **Short sessions**: Consider using `/compact` to compress context before starting new topics');
  }
  if (patterns.taskCategories['Bug fixing'] > patterns.taskCategories['Code generation']) {
    lines.push('- 💡 **High bug-fix ratio**: Consider running `uagent inspect` proactively to catch issues early');
  }
  lines.push('- 💡 Use `uagent usage --days 30` for raw token stats');
  lines.push('- 💡 Set limits: `uagent limits --tokens 100000 --cost 1.0`');
  lines.push('');
  lines.push('---');
  lines.push(`*Generated by uagent insights at ${new Date().toISOString()}*`);

  return lines.join('\n');
}

function buildHtmlReport(markdown: string, stats: InsightsStats): string {
  // Convert basic markdown to HTML for a nicer report
  let html = markdown
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^---$/gm, '<hr>')
    .replace(/\n\n/g, '</p><p>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>uagent Insights — ${stats.days} Day Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 900px; margin: 40px auto; padding: 0 20px; color: #333; }
    h1 { color: #1a1a2e; border-bottom: 3px solid #0f3460; padding-bottom: 10px; }
    h2 { color: #16213e; margin-top: 40px; }
    table { border-collapse: collapse; width: 100%; margin: 16px 0; }
    th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
    th { background: #f5f5f5; font-weight: 600; }
    tr:nth-child(even) { background: #fafafa; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
    blockquote { border-left: 4px solid #0f3460; margin: 0; padding: 8px 16px; color: #666; background: #f9f9f9; }
    li { margin: 6px 0; }
    hr { border: none; border-top: 1px solid #eee; margin: 30px 0; }
    .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin: 20px 0; }
    .stat-card { background: linear-gradient(135deg, #1a1a2e, #16213e); color: white; padding: 16px; border-radius: 8px; text-align: center; }
    .stat-card .value { font-size: 2em; font-weight: bold; color: #e94560; }
    .stat-card .label { font-size: 0.85em; opacity: 0.8; margin-top: 4px; }
  </style>
</head>
<body>
  <div class="stat-grid">
    <div class="stat-card"><div class="value">${stats.totalSessions}</div><div class="label">Sessions</div></div>
    <div class="stat-card"><div class="value">${stats.totalPrompts}</div><div class="label">Prompts</div></div>
    <div class="stat-card"><div class="value">$${stats.totalCostUSD.toFixed(3)}</div><div class="label">Total Cost</div></div>
    <div class="stat-card"><div class="value">${((stats.totalInputTokens + stats.totalOutputTokens) / 1000).toFixed(0)}k</div><div class="label">Total Tokens</div></div>
  </div>
  ${html}
</body>
</html>`;
}

// ── Main Function ─────────────────────────────────────────────────────────────

export interface InsightsOptions {
  days?: number;
  maxPrompts?: number;
  cwdOnly?: boolean;
  projectRoot?: string;
  outputPath?: string;
  html?: boolean;
  /** LLM client for AI analysis (optional) */
  llmClient?: {
    chat(opts: { systemPrompt: string; messages: Array<{ role: string; content: string }> }): Promise<{ type: string; content: string }>;
  };
}

export async function runInsights(options: InsightsOptions = {}): Promise<InsightsReport> {
  const days = options.days ?? 30;
  const maxPrompts = options.maxPrompts ?? 100;
  const projectRoot = options.cwdOnly ? (options.projectRoot ?? process.cwd()) : undefined;

  // Collect data
  const usageHistory = loadUsageHistory(days);
  const historyEntries = loadHistoryEntries(days, projectRoot);

  // Compute stats
  const stats = computeStats(usageHistory, historyEntries, days);
  const patterns = analyzePromptPatterns(historyEntries.slice(0, maxPrompts));

  // Optional LLM analysis
  let llmAnalysis: string | undefined;
  if (options.llmClient && historyEntries.length > 0) {
    try {
      const samplePrompts = historyEntries.slice(0, 20).map((e, i) =>
        `${i + 1}. ${e.display.slice(0, 200)}`
      ).join('\n');

      const response = await options.llmClient.chat({
        systemPrompt: 'You are a productivity analyst. Analyze the user\'s AI agent usage patterns and provide 3-5 actionable insights and workflow improvement suggestions. Be concise and specific. Output plain text with brief bullet points.',
        messages: [{
          role: 'user',
          content: [
            `Please analyze my AI agent usage over the last ${days} days:`,
            '',
            `**Stats**: ${stats.totalSessions} sessions, ${stats.totalPrompts} prompts, $${stats.totalCostUSD.toFixed(4)} spent`,
            `**Top task**: ${Object.entries(patterns.taskCategories).sort((a, b) => b[1] - a[1])[0]?.[0]}`,
            `**Key topics**: ${patterns.recentTopics.slice(0, 8).join(', ')}`,
            '',
            'Recent prompts (sample):',
            samplePrompts,
          ].join('\n'),
        }],
      });
      llmAnalysis = response.content;
    } catch { /* non-fatal */ }
  }

  const markdown = buildMarkdownReport(stats, patterns, usageHistory, llmAnalysis);

  // Save report
  const outputPath = options.outputPath ?? join(
    process.env.HOME || '~', '.uagent',
    `insights-${new Date().toISOString().slice(0, 10)}.md`,
  );
  mkdirSync(resolve(outputPath, '..'), { recursive: true });
  writeFileSync(outputPath, markdown, 'utf-8');

  let html: string | undefined;
  if (options.html) {
    html = buildHtmlReport(markdown, stats);
    const htmlPath = outputPath.replace(/\.md$/, '.html');
    writeFileSync(htmlPath, html, 'utf-8');
  }

  return { markdown, html, stats };
}
