/**
 * auto-update.ts — Check for updates and notify user
 *
 * On every `uagent` startup:
 *  1. Run `git fetch --quiet` to check for new commits (best-effort, 8s timeout)
 *  2. Compare local HEAD vs origin/<current-branch>
 *  3. If behind AND fast-forward is possible:
 *     a. git pull --ff-only
 *     b. npm run build
 *     c. Print a banner: "✅ Updated to vX! Please restart uagent."
 *     (We do NOT auto-restart — user restarts at their own pace)
 *
 * Any error (offline, diverged, build failure) is silently ignored so the
 * CLI always starts normally.
 *
 * Opt-out: UAGENT_NO_AUTO_UPDATE=1
 */

import { execFileSync, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

/** Absolute path to the uagent repo root (two levels up from dist/cli/) */
function findRepoRoot(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/cli/auto-update.js  →  up 2  →  repo root
    const root = resolve(here, '..', '..');
    if (existsSync(resolve(root, 'package.json')) && existsSync(resolve(root, '.git'))) {
      return root;
    }
    return null;
  } catch {
    return null;
  }
}

function run(cmd: string, args: string[], cwd: string, timeoutMs = 30_000): boolean {
  const r = spawnSync(cmd, args, { cwd, stdio: 'ignore', timeout: timeoutMs });
  return r.status === 0;
}

function getStdout(cmd: string, args: string[], cwd: string, timeoutMs = 8_000): string {
  try {
    return execFileSync(cmd, args, { cwd, timeout: timeoutMs, encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

/**
 * Check for upstream updates, pull + rebuild if available, then print a
 * restart-prompt.  Returns true if an update was applied (so caller can
 * show the banner after other startup output).
 */
export async function checkAndUpdate(): Promise<boolean> {
  if (process.env.UAGENT_NO_AUTO_UPDATE === '1') return false;

  const root = findRepoRoot();
  if (!root) return false;

  try {
    // 1. Fetch — silent, best-effort
    const fetched = run('git', ['fetch', '--quiet', '--no-tags'], root, 8_000);
    if (!fetched) return false;   // offline — skip

    // 2. Current branch
    const branch = getStdout('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root);
    if (!branch || branch === 'HEAD') return false;

    // 3. Compare refs
    const localRef  = getStdout('git', ['rev-parse', 'HEAD'], root);
    const remoteRef = getStdout('git', ['rev-parse', `origin/${branch}`], root);
    if (!localRef || !remoteRef || localRef === remoteRef) return false;   // up-to-date

    // 4. Only fast-forward
    const mergeBase = getStdout('git', ['merge-base', 'HEAD', `origin/${branch}`], root);
    if (mergeBase !== localRef) return false;   // diverged — skip

    // 5. Pull
    process.stdout.write('🔄 New version available — updating...\n');
    const pulled = run('git', ['pull', '--ff-only', '--quiet'], root, 15_000);
    if (!pulled) {
      process.stdout.write('⚠️  git pull failed — continuing with current version.\n\n');
      return false;
    }

    // 6. Rebuild
    process.stdout.write('🔨 Building new version...\n');
    const built = run('npm', ['run', 'build', '--silent'], root, 60_000);
    if (!built) {
      process.stdout.write('⚠️  Build failed — rolling back.\n\n');
      run('git', ['reset', '--hard', localRef], root);
      return false;
    }

    // 7. Done — let caller print the restart banner after other startup output
    return true;
  } catch {
    return false;
  }
}

/** Print the "please restart" banner. Call after all other startup output. */
export function printUpdateBanner(): void {
  const line = '─'.repeat(50);
  process.stdout.write(`\n${line}\n`);
  process.stdout.write('✅  uagent updated! Please restart to use the new version.\n');
  process.stdout.write(`   Run: uagent\n`);
  process.stdout.write(`${line}\n\n`);
}
