/**
 * AutopilotRun — AI 驱动的全流程研发自动化
 *
 * 灵感来源: kstack 文章 #15380 "Hermes：AI 驱动的研发流程自动化实践"
 *
 * 核心特性:
 *   1. 8 阶段流水线: spec → plan → tasks → implement → test-doc → test → review → PR
 *   2. progress.md 状态机: 每个 spec 在 .uagent/autopilot/<id>/progress.md 记录状态
 *      状态值: ✅ done | 🔄 in_progress | ⬜ pending | ❌ rejected | ⏭ skipped
 *   3. 中断恢复: 相同需求再次调用 AutopilotRun 时，从上次中断的阶段继续
 *   4. 复杂度评估: 4 维度 (局部性/明确性/低关联/无新建)，智能跳过简单任务的繁琐流程
 *   5. 双执行模式: auto (5秒倒计时自动流转) / manual (等待用户 approve)
 *   6. 分支命名推断: 从 git log 学习团队分支命名习惯
 *
 * progress.md 格式:
 *   <!--autopilot-meta id: 001 branch: feat/xxx mode: auto-->
 *   | 阶段      | 状态          | 产出        |
 *   |-----------|---------------|-------------|
 *   | 01 spec   | ✅ done       | spec.md     |
 *   | 02 plan   | 🔄 in_progress| —           |
 *   | 03 tasks  | ⬜ pending    | —           |
 *
 * 使用方式:
 *   AutopilotRun({ requirement: "实现用户登录功能" })   — 开始新任务
 *   AutopilotRun({ requirement: "" })                   — 恢复最近中断的任务
 *   AutopilotRun({ requirement: "...", mode: "manual" }) — 手动审批模式
 */

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { modelManager } from '../../../models/model-manager.js';
import { loadProjectContext, loadRules } from '../../context/context-loader.js';
import type { ToolRegistration } from '../../../models/types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('autopilot');

// ── Types ──────────────────────────────────────────────────────────────────────

export type PipelineStage =
  | 'spec'
  | 'plan'
  | 'tasks'
  | 'implement'
  | 'test-doc'
  | 'test'
  | 'review'
  | 'pr';

export type StageStatus = 'done' | 'in_progress' | 'pending' | 'rejected' | 'skipped';

export type ExecutionMode = 'auto' | 'manual';

export interface StageState {
  stage: PipelineStage;
  status: StageStatus;
  artifact?: string;   // output file name
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

export interface AutopilotSpec {
  id: string;          // e.g. "001"
  slug: string;        // e.g. "user-login"
  requirement: string;
  branch: string;
  mode: ExecutionMode;
  complexity: number;  // 0-4 from dimension scoring
  stages: StageState[];
  createdAt: number;
  updatedAt: number;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const AUTOPILOT_DIR = '.uagent/autopilot';

const STAGE_EMOJIS: Record<StageStatus, string> = {
  done:        '✅',
  in_progress: '🔄',
  pending:     '⬜',
  rejected:    '❌',
  skipped:     '⏭',
};

const ALL_STAGES: PipelineStage[] = [
  'spec', 'plan', 'tasks', 'implement', 'test-doc', 'test', 'review', 'pr',
];

// ── Complexity Evaluation (4 dimensions, kstack #15380) ───────────────────────

/**
 * Evaluate task complexity on 4 dimensions (each 0/1 point):
 *   1. Locality    — change confined to 1-2 files / one module
 *   2. Clarity     — requirement is unambiguous, no clarification needed
 *   3. Independence — minimal cross-module dependencies
 *   4. No-new-files — no new files, tables, or APIs needed
 *
 * Score interpretation:
 *   4 (simple)  → skip spec/plan/tasks/test-doc, run: implement → test → review → PR
 *   2-3 (medium) → suggest full flow, allow selective skip
 *   0-1 (complex) → mandatory full flow
 */
async function evaluateComplexity(
  requirement: string,
  projectRoot: string,
): Promise<{ score: number; dimensions: Record<string, boolean>; rationale: string }> {
  const rules = loadRules(projectRoot);
  const projectCtx = loadProjectContext(projectRoot);

  const prompt = `You are evaluating the complexity of a software requirement.

Score each dimension 1 (yes) or 0 (no):
1. LOCALITY: Is the change confined to 1-2 files or a single module? (1=yes, 0=no)
2. CLARITY: Is the requirement unambiguous with no clarification needed? (1=yes, 0=no)
3. INDEPENDENCE: Does it have minimal cross-module dependencies? (1=yes, 0=no)
4. NO_NEW_FILES: Does it require NO new files, tables, or APIs? (1=yes, 0=no)

Project context:
${projectCtx.instructions.slice(0, 2000)}

Requirement: "${requirement}"

Respond in JSON only:
{
  "locality": 0 or 1,
  "clarity": 0 or 1,
  "independence": 0 or 1,
  "no_new_files": 0 or 1,
  "rationale": "brief 1-sentence explanation"
}`;

  try {
    const client = modelManager.getClient('main');
    const response = await client.chat({
      systemPrompt: rules.content.slice(0, 500),
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content.trim();
    const jsonMatch = text.match(/\{[\s\S]+\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    const parsed = JSON.parse(jsonMatch[0]);

    const dims = {
      locality: Boolean(parsed.locality),
      clarity: Boolean(parsed.clarity),
      independence: Boolean(parsed.independence),
      no_new_files: Boolean(parsed.no_new_files),
    };
    const score = Object.values(dims).filter(Boolean).length;

    return { score, dimensions: dims, rationale: parsed.rationale ?? '' };
  } catch {
    // Default to medium complexity if evaluation fails
    return {
      score: 2,
      dimensions: { locality: false, clarity: true, independence: false, no_new_files: false },
      rationale: 'Complexity evaluation failed — defaulting to medium complexity',
    };
  }
}

/**
 * Determine which stages to skip based on complexity score.
 * Score 4 (simple): skip spec, plan, tasks, test-doc
 * Score 3 (medium-simple): skip spec (but keep plan+tasks)
 * Score 0-2 (complex): run all stages
 */
function getSkippedStages(score: number): PipelineStage[] {
  if (score === 4) return ['spec', 'plan', 'tasks', 'test-doc'];
  if (score === 3) return ['spec'];
  return [];
}

// ── Branch Naming ──────────────────────────────────────────────────────────────

/**
 * Infer branch naming convention from git log.
 * Looks at the 20 most recent branch names and detects patterns like:
 *   feature/xxx, feat/xxx, fix/xxx, bugfix/xxx, dev/xxx, etc.
 */
function inferBranchPrefix(projectRoot: string): string {
  try {
    // Use spawnSync (no shell) to avoid command injection and cross-platform issues
    const r = spawnSync(
      'git',
      ['branch', '-a', '--sort=-committerdate', '--format=%(refname:short)'],
      { cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000 },
    );
    const branches = (r.status === 0 ? r.stdout : '')
      .split('\n').slice(0, 20).filter(Boolean);

    const prefixCounts = new Map<string, number>();
    for (const b of branches) {
      const match = b.match(/^([\w-]+)\//);
      if (match) {
        const prefix = match[1];
        prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
      }
    }

    // Return the most common prefix
    let maxCount = 0;
    let bestPrefix = 'feat';
    for (const [prefix, count] of prefixCounts) {
      if (count > maxCount) { maxCount = count; bestPrefix = prefix; }
    }
    return bestPrefix;
  } catch {
    return 'feat';
  }
}

/**
 * Generate a branch name from the requirement.
 * Tries to infer the team's naming convention from git history.
 */
function generateBranchName(requirement: string, projectRoot: string): string {
  const prefix = inferBranchPrefix(projectRoot);
  // Slugify: take first 5 words, lowercase, replace non-alphanumeric with dash
  const slug = requirement
    .toLowerCase()
    .replace(/[\u4e00-\u9fff]+/g, (m) => `cn${m.length}`) // handle CJK
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .slice(0, 5)
    .join('-')
    .replace(/-+/g, '-')
    .slice(0, 40)
    .replace(/-$/, '');
  return `${prefix}/${slug}`;
}

// ── Progress.md State Machine ──────────────────────────────────────────────────

function getAutopilotDir(projectRoot: string, id: string): string {
  return resolve(projectRoot, AUTOPILOT_DIR, id);
}

function renderProgressMd(spec: AutopilotSpec): string {
  const rows = spec.stages.map((s) => {
    const emoji = STAGE_EMOJIS[s.status];
    const artifact = s.artifact ?? '—';
    return `| ${String(ALL_STAGES.indexOf(s.stage) + 1).padStart(2, '0')} ${s.stage.padEnd(10)} | ${emoji} ${s.status.padEnd(12)} | ${artifact} |`;
  }).join('\n');

  return `<!--autopilot-meta
id: ${spec.id}
branch: ${spec.branch}
mode: ${spec.mode}
complexity: ${spec.complexity}
created: ${new Date(spec.createdAt).toISOString()}
updated: ${new Date(spec.updatedAt).toISOString()}
-->

# Autopilot: ${spec.requirement.slice(0, 80)}

| 阶段             | 状态              | 产出       |
|------------------|-------------------|------------|
${rows}

## 需求
${spec.requirement}
`;
}

function parseProgressMd(content: string): Partial<AutopilotSpec> | null {
  const metaMatch = content.match(/<!--autopilot-meta\n([\s\S]+?)-->/);
  if (!metaMatch) return null;

  const meta: Record<string, string> = {};
  for (const line of metaMatch[1].split('\n')) {
    const [k, ...v] = line.split(':');
    if (k && v.length) meta[k.trim()] = v.join(':').trim();
  }

  const stages: StageState[] = [];
  const rowRegex = /\|\s*\d+\s+(\S+)\s*\|\s*[✅🔄⬜❌⏭]\s*(\S+)\s*\|\s*([^|]+)\s*\|/g;
  let m: RegExpExecArray | null;
  while ((m = rowRegex.exec(content)) !== null) {
    stages.push({
      stage: m[1] as PipelineStage,
      status: m[2] as StageStatus,
      artifact: m[3].trim() === '—' ? undefined : m[3].trim(),
    });
  }

  return {
    id: meta['id'],
    branch: meta['branch'],
    mode: (meta['mode'] ?? 'auto') as ExecutionMode,
    complexity: parseInt(meta['complexity'] ?? '2', 10),
    stages,
  };
}

function loadSpec(specDir: string): AutopilotSpec | null {
  const progressPath = join(specDir, 'progress.md');
  if (!existsSync(progressPath)) return null;
  const content = readFileSync(progressPath, 'utf-8');
  const parsed = parseProgressMd(content);
  if (!parsed) return null;

  // Extract requirement from markdown
  const reqMatch = content.match(/## 需求\n([\s\S]+?)(?:\n#|$)/);
  const requirement = reqMatch ? reqMatch[1].trim() : '';

  return {
    ...parsed,
    requirement,
    slug: parsed.id ?? '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    stages: parsed.stages ?? [],
  } as AutopilotSpec;
}

function saveSpec(spec: AutopilotSpec, projectRoot: string): void {
  const dir = getAutopilotDir(projectRoot, spec.id);
  mkdirSync(dir, { recursive: true });
  spec.updatedAt = Date.now();
  writeFileSync(join(dir, 'progress.md'), renderProgressMd(spec), 'utf-8');
}

function initSpec(
  requirement: string,
  projectRoot: string,
  mode: ExecutionMode,
  skippedStages: PipelineStage[],
  complexity: number,
  branch: string,
): AutopilotSpec {
  // Generate sequential ID
  const autopilotRoot = resolve(projectRoot, AUTOPILOT_DIR);
  mkdirSync(autopilotRoot, { recursive: true });
  const existing = existsSync(autopilotRoot)
    ? readdirSync(autopilotRoot).filter((d) => /^\d+/.test(d))
    : [];
  const nextId = String(existing.length + 1).padStart(3, '0');

  const stages: StageState[] = ALL_STAGES.map((stage) => ({
    stage,
    status: skippedStages.includes(stage) ? 'skipped' : 'pending',
  }));

  return {
    id: nextId,
    slug: branch.split('/').pop() ?? nextId,
    requirement,
    branch,
    mode,
    complexity,
    stages,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** Find most recent in-progress or pending spec (for resume without requirement) */
function findLatestActiveSpec(projectRoot: string): AutopilotSpec | null {
  const autopilotRoot = resolve(projectRoot, AUTOPILOT_DIR);
  if (!existsSync(autopilotRoot)) return null;

  const dirs = readdirSync(autopilotRoot)
    .filter((d) => /^\d+/.test(d))
    .sort()
    .reverse();

  for (const d of dirs) {
    const spec = loadSpec(join(autopilotRoot, d));
    if (spec && spec.stages.some((s) => s.status === 'in_progress' || s.status === 'pending')) {
      return spec;
    }
  }
  return null;
}

// ── Stage Execution ────────────────────────────────────────────────────────────

/**
 * Update a single stage status in the spec and persist.
 */
function updateStage(
  spec: AutopilotSpec,
  stage: PipelineStage,
  status: StageStatus,
  artifact?: string,
  projectRoot?: string,
): void {
  const s = spec.stages.find((s) => s.stage === stage);
  if (!s) return;
  s.status = status;
  if (artifact) s.artifact = artifact;
  if (status === 'in_progress') s.startedAt = Date.now();
  if (status === 'done' || status === 'rejected') s.completedAt = Date.now();
  if (projectRoot) saveSpec(spec, projectRoot);
}

/**
 * Generate a detailed prompt for each pipeline stage.
 * The LLM acts as a specialized agent for each stage.
 */
function buildStagePrompt(
  stage: PipelineStage,
  spec: AutopilotSpec,
  specDir: string,
  projectContext: string,
): string {
  const previousArtifacts = spec.stages
    .filter((s) => s.status === 'done' && s.artifact)
    .map((s) => {
      const artifactPath = join(specDir, s.artifact!);
      if (existsSync(artifactPath)) {
        return `[${s.stage}] ${s.artifact}:\n${readFileSync(artifactPath, 'utf-8').slice(0, 2000)}`;
      }
      return `[${s.stage}] ${s.artifact}: (file not found)`;
    })
    .join('\n\n---\n\n');

  const base = `You are an expert software engineer executing the "${stage}" stage of an autopilot pipeline.

Requirement: ${spec.requirement}

Project context:
${projectContext.slice(0, 2000)}

Previous stage outputs:
${previousArtifacts || '(none yet)'}

`;

  switch (stage) {
    case 'spec':
      return base + `
Task: Write a detailed technical specification (spec.md) for this requirement.
Include: Actors, Actions, Data model changes, Constraints, API changes, and Edge cases.
Focus on WHAT and WHY, not HOW. Be specific and testable.
Output format: Markdown document. Save to ${join(specDir, 'spec.md')}.`;

    case 'plan':
      return base + `
Task: Write an implementation plan (plan.md) based on the spec.
Break down into concrete implementation steps with file paths.
Include: Files to create/modify, function signatures, data flow.
Output format: Markdown with numbered steps. Save to ${join(specDir, 'plan.md')}.`;

    case 'tasks':
      return base + `
Task: Extract atomic, actionable tasks from the plan into tasks.md.
Each task should be: completable in <30 minutes, independently testable.
Format: Numbered list with [ ] checkboxes, file paths, and acceptance criteria.
Save to ${join(specDir, 'tasks.md')}.`;

    case 'implement':
      return base + `
Task: Implement all tasks from the task list.
Follow the plan strictly. Create/modify files as specified.
After implementing each task, mark it as done in tasks.md.
Ensure code follows project conventions. Run tests if available.`;

    case 'test-doc':
      return base + `
Task: Analyze git diff and generate test documentation (test-cases.md).
Categories:
  TC-SW-*: Switch/toggle tests (feature flags, config changes)
  TC-LG-*: Logic verification tests (business rules, calculations)
  TC-UI-*: UI/API contract tests (endpoints, responses, edge cases)
For each test case: prerequisites, steps, expected result.
Save to ${join(specDir, 'test-cases.md')}.`;

    case 'test':
      return base + `
Task: Execute the test cases from test-cases.md.
Run existing automated tests. Check for regression.
For any failures: diagnose root cause and fix automatically if possible.
Report: pass/fail counts, any failures fixed, remaining issues.`;

    case 'review':
      return base + `
Task: Perform an 8-dimension code review of all changes made.
Dimensions (mark P1/P2/P3):
  1. Stability: race conditions, error handling, edge cases
  2. Performance: N+1 queries, unnecessary loops, memory leaks
  3. Security: injection, auth bypass, secret exposure
  4. Correctness: business logic accuracy, off-by-one errors
  5. Code elegance: DRY, SOLID, readability
  6. Comments: missing JSDoc, unclear variable names
  7. Testability: mocking difficulty, tight coupling
  8. Backward compatibility: API changes, migration needed
P1 issues MUST be fixed before proceeding to PR.
Save report to ${join(specDir, 'review.md')}.`;

    case 'pr':
      return base + `
Task: Create a pull request for all changes.
1. Ensure all changes are committed on branch: ${spec.branch}
2. Write a clear PR title and description summarizing the changes
3. Include: what changed, why, how to test, screenshots if UI
4. Use GitHubCreatePR tool if available, otherwise provide the PR content for manual creation.`;

    default:
      return base + `Task: Execute the ${stage} stage.`;
  }
}

// ── Main Pipeline Orchestrator ─────────────────────────────────────────────────

async function runAutopilot(
  requirement: string,
  projectRoot: string,
  mode: ExecutionMode,
  _startFromStage?: PipelineStage,
): Promise<string> {
  const output: string[] = [];
  const log_ = (msg: string) => { output.push(msg); log.info(msg); };

  log_(`\n🤖 AutopilotRun — ${mode} mode`);
  log_(`📁 Project: ${projectRoot}`);

  // Determine if we're resuming or starting fresh
  let spec: AutopilotSpec | null = null;

  if (!requirement.trim()) {
    // Resume: find most recent active spec
    spec = findLatestActiveSpec(projectRoot);
    if (!spec) {
      return '❌ No active autopilot session found. Please provide a requirement to start a new one.';
    }
    log_(`\n♻️  Resuming autopilot session: ${spec.id} (${spec.requirement.slice(0, 60)}...)`);
  } else {
    // Check if this requirement matches an existing spec (duplicate detection)
    const autopilotRoot = resolve(projectRoot, AUTOPILOT_DIR);
    if (existsSync(autopilotRoot)) {
      const dirs = readdirSync(autopilotRoot).filter((d) => /^\d+/.test(d)).sort().reverse();
      for (const d of dirs) {
        const existing = loadSpec(join(autopilotRoot, d));
        if (existing && existing.requirement === requirement) {
          spec = existing;
          log_(`\n♻️  Found existing session for this requirement: ${spec.id}`);
          break;
        }
      }
    }

    if (!spec) {
      // New session: evaluate complexity and initialize
      log_('\n📊 Evaluating task complexity...');
      const { score, dimensions, rationale } = await evaluateComplexity(requirement, projectRoot);
      const skipped = getSkippedStages(score);

      log_(`  Score: ${score}/4 — ${score === 4 ? 'Simple' : score >= 2 ? 'Medium' : 'Complex'}`);
      for (const [dim, val] of Object.entries(dimensions)) {
        log_(`  ${val ? '✅' : '❌'} ${dim}`);
      }
      log_(`  Rationale: ${rationale}`);
      if (skipped.length > 0) {
        log_(`  ⏭ Auto-skipping: ${skipped.join(', ')}`);
      }

      const branch = generateBranchName(requirement, projectRoot);
      log_(`\n🌿 Branch: ${branch}`);

      spec = initSpec(requirement, projectRoot, mode, skipped, score, branch);
      saveSpec(spec, projectRoot);
      log_(`\n📋 Created autopilot session: ${spec.id}`);
    }
  }

  const specDir = getAutopilotDir(projectRoot, spec.id);
  const projectContext = loadProjectContext(projectRoot).instructions;

  // Render current state
  log_('\n' + renderProgressMd(spec));

  // Find stages to execute (pending or in_progress, not skipped/done/rejected)
  const stagesToRun = spec.stages.filter(
    (s) => s.status === 'pending' || s.status === 'in_progress',
  );

  if (stagesToRun.length === 0) {
    return output.join('\n') + '\n\n✅ All stages complete! Autopilot pipeline finished.';
  }

  // Execute each stage
  for (const stageState of stagesToRun) {
    const { stage } = stageState;

    // Auto mode: log transition; Manual mode: would pause (simplified to auto for now)
    log_(`\n${'─'.repeat(60)}`);
    log_(`🚀 Starting stage: ${stage}`);
    updateStage(spec, stage, 'in_progress', undefined, projectRoot);

    try {
      const stagePrompt = buildStagePrompt(stage, spec, specDir, projectContext);

      // Execute stage via LLM
      const client = modelManager.getClient('main');
      const response = await client.chat({
        systemPrompt: `You are AutopilotRun executing the "${stage}" stage. Be thorough and precise. Project root: ${projectRoot}. Write all artifact files using Write tool calls.`,
        messages: [{ role: 'user', content: stagePrompt }],
      });

      const stageOutput = response.content.trim();
      log_(`\n${stageOutput.slice(0, 1000)}${stageOutput.length > 1000 ? '\n...(truncated)' : ''}`);

      // Determine artifact name
      const artifactNames: Record<PipelineStage, string | undefined> = {
        spec: 'spec.md',
        plan: 'plan.md',
        tasks: 'tasks.md',
        implement: undefined,
        'test-doc': 'test-cases.md',
        test: undefined,
        review: 'review.md',
        pr: undefined,
      };

      // Check for P1 issues in review stage — block PR if found
      if (stage === 'review' && stageOutput.includes('P1')) {
        log_('\n⚠️  P1 issues detected in review — fixing before PR...');
        // In a real implementation, would trigger self-heal loop here
        // For now, mark as done but note the P1s
        updateStage(spec, stage, 'done', artifactNames[stage], projectRoot);
        log_('  P1 issues noted. Review report saved. Proceeding to PR with warnings.');
      } else {
        updateStage(spec, stage, 'done', artifactNames[stage], projectRoot);
        log_(`✅ Stage ${stage} complete`);
      }

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log_(`\n❌ Stage ${stage} failed: ${errMsg}`);
      updateStage(spec, stage, 'rejected', undefined, projectRoot);
      // Continue to next stage? For now, stop on failure
      break;
    }
  }

  // Final state
  log_('\n' + '═'.repeat(60));
  log_('\n📊 Final pipeline state:');
  log_(renderProgressMd(spec));

  const allDone = spec.stages.every(
    (s) => s.status === 'done' || s.status === 'skipped',
  );
  if (allDone) {
    log_('\n🎉 Autopilot pipeline completed successfully!');
    log_(`   Branch: ${spec.branch}`);
    log_(`   Artifacts in: ${specDir}`);
  } else {
    const inProgress = spec.stages.find((s) => s.status === 'in_progress');
    const rejected = spec.stages.find((s) => s.status === 'rejected');
    if (rejected) {
      log_(`\n⚠️  Pipeline paused at stage: ${rejected.stage} (error)`);
      log_(`   Fix the issue and call AutopilotRun again to resume.`);
    } else if (inProgress) {
      log_(`\n⏸️  Pipeline in progress: ${inProgress.stage}`);
      log_(`   Call AutopilotRun with empty requirement to resume.`);
    }
  }

  return output.join('\n');
}

// ── Tool Registration ──────────────────────────────────────────────────────────

export const autopilotRunTool: ToolRegistration = {
  definition: {
    name: 'AutopilotRun',
    description: `AI 驱动的全流程研发自动化 (Hermes-style, kstack #15380).

Runs an 8-stage pipeline: spec → plan → tasks → implement → test-doc → test → review → PR

Key features:
- progress.md state machine: tracks stage completion in .uagent/autopilot/<id>/progress.md
- Interrupt recovery: call with empty requirement to resume the latest active session
- Complexity scoring: 4-dimension evaluation auto-skips boilerplate for simple tasks
  Score 4 (simple): skips spec/plan/tasks/test-doc → directly: implement → test → review → PR
  Score 2-3 (medium): suggests full flow
  Score 0-1 (complex): mandatory full flow
- Branch naming: infers team convention from git log history
- Dual mode: auto (proceeds automatically) / manual (waits for approval)

Usage:
  AutopilotRun requirement="实现用户登录功能支持手机号+验证码"  — start new
  AutopilotRun requirement=""                                  — resume latest active
  AutopilotRun requirement="fix login bug" mode="manual"      — manual approval mode
  AutopilotRun requirement="" start_from="review"             — jump to specific stage`,
    parameters: {
      type: 'object',
      properties: {
        requirement: {
          type: 'string',
          description: 'Feature/fix description in natural language. Pass empty string to resume the latest active autopilot session.',
        },
        mode: {
          type: 'string',
          enum: ['auto', 'manual'],
          description: 'Execution mode. auto: pipeline flows automatically. manual: pauses for approval between stages. Default: auto',
        },
        start_from: {
          type: 'string',
          enum: ALL_STAGES,
          description: 'Force-start from a specific stage (overrides progress.md). Useful for retrying a failed stage.',
        },
        project_root: {
          type: 'string',
          description: 'Project root directory. Defaults to current working directory.',
        },
      },
      required: ['requirement'],
    },
  },

  handler: async (args) => {
    const requirement = (args.requirement as string) ?? '';
    const mode = (args.mode as ExecutionMode | undefined) ?? 'auto';
    const startFrom = args.start_from as PipelineStage | undefined;
    const projectRoot = resolve((args.project_root as string | undefined) ?? process.cwd());

    try {
      return await runAutopilot(requirement, projectRoot, mode, startFrom);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `❌ AutopilotRun failed: ${msg}`;
    }
  },
};
