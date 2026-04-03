/**
 * auto-update.ts — Transparent self-update on startup
 *
 * On every `uagent` invocation:
 *  1. Run `git fetch --quiet` in the repo root (non-blocking network call)
 *  2. Compare local HEAD vs origin/<current-branch>
 *  3. If behind: run `git pull --ff-only --quiet` then `npm run build`
 *  4. Re-exec the updated binary with the same argv (transparent restart)
 *
 * The whole flow is best-effort — any error is silently swallowed so a
 * broken git repo / offline machine never prevents the CLI from starting.
 *
 * Opt-out: set UAGENT_NO_AUTO_UPDATE=1 in .env or environment.
 */

import { execFileSync, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

/** Absolute path to the uagent repo root (two levels up from dist/cli/) */
function findRepoRoot(): string | null {
  try {
    // __dirname equivalent in ESM
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/cli/auto-update.js → up 2 levels → repo root
    const root = resolve(here, '..', '..');
    if (existsSync(resolve(root, 'package.json')) && existsSync(resolve(root, '.git'))) {
      return root;
    }
    return null;
  } catch {
    return null;
  }
}

function run(cmd: string, args: string[], cwd: string): boolean {
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: 'ignore',
    timeout: 15_000,
  });
  return result.status === 0;
}

function getStdout(cmd: string, args: string[], cwd: string): string {
  try {
    return execFileSync(cmd, args, { cwd, timeout: 8_000, encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

export async function checkAndUpdate(): Promise<void> {
  if (process.env.UAGENT_NO_AUTO_UPDATE === '1') return;

  const root = findRepoRoot();
  if (!root) return;

  try {
    // 1. Fetch remote refs (quiet, best-effort)
    const fetched = run('git', ['fetch', '--quiet', '--no-tags'], root);
    if (!fetched) return; // offline or not a git repo — skip silently

    // 2. Get current branch
    const branch = getStdout('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root);
    if (!branch || branch === 'HEAD') return; // detached HEAD — skip

    // 3. Compare local HEAD with remote tracking branch
    const localRef  = getStdout('git', ['rev-parse', 'HEAD'], root);
    const remoteRef = getStdout('git', ['rev-parse', `origin/${branch}`], root);

    if (!localRef || !remoteRef || localRef === remoteRef) return; // up to date

    // 4. Check we're behind (not diverged)
    const mergeBase = getStdout('git', ['merge-base', 'HEAD', `origin/${branch}`], root);
    if (mergeBase !== localRef) return; // diverged — don't auto-update

    // 5. Update!
    process.stdout.write('\n🔄 uagent: new version detected, updating...\n');

    const pulled = run('git', ['pull', '--ff-only', '--quiet'], root);
    if (!pulled) {
      process.stdout.write('⚠️  git pull failed — skipping update.\n\n');
      return;
    }

    process.stdout.write('🔨 Building...\n');
    const built = run('npm', ['run', 'build', '--silent'], root);
    if (!built) {
      process.stdout.write('⚠️  Build failed — using current version.\n\n');
      // Rollback pull so the repo stays consistent
      run('git', ['reset', '--hard', localRef], root);
      return;
    }

    // 6. Re-exec updated binary transparently
    process.stdout.write('✅ Updated! Restarting...\n\n');
    try {
      execFileSync(process.execPath, process.argv.slice(1), {
        stdio: 'inherit',
        env: { ...process.env, UAGENT_NO_AUTO_UPDATE: '1' },
      });
      // execFileSync for the REPL blocks until child exits — then we exit too.
      process.exit(0);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException & { status?: number }).status ?? 1;
      process.exit(code);
    }
  } catch {
    // Any unexpected error — silently ignore, proceed with current version
  }
}
