/**
 * Self-Healing Engine
 *
 * Orchestrates the "auto-purify" loop:
 *   1. Run static inspection  →  collect findings
 *   2. For each auto-fixable finding, attempt an LLM-guided patch
 *   3. Verify the patch compiles / passes tests
 *   4. Commit on success, roll back on failure
 *
 * Design goals:
 *  - Minimal blast radius: one finding → one patch attempt → verify → apply/revert
 *  - Never auto-apply CRITICAL security fixes silently (requires approval)
 *  - Dry-run mode for safe preview
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { execSync } from 'child_process';
import type { ToolRegistration } from '../../models/types.js';
import {
  type Finding,
  type InspectionResult,
  type Severity,
  codeInspectorTool,
} from './code-inspector.js';

// ─── Types ───────────────────────────────────────────────

export interface HealResult {
  finding: Finding;
  status: 'fixed' | 'skipped' | 'failed' | 'pending_approval';
  patch?: string;
  error?: string;
}

export interface PurifyResult {
  inspected: InspectionResult;
  healed: HealResult[];
  scoreAfter: number;
  committed: boolean;
}

// Rules that are safe to auto-fix without human review
const AUTO_FIXABLE_RULES = new Set([
  'console-log-leftover',
  'empty-catch',
  'todo-fixme',
  'no-explicit-any',
]);

// Rules that should never be auto-fixed (too risky)
const REQUIRES_APPROVAL = new Set([
  'hardcoded-secret',
  'sql-injection-risk',
]);

// ─── Patch Generators ─────────────────────────────────────

/**
 * Generate a deterministic fix for simple rules without LLM.
 * Returns the patched line or null if no deterministic fix exists.
 */
function deterministicFix(line: string, rule: string): string | null {
  switch (rule) {
    case 'console-log-leftover': {
      // Comment out console.* calls
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//')) return null;
      const indent = line.length - trimmed.length;
      return ' '.repeat(indent) + '// ' + trimmed;
    }
    case 'no-explicit-any': {
      // Replace `: any` with `: unknown` where safe (not in function params with `any[]`)
      if (line.includes(': any[]')) return null; // skip arrays — context-dependent
      return line.replace(/:\s*any\b(?!\s*\/\/)/g, ': unknown');
    }
    default:
      return null;
  }
}

// ─── Verifier ─────────────────────────────────────────────

function verifyBuild(projectRoot: string): boolean {
  try {
    // Try TypeScript check first, fall back to just checking syntax
    const hasTs = existsSync(join(projectRoot, 'tsconfig.json'));
    const cmd = hasTs ? 'npx tsc --noEmit 2>&1' : 'node --check . 2>&1';
    execSync(cmd, { cwd: projectRoot, timeout: 60000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ─── Core Healing Logic ───────────────────────────────────

async function healFinding(
  finding: Finding,
  projectRoot: string,
  dryRun: boolean
): Promise<HealResult> {
  // Never auto-fix security issues
  if (REQUIRES_APPROVAL.has(finding.rule)) {
    return { finding, status: 'pending_approval' };
  }

  // Only deterministic fixes for non-auto-fixable rules
  if (!AUTO_FIXABLE_RULES.has(finding.rule)) {
    return { finding, status: 'skipped' };
  }

  const filePath = resolve(projectRoot, finding.file);
  if (!existsSync(filePath)) return { finding, status: 'failed', error: 'File not found' };

  let original: string;
  try {
    original = readFileSync(filePath, 'utf-8');
  } catch (err) {
    return { finding, status: 'failed', error: String(err) };
  }

  const lines = original.split('\n');
  const lineIdx = finding.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) {
    return { finding, status: 'failed', error: 'Line index out of bounds' };
  }

  const originalLine = lines[lineIdx];
  const fixed = deterministicFix(originalLine, finding.rule);

  if (!fixed) {
    return { finding, status: 'skipped' };
  }

  const patch = `L${finding.line}: ${originalLine.trim()} → ${fixed.trim()}`;

  if (dryRun) {
    return { finding, status: 'fixed', patch };
  }

  // Apply patch
  lines[lineIdx] = fixed;
  const patched = lines.join('\n');

  try {
    writeFileSync(filePath, patched, 'utf-8');
  } catch (err) {
    return { finding, status: 'failed', error: `Write failed: ${err}` };
  }

  // Verify build still passes
  const buildOk = verifyBuild(projectRoot);
  if (!buildOk) {
    // Revert
    try { writeFileSync(filePath, original, 'utf-8'); } catch { /* ignore */ }
    return { finding, status: 'failed', error: 'Build failed after patch — reverted' };
  }

  return { finding, status: 'fixed', patch };
}

function commitFixes(projectRoot: string, count: number): boolean {
  try {
    execSync('git add -A', { cwd: projectRoot, stdio: 'pipe' });
    // Bug fix: newline in -m arg causes shell parse error — use two -m flags instead
    execSync(
      `git commit -m "fix(auto-purify): auto-fix ${count} finding(s)" -m "Applied by self-healing engine"`,
      { cwd: projectRoot, stdio: 'pipe', timeout: 30000 }
    );
    return true;
  } catch {
    return false;
  }
}

// ─── Tool Registration ─────────────────────────────────────

export const selfHealTool: ToolRegistration = {
  definition: {
    name: 'SelfHeal',
    description: [
      'Self-healing engine: automatically detects and fixes code issues.',
      'Runs static inspection, applies deterministic fixes for safe rules,',
      'verifies the build compiles after each fix, rolls back on failure.',
      'Security issues always require human approval.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Project root directory (default: current directory)',
        },
        dry_run: {
          type: 'boolean',
          description: 'Preview fixes without applying them (default: false)',
        },
        severity: {
          type: 'string',
          description: 'Minimum severity to attempt fixing: error | warning | info',
          enum: ['error', 'warning', 'info'],
        },
        commit: {
          type: 'boolean',
          description: 'Commit fixed files with git (default: false)',
        },
        max_fixes: {
          type: 'number',
          description: 'Maximum number of fixes to apply in one run (default: 20)',
        },
      },
    },
  },
  handler: async (args) => {
    const rawPath = resolve(process.cwd(), (args.path as string) || '.');

    // Bug b9: if the caller passes a single file path instead of a directory,
    // use the file's parent directory as projectRoot so codeInspectorTool
    // (which expects a directory) doesn't report "File not found".
    const rawPathStat = existsSync(rawPath) ? statSync(rawPath) : null;
    const projectRoot = rawPathStat?.isFile() ? dirname(rawPath) : rawPath;

    const dryRun = (args.dry_run as boolean) ?? false;
    const minSeverity = (args.severity as Severity) || 'warning';
    const doCommit = (args.commit as boolean) ?? false;
    const maxFixes = (args.max_fixes as number) || 20;

    const lines: string[] = [];
    lines.push(`\n🏥 Self-Healing Engine ${dryRun ? '[DRY RUN]' : ''}`);
    lines.push(`${'─'.repeat(50)}`);
    lines.push(`Root: ${projectRoot}`);

    // Step 1: Inspect
    lines.push('\n📊 Step 1: Running code inspection...');
    const inspectResult = await codeInspectorTool.handler({
      path: projectRoot,
      severity: minSeverity,
      format: 'json',
    });

    let inspection: InspectionResult;
    try {
      inspection = JSON.parse(inspectResult as string) as InspectionResult;
    } catch {
      return `Error: Failed to parse inspection results`;
    }

    lines.push(`   Found ${inspection.findings.length} findings (score: ${inspection.score}/100)`);

    if (inspection.findings.length === 0) {
      lines.push('\n✅ No issues found — codebase is clean!');
      return lines.join('\n');
    }

    // Step 2: Heal
    lines.push('\n🔧 Step 2: Attempting fixes...\n');

    const healResults: HealResult[] = [];
    let fixCount = 0;

    const severityOrder: Severity[] = ['info', 'warning', 'error', 'critical'];
    const minIdx = severityOrder.indexOf(minSeverity);

    for (const finding of inspection.findings) {
      if (fixCount >= maxFixes) break;
      if (severityOrder.indexOf(finding.severity) < minIdx) continue;

      const result = await healFinding(finding, projectRoot, dryRun);
      healResults.push(result);

      const icon = {
        fixed: '✅',
        skipped: '⏭️',
        failed: '❌',
        pending_approval: '⚠️',
      }[result.status];

      lines.push(`  ${icon} ${result.finding.file}:${result.finding.line} [${result.finding.rule}]`);
      if (result.status === 'fixed' && result.patch) {
        lines.push(`     → ${result.patch}`);
        fixCount++;
      }
      if (result.status === 'failed' && result.error) {
        lines.push(`     ✗ ${result.error}`);
      }
      if (result.status === 'pending_approval') {
        lines.push(`     ⚠️  Security issue — requires manual review`);
      }
    }

    // Step 3: Summary
    const fixed = healResults.filter((r) => r.status === 'fixed').length;
    const skipped = healResults.filter((r) => r.status === 'skipped').length;
    const failed = healResults.filter((r) => r.status === 'failed').length;
    const pendingApproval = healResults.filter((r) => r.status === 'pending_approval').length;

    lines.push(`\n📈 Step 3: Summary`);
    lines.push(`  ✅ Fixed           : ${fixed}`);
    lines.push(`  ⏭️  Skipped (manual) : ${skipped}`);
    lines.push(`  ❌ Failed          : ${failed}`);
    lines.push(`  ⚠️  Needs approval  : ${pendingApproval}`);

    // Step 4: Re-score
    if (fixed > 0 && !dryRun) {
      lines.push('\n🔍 Step 4: Re-inspecting...');
      const recheck = await codeInspectorTool.handler({
        path: projectRoot, severity: minSeverity, format: 'json',
      });
      try {
        const recheckResult = JSON.parse(recheck as string) as InspectionResult;
        const improvement = recheckResult.score - inspection.score;
        lines.push(`  Score: ${inspection.score} → ${recheckResult.score} (+${improvement})`);
      } catch { /* skip */ }
    }

    // Step 5: Commit
    if (doCommit && fixed > 0 && !dryRun) {
      lines.push('\n💾 Step 5: Committing fixes...');
      const committed = commitFixes(projectRoot, fixed);
      lines.push(committed ? '  ✅ Committed!' : '  ❌ Commit failed');
    }

    if (pendingApproval > 0) {
      lines.push('\n⚠️  Security issues require manual review:');
      for (const r of healResults.filter((h) => h.status === 'pending_approval')) {
        lines.push(`   - ${r.finding.file}:${r.finding.line} [${r.finding.rule}] ${r.finding.message}`);
      }
    }

    return lines.join('\n');
  },
};
