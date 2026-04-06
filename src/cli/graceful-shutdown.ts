/**
 * graceful-shutdown.ts -- A24: Complete graceful shutdown handler
 *
 * A24: Mirrors claude-code src/utils/gracefulShutdown.ts L237+L391
 *
 * Improvements over the existing simple SIGINT handler in launch.ts:
 *   - SIGTERM support (exit code 143, standard Unix convention)
 *   - SIGHUP support (exit code 129)
 *   - Failsafe timer: force-exit after timeoutMs if cleanup stalls
 *   - Standardized exit codes (SIGINT=130, SIGTERM=143, SIGHUP=129)
 *   - Idempotent: prevents double-shutdown on multiple signals
 *
 * Usage:
 *   setupGracefulShutdown({
 *     onShutdown: async () => { await saveSnapshot(); await drainIngest(); },
 *     timeoutMs: 5000,
 *   });
 */

type ShutdownCallback = () => Promise<void>;

let _shuttingDown = false;
let _cleanupFn: ShutdownCallback | undefined;

/**
 * A24: setupGracefulShutdown -- register SIGTERM/SIGHUP handlers with failsafe
 *
 * @param opts.onShutdown  Async cleanup function (save snapshots, drain ingest, close loggers, etc.)
 * @param opts.timeoutMs   Max time to wait for cleanup before force-exit (default: 5000ms)
 */
export function setupGracefulShutdown(opts: {
  onShutdown?: ShutdownCallback;
  timeoutMs?: number;
}): void {
  _cleanupFn = opts.onShutdown;
  const FAILSAFE_MS = opts.timeoutMs ?? 5_000;

  function getExitCode(signal: string): number {
    if (signal === 'SIGTERM') return 143;
    if (signal === 'SIGHUP') return 129;
    return 130; // SIGINT default
  }

  async function shutdown(signal: string): Promise<void> {
    if (_shuttingDown) return; // Idempotent: ignore duplicate signals
    _shuttingDown = true;

    process.stderr.write(`\n[graceful] Received ${signal}, shutting down...\n`);

    // Failsafe timer: force-exit if cleanup takes too long
    const timer = setTimeout(() => {
      process.stderr.write(`[graceful] Failsafe timeout (${FAILSAFE_MS}ms) — force exit\n`);
      process.exit(getExitCode(signal));
    }, FAILSAFE_MS);
    // unref() prevents the timer itself from keeping the process alive
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    }

    try {
      await _cleanupFn?.();
    } catch (err) {
      process.stderr.write(`[graceful] Cleanup error: ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      clearTimeout(timer);
    }

    process.exit(getExitCode(signal));
  }

  // Register SIGTERM (Kubernetes, systemd, Docker stop)
  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch(() => process.exit(143));
  });

  // Register SIGHUP (terminal hangup, nohup)
  process.on('SIGHUP', () => {
    shutdown('SIGHUP').catch(() => process.exit(129));
  });
}

/**
 * A24: markShuttingDown -- check if graceful shutdown has been initiated
 * Used to prevent new work from starting during shutdown sequence.
 */
export function isShuttingDown(): boolean {
  return _shuttingDown;
}
