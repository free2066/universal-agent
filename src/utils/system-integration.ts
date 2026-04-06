/**
 * system-integration.ts — OS-level system integration utilities
 *
 * Round 12 (H12): claude-code preventSleep.ts + notifier.ts parity
 *   - preventSleep: Prevents system sleep during long agent tasks
 *     macOS: caffeinate -i (inhibit idle sleep)
 *     Linux: systemd-inhibit (if available), otherwise no-op
 *     Windows: not implemented (no-op)
 *   - notifier: Send OS native notifications when agent tasks complete
 *     macOS: osascript AppleScript
 *     Linux: notify-send (if available)
 *     Windows: not implemented (no-op)
 */

import { spawn, execFileSync } from 'child_process';
import type { ChildProcess } from 'child_process';

// ── preventSleep ─────────────────────────────────────────────────────────────

/**
 * C26: preventSleep — refCount + 4分钟自动重启 + SIGKILL 自愈
 * Mirrors claude-code src/services/preventSleep.ts L27-92.
 *
 * - refCount: 多任务并发时 stop 不会提前终止 caffeinate
 * - 4分钟自动重启: 在 caffeinate 5分钟超时前重启进程（SIGKILL 自愈）
 * - caffeinate -t 300: 即使 Node 被 SIGKILL，孤儿进程也会在 300s 后自动退出
 */

let _caffeinateProc: ChildProcess | null = null;
let _refCount = 0;
let _restartInterval: ReturnType<typeof setInterval> | null = null;

const RESTART_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes (caffeinate -t 300 = 5 min)
const SLEEP_TIMEOUT_SEC = 300;              // caffeinate -t 300: SIGKILL auto-heal

function _spawnCaffeinate(): void {
  try {
    if (process.platform === 'darwin') {
      _caffeinateProc = spawn('caffeinate', ['-i', '-t', String(SLEEP_TIMEOUT_SEC)], {
        detached: false,
        stdio: 'ignore',
      });
      _caffeinateProc.unref(); // 不阻止 Node 进程退出
    } else if (process.platform === 'linux') {
      // systemd-inhibit with sleep 86400 (24h), terminated by stopPreventSleep
      _caffeinateProc = spawn(
        'systemd-inhibit',
        ['--mode=block', '--what=idle', '--who=uagent', '--why=agent task running', 'sleep', '86400'],
        { detached: false, stdio: 'ignore' },
      );
      _caffeinateProc.unref();
    }
    // Windows: not implemented — PowerRequest API would require native addon
  } catch {
    _caffeinateProc = null;
  }
}

/**
 * Prevent the system from sleeping during long-running agent tasks.
 *
 * C26: Uses refCount to support concurrent tasks. Safe to call multiple times.
 * Each call increments refCount; caffeinate only starts on 0→1 transition.
 *
 * macOS: caffeinate -i -t 300 (inhibit idle sleep, 5-min SIGKILL self-heal)
 * Linux: systemd-inhibit (if available)
 * Other platforms: no-op.
 */
export function startPreventSleep(): void {
  _refCount++;
  if (_refCount > 1) return; // 已在运行，增加引用计数即可

  _spawnCaffeinate();

  // C26: 4分钟自动重启 — 在 caffeinate 5分钟超时前重启，确保连续防休眠
  _restartInterval = setInterval(() => {
    if (_caffeinateProc) {
      try { _caffeinateProc.kill('SIGKILL'); } catch { /* ignore */ }
      _caffeinateProc = null;
    }
    _spawnCaffeinate();
  }, RESTART_INTERVAL_MS);
  _restartInterval.unref(); // 不阻止 Node 进程退出
}

/**
 * Release the sleep prevention lock.
 *
 * C26: Decrements refCount; only terminates caffeinate when refCount reaches 0.
 * Safe to call even if startPreventSleep() was never called.
 */
export function stopPreventSleep(): void {
  _refCount = Math.max(0, _refCount - 1);
  if (_refCount > 0) return; // 还有其他任务在使用，不终止

  if (_restartInterval !== null) {
    clearInterval(_restartInterval);
    _restartInterval = null;
  }
  try {
    _caffeinateProc?.kill('SIGKILL');
  } catch { /* non-fatal */ }
  _caffeinateProc = null;
}

// ── notifier ─────────────────────────────────────────────────────────────────

/**
 * Send a native OS notification.
 * Mirrors claude-code's notifier.ts notification dispatch.
 *
 * macOS: Uses `osascript` to display a notification via AppleScript.
 * Linux: Uses `notify-send` if available.
 * Other platforms: no-op (silently skipped).
 *
 * @param title   Notification title (app name / task type)
 * @param body    Notification body text
 * @param timeout Timeout in ms (default 3000). Notifications are fire-and-forget.
 */
export function sendNotification(title: string, body: string, timeout = 3000): void {
  // Sanitize inputs to prevent AppleScript/shell injection
  const safeTitle = title.replace(/["\\\n]/g, ' ').slice(0, 100);
  const safeBody = body.replace(/["\\\n]/g, ' ').slice(0, 200);

  try {
    if (process.platform === 'darwin') {
      execFileSync(
        'osascript',
        ['-e', `display notification "${safeBody}" with title "${safeTitle}"`],
        { timeout, stdio: 'ignore' },
      );
    } else if (process.platform === 'linux') {
      execFileSync(
        'notify-send',
        ['--expire-time=5000', safeTitle, safeBody],
        { timeout, stdio: 'ignore' },
      );
    }
    // Windows: not implemented (PowerShell toast requires native module)
  } catch {
    // Non-fatal: notifications are best-effort UX enhancement
  }
}

/**
 * Convenience: notify that a long agent task has completed.
 * Automatically stops sleep prevention after notification.
 *
 * @param taskSummary  Brief summary of what was completed (e.g. "Wrote 5 files")
 */
export function notifyTaskComplete(taskSummary: string): void {
  stopPreventSleep();
  sendNotification('Agent Task Complete', taskSummary);
}
