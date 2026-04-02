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

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

export interface Task {
  id: number;
  subject: string;
  description: string;
  status: TaskStatus;
  blockedBy: number[];
  owner: string;
  createdAt: number;
  updatedAt: number;
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
    return JSON.parse(readFileSync(p, 'utf-8')) as Task;
  }

  private save(task: Task): void {
    writeFileSync(this.filePath(task.id), JSON.stringify(task, null, 2), 'utf-8');
  }

  create(subject: string, description = '', blockedBy: number[] = []): string {
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
    };
    this.save(task);
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
  }): string {
    const task = this.load(id);
    if (opts.status) {
      if (!['pending', 'in_progress', 'completed'].includes(opts.status)) {
        throw new Error(`Invalid status: ${opts.status}`);
      }
      task.status = opts.status;
      if (opts.status === 'completed') {
        this.clearDependency(id);
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
    task.updatedAt = Date.now();
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  /** Remove completedId from all other tasks' blockedBy lists. */
  private clearDependency(completedId: number): void {
    const files = readdirSync(this.dir).filter((f) => /^task_\d+\.json$/.test(f));
    for (const f of files) {
      const task = JSON.parse(readFileSync(join(this.dir, f), 'utf-8')) as Task;
      if (task.blockedBy.includes(completedId)) {
        task.blockedBy = task.blockedBy.filter((x) => x !== completedId);
        task.updatedAt = Date.now();
        this.save(task);
      }
    }
  }

  listAll(): string {
    const files = readdirSync(this.dir)
      .filter((f) => /^task_\d+\.json$/.test(f))
      .sort((a, b) => {
        const na = parseInt(a.replace('task_', '').replace('.json', ''), 10);
        const nb = parseInt(b.replace('task_', '').replace('.json', ''), 10);
        return na - nb;
      });

    if (files.length === 0) return 'No tasks.';

    const tasks = files.map((f) => JSON.parse(readFileSync(join(this.dir, f), 'utf-8')) as Task);
    const lines = tasks.map((t) => {
      const marker = { pending: '[ ]', in_progress: '[>]', completed: '[x]' }[t.status] ?? '[?]';
      const blocked = t.blockedBy.length > 0 ? ` (blocked by: ${t.blockedBy.join(', ')})` : '';
      const owner = t.owner ? ` @${t.owner}` : '';
      return `${marker} #${t.id}: ${t.subject}${owner}${blocked}`;
    });
    return lines.join('\n');
  }

  /** Return tasks that are ready to be claimed (pending, unblocked, unowned). */
  unclaimedReady(): Task[] {
    const files = readdirSync(this.dir).filter((f) => /^task_\d+\.json$/.test(f));
    return files
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), 'utf-8')) as Task)
      .filter((t) => t.status === 'pending' && !t.owner && t.blockedBy.length === 0)
      .sort((a, b) => a.id - b.id);
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
        subject: { type: 'string', description: 'Short task title (≤80 chars).' },
        description: { type: 'string', description: 'Detailed description (optional).' },
        blocked_by: {
          type: 'array',
          items: { type: "number" },
          description: 'IDs of tasks that must complete before this one can start.',
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
    );
  },
};

export const taskUpdateTool: ToolRegistration = {
  definition: {
    name: 'task_update',
    description: [
      'Update a task\'s status or dependencies.',
      'Completing a task (status=completed) automatically removes it from all blockedBy lists,',
      'potentially unblocking downstream tasks.',
    ].join(' '),
    parameters: {
      type: 'object' as const,
      properties: {
        task_id: { type: "number", description: 'Task ID to update.' },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed'],
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
