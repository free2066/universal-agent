/**
 * shell-provider.ts — Shell detection and subprocess environment helpers
 *
 * Round 10 (C10): claude-code Shell.ts parity
 *   - findSuitableShell(): AGENT_SHELL → settings.defaultShell → $SHELL → auto-detect zsh/bash
 *   - buildSubprocessEnv(): merge process.env + user-configured env settings
 */
import { execSync } from 'child_process';

const SAFE_SHELLS = new Set(['/bin/bash', '/usr/bin/bash', '/bin/zsh', '/usr/bin/zsh', '/bin/sh']);

function isExecutable(path: string): boolean {
  try {
    execSync(`test -x ${JSON.stringify(path)}`, { stdio: 'ignore', timeout: 1000 });
    return true;
  } catch { return false; }
}

function which(name: string): string | null {
  try {
    const result = execSync(`which ${JSON.stringify(name)} 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return result || null;
  } catch { return null; }
}

let _cachedShell: string | null = null;

/**
 * Find the most suitable shell for executing commands.
 * Priority: AGENT_SHELL env → settings.defaultShell → $SHELL → zsh → bash → /bin/sh
 */
export function findSuitableShell(): string {
  if (_cachedShell) return _cachedShell;

  const envOverride = process.env.AGENT_SHELL;
  if (envOverride && isExecutable(envOverride)) {
    _cachedShell = envOverride;
    return _cachedShell;
  }

  try {
    // Dynamic require to avoid circular dependency
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pm = require('../core/agent/permission-manager') as { getUserSetting: (k: string) => string | undefined };
    const configShell = pm.getUserSetting('defaultShell');
    if (configShell && isExecutable(configShell)) {
      _cachedShell = configShell;
      return _cachedShell;
    }
  } catch { /* settings not available yet */ }

  const envShell = process.env.SHELL;
  if (envShell && (SAFE_SHELLS.has(envShell) || envShell.endsWith('bash') || envShell.endsWith('zsh'))) {
    if (isExecutable(envShell)) {
      _cachedShell = envShell;
      return _cachedShell;
    }
  }

  const zsh = which('zsh');
  if (zsh) { _cachedShell = zsh; return _cachedShell; }

  const bash = which('bash');
  if (bash) { _cachedShell = bash; return _cachedShell; }

  _cachedShell = '/bin/sh';
  return _cachedShell;
}

export function resetShellCache(): void {
  _cachedShell = null;
}

/**
 * Build subprocess env: process.env + user-configured env vars.
 */
export function buildSubprocessEnv(): NodeJS.ProcessEnv {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pm = require('../core/agent/permission-manager') as { getMergedEnv: () => Record<string, string> };
    const userEnv = pm.getMergedEnv();
    return { ...process.env, ...userEnv } as NodeJS.ProcessEnv;
  } catch {
    return { ...process.env } as NodeJS.ProcessEnv;
  }
}
