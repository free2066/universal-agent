/**
 * SpawnAgent Tool — Isolated sub-agent execution with context handoff
 *
 * Inspired by kstack article #15339 "Evil Mode" multi-agent self-organization:
 * Three primitives: Thread Reference (perceive), Spawn Thread (create), Post Message (communicate).
 *
 * SpawnAgent implements the "Spawn Thread" + "Thread Reference" primitives for universal-agent:
 *   - Spawns a fresh AgentCore instance with an isolated message history (Empty mode)
 *   - Optionally injects parent context via .uagent/context/<id>.md files (Reference mode)
 *   - Writes its output to .uagent/context/<task-id>.md for downstream tasks to consume
 *   - Supports fork mode: inherits the parent's current conversation history
 *
 * Usage (AI calling the tool):
 *   SpawnAgent({ task: "Analyze security vulnerabilities in src/auth/", task_id: "sec-audit" })
 *   SpawnAgent({ task: "...", context_ids: ["proj-struct", "dep-graph"] })  // Reference mode
 *   SpawnAgent({ task: "...", mode: "fork", parent_history: [...] })         // Fork mode
 *
 * Context files are stored in .uagent/context/ (flat JSON-like markdown) and can be
 * referenced by downstream tasks for cross-agent communication.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
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

// ── Spawn execution ────────────────────────────────────────────────────────

async function spawnAndRun(
  task: string,
  opts: {
    taskId?: string;
    contextIds?: string[];
    mode?: 'empty' | 'reference' | 'fork';
    parentModel?: string;
    projectRoot?: string;
    subagentType?: string;
    domain?: string;
  },
): Promise<string> {
  const root = resolve(opts.projectRoot ?? process.cwd());
  const taskId = opts.taskId ?? `task-${Date.now()}`;
  const mode = opts.mode ?? 'empty';

  // Build the task prompt, optionally prepending reference context
  let fullTask = task;
  if (mode === 'reference' && opts.contextIds?.length) {
    const ctxContent = loadContextFiles(root, opts.contextIds);
    if (ctxContent) {
      fullTask = `${ctxContent}\n\n---\n## Your Task\n${task}`;
    }
  }

  // If a specific subagent type is requested, delegate via SubagentSystem
  if (opts.subagentType) {
    const { subagentSystem } = await import('../subagent-system.js');
    const result = await subagentSystem.runAgent(opts.subagentType, fullTask, opts.parentModel);
    writeContextFile(root, taskId, result);
    return result;
  }

  // Otherwise spawn a fully isolated AgentCore
  const model = opts.parentModel ?? modelManager.getCurrentModel('main');
  const { AgentCore } = await import('../agent.js');
  const agent = new AgentCore({
    domain: (opts.domain as 'auto' | 'data' | 'dev' | 'service') ?? 'auto',
    model,
    stream: false,
    verbose: false,
  });

  const result = await agent.run(fullTask);
  writeContextFile(root, taskId, result);
  return result;
}

// ── Tool definition ────────────────────────────────────────────────────────

export const spawnAgentTool: ToolRegistration = {
  definition: {
    name: 'SpawnAgent',
    description: [
      'Spawn an isolated sub-agent to execute a task in a fresh context (Empty mode).',
      'Optionally inject shared context from previous sub-agents (Reference mode).',
      'The result is automatically saved to .uagent/context/<task_id>.md for downstream tasks.',
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
      'Example: spawn a security auditor reading dependency context:',
      '  SpawnAgent({ task: "Audit for CVEs", task_id: "sec-audit",',
      '               context_ids: ["dep-graph"], mode: "reference" })',
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
        context_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs of previous agent outputs to inject as context (used in reference mode).',
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
          description: 'Optional: override model for this spawned agent.',
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
      context_ids,
      subagent_type,
      domain,
      model,
    } = args as {
      task: string;
      task_id?: string;
      mode?: 'empty' | 'reference';
      context_ids?: string[];
      subagent_type?: string;
      domain?: string;
      model?: string;
    };

    if (!task || typeof task !== 'string') {
      return 'Error: SpawnAgent requires a non-empty "task" string.';
    }

    try {
      const result = await spawnAndRun(task, {
        taskId: task_id,
        contextIds: context_ids,
        mode,
        parentModel: model,
        subagentType: subagent_type,
        domain,
        projectRoot: process.cwd(),
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
      'Example — Phase 1 parallel scan:',
      '  SpawnParallel({ tasks: [',
      '    { task: "Analyze project structure", task_id: "struct" },',
      '    { task: "Build dependency graph", task_id: "deps" }',
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
            description: 'Each task: { task, task_id?, mode?, context_ids?, subagent_type?, domain? }',
          },
        },
        model: {
          type: 'string',
          description: 'Optional: shared model override for all spawned agents.',
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
        context_ids?: string[];
        subagent_type?: string;
        domain?: string;
      }>;
      model?: string;
    };

    if (!Array.isArray(tasks) || tasks.length === 0) {
      return 'Error: SpawnParallel requires a non-empty "tasks" array.';
    }

    const results = await Promise.all(
      tasks.map(async (t) => {
        try {
          const out = await spawnAndRun(t.task, {
            taskId: t.task_id,
            contextIds: t.context_ids,
            mode: t.mode,
            parentModel: model,
            subagentType: t.subagent_type,
            domain: t.domain,
            projectRoot: process.cwd(),
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
