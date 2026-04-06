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

let _caffeinateProc: ChildProcess | null = null;

/**
 * Prevent the system from sleeping during long-running agent tasks.
 * Call startPreventSleep() at task start, stopPreventSleep() at completion.
 *
 * macOS: Spawns `caffeinate -i` (inhibit idle sleep, terminates with process).
 * Linux: Uses `systemd-inhibit` if available.
 * Other platforms: no-op.
 *
 * Idempotent: calling while already active is a no-op.
 */
export function startPreventSleep(): void {
  if (_caffeinateProc !== null) return; // already active

  try {
    if (process.platform === 'darwin') {
      // caffeinate -i: inhibit idle sleep. Killed when parent exits.
      _caffeinateProc = spawn('caffeinate', ['-i'], {
        detached: false,
        stdio: 'ignore',
      });
      // Don't hold the event loop open if caffeinate outlives our process
      _caffeinateProc.unref();
    } else if (process.platform === 'linux') {
      // systemd-inhibit with --mode=block --what=idle for desktop Linux
      _caffeinateProc = spawn(
        'systemd-inhibit',
        ['--mode=block', '--what=idle', '--who=uagent', '--why=agent task running', 'sleep', '86400'],
        { detached: false, stdio: 'ignore' },
      );
      _caffeinateProc.unref();
    }
    // Windows: not implemented — PowerRequest API would require native addon
  } catch {
    // Non-fatal: sleep prevention is best-effort
    _caffeinateProc = null;
  }
}

/**
 * Release the sleep prevention lock.
 * Safe to call even if startPreventSleep() was never called.
 */
export function stopPreventSleep(): void {
  try {
    _caffeinateProc?.kill('SIGTERM');
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
