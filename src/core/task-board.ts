/**
 * Task Board — s07-style persistent task graph.
 *
 * Tasks persist as JSON files in .uagent/tasks/ so they survive context
 * compression, session restarts, and parallel agent runs.
 *
 * Each task has a dependency graph (blockedBy): completing a task
 * automatically removes it from every other task's blockedBy list.
 *
 *   .uagent/tasks/
 *     task_1.json  {"id":1, "subject":"...", "status":"completed", ...}
 *     task_2.json  {"id":2, "blockedBy":[1], "status":"pending", ...}
 *     task_3.json  {"id":3, "blockedBy":[2], ...}
 *
 *   Dependency resolution:
 *   +----------+     +----------+     +----------+
 *   | task 1   | --> | task 2   | --> | task 3   |
 *   | complete |     | blocked  |     | blocked  |
 *   +----------+     +----------+     +----------+
 *        |                ^
 *        +--- completing task 1 removes it from task 2's blockedBy
 *
 * s07 motto: "Break big goals into small tasks, order them, persist to disk"
 * Key insight: "State that survives compression -- because it's outside the conversation."
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import type { ToolRegistration } from '../models/types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface Task {
  id: number;
  subject: string;
  description: string;
  status: TaskStatus;
  blockedBy: number[];
  owner: string;
  createdAt: number;
  updatedAt: number;
  // F24: activeForm -- spinner display text shown in UI progress timeline
  // Mirrors claude-code TaskCreateTool activeForm field
  // e.g. "Running tests" (present-tense, concise)
  activeForm?: string;
  // F24: metadata -- arbitrary key-value pairs for agent coordination
  // Mirrors claude-code TaskUpdateTool metadata field
  // Set a key to null to delete it
  metadata?: Record<string, string | null>;
  // F24: output -- task result output (written by owning agent on completion)
  output?: string;
  outputWrittenAt?: number;
}

// ─── TaskBoard ────────────────────────────────────────────────────────────────

export class TaskBoard {
  private readonly dir: string;
  private nextId: number;

  constructor(tasksDir: string) {
    this.dir = tasksDir;
    mkdirSync(this.dir, { recursive: true });
    this.nextId = this.maxId() + 1;
  }

  private maxId(): number {
    const ids = readdirSync(this.dir)
      .filter((f) => /^task_\d+\.json$/.test(f))
      .map((f) => parseInt(f.replace('task_', '').replace('.json', ''), 10));
    return ids.length > 0 ? Math.max(...ids) : 0;
  }

  private filePath(id: number): string {
    return join(this.dir, `task_${id}.json`);
  }

  private load(id: number): Task {
    const p = this.filePath(id);
    if (!existsSync(p)) throw new Error(`Task ${id} not found`);
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    // Defensive check: ensure required fields are present before trusting the file
    if (
      typeof raw !== 'object' || raw === null ||
      typeof raw.id !== 'number' ||
      typeof raw.subject !== 'string' ||
      !['pending', 'in_progress', 'completed'].includes(raw.status)
    ) {
      throw new Error(`Task file task_${id}.json has invalid structure`);
    }
    return raw as Task;
  }

  private save(task: Task): void {
    writeFileSync(this.filePath(task.id), JSON.stringify(task, null, 2), 'utf-8');
  }

  create(subject: string, description = '', blockedBy: number[] = [], activeForm?: string): string {
    const now = Date.now();
    const task: Task = {
      id: this.nextId++,
      subject,
      description,
      status: 'pending',
      blockedBy,
      owner: '',
      createdAt: now,
      updatedAt: now,
      ...(activeForm ? { activeForm } : {}),
    };
    this.save(task);
    // Emit task_create hook (Batch 2)
    import('./hooks.js').then(({ emitHook }) => {
      emitHook('task_create', { taskId: task.id, taskSubject: task.subject });
    }).catch(() => { /* non-fatal */ });
    return JSON.stringify(task, null, 2);
  }

  get(id: number): string {
    return JSON.stringify(this.load(id), null, 2);
  }

  update(id: number, opts: {
    status?: TaskStatus;
    addBlockedBy?: number[];
    removeBlockedBy?: number[];
    owner?: string;
    activeForm?: string;
    metadata?: Record<string, string | null>;
    output?: string;
  }): string {
    const task = this.load(id);
    if (opts.status) {
      if (!['pending', 'in_progress', 'completed'].includes(opts.status)) {
        throw new Error(`Invalid status: ${opts.status}`);
      }
      task.status = opts.status;
      if (opts.status === 'completed') {
        this.clearDependency(id);
        // Emit task_complete hook (Batch 2)
        import('./hooks.js').then(({ emitHook }) => {
          emitHook('task_complete', { taskId: task.id, taskSubject: task.subject });
        }).catch(() => { /* non-fatal */ });
      }
    }
    if (opts.addBlockedBy) {
      task.blockedBy = [...new Set([...task.blockedBy, ...opts.addBlockedBy])];
    }
    if (opts.removeBlockedBy) {
      task.blockedBy = task.blockedBy.filter((x) => !opts.removeBlockedBy!.includes(x));
    }
    if (opts.owner !== undefined) {
      task.owner = opts.owner;
    }
    // F24: activeForm update
    if (opts.activeForm !== undefined) {
      task.activeForm = opts.activeForm;
    }
    // F24: metadata merge (set null key to delete)
    if (opts.metadata) {
      const current = task.metadata ?? {};
      for (const [k, v] of Object.entries(opts.metadata)) {
        if (v === null) {
          delete current[k];
        } else {
          current[k] = v;
        }
      }
      task.metadata = Object.keys(current).length > 0 ? current : undefined;
    }
    // F24: output recording
    if (opts.output !== undefined) {
      task.output = opts.output;
      task.outputWrittenAt = Date.now();
    }
    task.updatedAt = Date.now();
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  /** Remove completedId from all other tasks' blockedBy lists. */
  private clearDependency(completedId: number): void {
    const files = readdirSync(this.dir).filter((f) => /^task_\d+\.json$/.test(f));
    for (const f of files) {
      let task: Task;
      try {
        const raw = JSON.parse(readFileSync(join(this.dir, f), 'utf-8'));
        if (typeof raw !== 'object' || raw === null || !Array.isArray(raw.blockedBy)) continue;
        task = raw as Task;
      } catch { continue; }
      if (task.blockedBy.includes(completedId)) {
        task.blockedBy = task.blockedBy.filter((x) => x !== completedId);
        task.updatedAt = Date.now();
        this.save(task);
      }
    }
  }

  listAll(includeWorktrees = false): string {
    const files = readdirSync(this.dir)
      .filter((f) => /^task_\d+\.json$/.test(f))
      .sort((a, b) => {
        const na = parseInt(a.replace('task_', '').replace('.json', ''), 10);
        const nb = parseInt(b.replace('task_', '').replace('.json', ''), 10);
        return na - nb;
      });

    if (files.length === 0) return 'No tasks.';

    // Optionally load worktree index for binding display
    let worktreeBindings: Map<number, string> = new Map();
    if (includeWorktrees) {
      try {
        const wtIdx = resolve(process.cwd(), '.uagent', 'worktrees', 'index.json');
        if (existsSync(wtIdx)) {
          const idx = JSON.parse(readFileSync(wtIdx, 'utf-8')) as {
            worktrees: Array<{ name: string; task_id: number | null; status: string }>;
          };
          for (const wt of idx.worktrees) {
            if (wt.task_id !== null && wt.status !== 'removed') {
              worktreeBindings.set(wt.task_id, wt.name);
            }
          }
        }
      } catch { /* non-fatal */ }
    }

    const tasks = files.flatMap((f) => {
      try {
        const raw = JSON.parse(readFileSync(join(this.dir, f), 'utf-8'));
        if (typeof raw !== 'object' || raw === null || typeof raw.id !== 'number') return [];
        return [raw as Task];
      } catch { return []; }
    });
    const lines = tasks.map((t) => {
      const marker = { pending: '[ ]', in_progress: '[>]', completed: '[x]', cancelled: '[✗]' }[t.status] ?? '[?]';
      const blocked = t.blockedBy.length > 0 ? ` (blocked by: ${t.blockedBy.join(', ')})` : '';
      const owner = t.owner ? ` @${t.owner}` : '';
      const wt = includeWorktrees && worktreeBindings.has(t.id) ? ` [worktree:${worktreeBindings.get(t.id)}]` : '';
      return `${marker} #${t.id}: ${t.subject}${owner}${blocked}${wt}`;
    });
    return lines.join('\n');
  }

  /** Return tasks that are ready to be claimed (pending, unblocked, unowned). */
  unclaimedReady(): Task[] {
    const files = readdirSync(this.dir).filter((f) => /^task_\d+\.json$/.test(f));
    return files
      .flatMap((f) => {
        try {
          const raw = JSON.parse(readFileSync(join(this.dir, f), 'utf-8'));
          if (typeof raw !== 'object' || raw === null || typeof raw.id !== 'number') return [];
          return [raw as Task];
        } catch { return []; }
      })
      .filter((t) => t.status === 'pending' && !t.owner && t.blockedBy.length === 0)
      .sort((a, b) => a.id - b.id);
  }

  /**
   * s11 — Claim a task: set owner and status to in_progress.
   * Used by teammates in idle phase and the `claim_task` lead tool.
   */
  claim(id: number, owner: string): string {
    const task = this.load(id);
    task.owner = owner;
    task.status = 'in_progress';
    task.updatedAt = Date.now();
    this.save(task);
    return `Claimed task #${id} for ${owner}`;
  }

  /**
   * Cancel / stop a task.
   * Sets status to 'cancelled' and optionally records a reason.
   * Cancelled tasks are treated like completed tasks for dependency resolution.
   */
  cancel(id: number, reason?: string): string {
    const task = this.load(id);
    if (task.status === 'completed') {
      return `Task #${id} is already completed — nothing to cancel.`;
    }
    task.status = 'cancelled';
    (task as Task & { cancelledReason?: string }).cancelledReason = reason ?? 'stopped by agent';
    task.updatedAt = Date.now();
    this.save(task);
    // Treat cancellation like completion for dependency resolution
    this.clearDependency(id);
    const reasonStr = reason ? ` Reason: ${reason}` : '';
    return `Task #${id} cancelled.${reasonStr}`;
  }
}

// ─── Singleton per project root ───────────────────────────────────────────────

const boardCache = new Map<string, TaskBoard>();

export function getTaskBoard(projectRoot?: string): TaskBoard {
  const root = resolve(projectRoot ?? process.cwd());
  let board = boardCache.get(root);
  if (!board) {
    board = new TaskBoard(join(root, '.uagent', 'tasks'));
    boardCache.set(root, board);
  }
  return board;
}

// ─── Tool registrations ───────────────────────────────────────────────────────

export const taskCreateTool: ToolRegistration = {
  definition: {
    name: 'task_create',
    description: [
      'Create a new task on the persistent task board.',
      'Tasks survive context compression — use them to track multi-step goals.',
      'Specify blockedBy IDs to declare dependencies between tasks.',
    ].join(' '),
    parameters: {
      type: 'object' as const,
      properties: {
        subject: { type: 'string', description: 'Short task title (<=80 chars).' },
        description: { type: 'string', description: 'Detailed description (optional).' },
        blocked_by: {
          type: 'array',
          items: { type: "number" },
          description: 'IDs of tasks that must complete before this one can start.',
        },
        active_form: {
          type: 'string',
          description: 'F24: Present-tense spinner text shown in UI (e.g. "Running tests").',
        },
      },
      required: ['subject'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const board = getTaskBoard(process.cwd());
    return board.create(
      args.subject as string,
      (args.description as string | undefined) ?? '',
      (args.blocked_by as number[] | undefined) ?? [],
      args.active_form as string | undefined,
    );
  },
};

export const taskUpdateTool: ToolRegistration = {
  definition: {
    name: 'task_update',
    description: [
      'Update a task\'s status, dependencies, or metadata.',
      'Completing a task (status=completed) automatically removes it from all blockedBy lists,',
      'potentially unblocking downstream tasks.',
    ].join(' '),
    parameters: {
      type: 'object' as const,
      properties: {
        task_id: { type: "number", description: 'Task ID to update.' },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed', 'cancelled'],
          description: 'New status.',
        },
        add_blocked_by: {
          type: 'array',
          items: { type: "number" },
          description: 'Add dependencies.',
        },
        remove_blocked_by: {
          type: 'array',
          items: { type: "number" },
          description: 'Remove dependencies.',
        },
        owner: { type: 'string', description: 'Assign an owner (agent name or "me").' },
        active_form: {
          type: 'string',
          description: 'F24: Update spinner text (e.g. "Writing tests"). Set to "" to clear.',
        },
        metadata: {
          type: 'object',
          description: 'F24: Key-value metadata to merge. Set a key to null to delete it.',
        },
        output: {
          type: 'string',
          description: 'F24: Task result output written by the owning agent.',
        },
      },
      required: ['task_id'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const board = getTaskBoard(process.cwd());
    return board.update(args.task_id as number, {
      status: args.status as TaskStatus | undefined,
      addBlockedBy: args.add_blocked_by as number[] | undefined,
      removeBlockedBy: args.remove_blocked_by as number[] | undefined,
      owner: args.owner as string | undefined,
      activeForm: args.active_form as string | undefined,
      metadata: args.metadata as Record<string, string | null> | undefined,
      output: args.output as string | undefined,
    });
  },
};

export const taskListTool: ToolRegistration = {
  definition: {
    name: 'task_list',
    description: 'List all tasks with status, owner, and dependency summary.',
    parameters: { type: 'object' as const, properties: {} },
  },
  handler: async (): Promise<string> => {
    return getTaskBoard(process.cwd()).listAll();
  },
};

export const taskGetTool: ToolRegistration = {
  definition: {
    name: 'task_get',
    description: 'Get full details of a task by ID.',
    parameters: {
      type: 'object' as const,
      properties: {
        task_id: { type: "number", description: 'Task ID.' },
      },
      required: ['task_id'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    return getTaskBoard(process.cwd()).get(args.task_id as number);
  },
};

export const taskStopTool: ToolRegistration = {
  definition: {
    name: 'task_stop',
    description: [
      'Cancel / stop a running or pending task.',
      'Marks the task as cancelled and unblocks any tasks that were waiting for it.',
      'Use this when a task is no longer needed, has been superseded, or encountered',
      'an unrecoverable error that prevents completion.',
    ].join(' '),
    parameters: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'number', description: 'ID of the task to cancel.' },
        reason: {
          type: 'string',
          description: 'Optional reason for cancellation (recorded in the task file).',
        },
      },
      required: ['task_id'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    return getTaskBoard(process.cwd()).cancel(
      args.task_id as number,
      args.reason as string | undefined,
    );
  },
};

/**
 * F24: taskOutputTool -- poll or wait for task output
 *
 * Mirrors claude-code src/tools/TaskOutputTool/TaskOutputTool.tsx:
 * Polls the task's output field, optionally blocking until it appears or the task completes.
 * Supports bash/agent/swarm tasks uniformly.
 */
export const taskOutputTool: ToolRegistration = {
  definition: {
    name: 'task_output',
    description: [
      'F24: Poll or wait for the output of a task.',
      'Returns the task\'s output field if available.',
      'With block=true, waits up to timeout_ms milliseconds for the task to complete.',
      'Useful for coordinating between agents: agent writes output via task_update(output=...),',
      'lead polls via task_output.',
    ].join(' '),
    parameters: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'number', description: 'Task ID to get output from.' },
        block: {
          type: 'boolean',
          description: 'If true, wait for the task to complete (default: false).',
        },
        timeout_ms: {
          type: 'number',
          description: 'Max wait time in ms when block=true (default: 30000 = 30s).',
        },
        poll_interval_ms: {
          type: 'number',
          description: 'Poll interval in ms when block=true (default: 2000 = 2s).',
        },
      },
      required: ['task_id'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const taskId = args.task_id as number;
    const block = (args.block as boolean | undefined) ?? false;
    const timeoutMs = (args.timeout_ms as number | undefined) ?? 30_000;
    const pollIntervalMs = (args.poll_interval_ms as number | undefined) ?? 2_000;

    const board = getTaskBoard(process.cwd());

    // Non-blocking: return current state immediately
    if (!block) {
      const raw = JSON.parse(board.get(taskId)) as Task;
      if (raw.output) {
        return `Task #${taskId} output:\n${raw.output}`;
      }
      const statusInfo = `Task #${taskId} (${raw.status}): no output yet.`;
      if (['completed', 'cancelled'].includes(raw.status)) {
        return `${statusInfo} Task ended without writing output.`;
      }
      return statusInfo;
    }

    // Blocking: poll until output appears or task completes or timeout
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let raw: Task;
      try {
        raw = JSON.parse(board.get(taskId)) as Task;
      } catch {
        return `Error: Task ${taskId} not found.`;
      }

      if (raw.output) {
        return `Task #${taskId} output:\n${raw.output}`;
      }

      if (['completed', 'cancelled'].includes(raw.status)) {
        return `Task #${taskId} ended (${raw.status}) without writing output.`;
      }

      // Wait before polling again
      await new Promise<void>((resolve) => {
        const wait = Math.min(pollIntervalMs, deadline - Date.now());
        if (wait <= 0) { resolve(); return; }
        setTimeout(resolve, wait);
      });
    }

    // Timeout
    return `Task #${taskId} output poll timed out after ${timeoutMs}ms. Task may still be running.`;
  },
};
