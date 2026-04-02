/**
 * AI Code Reviewer
 *
 * Implements the P1/P2/P3 graded code review pipeline from kstack article #15332,
 * enhanced with a Four-Dimension quality framework from kstack article #15347
 * ("AI覆盖率在CNY的探索"):
 *
 * Severity grades:
 *   P1 — Must fix before merge (bugs, security, data loss, build breaks)
 *   P2 — Should fix (logic errors, missing tests, performance issues)
 *   P3 — Nice to fix (style, naming, comments, minor refactors)
 *
 * Four-Dimension review framework (article #15347):
 *   business      — Business Authenticity: is the scenario real and triggerable?
 *   coverage      — Coverage Precision: does it precisely cover the target code path?
 *   scenario      — Scenario Completeness: are edge cases and state transitions covered?
 *   executability — Executability: can the issue be directly acted on by a developer?
 *
 * Each ReviewIssue can now carry an optional `dimension` label that identifies
 * which quality dimension the issue belongs to. The final report includes a
 * Four-Dimension Summary block showing distribution of issues across dimensions.
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

/**
 * Four-Dimension quality framework from kstack article #15347
 * ("AI覆盖率在CNY的探索").
 *
 * Each review issue can be tagged with a dimension that identifies WHICH
 * quality aspect it belongs to. The report renders a dimension summary
 * so reviewers can see where issues cluster (e.g. mostly executability gaps
 * → tooling/environment problem; mostly business authenticity → LLM hallucination).
 *
 *   business      — Business Authenticity: is the scenario real and actually triggerable?
 *                   Anti-pattern: AI generates cases for dead code that is never called.
 *   coverage      — Coverage Precision: does the issue/case precisely cover the target
 *                   code path, not something adjacent or overlapping?
 *   scenario      — Scenario Completeness: are boundary conditions, invalid inputs, and
 *                   state transitions all represented?
 *   executability — Executability: can the issue be directly acted on by a developer?
 *                   (Has a clear reproduction path, expected vs actual, fix suggestion)
 */
export type ReviewDimension = 'business' | 'coverage' | 'scenario' | 'executability';

export interface ReviewIssue {
  priority: ReviewPriority;
  file: string;
  line?: number;
  title: string;
  detail: string;
  suggestion?: string;
  /**
   * Optional four-dimension label (kstack #15347).
   * When present, the report groups issues by dimension in the summary block.
   */
  dimension?: ReviewDimension;
}

export interface ReviewReport {
  /** Total issues by priority */
  summary: { P1: number; P2: number; P3: number };
  issues: ReviewIssue[];
  /** Formatted markdown report (includes Four-Dimension Summary when dimensions are populated) */
  markdown: string;
  /** Whether P1 issues exist (used for --review auto-fix loop) */
  hasBlockers: boolean;
  /**
   * Four-Dimension distribution (kstack #15347).
   * Only populated when at least one issue has a `dimension` field.
   */
  dimensionSummary?: Record<ReviewDimension, number>;
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

Additionally, tag each issue with a "dimension" from the Four-Dimension quality framework
(kstack article #15347 — AI Coverage Rate Engineering Practice):
- "business":      Business Authenticity — does this relate to a scenario that is real and triggerable?
                   Flag if code paths are unreachable (dead code) or scenarios are hypothetical.
- "coverage":      Coverage Precision — does the issue indicate a code path that is NOT precisely tested/handled?
                   Flag missing branches, uncovered error paths, or adjacent-but-wrong coverage.
- "scenario":      Scenario Completeness — are edge cases, invalid inputs, and state transitions addressed?
                   Flag missing boundary conditions, race conditions, or incomplete state machine transitions.
- "executability": Executability — can the issue be directly acted on? Does it have a clear reproduction path?
                   Flag vague errors, missing context, or issues without a clear fix direction.

Output ONLY a valid JSON array. No prose, no markdown fences.
Format: [{"priority":"P1","file":"path/to/file.ts","line":42,"title":"short issue title","detail":"explanation","suggestion":"how to fix","dimension":"executability"}]

The "dimension" field is optional but highly encouraged — omit only if the issue clearly fits none of the four dimensions.

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

/**
 * Build the Four-Dimension summary block.
 * Only renders when at least one issue has a `dimension` field.
 *
 * Inspired by kstack article #15347:
 * "制定Agent间信息传输协议，格式化独立context避免幻觉"
 * — the same principle applies here: giving reviewers a structured
 *   dimension breakdown reduces cognitive load and surfaces systemic gaps.
 */
function buildDimensionSummary(
  issues: ReviewIssue[],
): { block: string; counts: Record<ReviewDimension, number> } | null {
  const dimensioned = issues.filter((i) => i.dimension);
  if (dimensioned.length === 0) return null;

  const counts: Record<ReviewDimension, number> = {
    business: 0,
    coverage: 0,
    scenario: 0,
    executability: 0,
  };
  for (const i of dimensioned) {
    if (i.dimension) counts[i.dimension]++;
  }

  const DIM_META: Record<ReviewDimension, { emoji: string; label: string; desc: string }> = {
    business:      { emoji: '🏢', label: 'Business Authenticity', desc: 'Real + triggerable scenarios' },
    coverage:      { emoji: '🎯', label: 'Coverage Precision',    desc: 'Target code path precisely hit' },
    scenario:      { emoji: '🗺️', label: 'Scenario Completeness', desc: 'Edge cases + state transitions' },
    executability: { emoji: '⚙️', label: 'Executability',         desc: 'Clear repro path + fix direction' },
  };

  const rows = (Object.entries(counts) as [ReviewDimension, number][])
    .filter(([, n]) => n > 0)
    .map(([dim, n]) => {
      const { emoji, label, desc } = DIM_META[dim];
      return `| ${emoji} ${label} | ${n} | ${desc} |`;
    });

  const block = [
    `### 🔬 Four-Dimension Quality Analysis (kstack #15347)`,
    ``,
    `> Tagging issues across 4 dimensions helps identify systemic gaps.`,
    `> High "business" count → dead-code or unreachable paths; high "executability" → unclear fix direction.`,
    ``,
    `| Dimension | Count | Focus Area |`,
    `|-----------|-------|------------|`,
    ...rows,
    ``,
  ].join('\n');

  return { block, counts };
}

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
      const dimTag = issue.dimension ? ` \`[${issue.dimension}]\`` : '';
      lines.push(`**[${issue.file}${loc}]** ${issue.title}${dimTag}`);
      lines.push(`> ${issue.detail}`);
      if (issue.suggestion) lines.push(`> 💡 ${issue.suggestion}`);
      lines.push('');
    }
  }

  // Append Four-Dimension Summary block if any issues carry dimension tags
  const dimSummary = buildDimensionSummary(issues);
  if (dimSummary) {
    lines.push('---', '', dimSummary.block);
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

  // ── Run static + AI review concurrently (independent — no shared state) ──
  const [staticIssues, aiIssues] = await Promise.all([
    options.skipStatic
      ? Promise.resolve([] as ReviewIssue[])
      : runStaticReview(root, root).catch(() => [] as ReviewIssue[]),
    options.skipAI
      ? Promise.resolve([] as ReviewIssue[])
      : runAIReview(diff, files, root).catch(() => [] as ReviewIssue[]),
  ]);

  const allIssues: ReviewIssue[] = [...staticIssues, ...aiIssues];

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

  const markdown = buildMarkdownReport(deduped);
  const dimSummary = buildDimensionSummary(deduped);

  return {
    summary,
    issues: deduped,
    markdown,
    hasBlockers: summary.P1 > 0,
    ...(dimSummary ? { dimensionSummary: dimSummary.counts } : {}),
  };
}
