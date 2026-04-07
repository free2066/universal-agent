/**
 * s12 Worktree Tools — directory-level isolation for parallel task execution.
 *
 * Tasks are the control plane. Worktrees are the execution plane.
 * Key insight: "Isolate by directory, coordinate by task ID."
 *
 *   .uagent/worktrees/
 *     index.json       { worktrees: [{ name, path, branch, task_id, status }] }
 *     events.jsonl     append-only lifecycle event log (EventBus)
 *
 * Tools provided:
 *   worktree_create  — create git worktree, optionally bind to task
 *   worktree_list    — list tracked worktrees
 *   worktree_status  — git status for a named worktree
 *   worktree_run     — run a command inside a worktree directory
 *   worktree_remove  — remove worktree, optionally complete bound task
 *   worktree_keep    — mark worktree as "kept" without removing
 *   worktree_events  — list recent lifecycle events
 *   task_bind_worktree — bind a task to a worktree name
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join, resolve } from 'path';
import { execSync, spawnSync } from 'child_process';
import { sanitizeName } from '../../../utils/path-security.js';
import type { ToolRegistration } from '../../../models/types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('worktree');

// ─── EventBus ──────────────────────────────────────────────────────────────────

class EventBus {
  private readonly path: string;

  constructor(logPath: string) {
    this.path = logPath;
    mkdirSync(resolve(logPath, '..'), { recursive: true });
    if (!existsSync(this.path)) writeFileSync(this.path, '', 'utf-8');
  }

  emit(event: string, task: Record<string, unknown> = {}, worktree: Record<string, unknown> = {}, error?: string): void {
    const payload: Record<string, unknown> = {
      event,
      ts: Date.now() / 1000,
      task,
      worktree,
    };
    if (error) payload.error = error;
    appendFileSync(this.path, JSON.stringify(payload) + '\n', 'utf-8');
  }

  listRecent(limit = 20): string {
    const n = Math.max(1, Math.min(limit, 200));
    const lines = readFileSync(this.path, 'utf-8').split('\n').filter(Boolean);
    const recent = lines.slice(-n);
    const items = recent.map((l) => {
      try { return JSON.parse(l); } catch { return { event: 'parse_error', raw: l }; }
    });
    return JSON.stringify(items, null, 2);
  }
}

// ─── WorktreeIndex ─────────────────────────────────────────────────────────────

interface WorktreeEntry {
  name: string;
  path: string;
  branch: string;
  task_id: number | null;
  status: 'active' | 'kept' | 'removed';
  created_at: number;
  kept_at?: number;
  removed_at?: number;
}

interface WorktreeIndex {
  worktrees: WorktreeEntry[];
}

// ─── WorktreeManager ────────────────────────────────────────────────────────────

export class WorktreeManager {
  private readonly repoRoot: string;
  private readonly worktreeDir: string;
  private readonly indexPath: string;
  private readonly events: EventBus;
  private readonly tasksDir: string;
  public readonly gitAvailable: boolean;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
    this.worktreeDir = join(repoRoot, '.uagent', 'worktrees');
    this.indexPath = join(this.worktreeDir, 'index.json');
    this.tasksDir = join(repoRoot, '.uagent', 'tasks');
    this.events = new EventBus(join(this.worktreeDir, 'events.jsonl'));
    mkdirSync(this.worktreeDir, { recursive: true });
    if (!existsSync(this.indexPath)) {
      writeFileSync(this.indexPath, JSON.stringify({ worktrees: [] }, null, 2), 'utf-8');
    }
    this.gitAvailable = this.isGitRepo();
  }

  private isGitRepo(): boolean {
    try {
      const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: this.repoRoot, encoding: 'utf-8' });
      return r.status === 0;
    } catch { return false; }
  }

  private runGit(args: string[]): string {
    if (!this.gitAvailable) throw new Error('Not in a git repository. worktree tools require git.');
    const r = spawnSync('git', args, { cwd: this.repoRoot, encoding: 'utf-8' });
    if (r.status !== 0) {
      const msg = ((r.stdout ?? '') + (r.stderr ?? '')).trim();
      throw new Error(msg || `git ${args.join(' ')} failed`);
    }
    return ((r.stdout ?? '') + (r.stderr ?? '')).trim() || '(no output)';
  }

  private loadIndex(): WorktreeIndex {
    try {
      const raw = JSON.parse(readFileSync(this.indexPath, 'utf-8'));
      // Defensive: must be an object with a worktrees array
      if (typeof raw !== 'object' || raw === null || !Array.isArray(raw.worktrees)) {
        return { worktrees: [] };
      }
      return raw as WorktreeIndex;
    } catch {
      return { worktrees: [] };
    }
  }

  private saveIndex(data: WorktreeIndex): void {
    writeFileSync(this.indexPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  private find(name: string): WorktreeEntry | null {
    return this.loadIndex().worktrees.find((w) => w.name === name) ?? null;
  }

  private validateName(name: string): void {
    // Use sanitizeName for CWE-22 path-traversal prevention (rejects ../ / \)
    sanitizeName(name, 'worktree name');
    if (name.length > 40) {
      throw new Error('Invalid worktree name. Use 1-40 chars: letters, numbers, ., _, -');
    }
  }

  private bindTaskToWorktree(taskId: number, worktreeName: string): void {
    // taskId is always a number so no path-traversal risk here, but validate anyway
    if (!Number.isInteger(taskId) || taskId < 0) throw new Error(`Invalid task id: ${taskId}`);
    const p = join(this.tasksDir, `task_${taskId}.json`);
    if (!existsSync(p)) return;
    let task: Record<string, unknown>;
    try { task = JSON.parse(readFileSync(p, 'utf-8')); } catch { return; }
    if (typeof task !== 'object' || task === null) return;
    task.worktree = worktreeName;
    if (task.status === 'pending') task.status = 'in_progress';
    task.updatedAt = Date.now();
    writeFileSync(p, JSON.stringify(task, null, 2), 'utf-8');
  }

  private unbindTask(taskId: number): void {
    if (!Number.isInteger(taskId) || taskId < 0) throw new Error(`Invalid task id: ${taskId}`);
    const p = join(this.tasksDir, `task_${taskId}.json`);
    if (!existsSync(p)) return;
    let task: Record<string, unknown>;
    try { task = JSON.parse(readFileSync(p, 'utf-8')); } catch { return; }
    if (typeof task !== 'object' || task === null) return;
    task.worktree = '';
    task.updatedAt = Date.now();
    writeFileSync(p, JSON.stringify(task, null, 2), 'utf-8');
  }

  create(name: string, taskId?: number, baseRef = 'HEAD'): string {
    this.validateName(name);
    if (this.find(name)) throw new Error(`Worktree '${name}' already exists in index`);
    if (taskId !== undefined && !existsSync(join(this.tasksDir, `task_${taskId}.json`))) {
      throw new Error(`Task ${taskId} not found`);
    }
    const wtPath = join(this.worktreeDir, name);
    const branch = `wt/${name}`;
    this.events.emit('worktree.create.before',
      taskId !== undefined ? { id: taskId } : {},
      { name, base_ref: baseRef });
    try {
      this.runGit(['worktree', 'add', '-b', branch, wtPath, baseRef]);
      const entry: WorktreeEntry = {
        name, path: wtPath, branch,
        task_id: taskId ?? null, status: 'active',
        created_at: Date.now() / 1000,
      };
      const idx = this.loadIndex();
      idx.worktrees.push(entry);
      this.saveIndex(idx);
      if (taskId !== undefined) this.bindTaskToWorktree(taskId, name);
      this.events.emit('worktree.create.after',
        taskId !== undefined ? { id: taskId } : {},
        { name, path: wtPath, branch, status: 'active' });
      // Emit public worktree_create hook (Batch 2)
      import('../../hooks.js').then(({ emitHook }) => {
        emitHook('worktree_create', { worktreeName: name, worktreePath: wtPath, taskId });
      }).catch(() => { /* non-fatal */ });
      return JSON.stringify(entry, null, 2);
    } catch (e) {
      this.events.emit('worktree.create.failed',
        taskId !== undefined ? { id: taskId } : {},
        { name, base_ref: baseRef }, String(e));
      throw e;
    }
  }

  listAll(): string {
    const wts = this.loadIndex().worktrees;
    if (wts.length === 0) return 'No worktrees in index.';
    return wts.map((w) => {
      const suffix = w.task_id !== null ? ` task=${w.task_id}` : '';
      return `[${w.status}] ${w.name} -> ${w.path} (${w.branch})${suffix}`;
    }).join('\n');
  }

  status(name: string): string {
    const wt = this.find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;
    if (!existsSync(wt.path)) return `Error: Worktree path missing: ${wt.path}`;
    const r = spawnSync('git', ['status', '--short', '--branch'], { cwd: wt.path, encoding: 'utf-8' });
    return ((r.stdout ?? '') + (r.stderr ?? '')).trim() || 'Clean worktree';
  }

  run(name: string, command: string): string {
    const dangerous = ['rm -rf /', 'sudo', 'shutdown', 'reboot', '> /dev/'];
    if (dangerous.some((d) => command.includes(d))) return 'Error: Dangerous command blocked';
    const wt = this.find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;
    if (!existsSync(wt.path)) return `Error: Worktree path missing: ${wt.path}`;
    try {
      const r = spawnSync(command, { shell: true, cwd: wt.path, encoding: 'utf-8' });
      const out = ((r.stdout ?? '') + (r.stderr ?? '')).trim();
      return (out || '(no output)').slice(0, 50000);
    } catch (e) { return `Error: ${e}`; }
  }

  remove(name: string, force = false, completeTask = false): string {
    const wt = this.find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;
    this.events.emit('worktree.remove.before',
      wt.task_id !== null ? { id: wt.task_id } : {},
      { name, path: wt.path });
    try {
      const args = ['worktree', 'remove', ...(force ? ['--force'] : []), wt.path];
      this.runGit(args);
      if (completeTask && wt.task_id !== null) {
        const tp = join(this.tasksDir, `task_${wt.task_id}.json`);
        if (existsSync(tp)) {
          let task: Record<string, unknown>;
          try { task = JSON.parse(readFileSync(tp, 'utf-8')); } catch { task = {}; }
          if (typeof task !== 'object' || task === null) task = {};
          task.status = 'completed';
          task.updatedAt = Date.now();
          writeFileSync(tp, JSON.stringify(task, null, 2), 'utf-8');
        }
        this.unbindTask(wt.task_id);
        this.events.emit('task.completed', { id: wt.task_id, status: 'completed' }, { name });
      }
      const idx = this.loadIndex();
      for (const item of idx.worktrees) {
        if (item.name === name) { item.status = 'removed'; item.removed_at = Date.now() / 1000; }
      }
      this.saveIndex(idx);
      this.events.emit('worktree.remove.after',
        wt.task_id !== null ? { id: wt.task_id } : {},
        { name, path: wt.path, status: 'removed' });
      // Emit public worktree_remove hook (Batch 2)
      import('../../hooks.js').then(({ emitHook }) => {
        emitHook('worktree_remove', { worktreeName: name, worktreePath: wt.path });
      }).catch(() => { /* non-fatal */ });
      return `Removed worktree '${name}'`;
    } catch (e) {
      this.events.emit('worktree.remove.failed',
        wt.task_id !== null ? { id: wt.task_id } : {},
        { name, path: wt.path }, String(e));
      throw e;
    }
  }

  keep(name: string): string {
    const wt = this.find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;
    const idx = this.loadIndex();
    let kept: WorktreeEntry | null = null;
    for (const item of idx.worktrees) {
      if (item.name === name) { item.status = 'kept'; item.kept_at = Date.now() / 1000; kept = item; }
    }
    this.saveIndex(idx);
    this.events.emit('worktree.keep',
      wt.task_id !== null ? { id: wt.task_id } : {},
      { name, path: wt.path, status: 'kept' });
    return kept ? JSON.stringify(kept, null, 2) : `Error: Unknown worktree '${name}'`;
  }

  eventsRecent(limit = 20): string {
    return this.events.listRecent(limit);
  }

  bindTask(taskId: number, worktreeName: string): string {
    this.bindTaskToWorktree(taskId, worktreeName);
    return `Task ${taskId} bound to worktree '${worktreeName}'`;
  }
}

// ─── Singleton per project root ─────────────────────────────────────────────

const managerCache = new Map<string, WorktreeManager>();

function getWorktreeManager(projectRoot?: string): WorktreeManager {
  const root = resolve(projectRoot ?? process.cwd());
  let mgr = managerCache.get(root);
  if (!mgr) { mgr = new WorktreeManager(root); managerCache.set(root, mgr); }
  return mgr;
}

// ─── Tool registrations ───────────────────────────────────────────────────────

export const worktreeCreateTool: ToolRegistration = {
  definition: {
    name: 'worktree_create',
    description: 'Create a git worktree in .uagent/worktrees/<name>/ and optionally bind it to a task. Use this to isolate parallel or risky work in its own directory.',
    parameters: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Worktree name (1-40 chars, letters/numbers/.-_).' },
        task_id: { type: 'number', description: 'Optional task ID to bind to this worktree.' },
        base_ref: { type: 'string', description: 'Git ref to branch from (default: HEAD).' },
      },
      required: ['name'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    try {
      return getWorktreeManager().create(
        args.name as string,
        args.task_id as number | undefined,
        (args.base_ref as string | undefined) ?? 'HEAD',
      );
    } catch (e) { return `Error: ${e instanceof Error ? e.message : String(e)}`; }
  },
};

export const worktreeListTool: ToolRegistration = {
  definition: {
    name: 'worktree_list',
    description: 'List worktrees tracked in .uagent/worktrees/index.json with status and task bindings.',
    parameters: { type: 'object' as const, properties: {} },
  },
  handler: async (): Promise<string> => getWorktreeManager().listAll(),
};

export const worktreeStatusTool: ToolRegistration = {
  definition: {
    name: 'worktree_status',
    description: 'Show git status for a named worktree.',
    parameters: {
      type: 'object' as const,
      properties: { name: { type: 'string', description: 'Worktree name.' } },
      required: ['name'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => getWorktreeManager().status(args.name as string),
};

export const worktreeRunTool: ToolRegistration = {
  definition: {
    name: 'worktree_run',
    description: 'Run a shell command inside a named worktree directory. Use for isolated builds, tests, or edits.',
    parameters: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Worktree name.' },
        command: { type: 'string', description: 'Shell command to run.' },
      },
      required: ['name', 'command'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => getWorktreeManager().run(args.name as string, args.command as string),
};

export const worktreeRemoveTool: ToolRegistration = {
  definition: {
    name: 'worktree_remove',
    description: 'Remove a worktree. If complete_task=true, marks the bound task as completed and unbinds it.',
    parameters: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Worktree name.' },
        force: { type: 'boolean', description: 'Force removal even with uncommitted changes.' },
        complete_task: { type: 'boolean', description: 'Mark bound task as completed.' },
      },
      required: ['name'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    try {
      return getWorktreeManager().remove(
        args.name as string,
        (args.force as boolean | undefined) ?? false,
        (args.complete_task as boolean | undefined) ?? false,
      );
    } catch (e) { return `Error: ${e instanceof Error ? e.message : String(e)}`; }
  },
};

export const worktreeKeepTool: ToolRegistration = {
  definition: {
    name: 'worktree_keep',
    description: 'Mark a worktree as "kept" (completed but preserved for reference) without removing it.',
    parameters: {
      type: 'object' as const,
      properties: { name: { type: 'string', description: 'Worktree name.' } },
      required: ['name'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => getWorktreeManager().keep(args.name as string),
};

export const worktreeEventsTool: ToolRegistration = {
  definition: {
    name: 'worktree_events',
    description: 'List recent worktree/task lifecycle events from .uagent/worktrees/events.jsonl.',
    parameters: {
      type: 'object' as const,
      properties: { limit: { type: 'number', description: 'Max events to return (default 20, max 200).' } },
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => getWorktreeManager().eventsRecent((args.limit as number | undefined) ?? 20),
};

export const taskBindWorktreeTool: ToolRegistration = {
  definition: {
    name: 'task_bind_worktree',
    description: 'Bind a task to a worktree name (updates task JSON with worktree field).',
    parameters: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'number', description: 'Task ID to bind.' },
        worktree: { type: 'string', description: 'Worktree name to bind to.' },
      },
      required: ['task_id', 'worktree'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => getWorktreeManager().bindTask(args.task_id as number, args.worktree as string),
};

/**
 * E26: worktree_enter — 切换当前 agent 会话工作目录到 worktree 路径
 *
 * Mirrors claude-code EnterWorktreeTool.ts 的4步实现：
 *   1. process.chdir(wtPath)          — OS 进程切换目录
 *   2. 记录原始 cwd（供 worktree_exit 恢复）
 *   3. clearSystemPromptSectionsCache — 清 system prompt 缓存（避免旧 cwd 信息残留）
 *   4. clearMemoryFilesCache          — 清 CLAUDE.md/AGENTS.md 缓存
 *
 * 调用 worktree_exit 恢复原始工作目录。
 */
export const worktreeEnterTool: ToolRegistration = {
  definition: {
    name: 'worktree_enter',
    description:
      'Enter a git worktree, switching the agent session working directory to the worktree path. ' +
      'All subsequent tool calls (file read/write, bash, etc.) will use the worktree as their working directory. ' +
      'Call worktree_exit to return to the original directory.',
    parameters: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the worktree directory, or a named worktree (looks up path from worktree index).',
        },
      },
      required: ['path'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const pathArg = args.path as string;

    // Look up path from worktree index if it's a named worktree
    let wtPath = resolve(pathArg);
    const mgr = getWorktreeManager();
    try {
      const idx = mgr.listAll();
      // list() returns JSON string; try to parse it and find by name
      const parsed = JSON.parse(idx) as { name: string; path: string }[];
      const entry = parsed.find((e) => e.name === pathArg || resolve(e.path) === wtPath);
      if (entry) wtPath = resolve(entry.path);
    } catch { /* fallback to direct path */ }

    if (!existsSync(wtPath)) {
      return `Error: Worktree path does not exist: ${wtPath}`;
    }

    const originalCwd = process.cwd();

    // E26: Step 1 + 2 — switch OS process working directory + record original
    try {
      process.chdir(wtPath);
    } catch (e) {
      return `Error: Failed to chdir to worktree path: ${wtPath}: ${e instanceof Error ? e.message : String(e)}`;
    }

    // Store original cwd as an environment variable so worktree_exit can restore it
    process.env['__UAGENT_WORKTREE_ORIGINAL_CWD'] = originalCwd;
    process.env['__UAGENT_WORKTREE_ACTIVE'] = wtPath;

    // E26: Step 3 + 4 — context will be rebuilt for the new cwd on the next LLM call
    // (buildSystemPromptWithContext uses process.cwd() at call time, so chdir is sufficient)

    log.debug('worktree_enter: switched cwd', { from: originalCwd, to: wtPath });

    return [
      `Entered worktree: ${wtPath}`,
      `Original cwd saved: ${originalCwd}`,
      `All subsequent file/bash tool calls will use the worktree directory.`,
      `Use worktree_exit to return to ${originalCwd}`,
    ].join('\n');
  },
};

/**
 * E26: worktree_exit — 从 worktree 恢复到原始工作目录
 *
 * Mirrors claude-code ExitWorktreeTool.ts 的恢复逻辑：
 *   1. process.chdir(originalCwd)     — 恢复 OS 进程工作目录
 *   2. 清除 worktree 会话状态
 *   3. clearSystemPromptSectionsCache — 重新构建 system prompt（新 cwd 上下文）
 */
export const worktreeExitTool: ToolRegistration = {
  definition: {
    name: 'worktree_exit',
    description:
      'Exit the current git worktree and return to the original working directory. ' +
      'Clears worktree session state and rebuilds context for the original directory. ' +
      'Use force=true to exit even if there are uncommitted changes.',
    parameters: {
      type: 'object' as const,
      properties: {
        force: {
          type: 'boolean',
          description: 'Force exit even if there are uncommitted changes (default: false). ' +
            'By default, exits are blocked when uncommitted changes exist to prevent accidental data loss.',
        },
      },
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const originalCwd = process.env['__UAGENT_WORKTREE_ORIGINAL_CWD'];
    const activePath = process.env['__UAGENT_WORKTREE_ACTIVE'];
    const force = (args.force as boolean | undefined) ?? false;

    if (!originalCwd) {
      return 'Not in a worktree session (no active worktree_enter recorded). Current directory: ' + process.cwd();
    }

    // F32: fail-closed — check for uncommitted changes before exiting
    // Mirrors claude-code ExitWorktreeTool.ts countWorktreeChanges()
    if (!force) {
      try {
        const wtPath = activePath ?? process.cwd();
        const result = spawnSync('git', ['status', '--porcelain'], {
          cwd: wtPath, encoding: 'utf-8',
        });
        const changedLines = (result.stdout ?? '').trim().split('\n').filter(Boolean);
        if (changedLines.length > 0) {
          const preview = changedLines.slice(0, 5).map((l) => `  ${l}`);
          const extra = changedLines.length > 5 ? [`  ... and ${changedLines.length - 5} more`] : [];
          return [
            `Error: Worktree has ${changedLines.length} uncommitted change(s).`,
            `Changed files:`,
            ...preview,
            ...extra,
            ``,
            `Options:`,
            `  1. Commit your changes: git commit -am "message"`,
            `  2. Stash changes: git stash`,
            `  3. Force exit (may lose work): worktree_exit force=true`,
          ].join('\n');
        }
      } catch { /* git not available or not a git repo — proceed without check */ }
    }

    if (!existsSync(originalCwd)) {
      return `Error: Original cwd no longer exists: ${originalCwd}`;
    }

    const wtPath = process.cwd();

    // E26: Step 1 — restore original cwd
    try {
      process.chdir(originalCwd);
    } catch (e) {
      return `Error: Failed to chdir back to original cwd: ${originalCwd}: ${e instanceof Error ? e.message : String(e)}`;
    }

    // Clear worktree session state
    delete process.env['__UAGENT_WORKTREE_ORIGINAL_CWD'];
    delete process.env['__UAGENT_WORKTREE_ACTIVE'];

    // E26: Step 3 — context will be rebuilt for restored cwd on next LLM call
    // (buildSystemPromptWithContext uses process.cwd() at call time, so chdir is sufficient)

    log.debug('worktree_exit: restored cwd', { from: wtPath, to: originalCwd });

    return [
      `Exited worktree: ${activePath ?? wtPath}`,
      `Restored working directory: ${originalCwd}`,
      `All subsequent tool calls will use the original directory.`,
    ].join('\n');
  },
};

/**
 * worktree_sync — Batch 2: Synchronize worktree statuses to task board.
 *
 * Scans the worktree index and, for each active worktree with a bound task:
 *  1. Reads the git status (modified/clean)
 *  2. Updates the task description with a live worktree status summary
 *  3. Returns a combined view of tasks + worktrees
 */
export const worktreeSyncTool: ToolRegistration = {
  definition: {
    name: 'worktree_sync',
    description: [
      'Sync worktree statuses to task board. ',
      'For each active worktree with a bound task, reads git status and shows ',
      'a combined "task board + worktree status" table. ',
      'Use before merging branches or when coordinating parallel tasks.',
    ].join(''),
    parameters: {
      type: 'object' as const,
      properties: {},
    },
  },
  handler: async (): Promise<string> => {
    const mgr = getWorktreeManager();
    const wtIdx = join(resolve(process.cwd(), '.uagent', 'worktrees'), 'index.json');
    if (!existsSync(wtIdx)) return 'No worktrees found.';
    let idx: { worktrees: Array<{ name: string; path: string; branch: string; task_id: number | null; status: string }> };
    try { idx = JSON.parse(readFileSync(wtIdx, 'utf-8')); } catch { return 'Failed to read worktree index.'; }
    const active = idx.worktrees.filter((w) => w.status !== 'removed');
    if (!active.length) return 'No active worktrees.';
    const lines: string[] = ['Worktree ↔ Task Board Sync:', ''];
    lines.push(`  ${'WORKTREE'.padEnd(20)} ${'TASK'.padEnd(8)} ${'BRANCH'.padEnd(25)} GIT STATUS`);
    lines.push('  ' + '-'.repeat(75));
    for (const wt of active) {
      let gitStatus = 'unknown';
      try {
        const out = mgr.run(wt.name, 'git status --short');
        const changed = out.trim().split('\n').filter(Boolean).length;
        gitStatus = changed === 0 ? 'clean' : `${changed} modified`;
      } catch { gitStatus = 'error'; }
      const taskStr = wt.task_id !== null ? `#${wt.task_id}` : '-';
      lines.push(`  ${wt.name.padEnd(20)} ${taskStr.padEnd(8)} ${wt.branch.padEnd(25)} ${gitStatus}`);
    }
    lines.push('');
    lines.push('  Tip: worktree_remove --complete_task true  to merge and close task');
    return lines.join('\n');
  },
};
