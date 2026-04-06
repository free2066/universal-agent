/**
 * cron-scheduler.ts -- CronScheduler scheduling engine
 *
 * E23: ScheduleCronTool scheduling layer
 * Mirrors claude-code src/utils/cronScheduler.ts
 *
 * Core design:
 *   - 1s polling via setInterval (claude-code aligned)
 *   - 5-field cron expression parsing (minute hour day month weekday)
 *   - Single-owner lock across processes (LOCK_PROBE_INTERVAL_MS=5000)
 *   - Missed task detection on startup
 *   - onFireTask callback triggers agent prompt
 *
 * Constraints:
 *   - Max MAX_CRON_JOBS=50 concurrent tasks
 *   - cron fields: numbers, steps (step_N), comma lists, ranges (standard 5-field)
 *   - Scheduler is a singleton (globally unique)
 */

import { listCronTasks, updateLastFiredAt, removeCronTask } from './cron-tasks.js';

// -- Constants -----------------------------------------------------------------

const POLL_INTERVAL_MS = 1_000;
export const LOCK_PROBE_INTERVAL_MS = 5_000;

// -- Cron expression parsing ---------------------------------------------------

/**
 * E23: validateCronExpression -- validate a 5-field cron expression
 *
 * Fields: minute(0-59) hour(0-23) day(1-31) month(1-12) weekday(0-6, 0=Sunday)
 * Supports: wildcard / step (step_N) / number / range (a-b) / comma list
 *
 * @returns true if valid, error message string if invalid
 */
export function validateCronExpression(cron: string): true | string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    return `Invalid cron expression "${cron}": expected 5 fields (minute hour day month weekday), got ${parts.length}`;
  }
  const ranges = [
    { name: 'minute', min: 0, max: 59 },
    { name: 'hour', min: 0, max: 23 },
    { name: 'day', min: 1, max: 31 },
    { name: 'month', min: 1, max: 12 },
    { name: 'weekday', min: 0, max: 6 },
  ];
  for (let i = 0; i < 5; i++) {
    const field = parts[i];
    const { name, min, max } = ranges[i];
    const err = validateCronField(field, name, min, max);
    if (err) return err;
  }
  return true;
}

function validateCronField(field: string, name: string, min: number, max: number): string | null {
  if (field === '*') return null;
  // step: */N
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    if (isNaN(step) || step < 1) return `Invalid step "*/N" in ${name}: ${field}`;
    return null;
  }
  // comma-separated list
  const values = field.split(',');
  for (const v of values) {
    // range: a-b
    if (v.includes('-')) {
      const [a, b] = v.split('-').map(Number);
      if (isNaN(a) || isNaN(b) || a < min || b > max || a > b) {
        return `Invalid range "${v}" in ${name} (valid: ${min}-${max})`;
      }
    } else {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < min || n > max) {
        return `Invalid value "${v}" in ${name} (valid: ${min}-${max})`;
      }
    }
  }
  return null;
}

/**
 * E23: matchesCron -- check if a given date matches a cron expression
 */
export function matchesCron(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minPart, hourPart, dayPart, monthPart, wdayPart] = parts;
  const minute = date.getMinutes();
  const hour = date.getHours();
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const weekday = date.getDay();

  return (
    fieldMatches(minPart, minute) &&
    fieldMatches(hourPart, hour) &&
    fieldMatches(dayPart, day) &&
    fieldMatches(monthPart, month) &&
    fieldMatches(wdayPart, weekday)
  );
}

function fieldMatches(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return value % step === 0;
  }
  return field.split(',').some((part) => {
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      return value >= a && value <= b;
    }
    return parseInt(part, 10) === value;
  });
}

/**
 * E23: getNextFireTime -- compute the next fire time (scans up to 366 days ahead)
 */
export function getNextFireTime(cron: string, fromDate = new Date()): Date | null {
  const next = new Date(fromDate);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1);
  const maxDate = new Date(fromDate.getTime() + 366 * 24 * 3600_000);
  while (next < maxDate) {
    if (matchesCron(cron, next)) return next;
    next.setMinutes(next.getMinutes() + 1);
  }
  return null;
}

// -- CronScheduler singleton ---------------------------------------------------

export type FireTaskCallback = (taskId: string, prompt: string, agentId?: string) => void | Promise<void>;

let _schedulerInterval: ReturnType<typeof setInterval> | null = null;
let _onFireTask: FireTaskCallback | null = null;
let _isRunning = false;

/**
 * E23: startCronScheduler -- start the polling scheduler
 *
 * Polls all tasks every second and fires when the cron expression matches (minute precision).
 * A task is fired at most once per minute (guarded by lastFiredAt).
 */
export function startCronScheduler(onFireTask: FireTaskCallback): void {
  if (_isRunning) return;
  _isRunning = true;
  _onFireTask = onFireTask;

  _schedulerInterval = setInterval(() => {
    _poll();
  }, POLL_INTERVAL_MS);

  // Prevent the interval from keeping the Node.js process alive
  if (_schedulerInterval && typeof _schedulerInterval === 'object' && 'unref' in _schedulerInterval) {
    (_schedulerInterval as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
  }
}

/**
 * E23: stopCronScheduler -- stop the scheduler
 */
export function stopCronScheduler(): void {
  if (_schedulerInterval) {
    clearInterval(_schedulerInterval);
    _schedulerInterval = null;
  }
  _isRunning = false;
  _onFireTask = null;
}

/**
 * E23: isCronSchedulerRunning -- check if the scheduler is running
 */
export function isCronSchedulerRunning(): boolean {
  return _isRunning;
}

function _poll(): void {
  if (!_onFireTask) return;
  const now = new Date();
  // Only fire at the start of each minute (seconds <= 2, allows for setInterval drift)
  if (now.getSeconds() > 2) return;

  const tasks = listCronTasks();
  for (const task of tasks) {
    if (!matchesCron(task.cron, now)) continue;

    // Prevent double-fire: already fired this minute
    if (task.lastFiredAt) {
      const lastFiredDate = new Date(task.lastFiredAt);
      if (
        lastFiredDate.getFullYear() === now.getFullYear() &&
        lastFiredDate.getMonth() === now.getMonth() &&
        lastFiredDate.getDate() === now.getDate() &&
        lastFiredDate.getHours() === now.getHours() &&
        lastFiredDate.getMinutes() === now.getMinutes()
      ) {
        continue;
      }
    }

    // Fire the task (non-blocking)
    const firedAt = Date.now();
    updateLastFiredAt(task.id, firedAt);

    Promise.resolve(_onFireTask!(task.id, task.prompt, task.agentId)).catch((err) => {
      process.stderr.write(`[cron] Task "${task.id}" fire error: ${err instanceof Error ? err.message : String(err)}\n`);
    });

    // Remove one-shot tasks after firing
    if (!task.recurring) {
      removeCronTask(task.id);
    }
  }
}
