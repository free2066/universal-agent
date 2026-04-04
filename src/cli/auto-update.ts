/**
 * auto-update.ts — Check for upstream git updates, install deps, rebuild, restart.
 *
 * On every `uagent` startup:
 *  1. Run `git fetch --quiet` to check for new commits (best-effort, 8s timeout)
 *  2. Compare local HEAD vs origin/<current-branch>
 *  3. If behind AND fast-forward is possible:
 *     a. git pull --ff-only
 *     b. npm install        ← installs any new/updated npm dependencies from package.json
 *                             This is the key step that keeps npm package versions current:
 *                             when package.json is bumped upstream (e.g. @anthropic-ai/sdk
 *                             from ^0.82.0 to ^0.83.0), `npm install` downloads the new
 *                             version so the build uses the latest SDK.
 *     c. npm run build
 *     d. Print restart banner (user restarts at their own pace)
 *
 * Any error (offline, diverged, install/build failure) is silently ignored so
 * the CLI always starts normally.
 *
 * Opt-out: UAGENT_NO_AUTO_UPDATE=1
 *         or set `autoUpdate: false` in ~/.codeflicker/config.json / .codeflicker/config.json
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
 * Check for upstream updates.  If new commits are available and can be fast-forwarded:
 *   1. git pull
 *   2. npm install   (updates npm dependencies per the new package.json)
 *   3. npm run build
 *
 * Returns true if an update was applied (caller should show the restart banner).
 * Returns false if already up-to-date or any step failed.
 */
export async function checkAndUpdate(): Promise<boolean> {
  // Opt-out via config file: autoUpdate: false
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadConfig } = require('./config-store.js') as typeof import('./config-store.js');
    if (loadConfig().autoUpdate === false) return false;
  } catch { /* config-store not built yet — fall through */ }

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

    // 4. Only fast-forward (don't touch diverged branches)
    const mergeBase = getStdout('git', ['merge-base', 'HEAD', `origin/${branch}`], root);
    if (mergeBase !== localRef) return false;

    // 5. Pull
    process.stdout.write('🔄 New version available — updating...\n');
    const pulled = run('git', ['pull', '--ff-only', '--quiet'], root, 15_000);
    if (!pulled) {
      process.stdout.write('⚠️  git pull failed — continuing with current version.\n\n');
      return false;
    }

    // 6. Install dependencies
    //    When package.json is updated upstream (e.g. @anthropic-ai/sdk bumped
    //    from ^0.82.0 to ^0.83.0), npm install will pull the new package into
    //    node_modules.  Without this step the old version stays installed even
    //    after git pull, and the build would use the stale package.
    process.stdout.write('📦 Installing dependencies...\n');
    const installed = run('npm', ['install', '--silent'], root, 120_000);
    if (!installed) {
      process.stdout.write('⚠️  npm install failed — rolling back.\n\n');
      run('git', ['reset', '--hard', localRef], root);
      return false;
    }

    // 7. Rebuild with new deps
    process.stdout.write('🔨 Building new version...\n');
    const built = run('npm', ['run', 'build', '--silent'], root, 60_000);
    if (!built) {
      process.stdout.write('⚠️  Build failed — rolling back.\n\n');
      run('git', ['reset', '--hard', localRef], root);
      return false;
    }

    // Done — tell the caller to show the "please restart" banner
    return true;
  } catch (err) {
    process.stderr.write(`[auto-update] Update failed unexpectedly: ${String(err)}\n`);
    return false;
  }
}

/** Print the "please restart" banner. Called by index.ts after startup output. */
export function printUpdateBanner(): void {
  const line = '─'.repeat(50);
  process.stdout.write(`\n${line}\n`);
  process.stdout.write('✅  uagent updated! Please restart to use the new version.\n');
  process.stdout.write(`   Run: uagent\n`);
  process.stdout.write(`${line}\n\n`);
}
