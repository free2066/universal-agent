/**
 * CoordinatorRun Tool — R→S→I→V Four-phase Multi-Agent Pipeline
 *
 * Inspired by Claude Code's "Coordinator Mode" (CLAUDE_CODE_COORDINATOR_MODE):
 * The Coordinator acts as a pure orchestrator — it ONLY spawns agents and synthesizes
 * results. It never directly writes files, runs commands, or touches code.
 *
 * Four phases (mirrors Claude Code's design exactly):
 *   Phase 1 — Research:        Multiple worker agents run IN PARALLEL, exploring the
 *                               codebase, gathering facts, writing to scratchpad.
 *   Phase 2 — Synthesis:       Coordinator itself reads all scratchpad entries and
 *                               produces a concrete implementation plan. Must NOT say
 *                               "based on your findings" — must read and specify exactly.
 *   Phase 3 — Implementation:  Multiple worker agents run IN PARALLEL, each implementing
 *                               a specific part of the plan. Use 'main' (strong) model.
 *   Phase 4 — Verification:    Worker agents verify the implementation (tests, lint, review).
 *                               Use 'quick' model (broad sweep, not deep reasoning).
 *
 * Tool role isolation (mirrors Claude Code's INTERNAL_COORDINATOR_TOOLS):
 *   - Coordinator: can ONLY spawn agents and synthesize. No Bash, no file writes.
 *   - Workers:     cannot use coordination tools (no SpawnAgent, no SpawnParallel).
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

export interface CoordinatorResult {
  goal: string;
  scratchpadId: string;
  phases: {
    research: string[];
    synthesis: string;
    implementation: string[];
    verification: string[];
  };
  success: boolean;
  summary: string;
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

async function runCoordinator(
  goal: string,
  researchTasks: string[],
  scratchpadId: string,
  projectRoot: string,
  timeoutMs: number,
): Promise<CoordinatorResult> {
  const root = resolve(projectRoot);

  // ── Phase 1: Research (parallel) ─────────────────────────────────────────
  const researchResults = await runWorkersParallel(researchTasks, 'research', {
    scratchpadId,
    projectRoot: root,
    timeoutMs,
  });

  // ── Phase 2: Synthesis (coordinator only) ─────────────────────────────────
  // Read all scratchpad entries written by research workers
  const scratchKeys = scratchpadList(root).filter((k) => k.startsWith(scratchpadId));
  const scratchEntries = scratchKeys
    .map((k) => {
      const val = scratchpadRead(root, k);
      return val ? `### [${k}]\n${val}` : null;
    })
    .filter(Boolean)
    .join('\n\n---\n\n');

  const synthPlan = await runSynthesis(goal, scratchEntries, root, scratchpadId);

  // ── Phase 3: Implementation (parallel) ────────────────────────────────────
  const implTasks = extractTasks(synthPlan, 'Task');
  const implResults = await runWorkersParallel(implTasks, 'implementation', {
    scratchpadId,
    projectRoot: root,
    timeoutMs,
  });

  // ── Phase 4: Verification (parallel) ──────────────────────────────────────
  const verifyTasks = extractTasks(synthPlan, 'Verify');
  const verifyResults = await runWorkersParallel(verifyTasks, 'verify', {
    scratchpadId,
    projectRoot: root,
    timeoutMs,
  });

  // Determine overall success: no verify task should contain "FAIL" or "ERROR"
  const failed = verifyResults.some((r) =>
    /\b(FAIL|FAILED|ERROR|❌)\b/i.test(r),
  );

  const summary = [
    `# Coordinator Run: ${goal}`,
    ``,
    `## Phases Completed`,
    `- ✅ Research (${researchResults.length} workers)`,
    `- ✅ Synthesis`,
    `- ${failed ? '⚠️' : '✅'} Implementation (${implResults.length} workers)`,
    `- ${failed ? '❌' : '✅'} Verification (${verifyResults.length} workers)`,
    ``,
    `## Implementation Plan`,
    synthPlan.slice(0, 1000) + (synthPlan.length > 1000 ? '\n...(truncated)' : ''),
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
      'Orchestrate a complex task using a four-phase multi-agent pipeline:',
      '  Phase 1 — Research:        Parallel worker agents explore the codebase and gather facts',
      '  Phase 2 — Synthesis:       Coordinator reads all findings, produces concrete plan (NO vague delegation)',
      '  Phase 3 — Implementation:  Parallel worker agents execute the plan (uses strong model)',
      '  Phase 4 — Verification:    Worker agents verify results (tests, lint, review)',
      '',
      'Key design principles (from Claude Code source):',
      '  - Coordinator ONLY orchestrates — never writes files or runs commands directly',
      '  - Worker agents are isolated — no access to coordination tools (recursive-bomb safe)',
      '  - Research workers use quick/cheap model; Implementation workers use main/strong model',
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
    } = args as {
      goal: string;
      research_tasks: string[];
      scratchpad_id: string;
      timeout_seconds?: number;
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
      );
      return result.summary;
    } catch (err) {
      return `CoordinatorRun error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
