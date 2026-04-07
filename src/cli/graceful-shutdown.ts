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
// 跟踪已注册的 handler 引用，防止多次调用 setupGracefulShutdown 时累积 listener
let _handlersRegistered = false;

export function setupGracefulShutdown(opts: {
  onShutdown?: ShutdownCallback;
  timeoutMs?: number;
}): void {
  _cleanupFn = opts.onShutdown;
  const FAILSAFE_MS = opts.timeoutMs ?? 5_000;

  // 避免重复注册
  if (_handlersRegistered) return;
  _handlersRegistered = true;

  function getExitCode(signal: string): number {
    if (signal === 'SIGTERM') return 143;
    if (signal === 'SIGHUP') return 129;
    return 130;
  }

  async function shutdown(signal: string): Promise<void> {
    if (_shuttingDown) return;
    _shuttingDown = true;

    process.stderr.write(`\n[graceful] Received ${signal}, shutting down...\n`);

    const timer = setTimeout(() => {
      process.stderr.write(`[graceful] Failsafe timeout (${FAILSAFE_MS}ms) — force exit\n`);
      process.exit(getExitCode(signal));
    }, FAILSAFE_MS);
    (timer as unknown as { unref?: () => void }).unref?.();

    try {
      await _cleanupFn?.();
    } catch (err) {
      process.stderr.write(`[graceful] Cleanup error: ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      clearTimeout(timer);
      // 等待当前 event loop 中的微任务完成（drain promises）
      await new Promise<void>((r) => setImmediate(r));
    }

    process.exit(getExitCode(signal));
  }

  process.on('SIGTERM', () => { void shutdown('SIGTERM').catch(() => process.exit(143)); });
  process.on('SIGHUP',  () => { void shutdown('SIGHUP').catch(() => process.exit(129)); });
}

/**
 * A24: markShuttingDown -- check if graceful shutdown has been initiated
 * Used to prevent new work from starting during shutdown sequence.
 */
export function isShuttingDown(): boolean {
  return _shuttingDown;
}
