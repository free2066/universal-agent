/**
 * SpawnAgent Tool — Isolated sub-agent execution with context handoff
 *
 * Inspired by kstack article #15339 (multi-agent self-organization) and
 * kstack article #15340 (Claude Code multi-agent architecture):
 *
 * Three primitives: Thread Reference (perceive), Spawn Thread (create), Post Message (communicate).
 *
 * Key design decisions adopted from Claude Code's source analysis:
 *  1. Sub-agents cannot re-spawn agents (recursive-bomb prevention via SPAWN_DEPTH env var)
 *  2. Scratchpad shared directory (.uagent/scratchpad/) for worker→worker findings sharing
 *  3. Heterogeneous model dispatch: caller can tag role=research|implementation|verify
 *     to automatically pick quick vs main model
 *
 * Context files (.uagent/context/<id>.md) remain the cross-agent communication channel.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { modelManager } from '../../models/model-manager.js';
import type { ToolRegistration } from '../../models/types.js';

// ── Context file helpers ───────────────────────────────────────────────────

function contextDir(projectRoot: string): string {
  return join(projectRoot, '.uagent', 'context');
}

function contextPath(projectRoot: string, taskId: string): string {
  return join(contextDir(projectRoot), `${taskId}.md`);
}

function loadContextFiles(projectRoot: string, ids: string[]): string {
  const parts: string[] = [];
  for (const id of ids) {
    const p = contextPath(projectRoot, id);
    if (existsSync(p)) {
      const content = readFileSync(p, 'utf-8').trim();
      if (content) parts.push(`## Context from [${id}]\n${content}`);
    }
  }
  return parts.join('\n\n');
}

function writeContextFile(projectRoot: string, taskId: string, result: string) {
  const dir = contextDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  const content = [
    `# Agent Context: ${taskId}`,
    '',
    `> Generated at: ${new Date().toISOString()}`,
    '',
    result,
  ].join('\n');
  writeFileSync(contextPath(projectRoot, taskId), content, 'utf-8');
}

// ── Scratchpad helpers ─────────────────────────────────────────────────────
// A shared bulletin-board directory where all workers in a session can post
// findings. Analogous to Claude Code's `tengu_scratch` feature flag.
// All writes are sync (tiny markdown snippets) to keep the helper import-free.

function scratchpadDir(projectRoot: string): string {
  return join(projectRoot, '.uagent', 'scratchpad');
}

export function scratchpadWrite(projectRoot: string, key: string, content: string): void {
  const dir = scratchpadDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${key}.md`), content, 'utf-8');
}

export function scratchpadRead(projectRoot: string, key: string): string | null {
  const p = join(scratchpadDir(projectRoot), `${key}.md`);
  return existsSync(p) ? readFileSync(p, 'utf-8') : null;
}

export function scratchpadList(projectRoot: string): string[] {
  const dir = scratchpadDir(projectRoot);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''));
  } catch { return []; }
}

// ── Heterogeneous model dispatch ───────────────────────────────────────────
// Research/verify tasks → quick model (cheaper, faster broad exploration)
// Implementation tasks  → main model  (strongest, precise code editing)
// This mirrors Claude Code's pattern: "难的任务用 Opus，简单的用 Haiku"

type AgentRole = 'research' | 'implementation' | 'verify' | 'auto';

function resolveModelForRole(role: AgentRole, override?: string): string {
  if (override) return override;
  switch (role) {
    case 'research':
    case 'verify':
      return modelManager.getCurrentModel('quick');
    case 'implementation':
      return modelManager.getCurrentModel('main');
    default:
      return modelManager.getCurrentModel('main');
  }
}

// ── Recursive-bomb guard ───────────────────────────────────────────────────
// Claude Code's AgentTool explicitly strips the AgentTool from sub-agent tool
// sets so sub-agents cannot re-spawn. We enforce the same constraint via an
// environment variable depth counter:
//   UAGENT_SPAWN_DEPTH=0  (top-level agent)
//   UAGENT_SPAWN_DEPTH=1  (first-level sub-agent, may still spawn)
//   UAGENT_SPAWN_DEPTH>=MAX  → refuse to spawn

const MAX_SPAWN_DEPTH = parseInt(process.env.UAGENT_MAX_SPAWN_DEPTH ?? '2', 10);

function currentSpawnDepth(): number {
  return parseInt(process.env.UAGENT_SPAWN_DEPTH ?? '0', 10);
}

// ── Spawn execution ────────────────────────────────────────────────────────

async function spawnAndRun(
  task: string,
  opts: {
    taskId?: string;
    contextIds?: string[];
    mode?: 'empty' | 'reference' | 'fork';
    role?: AgentRole;
    parentModel?: string;
    projectRoot?: string;
    subagentType?: string;
    domain?: string;
    /** Max ms to wait for the sub-agent. Default: 5 min. */
    timeoutMs?: number;
    /** Keys to read from scratchpad and prepend as context */
    scratchpadKeys?: string[];
    /**
     * Pre-built system prompt from the parent process.
     *
     * Claude Code article #15343 insight: sub-agents in Claude Code share the
     * same prompt cache — the common context (AGENTS.md, rules, git status) is
     * only computed ONCE by the parent and passed down.  Without this, N parallel
     * sub-agents each trigger buildSystemPromptWithContext() independently:
     *   – N × fs.readFileSync (AGENTS.md + rule files)
     *   – N × execSync('git status') despite the b4 cache only helping within
     *     the SAME process (each new AgentCore is a fresh process-level scope)
     *
     * Passing parentSystemPrompt lets sub-agents skip all that and start with
     * an identical prompt string that is already in the LLM provider's
     * KV-cache, dramatically reducing both latency and cost for SpawnParallel.
     */
    parentSystemPrompt?: string;
  },
): Promise<string> {
  // ── Depth guard ──────────────────────────────────────────────────────────
  const depth = currentSpawnDepth();
  if (depth >= MAX_SPAWN_DEPTH) {
    return (
      `[SpawnAgent blocked] Recursive spawn limit reached (depth=${depth}, max=${MAX_SPAWN_DEPTH}).\n` +
      `Sub-agents may not re-spawn agents. Increase UAGENT_MAX_SPAWN_DEPTH to override.`
    );
  }

  const root = resolve(opts.projectRoot ?? process.cwd());
  const taskId = opts.taskId ?? `task-${Date.now()}`;
  const mode = opts.mode ?? 'empty';
  const role = opts.role ?? 'auto';

  // ── Build full task prompt ────────────────────────────────────────────────
  let fullTask = task;

  // Inject reference context files
  if (mode === 'reference' && opts.contextIds?.length) {
    const ctxContent = loadContextFiles(root, opts.contextIds);
    if (ctxContent) {
      fullTask = `${ctxContent}\n\n---\n## Your Task\n${task}`;
    }
  }

  // Inject scratchpad findings (shared bulletin board)
  if (opts.scratchpadKeys?.length) {
    const parts: string[] = [];
    for (const key of opts.scratchpadKeys) {
      const val = scratchpadRead(root, key);
      if (val) parts.push(`### Scratchpad [${key}]\n${val}`);
    }
    if (parts.length > 0) {
      fullTask = `## Shared Findings\n${parts.join('\n\n')}\n\n---\n${fullTask}`;
    }
  }

  // ── Model selection ───────────────────────────────────────────────────────
  const model = resolveModelForRole(role, opts.parentModel);

  // ── Delegate to subagent system if a named type is requested ─────────────
  if (opts.subagentType) {
    const { subagentSystem } = await import('../subagent-system.js');
    const result = await subagentSystem.runAgent(opts.subagentType, fullTask, model);
    writeContextFile(root, taskId, result);
    return result;
  }

  // ── Spawn a fully isolated AgentCore, injecting depth+1 ──────────────────
  const { AgentCore } = await import('../agent.js');
  const agent = new AgentCore({
    domain: (opts.domain as 'auto' | 'data' | 'dev' | 'service') ?? 'auto',
    model,
    stream: false,
    verbose: false,
  });

  // ── Shared prompt cache (kstack article #15343) ───────────────────────────
  // If the parent passes its pre-built systemPrompt, inject it directly into
  // the child agent so it skips re-loading AGENTS.md + rules + git-status.
  // This is the same pattern Claude Code uses: all sub-agents in a parallel
  // fan-out share the SAME system prompt string that the parent already built,
  // meaning the LLM provider's KV-cache can be hit on every sub-agent call
  // instead of recomputing a fresh (slightly different) prompt each time.
  if (opts.parentSystemPrompt) {
    agent.setSystemPrompt(opts.parentSystemPrompt);
  }

  // Pass depth counter into child process env so nested spawns can check it
  const prevDepth = process.env.UAGENT_SPAWN_DEPTH;
  process.env.UAGENT_SPAWN_DEPTH = String(depth + 1);

  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000; // 5 min default
  const runPromise = agent.run(fullTask).finally(() => {
    // Restore parent's depth after child completes
    if (prevDepth === undefined) {
      delete process.env.UAGENT_SPAWN_DEPTH;
    } else {
      process.env.UAGENT_SPAWN_DEPTH = prevDepth;
    }
  });
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`SpawnAgent timed out after ${timeoutMs / 1000}s`)), timeoutMs),
  );
  const result = await Promise.race([runPromise, timeoutPromise]);
  writeContextFile(root, taskId, result);
  return result;
}

// ── Tool definitions ────────────────────────────────────────────────────────

export const spawnAgentTool: ToolRegistration = {
  definition: {
    name: 'SpawnAgent',
    description: [
      'Spawn an isolated sub-agent to execute a task in a fresh context (Empty mode).',
      'Optionally inject shared context from previous sub-agents (Reference mode).',
      'The result is automatically saved to .uagent/context/<task_id>.md for downstream tasks.',
      '',
      'Sub-agents cannot re-spawn other agents (recursive-bomb prevention).',
      '',
      'Use this tool when:',
      '  - A task can be fully described in self-contained instructions',
      '  - You want to isolate context to prevent history pollution',
      '  - You need to run multiple agents in parallel on independent subtasks',
      '  - You want to chain agents: A produces context → B reads it via context_ids',
      '',
      'Modes:',
      '  empty     (default) — fresh agent, no parent history',
      '  reference — fresh agent, but can read named context files written by previous agents',
      '',
      'Roles (auto-selects model):',
      '  research       → uses quick/cheap model for broad exploration',
      '  implementation → uses main/strong model for precise code changes',
      '  verify         → uses quick model for test/lint validation',
      '  auto           → uses main model (default)',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The complete task description for the spawned agent. Be specific and self-contained.',
        },
        task_id: {
          type: 'string',
          description: 'Unique ID for this task. Result saved to .uagent/context/<task_id>.md. Use snake_case.',
        },
        mode: {
          type: 'string',
          enum: ['empty', 'reference'],
          description: 'empty (default): isolated agent. reference: injects context_ids files into the prompt.',
        },
        role: {
          type: 'string',
          enum: ['research', 'implementation', 'verify', 'auto'],
          description: 'Agent role — determines model selection. research/verify→quick model, implementation→main model.',
        },
        context_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs of previous agent outputs to inject as context (used in reference mode).',
        },
        scratchpad_keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keys to read from shared scratchpad (.uagent/scratchpad/) and prepend as context.',
        },
        subagent_type: {
          type: 'string',
          description: 'Optional: delegate to a named subagent (reviewer, architect, security-auditor, etc.).',
        },
        domain: {
          type: 'string',
          enum: ['auto', 'data', 'dev', 'service'],
          description: 'Domain context for the spawned agent. Default: auto.',
        },
        model: {
          type: 'string',
          description: 'Optional: override model for this spawned agent (overrides role-based selection).',
        },
        timeout_seconds: {
          type: 'number',
          description: 'Max seconds to wait for the sub-agent to complete (default: 300).',
        },
      },
      required: ['task'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const {
      task,
      task_id,
      mode,
      role,
      context_ids,
      scratchpad_keys,
      subagent_type,
      domain,
      model,
      timeout_seconds,
    } = args as {
      task: string;
      task_id?: string;
      mode?: 'empty' | 'reference';
      role?: AgentRole;
      context_ids?: string[];
      scratchpad_keys?: string[];
      subagent_type?: string;
      domain?: string;
      model?: string;
      timeout_seconds?: number;
    };

    if (!task || typeof task !== 'string') {
      return 'Error: SpawnAgent requires a non-empty "task" string.';
    }

    try {
      const result = await spawnAndRun(task, {
        taskId: task_id,
        contextIds: context_ids,
        scratchpadKeys: scratchpad_keys,
        mode,
        role,
        parentModel: model,
        subagentType: subagent_type,
        domain,
        projectRoot: process.cwd(),
        timeoutMs: timeout_seconds ? timeout_seconds * 1000 : undefined,
      });
      const saved = task_id ? ` (saved to .uagent/context/${task_id}.md)` : '';
      return `[SpawnAgent result${saved}]\n\n${result}`;
    } catch (err) {
      return `SpawnAgent error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

/**
 * Parallel spawn: run multiple independent sub-agents concurrently.
 * All results are saved and a combined report is returned.
 */
export const spawnParallelTool: ToolRegistration = {
  definition: {
    name: 'SpawnParallel',
    description: [
      'Spawn multiple isolated sub-agents in parallel and collect their results.',
      'Each subtask runs concurrently — use for independent tasks with no mutual dependencies.',
      'All results are saved to .uagent/context/<task_id>.md for downstream agents to read.',
      '',
      'Sub-agents cannot re-spawn other agents (recursive-bomb prevention).',
      '',
      'Example — Phase 1 parallel research:',
      '  SpawnParallel({ tasks: [',
      '    { task: "Analyze project structure", task_id: "struct", role: "research" },',
      '    { task: "Build dependency graph", task_id: "deps", role: "research" }',
      '  ]})',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'Array of tasks to run in parallel.',
          items: {
            type: 'object',
            description: 'Each task: { task, task_id?, mode?, role?, context_ids?, scratchpad_keys?, subagent_type?, domain? }',
          },
        },
        model: {
          type: 'string',
          description: 'Optional: shared model override for all spawned agents (overrides role-based selection).',
        },
      },
      required: ['tasks'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const { tasks, model } = args as {
      tasks: Array<{
        task: string;
        task_id?: string;
        mode?: 'empty' | 'reference';
        role?: AgentRole;
        context_ids?: string[];
        scratchpad_keys?: string[];
        subagent_type?: string;
        domain?: string;
      }>;
      model?: string;
    };

    if (!Array.isArray(tasks) || tasks.length === 0) {
      return 'Error: SpawnParallel requires a non-empty "tasks" array.';
    }

    const results = await Promise.all(
      tasks.map(async (t, idx) => {
        if (!t || typeof t.task !== 'string' || !t.task.trim()) {
          const label = t?.task_id ?? `task[${idx}]`;
          return `### [${label}] ❌ Skipped\nMissing or empty "task" field.`;
        }
        try {
          const out = await spawnAndRun(t.task, {
            taskId: t.task_id,
            contextIds: t.context_ids,
            scratchpadKeys: t.scratchpad_keys,
            mode: t.mode,
            role: t.role,
            parentModel: model,
            subagentType: t.subagent_type,
            domain: t.domain,
            projectRoot: process.cwd(),
            // Pass caller's pre-built system prompt down to all sub-agents so
            // they skip re-loading AGENTS.md/rules/git-status (article #15343).
            parentSystemPrompt: (args as Record<string, unknown>).parent_system_prompt as string | undefined,
          });
          const label = t.task_id ?? t.task.slice(0, 40);
          return `### [${label}]\n${out}`;
        } catch (err) {
          const label = t.task_id ?? t.task.slice(0, 40);
          return `### [${label}] ❌ Error\n${err instanceof Error ? err.message : String(err)}`;
        }
      }),
    );

    return `## SpawnParallel Results (${tasks.length} agents)\n\n${results.join('\n\n---\n\n')}`;
  },
};
