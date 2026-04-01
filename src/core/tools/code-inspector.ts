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
  // Use a factory so each call gets a fresh RegExp (avoids lastIndex state leaking
  // when the /g flag is present — even though we don't use /g here, using a
  // factory is defensive and makes adding flags later safe).
  pattern: () => RegExp;
  severity: Severity;
  category: Category;
  message: string;
  suggestion?: string;
}

const RULES: Rule[] = [
  // ── Bug rules ─────────────────────────────────────────
  {
    id: 'no-floating-promise',
    // Matches lines that call async APIs without await/return/void
    pattern: () => /(?<!\bawait\s)(?<!\breturn\s)(?<!\bvoid\s)\b(?:fetch|axios\.\w+|fs\.\w+Async)\s*\(/,
    severity: 'error',
    category: 'bug',
    message: 'Potentially unhandled Promise — use await, return, or void',
    suggestion: 'Add await or .catch() to handle the Promise',
  },
  {
    id: 'console-log-leftover',
    pattern: () => /console\.(log|warn|error|debug|trace)\s*\(/,
    severity: 'warning',
    category: 'style',
    message: 'console statement found — remove before production',
    suggestion: 'Replace with a proper logger or remove',
  },
  {
    id: 'hardcoded-secret',
    pattern: () => /(?:api[-_]?key|secret|password|token|auth)\s*[:=]\s*["'][^"']{8,}["']/i,
    severity: 'critical',
    category: 'security',
    message: 'Possible hardcoded secret or credential',
    suggestion: 'Move to environment variable or secrets manager',
  },
  {
    id: 'sql-injection-risk',
    pattern: () => /(?:query|execute|run)\s*\(\s*[`"'].*?\$\{/,
    severity: 'critical',
    category: 'security',
    message: 'Potential SQL injection — string interpolation in query',
    suggestion: 'Use parameterized queries or prepared statements',
  },
  {
    id: 'empty-catch',
    // Matches catch blocks that are completely empty or contain only a comment
    pattern: () => /catch\s*\([^)]*\)\s*\{\s*(?:\/\/[^\n]*)?\s*\}/,
    severity: 'error',
    category: 'bug',
    message: 'Empty catch block silently swallows errors',
    suggestion: 'Log the error or re-throw it',
  },
  {
    id: 'no-explicit-any',
    pattern: () => /:\s*any\b(?!\s*\/\/\s*eslint-disable)/,
    severity: 'warning',
    category: 'style',
    message: 'Explicit `any` type weakens type safety',
    suggestion: 'Replace with a specific type or `unknown`',
  },
  {
    id: 'non-null-assertion',
    // Match `!.` or `![` but not `!!` or `!==`
    pattern: () => /[^!=]!\s*[.[]/,
    severity: 'warning',
    category: 'bug',
    message: 'Non-null assertion operator (!) suppresses null checks',
    suggestion: 'Use optional chaining (?.) or add explicit null check',
  },
  {
    id: 'todo-fixme',
    pattern: () => /\/\/\s*(TODO|FIXME|HACK|XXX|BUG)\b/i,
    severity: 'info',
    category: 'style',
    message: 'Unresolved TODO/FIXME comment',
    suggestion: 'Create a ticket and remove the comment',
  },

  // ── Security rules (OWASP Top 10 / CWE/MITRE Top 25) ──
  {
    id: 'command-injection',
    // exec('cmd ' + userInput) or exec(`cmd ${var}`)
    pattern: () => /\bexec\s*\(\s*(?:[`'"].*?\$\{|[^)]*?\+\s*[a-zA-Z_$])/,
    severity: 'critical',
    category: 'security',
    message: 'Possible command injection — user data in exec() call',
    suggestion: 'Use execFile(cmd, [argsArray]) to avoid shell interpolation',
  },
  {
    id: 'path-traversal',
    // readFileSync('./uploads/' + var) or join(dir, userInput) without validation
    pattern: () => /(?:readFileSync|writeFileSync|createReadStream|createWriteStream|join\s*\(\s*[^,]+,\s*(?:req\.|params\.|query\.|body\.|args\.))/,
    severity: 'error',
    category: 'security',
    message: 'Potential path traversal — user-controlled path argument',
    suggestion: 'Resolve the path and assert it starts with the expected base directory',
  },
  {
    id: 'xss-innerhtml',
    pattern: () => /\.innerHTML\s*[+]?=/,
    severity: 'error',
    category: 'security',
    message: 'innerHTML assignment — potential XSS (CWE-79)',
    suggestion: 'Use textContent, or sanitise with DOMPurify before assigning innerHTML',
  },
  {
    id: 'eval-usage',
    pattern: () => /\beval\s*\(/,
    severity: 'critical',
    category: 'security',
    message: 'eval() usage — arbitrary code execution risk (CWE-94)',
    suggestion: 'Remove eval(). Use JSON.parse() for data, or Function constructor with extreme caution',
  },
  {
    id: 'insecure-random',
    // Math.random() for security/crypto purposes (detected by nearby context keywords)
    pattern: () => /Math\.random\s*\(\s*\).*(?:token|secret|key|nonce|salt|id|uuid)/i,
    severity: 'error',
    category: 'security',
    message: 'Math.random() used for security-sensitive value — not cryptographically secure',
    suggestion: 'Use crypto.randomBytes() or crypto.randomUUID() instead',
  },
  {
    id: 'error-stack-exposure',
    // res.json/send with err.stack or err.message in error handlers
    pattern: () => /(?:res\.(?:json|send|status)|response\.(?:json|send))\s*\([^)]*(?:err\.stack|error\.stack)/,
    severity: 'error',
    category: 'security',
    message: 'Stack trace exposed in HTTP response — information disclosure (CWE-209)',
    suggestion: 'Log err.stack server-side; return only a generic error message to the client',
  },
  {
    id: 'weak-crypto',
    // MD5 or SHA1 for signing/hashing passwords
    pattern: () => /createHash\s*\(\s*['"](?:md5|sha1)['"]\s*\)/i,
    severity: 'error',
    category: 'security',
    message: 'Weak hash algorithm (MD5/SHA1) — not suitable for passwords or integrity checks',
    suggestion: 'Use SHA-256 or bcrypt/argon2 for passwords',
  },
  {
    id: 'prototype-pollution',
    // Object.assign/merge with user-supplied object at top level
    pattern: () => /Object\.assign\s*\(\s*(?:this|prototype|Object\.prototype|globalThis|global)/,
    severity: 'critical',
    category: 'security',
    message: 'Potential prototype pollution — merging into prototype or global object',
    suggestion: 'Validate that merged objects do not contain __proto__, constructor, or prototype keys',
  },

  // ── Performance rules ──────────────────────────────────
  {
    id: 'array-push-in-loop',
    // Only match simple single-line for loops with a push — avoids false positives
    pattern: () => /for\s*\([^)]+\)\s*\{[^{}]*\.push\s*\(/,
    severity: 'warning',
    category: 'performance',
    message: 'Array.push inside loop — consider pre-allocating or using map/filter',
    suggestion: 'Use Array.from(), map(), or pre-allocate the array',
  },
  {
    id: 'sync-in-async',
    pattern: () => /\b(?:readFileSync|writeFileSync|execSync)\s*\(/,
    severity: 'warning',
    category: 'performance',
    message: 'Synchronous I/O — may block the event loop',
    suggestion: 'Use async variants (readFile, writeFile, exec) with await',
  },
  {
    id: 'large-json-stringify',
    pattern: () => /JSON\.stringify\s*\([^)]{50,}\)/,
    severity: 'info',
    category: 'performance',
    message: 'Complex JSON.stringify call — may be slow on large objects',
    suggestion: 'Consider streaming serialization for large payloads',
  },

  // ── Style rules ────────────────────────────────────────
  {
    id: 'magic-number',
    // Numbers ≥ 10 that are NOT 10, 16, 32, 64, 100, 1000 and not part of identifiers
    pattern: () => /(?<![.\w])\b(?!10\b|16\b|32\b|64\b|100\b|1000\b)\d{3,}\b(?![.\w%])/,
    severity: 'info',
    category: 'style',
    message: 'Magic number — extract to a named constant',
    suggestion: 'const MAX_ITEMS = <value>;',
  },
];

// ─── Scanner ─────────────────────────────────────────────

/**
 * Scan a single file for all rule violations.
 * Each rule creates a fresh RegExp via its factory to avoid lastIndex state leaks.
 */
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
    lines.forEach((line, lineIdx) => {
      // Skip pure comment lines for most rules (avoid scanning commented-out code)
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') && rule.id !== 'todo-fixme') return;
      if (trimmed.startsWith('*')) return; // JSDoc

      // Fresh RegExp per line per rule → no lastIndex issues
      const re = rule.pattern();
      const match = re.exec(line);
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

  // Pass already-split lines to avoid re-splitting inside detectLongFunctions (b9 opt)
  findings.push(...detectLongFunctions(lines, relFile));

  return findings;
}

/**
 * Detect functions with more than LONG_FN_THRESHOLD lines by tracking brace depth.
 * Accepts already-split lines to avoid a redundant content.split('\n') call
 * (scanFile already splits the content once; passing lines avoids re-splitting on large files).
 */
function detectLongFunctions(lines: string[], relFile: string): Finding[] {
  const LONG_FN_THRESHOLD = 60; // lines
  const findings: Finding[] = [];
  // `lines` is already split by the caller

  // Find function definition lines
  const fnDefPattern = /(?:^|\s)(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w]+)\s*=>|\w+\s*\([^)]*\)\s*\{)/;

  for (let i = 0; i < lines.length; i++) {
    if (!fnDefPattern.test(lines[i])) continue;
    if (!lines[i].includes('{')) continue;

    // Count lines until matching closing brace
    let depth = 0;
    let start = i;
    let end = -1;

    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) { end = j; break; }
        }
      }
      if (end !== -1) break;
    }

    if (end !== -1 && (end - start) > LONG_FN_THRESHOLD) {
      findings.push({
        file: relFile,
        line: start + 1,
        column: 1,
        severity: 'info',
        category: 'style',
        rule: 'long-function',
        message: `Function is ${end - start} lines long — consider splitting`,
        snippet: lines[start].trim().slice(0, 120),
        suggestion: 'Extract logic into smaller, focused functions',
      });
    }
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
  const penalties: Record<Severity, number> = { critical: 20, error: 10, warning: 3, info: 1 };
  const total = findings.reduce((sum, f) => sum + (penalties[f.severity] ?? 0), 0);
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
    const arr = byFile.get(f.file) ?? [];
    arr.push(f);
    byFile.set(f.file, arr);
  }

  lines.push('\n📋 Issues by file:\n');

  for (const [file, filFindings] of byFile.entries()) {
    lines.push(`📄 ${file} (${filFindings.length} issue${filFindings.length !== 1 ? 's' : ''})`);
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
      lines.push(`  ... and ${filFindings.length - 5} more (use --verbose to see all)`);
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

// ─── Programmatic API ────────────────────────────────────

export interface InspectOptions {
  severityFilter?: Severity;
  categoryFilter?: Category | 'all';
}

/**
 * Programmatic inspection API for use by ai-reviewer and other tools.
 * Returns structured InspectionResult without any formatting.
 */
export async function inspectProject(
  targetPath: string,
  options: InspectOptions = {},
): Promise<InspectionResult> {
  const minSeverity = options.severityFilter ?? 'warning';
  const filterCategory = options.categoryFilter ?? 'all';

  if (!existsSync(targetPath)) {
    return { scanned: 0, findings: [], summary: { critical: 0, error: 0, warning: 0, info: 0 }, score: 100 };
  }

  let st: ReturnType<typeof statSync>;
  try { st = statSync(targetPath); } catch {
    return { scanned: 0, findings: [], summary: { critical: 0, error: 0, warning: 0, info: 0 }, score: 100 };
  }

  const files = st.isFile()
    ? [targetPath]
    : collectFiles(targetPath, ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
  const rootDir = st.isFile() ? resolve(targetPath, '..') : targetPath;

  const severityOrder: Severity[] = ['info', 'warning', 'error', 'critical'];
  const minIdx = severityOrder.indexOf(minSeverity);

  let allFindings: Finding[] = [];
  for (const file of files) allFindings.push(...scanFile(file, rootDir));
  allFindings = allFindings.filter((f) => {
    const sevOk = severityOrder.indexOf(f.severity) >= minIdx;
    const catOk = filterCategory === 'all' || f.category === filterCategory;
    return sevOk && catOk;
  });
  allFindings.sort((a, b) => {
    const diff = severityOrder.indexOf(b.severity) - severityOrder.indexOf(a.severity);
    return diff !== 0 ? diff : a.file.localeCompare(b.file);
  });

  const summary: Record<Severity, number> = { critical: 0, error: 0, warning: 0, info: 0 };
  for (const f of allFindings) summary[f.severity]++;

  return { scanned: files.length, findings: allFindings, summary, score: computeScore(allFindings, files.length) };
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

    // Bug fix: wrap statSync in try/catch to avoid crashing on broken symlinks
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(targetPath);
    } catch (err) {
      return `Error: Cannot stat path: ${targetPath} — ${err instanceof Error ? err.message : String(err)}`;
    }

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

    // Sort: critical first, then by file name
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
