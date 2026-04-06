/**
 * shell-provider.ts — Shell detection and subprocess environment helpers
 *
 * Round 10 (C10): claude-code Shell.ts parity
 *   - findSuitableShell(): AGENT_SHELL env → settings.defaultShell → $SHELL → auto-detect zsh/bash
 *   - buildSubprocessEnv(): merge process.env + user-configured env settings
 *
 * Round 11 (B11): Security + correctness fixes (claude-code Shell.ts L50-67 parity)
 *   - isExecutable(): use fs.accessSync(X_OK) instead of `test -x` shell subprocess
 *   - which(): use execFileSync('/usr/bin/which', [name]) instead of `which name` via shell
 *     Eliminates shell injection risk and PATH-pollution attack surface.
 */
import { accessSync, constants as fsConstants } from 'fs';
import { execFileSync } from 'child_process';

const SAFE_SHELLS = new Set(['/bin/bash', '/usr/bin/bash', '/bin/zsh', '/usr/bin/zsh', '/bin/sh']);

/**
 * Check if a path is executable.
 * Uses fs.accessSync(X_OK) — no shell subprocess, no injection risk.
 * Falls back to execFileSync(path, ['--version']) for environments where X_OK check is unreliable
 * (e.g. Nix, some container environments).
 * Mirrors claude-code Shell.ts isExecutable() implementation.
 */
function isExecutable(shellPath: string): boolean {
  try {
    accessSync(shellPath, fsConstants.X_OK);
    return true;
  } catch {
    // Fallback: try to execute the shell with --version (quick, no side effects)
    // Use execFileSync to avoid any shell interpretation — direct syscall path.
    try {
      execFileSync(shellPath, ['--version'], { timeout: 1000, stdio: 'ignore' });
      return true;
    } catch { return false; }
  }
}

/**
 * Find the path of a command using /usr/bin/which (no shell invocation).
 * Mirrors claude-code's which() which uses Bun.which or direct execFileSync.
 * Using execFileSync with explicit /usr/bin/which path prevents PATH hijacking.
 */
function which(name: string): string | null {
  try {
    // Use execFileSync — NOT execSync — to avoid shell interpretation.
    // Explicit /usr/bin/which path avoids PATH-based which substitution attacks.
    const result = execFileSync('/usr/bin/which', [name], {
      encoding: 'utf-8',
      timeout: 2000,
    }).trim();
    return result || null;
  } catch { return null; }
}

let _cachedShell: string | null = null;

/**
 * Find the most suitable shell for executing commands.
 * Priority: AGENT_SHELL env → settings.defaultShell → $SHELL → zsh → bash → /bin/sh
 *
 * Result is cached for the process lifetime (resetShellCache() to invalidate).
 */
export function findSuitableShell(): string {
  if (_cachedShell) return _cachedShell;

  // 1. Explicit env override (e.g. CI, container, test harness)
  const envOverride = process.env.AGENT_SHELL;
  if (envOverride && isExecutable(envOverride)) {
    _cachedShell = envOverride;
    return _cachedShell;
  }

  // 2. User-configured defaultShell (from .uagent/settings.json)
  try {
    // Dynamic require to avoid circular dependency with permission-manager
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pm = require('../core/agent/permission-manager') as { getUserSetting: (k: string) => string | undefined };
    const configShell = pm.getUserSetting('defaultShell');
    if (configShell && isExecutable(configShell)) {
      _cachedShell = configShell;
      return _cachedShell;
    }
  } catch { /* settings not available yet — continue to fallback chain */ }

  // 3. $SHELL environment variable (only bash/zsh accepted for security)
  const envShell = process.env.SHELL;
  if (envShell && (SAFE_SHELLS.has(envShell) || envShell.endsWith('bash') || envShell.endsWith('zsh'))) {
    if (isExecutable(envShell)) {
      _cachedShell = envShell;
      return _cachedShell;
    }
  }

  // 4. Auto-detect: prefer zsh (macOS default), then bash
  const zsh = which('zsh');
  if (zsh && isExecutable(zsh)) { _cachedShell = zsh; return _cachedShell; }

  const bash = which('bash');
  if (bash && isExecutable(bash)) { _cachedShell = bash; return _cachedShell; }

  // 5. Last resort: POSIX /bin/sh
  _cachedShell = '/bin/sh';
  return _cachedShell;
}

export function resetShellCache(): void {
  _cachedShell = null;
}

/**
 * Build subprocess env: merge process.env + user-configured env vars (all 3 settings layers).
 * User env vars (local > project > user priority) are layered on top of system env.
 * Mirrors claude-code's subprocessEnv() pattern.
 */
export function buildSubprocessEnv(): NodeJS.ProcessEnv {
  try {
    // Dynamic require to avoid circular dependency
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pm = require('../core/agent/permission-manager') as { getMergedEnv: () => Record<string, string> };
    const userEnv = pm.getMergedEnv();
    return { ...process.env, ...userEnv } as NodeJS.ProcessEnv;
  } catch {
    return { ...process.env } as NodeJS.ProcessEnv;
  }
}
