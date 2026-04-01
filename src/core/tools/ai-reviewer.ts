/**
 * AI Code Reviewer
 *
 * Implements the P1/P2/P3 graded code review pipeline from kstack article #15332.
 *
 * Severity grades:
 *   P1 — Must fix before merge (bugs, security, data loss, build breaks)
 *   P2 — Should fix (logic errors, missing tests, performance issues)
 *   P3 — Nice to fix (style, naming, comments, minor refactors)
 *
 * Review sources (applied in order):
 *   1. Static analysis via code-inspector (fast, zero LLM cost)
 *   2. AI review of git diff or specified files (deep, requires LLM)
 *
 * Usage:
 *   CLI:  uagent review [path]
 *   REPL: /review [path|--diff]
 *   Code: const report = await reviewCode({ diff, files, projectRoot })
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { modelManager } from '../../models/model-manager.js';
import { loadProjectContext, loadRules } from '../context-loader.js';
import { inspectProject } from './code-inspector.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ReviewPriority = 'P1' | 'P2' | 'P3';

export interface ReviewIssue {
  priority: ReviewPriority;
  file: string;
  line?: number;
  title: string;
  detail: string;
  suggestion?: string;
}

export interface ReviewReport {
  /** Total issues by priority */
  summary: { P1: number; P2: number; P3: number };
  issues: ReviewIssue[];
  /** Formatted markdown report */
  markdown: string;
  /** Whether P1 issues exist (used for --review auto-fix loop) */
  hasBlockers: boolean;
}

// ─── Git Diff Helpers ────────────────────────────────────────────────────────

/**
 * Get the current git diff (staged + unstaged, or vs a base ref).
 * Returns null if not a git repo or diff is empty.
 */
export function getGitDiff(cwd?: string, base = 'HEAD'): string | null {
  const dir = cwd ?? process.cwd();
  try {
    // Try staged first, then working tree
    let diff = execSync(`git diff --cached ${base} 2>/dev/null`, {
      cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
    }).trim();
    if (!diff) {
      diff = execSync(`git diff ${base} 2>/dev/null`, {
        cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
      }).trim();
    }
    return diff || null;
  } catch {
    return null;
  }
}

/**
 * Get list of files changed vs HEAD.
 */
export function getChangedFiles(cwd?: string): string[] {
  const dir = cwd ?? process.cwd();
  try {
    const out = execSync('git diff --name-only HEAD 2>/dev/null && git diff --cached --name-only HEAD 2>/dev/null', {
      cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
    }).trim();
    return [...new Set(out.split('\n').filter((f) => f && (f.endsWith('.ts') || f.endsWith('.js'))))];
  } catch {
    return [];
  }
}

// ─── Static Review ───────────────────────────────────────────────────────────

/**
 * Run code-inspector and convert findings to ReviewIssues.
 */
async function runStaticReview(targetPath: string, projectRoot: string): Promise<ReviewIssue[]> {
  const result = await inspectProject(targetPath, {
    severityFilter: 'warning',
    categoryFilter: 'all',
  });

  return result.findings.map((f) => ({
    priority: f.severity === 'critical' ? 'P1' : f.severity === 'error' ? 'P1' : 'P2',
    file: f.file,
    line: f.line,
    title: `[${f.rule}] ${f.message}`,
    detail: `\`${f.snippet}\``,
    suggestion: f.suggestion,
  } as ReviewIssue));
}

// ─── AI Review ───────────────────────────────────────────────────────────────

const REVIEW_SYSTEM_PROMPT = `You are a strict senior code reviewer. Your job is to find real issues in code changes.

Classify every issue with priority:
- P1: Must fix before merge — bugs, security vulnerabilities, data loss, build breaks, logic errors that affect correctness
- P2: Should fix — missing error handling, performance problems, incomplete test coverage, API contract violations
- P3: Nice to fix — naming, style, redundant code, missing comments

Output ONLY a valid JSON array. No prose, no markdown fences.
Format: [{"priority":"P1","file":"path/to/file.ts","line":42,"title":"short issue title","detail":"explanation","suggestion":"how to fix"}]

If there are no issues, return: []`;

function buildReviewPrompt(
  diff: string | null,
  files: string[],
  projectCtx: string,
  rules: string,
): string {
  const parts: string[] = [];

  if (projectCtx) parts.push(`## Project Context\n${projectCtx.slice(0, 2000)}`);
  if (rules) parts.push(`## Coding Rules\n${rules.slice(0, 1500)}`);

  if (diff) {
    // Truncate large diffs to stay within context
    const truncated = diff.length > 12000 ? diff.slice(0, 12000) + '\n...(truncated)' : diff;
    parts.push(`## Git Diff\n\`\`\`diff\n${truncated}\n\`\`\``);
  } else if (files.length > 0) {
    const fileContents = files
      .slice(0, 5) // max 5 files
      .map((f) => {
        const abs = resolve(f);
        if (!existsSync(abs)) return null;
        const content = readFileSync(abs, 'utf8').slice(0, 3000);
        return `### ${f}\n\`\`\`typescript\n${content}\n\`\`\``;
      })
      .filter(Boolean)
      .join('\n\n');
    parts.push(`## Files to Review\n${fileContents}`);
  }

  parts.push('Review the code above. Return a JSON array of issues. Return [] if no issues found.');
  return parts.join('\n\n');
}

async function runAIReview(
  diff: string | null,
  files: string[],
  projectRoot: string,
): Promise<ReviewIssue[]> {
  if (!diff && files.length === 0) return [];

  const ctx = loadProjectContext(projectRoot);
  const rules = loadRules(projectRoot);
  const prompt = buildReviewPrompt(diff, files, ctx.instructions, rules.content);

  try {
    const client = modelManager.getClient('main');
    const response = await client.chat({
      systemPrompt: REVIEW_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = response.content.trim();
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as ReviewIssue[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ─── Report Formatter ────────────────────────────────────────────────────────

function buildMarkdownReport(issues: ReviewIssue[]): string {
  if (issues.length === 0) {
    return '✅ **Code Review Passed** — no issues found.\n';
  }

  const p1 = issues.filter((i) => i.priority === 'P1');
  const p2 = issues.filter((i) => i.priority === 'P2');
  const p3 = issues.filter((i) => i.priority === 'P3');

  const lines: string[] = [
    `## 🔍 Code Review Report`,
    '',
    `> **${p1.length} P1** (must fix) · **${p2.length} P2** (should fix) · **${p3.length} P3** (nice to fix)`,
    '',
  ];

  for (const [label, group] of [['🔴 P1 — Must Fix', p1], ['🟡 P2 — Should Fix', p2], ['🔵 P3 — Nice to Fix', p3]] as const) {
    if ((group as ReviewIssue[]).length === 0) continue;
    lines.push(`### ${label}`, '');
    for (const issue of (group as ReviewIssue[])) {
      const loc = issue.line ? `:${issue.line}` : '';
      lines.push(`**[${issue.file}${loc}]** ${issue.title}`);
      lines.push(`> ${issue.detail}`);
      if (issue.suggestion) lines.push(`> 💡 ${issue.suggestion}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ─── Main Export ─────────────────────────────────────────────────────────────

export interface ReviewOptions {
  /** Git diff string (overrides auto-detect) */
  diff?: string;
  /** Specific files to review (used if no diff) */
  files?: string[];
  /** Project root for context loading */
  projectRoot?: string;
  /** Skip static analysis (code-inspector) — faster but less thorough */
  skipStatic?: boolean;
  /** Skip AI review — only static analysis */
  skipAI?: boolean;
}

/**
 * Run a full P1/P2/P3 code review.
 *
 * Pipeline:
 *   1. Static analysis via code-inspector (always, unless skipStatic)
 *   2. AI review of git diff or files (unless skipAI)
 *   3. Merge & deduplicate findings
 *   4. Format markdown report
 */
export async function reviewCode(options: ReviewOptions = {}): Promise<ReviewReport> {
  const root = resolve(options.projectRoot ?? process.cwd());

  // Auto-detect diff / files
  const diff = options.diff ?? getGitDiff(root);
  const files = options.files ?? (diff ? [] : getChangedFiles(root));

  const allIssues: ReviewIssue[] = [];

  // ── Static analysis ──
  if (!options.skipStatic) {
    try {
      const staticIssues = await runStaticReview(root, root);
      allIssues.push(...staticIssues);
    } catch { /* non-fatal */ }
  }

  // ── AI review ──
  if (!options.skipAI) {
    const aiIssues = await runAIReview(diff, files, root);
    allIssues.push(...aiIssues);
  }

  // Deduplicate by (file + line + title)
  const seen = new Set<string>();
  const deduped = allIssues.filter((i) => {
    const key = `${i.file}:${i.line ?? 0}:${i.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort: P1 → P2 → P3
  deduped.sort((a, b) => a.priority.localeCompare(b.priority));

  const summary = {
    P1: deduped.filter((i) => i.priority === 'P1').length,
    P2: deduped.filter((i) => i.priority === 'P2').length,
    P3: deduped.filter((i) => i.priority === 'P3').length,
  };

  return {
    summary,
    issues: deduped,
    markdown: buildMarkdownReport(deduped),
    hasBlockers: summary.P1 > 0,
  };
}
