/**
 * CoordinatorRun Tool — R→S→Critic→I→V Five-phase Multi-Agent Pipeline
 *
 * Inspired by Claude Code's "Coordinator Mode" and Cowork Forge's Actor-Critic pattern
 * (kstack article #15345 "我组建了一个虚拟产研团队，7个成员全是AI"):
 *
 * The Coordinator acts as a pure orchestrator — it ONLY spawns agents and synthesizes
 * results. It never directly writes files, runs commands, or touches code.
 *
 * Five phases (original 4 + Critic Review from Cowork Forge):
 *   Phase 1 — Research:        Parallel worker agents explore the codebase, write to scratchpad.
 *   Phase 2 — Synthesis:       Coordinator reads findings, produces concrete implementation plan.
 *   Phase 2.5 — Critic Review: Independent Critic agent audits the synthesis plan.
 *                               If plan has major gaps, triggers one refinement loop.
 *                               Inspired by Cowork Forge's Actor-Critic pattern:
 *                               "每个阶段不是生成即结束，而是生成→审查→迭代"
 *   Phase 3 — Implementation:  Parallel worker agents execute the (possibly refined) plan.
 *   Phase 4 — Verification:    Worker agents verify results (tests, lint, review).
 *
 * Tool role isolation (mirrors Claude Code's INTERNAL_COORDINATOR_TOOLS):
 *   - Coordinator: can ONLY orchestrate — never writes files or runs commands directly.
 *   - Workers:     cannot use coordination tools (recursive-bomb safe).
 *   - This is enforced via UAGENT_WORKER_MODE=1 env var in worker processes.
 *
 * Usage:
 *   CoordinatorRun({ goal: "Refactor auth module to use JWT", scratchpad_id: "auth-refactor" })
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { modelManager } from '../../models/model-manager.js';
import { scratchpadRead, scratchpadList, scratchpadWrite } from './spawn-agent.js';
import type { ToolRegistration } from '../../models/types.js';

// ── Types ─────────────────────────────────────────────────────────────────

/**
 * FlowConfig — Parameterize the Coordinator pipeline behavior.
 *
 * Inspired by Cowork Forge's Flow JSON configuration:
 * "开发流程可以通过JSON配置定制，包括阶段顺序、Agent角色、工具集"
 *
 * Key options:
 *   skip_critic:           Skip Critic Review phase (fast mode, saves ~30s)
 *   skip_verification:     Skip Phase 4 Verification (useful for pure research runs)
 *   max_parallel:          Limit concurrent worker agents (default: unlimited)
 *   stop_on_impl_failure:  Abort pipeline if any implementation worker returns ERROR
 */
export interface FlowConfig {
  /** Skip Critic Review (Phase 2.5) — fast mode. Default: false */
  skip_critic?: boolean;
  /** Skip Verification (Phase 4). Default: false */
  skip_verification?: boolean;
  /** Max concurrent workers per phase. Default: unlimited */
  max_parallel?: number;
  /** Stop implementation phase if any worker returns ERROR. Default: false */
  stop_on_impl_failure?: boolean;
}

export interface CriticReview {
  /** PASS: plan is good, proceed to implementation */
  verdict: 'PASS' | 'REVISE';
  /** Issues found by Critic (empty if PASS) */
  issues: string[];
  /** Refined plan (only present when verdict === 'REVISE') */
  refinedPlan?: string;
}

export interface CoordinatorResult {
  goal: string;
  scratchpadId: string;
  phases: {
    research: string[];
    synthesis: string;
    criticReview?: CriticReview;
    implementation: string[];
    verification: string[];
  };
  success: boolean;
  summary: string;
}

// ── Critic Review phase ────────────────────────────────────────────────────
// Actor-Critic pattern from Cowork Forge (kstack #15345):
//   Actor (Synthesis) generates the plan.
//   Critic audits the plan for gaps, contradictions, infeasible tasks.
//   If REVISE: feeds issues back to Synthesis for one refinement pass.
// Uses 'quick' model — Critic should be fast, not deep reasoning.

async function runCriticReview(
  plan: string,
  goal: string,
  projectRoot: string,
  critId: string,
): Promise<CriticReview> {
  const { AgentCore } = await import('../agent.js');
  const model = modelManager.getCurrentModel('quick'); // Critic uses quick model (fast)

  const agent = new AgentCore({
    domain: 'auto',
    model,
    stream: false,
    verbose: false,
  });

  const criticPrompt = [
    `# Critic Review Phase`,
    ``,
    `## Goal`,
    goal,
    ``,
    `## Synthesis Plan to Review`,
    plan,
    ``,
    `## Your Role`,
    `You are a critical reviewer (Critic agent). Your job is to audit the implementation plan above.`,
    `Be strict. Find gaps before they become bugs.`,
    ``,
    `## Check for these issues:`,
    `1. **Completeness**: Are all aspects of the goal covered? Are there missing steps?`,
    `2. **Dependencies**: Are task dependencies correct? Will task N definitely have what it needs?`,
    `3. **Feasibility**: Are there tasks that are vague, contradictory, or technically infeasible?`,
    `4. **Risks**: Are there obvious risks the plan ignores?`,
    ``,
    `## Output Format (STRICT — return valid JSON only)`,
    `{`,
    `  "verdict": "PASS" | "REVISE",`,
    `  "issues": ["issue 1", "issue 2"],`,
    `  "refinedPlan": "<revised full plan — only include if verdict is REVISE>"`,
    `}`,
    ``,
    `Rules:`,
    `- Return PASS if the plan is solid (minor nitpicks don't count — only real gaps)`,
    `- Return REVISE only if there are P0 issues that would cause implementation failure`,
    `- If REVISE, include a fully corrected version of the plan in refinedPlan`,
    `- Return ONLY the JSON object — no prose, no markdown fences`,
  ].join('\n');

  try {
    const raw = await agent.run(criticPrompt);
    // Extract JSON from response (may include extra prose)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // If no JSON found, treat as PASS (non-blocking)
      return { verdict: 'PASS', issues: [] };
    }
    const parsed = JSON.parse(jsonMatch[0]) as CriticReview;
    const result: CriticReview = {
      verdict: parsed.verdict === 'REVISE' ? 'REVISE' : 'PASS',
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      refinedPlan: parsed.refinedPlan,
    };
    scratchpadWrite(projectRoot, critId, JSON.stringify(result, null, 2));
    return result;
  } catch {
    // Critic failure is non-blocking (标注不阻塞原则)
    return { verdict: 'PASS', issues: ['[Critic error — proceeding with original plan]'] };
  }
}

// ── Synthesis phase ────────────────────────────────────────────────────────
// The coordinator reads ALL scratchpad entries and produces a concrete plan.
// Claude Code explicitly forbids "甩锅式委派": must read findings and specify exactly.

async function runSynthesis(
  goal: string,
  scratchpadEntries: string,
  projectRoot: string,
  synthId: string,
): Promise<string> {
  const { AgentCore } = await import('../agent.js');
  const model = modelManager.getCurrentModel('main'); // synthesis always uses main model

  const agent = new AgentCore({
    domain: 'auto',
    model,
    stream: false,
    verbose: false,
  });

  const synthPrompt = [
    `# Coordinator Synthesis Phase`,
    ``,
    `## Goal`,
    goal,
    ``,
    `## Research Findings (from worker agents)`,
    scratchpadEntries || '(No research findings available)',
    ``,
    `## Your Task`,
    `You are the Coordinator in Synthesis mode. Read the research findings above carefully.`,
    ``,
    `Produce a concrete implementation plan with:`,
    `1. A numbered list of implementation tasks (each must be fully self-contained)`,
    `2. For each task: exact files to modify, specific changes to make`,
    `3. A verification checklist (what tests/checks should pass)`,
    ``,
    `CRITICAL RULES:`,
    `- Do NOT say "based on your findings" or delegate vaguely — you must read the findings`,
    `  and specify EXACTLY what each worker should do`,
    `- Each implementation task must be runnable by an isolated agent that has never seen`,
    `  the research findings`,
    `- Format implementation tasks as: "## Task N: <title>\\n<detailed instructions>"`,
    `- Format verification tasks as: "## Verify N: <title>\\n<what to run/check>"`,
  ].join('\n');

  const plan = await agent.run(synthPrompt);
  scratchpadWrite(projectRoot, `${synthId}-plan`, plan);
  return plan;
}

// ── Task extraction ────────────────────────────────────────────────────────

function extractTasks(plan: string, prefix: string): string[] {
  const regex = new RegExp(`## ${prefix} \\d+:([^\\n]+)\\n([\\s\\S]*?)(?=## ${prefix} \\d+:|## (?!${prefix})|$)`, 'g');
  const tasks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(plan)) !== null) {
    const title = match[1].trim();
    const body = match[2].trim();
    tasks.push(`# ${prefix}: ${title}\n\n${body}`);
  }
  return tasks.length > 0 ? tasks : [plan]; // fallback: treat whole plan as one task
}

// ── Worker runner (parallel) ───────────────────────────────────────────────

async function runWorkersParallel(
  tasks: string[],
  role: 'research' | 'implementation' | 'verify',
  opts: {
    scratchpadId: string;
    projectRoot: string;
    contextIds?: string[];
    timeoutMs?: number;
  },
): Promise<string[]> {
  const { spawnAgentTool } = await import('./spawn-agent.js');

  return Promise.all(
    tasks.map(async (task, idx) => {
      const taskId = `${opts.scratchpadId}-${role}-${idx}`;
      try {
        const result = await spawnAgentTool.handler({
          task,
          task_id: taskId,
          role,
          mode: opts.contextIds?.length ? 'reference' : 'empty',
          context_ids: opts.contextIds,
          timeout_seconds: opts.timeoutMs ? opts.timeoutMs / 1000 : 300,
        }) as string;
        // Research workers write to scratchpad so coordinator can read all findings
        if (role === 'research') {
          scratchpadWrite(opts.projectRoot, taskId, result);
        }
        return result;
      } catch (err) {
        return `[${role} ${idx}] Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }),
  );
}

// ── Main coordinator orchestration ────────────────────────────────────────

/**
 * Concurrency limiter: run `tasks` in batches of `maxParallel`.
 * When `maxParallel` is undefined or <= 0, runs all concurrently (existing behavior).
 * Inspired by Cowork Forge's configurable parallelism: "max_parallel controls worker concurrency"
 */
async function runWorkersLimited<T>(
  tasks: Array<() => Promise<T>>,
  maxParallel?: number,
): Promise<T[]> {
  if (!maxParallel || maxParallel <= 0 || maxParallel >= tasks.length) {
    return Promise.all(tasks.map((fn) => fn()));
  }

  const results: T[] = new Array(tasks.length);
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: maxParallel }, () => worker());
  await Promise.all(workers);
  return results;
}

async function runCoordinator(
  goal: string,
  researchTasks: string[],
  scratchpadId: string,
  projectRoot: string,
  timeoutMs: number,
  flowConfig: FlowConfig = {},
): Promise<CoordinatorResult> {
  const root = resolve(projectRoot);

  // ── Phase 1: Research (parallel, optionally limited) ────────────────────
  const researchFns = researchTasks.map((task, idx) => async () => {
    const taskId = `${scratchpadId}-research-${idx}`;
    try {
      const { spawnAgentTool } = await import('./spawn-agent.js');
      const result = await spawnAgentTool.handler({
        task,
        task_id: taskId,
        role: 'research',
        mode: 'empty',
        timeout_seconds: timeoutMs / 1000,
      }) as string;
      scratchpadWrite(root, taskId, result);
      return result;
    } catch (err) {
      return `[research ${idx}] Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  });
  const researchResults = await runWorkersLimited(researchFns, flowConfig.max_parallel);

  // ── Phase 2: Synthesis (coordinator only) ─────────────────────────────────
  const scratchKeys = scratchpadList(root).filter((k) => k.startsWith(scratchpadId));
  const scratchEntries = scratchKeys
    .map((k) => {
      const val = scratchpadRead(root, k);
      return val ? `### [${k}]\n${val}` : null;
    })
    .filter(Boolean)
    .join('\n\n---\n\n');

  const synthPlan = await runSynthesis(goal, scratchEntries, root, scratchpadId);

  // ── Phase 2.5: Critic Review (Actor-Critic, skippable via FlowConfig) ──────
  // Inspired by Cowork Forge: "每个阶段不是生成即结束，而是生成→审查→迭代"
  // Skip when flow_config.skip_critic=true (fast mode)
  let criticReview: CriticReview = { verdict: 'PASS', issues: [] };
  if (!flowConfig.skip_critic) {
    criticReview = await runCriticReview(
      synthPlan,
      goal,
      root,
      `${scratchpadId}-critic`,
    );
  }
  const finalPlan = criticReview.verdict === 'REVISE' && criticReview.refinedPlan
    ? criticReview.refinedPlan
    : synthPlan;

  // ── Phase 3: Implementation (parallel, optionally limited) ────────────────
  // stop_on_impl_failure: abort if any worker returns ERROR keyword
  const implTasks = extractTasks(finalPlan, 'Task');
  const implFns = implTasks.map((task, idx) => async () => {
    const taskId = `${scratchpadId}-implementation-${idx}`;
    try {
      const { spawnAgentTool } = await import('./spawn-agent.js');
      return await spawnAgentTool.handler({
        task,
        task_id: taskId,
        role: 'implementation',
        mode: 'empty',
        timeout_seconds: timeoutMs / 1000,
      }) as string;
    } catch (err) {
      return `[implementation ${idx}] Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  });

  let implResults: string[];
  if (flowConfig.stop_on_impl_failure) {
    // Sequential with early abort on ERROR
    implResults = [];
    for (const fn of implFns) {
      const result = await fn();
      implResults.push(result);
      if (/\b(ERROR)\b/i.test(result)) {
        implResults.push(`[Pipeline aborted: stop_on_impl_failure=true, ERROR detected in implementation worker ${implResults.length - 1}]`);
        break;
      }
    }
  } else {
    implResults = await runWorkersLimited(implFns, flowConfig.max_parallel);
  }

  // ── Phase 4: Verification (parallel, skippable via FlowConfig) ────────────
  let verifyResults: string[] = [];
  if (!flowConfig.skip_verification) {
    const verifyTasks = extractTasks(finalPlan, 'Verify');
    const verifyFns = verifyTasks.map((task, idx) => async () => {
      const taskId = `${scratchpadId}-verify-${idx}`;
      try {
        const { spawnAgentTool } = await import('./spawn-agent.js');
        return await spawnAgentTool.handler({
          task,
          task_id: taskId,
          role: 'verify',
          mode: 'empty',
          timeout_seconds: timeoutMs / 1000,
        }) as string;
      } catch (err) {
        return `[verify ${idx}] Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    });
    verifyResults = await runWorkersLimited(verifyFns, flowConfig.max_parallel);
  }

  // Determine overall success
  const failed = verifyResults.some((r) =>
    /\b(FAIL|FAILED|ERROR|❌)\b/i.test(r),
  );

  const criticLine = flowConfig.skip_critic
    ? `- ⏭️ Critic Review (SKIPPED — fast mode via flow_config.skip_critic)`
    : criticReview.verdict === 'PASS'
      ? `- ✅ Critic Review (PASS — plan approved)`
      : `- ⚡ Critic Review (REVISED — ${criticReview.issues.length} issue(s) addressed)`;

  const summary = [
    `# Coordinator Run: ${goal}`,
    ``,
    `## Phases Completed`,
    `- ✅ Research (${researchResults.length} workers)`,
    `- ✅ Synthesis`,
    criticLine,
    `- ${failed ? '⚠️' : '✅'} Implementation (${implResults.length} workers)`,
    `- ${failed ? '❌' : '✅'} Verification (${verifyResults.length} workers)`,
    ``,
    `## Implementation Plan${criticReview.verdict === 'REVISE' ? ' (Critic-Refined)' : ''}`,
    finalPlan.slice(0, 1000) + (finalPlan.length > 1000 ? '\n...(truncated)' : ''),
    ``,
    `## Status: ${failed ? 'PARTIAL — verification failures detected' : 'SUCCESS'}`,
  ].join('\n');

  // Write full summary to scratchpad
  scratchpadWrite(root, `${scratchpadId}-summary`, summary);

  return {
    goal,
    scratchpadId,
    phases: {
      research: researchResults,
      synthesis: synthPlan,
      criticReview,
      implementation: implResults,
      verification: verifyResults,
    },
    success: !failed,
    summary,
  };
}


// ── Tool registration ──────────────────────────────────────────────────────

export const coordinatorRunTool: ToolRegistration = {
  definition: {
    name: 'CoordinatorRun',
    description: [
      'orchestrate a complex task using a five-phase multi-agent pipeline (Actor-Critic enhanced):',
      '  Phase 1 — Research:        Parallel worker agents explore the codebase and gather facts',
      '  Phase 2 — Synthesis:       Coordinator reads all findings, produces concrete plan (NO vague delegation)',
      '  Phase 2.5 — Critic Review: Critic agent audits the plan; REVISE verdict triggers one refinement loop',
      '  Phase 3 — Implementation:  Parallel worker agents execute the (possibly refined) plan',
      '  Phase 4 — Verification:    Worker agents verify results (tests, lint, review)',
      '',
      'Key design principles (Claude Code + Cowork Forge Actor-Critic pattern):',
      '  - Coordinator ONLY orchestrates — never writes files or runs commands directly',
      '  - Critic uses quick model (fast audit); Implementation uses main model (strong execution)',
      '  - Workers share findings via scratchpad directory (.uagent/scratchpad/)',
      '  - Synthesis MUST specify exactly what to do — forbidden to say "based on your findings"',
      '',
      'Use this for large, complex tasks that benefit from parallel exploration + structured execution.',
      'For simpler single-agent tasks, use SpawnAgent instead.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: 'High-level goal description. Be specific about what "done" looks like.',
        },
        research_tasks: {
          type: 'array',
          items: { type: 'string' },
          description: [
            'List of research questions/tasks for Phase 1 workers (run in parallel).',
            'Each task should be independent and focused on a specific aspect of the codebase.',
            'Example: ["Map all API endpoints and their auth requirements",',
            '          "Identify all database models and their relationships"]',
          ].join('\n'),
        },
        scratchpad_id: {
          type: 'string',
          description: 'Unique ID for this coordinator run. Used to namespace all scratchpad entries. Use kebab-case.',
        },
        timeout_seconds: {
          type: 'number',
          description: 'Timeout per worker agent in seconds (default: 300). Total time may be up to 4x this.',
        },
        flow_config: {
          type: 'object',
          description: [
            'Optional FlowConfig to customize pipeline behavior (Cowork Forge-inspired).',
            'Properties:',
            '  skip_critic: boolean — Skip Critic Review (Phase 2.5). Fast mode. Default: false',
            '  skip_verification: boolean — Skip Verification (Phase 4). Default: false',
            '  max_parallel: number — Max concurrent workers per phase. Default: unlimited',
            '  stop_on_impl_failure: boolean — Abort if any impl worker returns ERROR. Default: false',
            'Example: { "skip_critic": true, "max_parallel": 3 }',
          ].join('\n'),
          properties: {
            skip_critic: { type: 'boolean' },
            skip_verification: { type: 'boolean' },
            max_parallel: { type: 'number' },
            stop_on_impl_failure: { type: 'boolean' },
          },
        },
      },
      required: ['goal', 'research_tasks', 'scratchpad_id'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const {
      goal,
      research_tasks,
      scratchpad_id,
      timeout_seconds,
      flow_config,
    } = args as {
      goal: string;
      research_tasks: string[];
      scratchpad_id: string;
      timeout_seconds?: number;
      flow_config?: FlowConfig;
    };

    if (!goal || typeof goal !== 'string') {
      return 'Error: CoordinatorRun requires a non-empty "goal" string.';
    }
    if (!Array.isArray(research_tasks) || research_tasks.length === 0) {
      return 'Error: CoordinatorRun requires a non-empty "research_tasks" array.';
    }
    if (!scratchpad_id || typeof scratchpad_id !== 'string') {
      return 'Error: CoordinatorRun requires a "scratchpad_id" string.';
    }

    // Prevent workers from spawning more coordinators (recursive-bomb guard)
    if (process.env.UAGENT_WORKER_MODE === '1') {
      return 'Error: CoordinatorRun cannot be called from within a worker agent (recursive coordination not allowed).';
    }

    try {
      const result = await runCoordinator(
        goal,
        research_tasks,
        scratchpad_id,
        process.cwd(),
        (timeout_seconds ?? 300) * 1000,
        flow_config ?? {},
      );
      return result.summary;
    } catch (err) {
      return `CoordinatorRun error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
