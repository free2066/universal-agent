/**
 * Code Inspector Tool
 * Statically scans TypeScript/JavaScript files for:
 *  - Bug patterns (null-deref, uncaught promise, etc.)
 *  - Performance anti-patterns
 *  - Code-style / convention violations
 *
 * This is a pure static analysis layer that runs WITHOUT an LLM.
 * Results are returned as structured findings so the agent can
 * decide which ones to fix automatically.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, join, relative, extname } from 'path';
import type { ToolRegistration } from '../../models/types.js';

// ─── Types ───────────────────────────────────────────────

export type Severity = 'critical' | 'error' | 'warning' | 'info';
export type Category = 'bug' | 'performance' | 'style' | 'security';

export interface Finding {
  file: string;
  line: number;
  column: number;
  severity: Severity;
  category: Category;
  rule: string;
  message: string;
  snippet: string;
  suggestion?: string;
}

export interface InspectionResult {
  scanned: number;
  findings: Finding[];
  summary: Record<Severity, number>;
  score: number; // 0-100, higher is better
}

// ─── Rules ───────────────────────────────────────────────

interface Rule {
  id: string;
  pattern: RegExp;
  severity: Severity;
  category: Category;
  message: string;
  suggestion?: string;
}

const RULES: Rule[] = [
  // ── Bug rules ─────────────────────────────────────────
  {
    id: 'no-floating-promise',
    pattern: /(?<!\bawait\b\s+)(?<!\breturn\b\s+)(?<!\bvoid\b\s+)\b(fetch|axios\.\w+|fs\.\w+Async|\w+\.then\()\s*\(/,
    severity: 'error',
    category: 'bug',
    message: 'Potentially unhandled Promise — use await, return, or void',
    suggestion: 'Add await or .catch() to handle the Promise',
  },
  {
    id: 'unsafe-optional-chain',
    pattern: /\b(\w+)\.(\w+)\s+(?![\?!])/,
    severity: 'info',
    category: 'bug',
    message: 'Property access without optional chaining on potentially nullable value',
    suggestion: 'Use optional chaining: obj?.property',
  },
  {
    id: 'console-log-leftover',
    pattern: /console\.(log|warn|error|debug|trace)\s*\(/,
    severity: 'warning',
    category: 'style',
    message: 'console statement found — remove before production',
    suggestion: 'Replace with a proper logger or remove',
  },
  {
    id: 'hardcoded-secret',
    pattern: /(?:api[-_]?key|secret|password|token|auth)\s*[:=]\s*["'][^"']{8,}["']/i,
    severity: 'critical',
    category: 'security',
    message: 'Possible hardcoded secret or credential',
    suggestion: 'Move to environment variable or secrets manager',
  },
  {
    id: 'sql-injection-risk',
    pattern: /(?:query|execute|run)\s*\(\s*[`"'].*?\$\{/,
    severity: 'critical',
    category: 'security',
    message: 'Potential SQL injection — string interpolation in query',
    suggestion: 'Use parameterized queries or prepared statements',
  },
  {
    id: 'empty-catch',
    pattern: /catch\s*\([^)]*\)\s*\{\s*(?:\/\/[^\n]*)?\s*\}/,
    severity: 'error',
    category: 'bug',
    message: 'Empty catch block silently swallows errors',
    suggestion: 'Log the error or re-throw it',
  },
  {
    id: 'no-explicit-any',
    pattern: /:\s*any\b(?!\s*\/\/\s*eslint-disable)/,
    severity: 'warning',
    category: 'style',
    message: 'Explicit `any` type weakens type safety',
    suggestion: 'Replace with a specific type or `unknown`',
  },
  {
    id: 'non-null-assertion',
    pattern: /[^!]!\s*[.[\(]/,
    severity: 'warning',
    category: 'bug',
    message: 'Non-null assertion operator (!) suppresses null checks',
    suggestion: 'Use optional chaining (?.) or add explicit null check',
  },
  {
    id: 'todo-fixme',
    pattern: /\/\/\s*(TODO|FIXME|HACK|XXX|BUG)\b/i,
    severity: 'info',
    category: 'style',
    message: 'Unresolved TODO/FIXME comment',
    suggestion: 'Create a ticket and remove the comment',
  },

  // ── Performance rules ──────────────────────────────────
  {
    id: 'array-in-loop',
    pattern: /for\s*\([^)]*\)\s*\{[^}]*\.push\s*\(/,
    severity: 'warning',
    category: 'performance',
    message: 'Array.push inside loop — consider pre-allocating or using map/filter',
    suggestion: 'Use Array.from(), map(), or pre-allocate the array',
  },
  {
    id: 'nested-loops',
    pattern: /for\s*\([^{]+\{[^}]*for\s*\([^{]+\{/,
    severity: 'warning',
    category: 'performance',
    message: 'Nested loops detected — potential O(n²) complexity',
    suggestion: 'Consider using a Map/Set for O(1) lookups',
  },
  {
    id: 'sync-in-async',
    pattern: /(?:readFileSync|writeFileSync|execSync)\s*\(/,
    severity: 'warning',
    category: 'performance',
    message: 'Synchronous I/O inside potentially async context',
    suggestion: 'Use async variants (readFile, writeFile, exec) with await',
  },
  {
    id: 'new-in-loop',
    pattern: /for\s*\([^{]+\{[^}]*new\s+\w+\s*\(/,
    severity: 'warning',
    category: 'performance',
    message: 'Object instantiation inside loop',
    suggestion: 'Move instantiation outside the loop if possible',
  },
  {
    id: 'large-json-stringify',
    pattern: /JSON\.stringify\s*\([^)]{50,}\)/,
    severity: 'info',
    category: 'performance',
    message: 'Complex JSON.stringify call — may be slow on large objects',
    suggestion: 'Consider streaming serialization for large payloads',
  },

  // ── Style rules ────────────────────────────────────────
  {
    id: 'magic-number',
    pattern: /(?<![.\w])\b(?!0|1|2|-1|100|1000)\d{2,}\b(?![.\w%])/,
    severity: 'info',
    category: 'style',
    message: 'Magic number — extract to a named constant',
    suggestion: 'const MAX_ITEMS = 50;',
  },
  {
    id: 'long-function',
    pattern: /(?:function\s+\w+|=>\s*)\{(?:[^{}]|\{[^{}]*\}){200,}\}/,
    severity: 'info',
    category: 'style',
    message: 'Function may be too long (>200 chars) — consider splitting',
    suggestion: 'Extract logic into smaller, focused functions',
  },
];

// ─── Scanner ─────────────────────────────────────────────

function scanFile(filePath: string, rootDir: string): Finding[] {
  const findings: Finding[] = [];
  let content: string;

  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return findings;
  }

  const lines = content.split('\n');
  const relFile = relative(rootDir, filePath);

  for (const rule of RULES) {
    // Match line-by-line for precise location
    lines.forEach((line, lineIdx) => {
      // Skip comment-only lines for most rules
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') && rule.id !== 'todo-fixme') return;
      if (trimmed.startsWith('*')) return; // JSDoc

      const match = rule.pattern.exec(line);
      if (match) {
        findings.push({
          file: relFile,
          line: lineIdx + 1,
          column: match.index + 1,
          severity: rule.severity,
          category: rule.category,
          rule: rule.id,
          message: rule.message,
          snippet: line.trim().slice(0, 120),
          suggestion: rule.suggestion,
        });
      }
    });
  }

  return findings;
}

function collectFiles(dir: string, exts: string[], maxFiles = 500): string[] {
  const files: string[] = [];

  function walk(current: string, depth: number) {
    if (depth > 8 || files.length >= maxFiles) return;
    let entries: string[];
    try { entries = readdirSync(current); } catch { return; }

    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
      const full = join(current, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full, depth + 1);
        } else if (exts.includes(extname(entry).toLowerCase())) {
          files.push(full);
        }
      } catch { /* skip broken symlinks */ }
    }
  }

  walk(dir, 0);
  return files;
}

function computeScore(findings: Finding[], fileCount: number): number {
  if (fileCount === 0) return 100;
  const penalties = { critical: 20, error: 10, warning: 3, info: 1 };
  const total = findings.reduce((sum, f) => sum + (penalties[f.severity] || 0), 0);
  return Math.max(0, Math.round(100 - (total / Math.max(fileCount, 1))));
}

function formatReport(result: InspectionResult, verbose: boolean): string {
  const lines: string[] = [];
  const sev = result.summary;

  lines.push(`\n🔍 Code Inspection Report`);
  lines.push(`${'─'.repeat(50)}`);
  lines.push(`Files scanned : ${result.scanned}`);
  lines.push(`Health score  : ${result.score}/100 ${scoreEmoji(result.score)}`);
  lines.push(`Findings      : ${result.findings.length} total`);
  lines.push(`  🔴 Critical : ${sev.critical}`);
  lines.push(`  🟠 Error    : ${sev.error}`);
  lines.push(`  🟡 Warning  : ${sev.warning}`);
  lines.push(`  🔵 Info     : ${sev.info}`);

  if (result.findings.length === 0) {
    lines.push('\n✅ No issues found!');
    return lines.join('\n');
  }

  // Group by file
  const byFile = new Map<string, Finding[]>();
  for (const f of result.findings) {
    const arr = byFile.get(f.file) || [];
    arr.push(f);
    byFile.set(f.file, arr);
  }

  lines.push('\n📋 Issues by file:\n');

  for (const [file, filFindings] of byFile.entries()) {
    lines.push(`📄 ${file} (${filFindings.length} issues)`);
    const shown = verbose ? filFindings : filFindings.slice(0, 5);
    for (const f of shown) {
      const icon = { critical: '🔴', error: '🟠', warning: '🟡', info: '🔵' }[f.severity];
      lines.push(`  ${icon} L${f.line}:${f.column} [${f.rule}] ${f.message}`);
      if (verbose) {
        lines.push(`     Code: ${f.snippet}`);
        if (f.suggestion) lines.push(`     Fix : ${f.suggestion}`);
      }
    }
    if (!verbose && filFindings.length > 5) {
      lines.push(`  ... and ${filFindings.length - 5} more`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function scoreEmoji(score: number): string {
  if (score >= 90) return '🟢 Excellent';
  if (score >= 75) return '🟡 Good';
  if (score >= 50) return '🟠 Needs work';
  return '🔴 Poor';
}

// ─── Tool Registration ────────────────────────────────────

export const codeInspectorTool: ToolRegistration = {
  definition: {
    name: 'InspectCode',
    description: [
      'Static code inspection: scans TypeScript/JavaScript files for bugs, security issues,',
      'performance anti-patterns, and style violations. Returns structured findings with',
      'line numbers, severity levels, and fix suggestions.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory or single file to inspect (default: current directory)',
        },
        severity: {
          type: 'string',
          description: 'Minimum severity to report: critical | error | warning | info',
          enum: ['critical', 'error', 'warning', 'info'],
        },
        category: {
          type: 'string',
          description: 'Filter by category: bug | performance | style | security | all',
          enum: ['bug', 'performance', 'style', 'security', 'all'],
        },
        verbose: {
          type: 'boolean',
          description: 'Show code snippets and fix suggestions (default: false)',
        },
        format: {
          type: 'string',
          description: 'Output format: report | json',
          enum: ['report', 'json'],
        },
      },
    },
  },
  handler: async (args) => {
    const targetPath = resolve(process.cwd(), (args.path as string) || '.');
    const minSeverity = (args.severity as Severity) || 'info';
    const filterCategory = (args.category as Category | 'all') || 'all';
    const verbose = (args.verbose as boolean) || false;
    const format = (args.format as string) || 'report';

    if (!existsSync(targetPath)) {
      return `Error: Path not found: ${targetPath}`;
    }

    const st = statSync(targetPath);
    const files = st.isFile()
      ? [targetPath]
      : collectFiles(targetPath, ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

    const rootDir = st.isFile() ? resolve(targetPath, '..') : targetPath;
    const severityOrder: Severity[] = ['info', 'warning', 'error', 'critical'];
    const minIdx = severityOrder.indexOf(minSeverity);

    let allFindings: Finding[] = [];
    for (const file of files) {
      allFindings.push(...scanFile(file, rootDir));
    }

    // Filter
    allFindings = allFindings.filter((f) => {
      const sevOk = severityOrder.indexOf(f.severity) >= minIdx;
      const catOk = filterCategory === 'all' || f.category === filterCategory;
      return sevOk && catOk;
    });

    // Sort: critical first
    allFindings.sort((a, b) => {
      const diff = severityOrder.indexOf(b.severity) - severityOrder.indexOf(a.severity);
      return diff !== 0 ? diff : a.file.localeCompare(b.file);
    });

    const summary: Record<Severity, number> = { critical: 0, error: 0, warning: 0, info: 0 };
    for (const f of allFindings) summary[f.severity]++;

    const result: InspectionResult = {
      scanned: files.length,
      findings: allFindings,
      summary,
      score: computeScore(allFindings, files.length),
    };

    if (format === 'json') return JSON.stringify(result, null, 2);
    return formatReport(result, verbose);
  },
};
