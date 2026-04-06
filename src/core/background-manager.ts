/**
 * Background Manager — s08-style non-blocking command execution.
 *
 * Spawn long-running commands (npm test, npm run build, etc.) in background
 * child processes. The agent doesn't block — it gets a task_id immediately
 * and can do other work. Results are pushed to a notification queue that is
 * drained and injected into the conversation before the next LLM call.
 *
 *   Main thread              Background process
 *   +-----------------+      +-----------------+
 *   | agent loop      |      | task executes   |
 *   | ...             |      | ...             |
 *   | [LLM call] <----+----- | enqueue(result) |
 *   |  ^drain queue   |      +-----------------+
 *   +-----------------+
 *
 *   Timeline:
 *   Agent ----[spawn A]----[spawn B]----[other work]----
 *                 |              |
 *                 v              v
 *              [A runs]      [B runs]         (parallel)
 *                 |              |
 *                 +-- notification queue --> [results injected]
 *
 * s08 motto: "Fire and forget — the agent doesn't block while the command runs."
 */

import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { resolve } from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export type BgTaskStatus = 'running' | 'completed' | 'timeout' | 'error';

export interface BgTask {
  id: string;
  command: string;
  status: BgTaskStatus;
  result: string | null;
  startedAt: number;
}

export interface BgNotification {
  taskId: string;
  status: BgTaskStatus;
  command: string;
  result: string;
}

// ─── BackgroundManager ────────────────────────────────────────────────────────

export class BackgroundManager {
  private tasks = new Map<string, BgTask>();
  private notificationQueue: BgNotification[] = [];
  /** Map from task_id → child process PID (for kill support) */
  private pids = new Map<string, number>();

  run(command: string, cwd?: string): string {
    const id = randomBytes(4).toString('hex');
    const task: BgTask = {
      id,
      command,
      status: 'running',
      result: null,
      startedAt: Date.now(),
    };
    this.tasks.set(id, task);

    const workdir = resolve(cwd ?? process.cwd());
    const chunks: Buffer[] = [];

    const proc = spawn('sh', ['-c', command], {
      cwd: workdir,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    proc.stdout?.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr?.on('data', (d: Buffer) => chunks.push(d));

    // 5-minute timeout guard
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      this.finalize(id, 'timeout', 'Error: Timeout (300s)');
    }, 300_000);

    if (proc.pid !== undefined) this.pids.set(id, proc.pid);

    proc.on('close', () => {
      clearTimeout(timer);
      if (task.status === 'timeout') return; // already handled
      const output = Buffer.concat(chunks).toString('utf-8').trim().slice(0, 50_000);
      this.finalize(id, 'completed', output || '(no output)');
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      if (task.status !== 'running') return;
      this.finalize(id, 'error', `Error: ${err.message}`);
    });

    return `Background task ${id} started: ${command.slice(0, 80)}`;
  }

  /**
   * Terminate a running background task by id.
   * Sends SIGTERM first; if still alive after 3 s sends SIGKILL.
   * Returns a status message.
   */
  kill(taskId: string): string {
    const task = this.tasks.get(taskId);
    if (!task) return `Error: Unknown task ${taskId}`;
    if (task.status !== 'running') return `Task ${taskId} is already ${task.status} — nothing to kill.`;

    const pid = this.pids.get(taskId);
    if (pid === undefined) return `Error: No PID found for task ${taskId} (may have already exited).`;

    try {
      process.kill(pid, 'SIGTERM');
      // Escalate to SIGKILL after 3 s if still alive
      const sigkillTimer = setTimeout(() => {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
      }, 3000);
      // Unref so the timer does not keep the Node process alive
      if (typeof sigkillTimer.unref === 'function') sigkillTimer.unref();

      this.finalize(taskId, 'error', `Killed by user (SIGTERM sent to PID ${pid})`);
      return `✓ Sent SIGTERM to task ${taskId} (PID ${pid}): ${task.command.slice(0, 80)}`;
    } catch (err) {
      return `Error killing task ${taskId}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private finalize(id: string, status: BgTaskStatus, result: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.status = status;
    task.result = result;
    this.notificationQueue.push({
      taskId: id,
      status,
      command: task.command.slice(0, 80),
      result: result.slice(0, 500),
    });
  }

  check(taskId?: string): string {
    if (taskId) {
      const t = this.tasks.get(taskId);
      if (!t) return `Error: Unknown task ${taskId}`;
      return `[${t.status}] ${t.command.slice(0, 60)}\n${t.result ?? '(running)'}`;
    }
    if (this.tasks.size === 0) return 'No background tasks.';
    return [...this.tasks.entries()]
      .map(([id, t]) => `${id}: [${t.status}] ${t.command.slice(0, 60)}`)
      .join('\n');
  }

  /**
   * Return and clear all pending completion notifications.
   * Called by the agent loop BEFORE each LLM call to inject results.
   */
  drainNotifications(): BgNotification[] {
    const items = [...this.notificationQueue];
    this.notificationQueue = [];
    return items;
  }

  hasPending(): boolean {
    return [...this.tasks.values()].some((t) => t.status === 'running');
  }

  /**
   * G26: registerExistingProcess — adopt an already-spawned child process.
   * Used by Bash auto-background: when a command runs >15s, the bash handler
   * transfers the existing process to the background manager and returns immediately.
   *
   * Mirrors claude-code BashTool.tsx's backgroundFn transfer pattern.
   */
  registerExistingProcess(
    proc: import('child_process').ChildProcess,
    command: string,
    partialOutput: string,
  ): string {
    const id = randomBytes(4).toString('hex');
    const task: BgTask = {
      id,
      command,
      status: 'running',
      result: null,
      startedAt: Date.now(),
    };
    this.tasks.set(id, task);

    if (proc.pid !== undefined) this.pids.set(id, proc.pid);

    // Collect remaining output (process is already running)
    const chunks: Buffer[] = [Buffer.from(partialOutput)];
    proc.stdout?.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr?.on('data', (d: Buffer) => chunks.push(d));

    // 5-minute timeout guard (from registration time)
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* already dead */ }
      this.finalize(id, 'timeout', 'Error: Timeout (300s) after auto-background');
    }, 300_000);

    proc.on('close', () => {
      clearTimeout(timer);
      if (task.status === 'timeout') return;
      const output = Buffer.concat(chunks).toString('utf-8').trim().slice(0, 50_000);
      this.finalize(id, 'completed', output || '(no output)');
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      if (task.status !== 'running') return;
      this.finalize(id, 'error', `Error: ${err.message}`);
    });

    return id;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const backgroundManager = new BackgroundManager();
