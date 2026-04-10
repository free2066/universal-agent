// @ts-nocheck
/**
 * R2: Git-based file snapshot / revert system.
 *
 * Inspired by opencode's snapshot/index.ts — uses an isolated bare-like git
 * repo (separate --git-dir, real --work-tree) so project snapshots never
 * pollute the user's own git history.
 *
 * Storage layout:
 *   ~/.uagent/snapshots/<projectId>/   ← git directory (bare-like)
 *
 * Key operations:
 *   init()      — initialise the git dir if it doesn't exist yet
 *   track()     — stage all files + write-tree → returns tree hash
 *   restore(h)  — restore entire work-tree to a previously tracked hash
 *   revert(f,h) — restore specific files from hash (selective undo)
 *   diff(h)     — show text diff between hash and current state
 *   cleanup()   — gc prune objects older than 7 days
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import os from 'os'

const execAsync = promisify(exec)

/** Maximum file size tracked by snapshots (2 MB — same as opencode) */
const MAX_FILE_SIZE = 2 * 1024 * 1024

/**
 * One entry in the revert list: which files to restore and from which hash.
 */
export interface RevertPatch {
  hash: string
  files: string[]
}

/**
 * G5: Snapshot patch info — which files are contained in a given tree hash.
 * Mirrors opencode's Snapshot.Patch type.
 */
export interface SnapshotPatch {
  hash: string
  files: string[]
}

/**
 * G1: Per-file diff information returned by diffFull().
 * Mirrors opencode's Snapshot.FileDiff type.
 */
export interface FileDiff {
  file: string
  patch: string
  additions: number
  deletions: number
  status: 'added' | 'deleted' | 'modified'
}

export class SnapshotService {
  /** Absolute path to the isolated git directory */
  readonly gitDir: string
  /** Absolute path to the project working directory */
  readonly workTree: string

  private _initialised = false
  // Protect concurrent git operations within the same process
  private _lock: Promise<void> = Promise.resolve()

  constructor(workTree: string) {
    this.workTree = path.resolve(workTree)
    const projectId = crypto
      .createHash('sha256')
      .update(this.workTree)
      .digest('hex')
      .slice(0, 16)
    this.gitDir = path.join(os.homedir(), '.uagent', 'snapshots', projectId)
  }

  // ──────────────────────────────────────────────────────────
  //  Private helpers
  // ──────────────────────────────────────────────────────────

  private async _run(cmd: string): Promise<string> {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    const { stdout } = await execAsync(cmd, { env, cwd: this.workTree })
    return stdout.trim()
  }

  /** Build the git flag pair used in every command */
  private _gitFlags(): string {
    return `--git-dir="${this.gitDir}" --work-tree="${this.workTree}"`
  }

  private _git(subCmd: string): string {
    return `git ${this._gitFlags()} ${subCmd}`
  }

  /** Acquire a serial lock so concurrent calls don't corrupt the index */
  private _withLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = this._lock
    let resolve!: () => void
    this._lock = new Promise<void>(r => (resolve = r))
    return release.then(() => fn().finally(resolve))
  }

  // ──────────────────────────────────────────────────────────
  //  Public API
  // ──────────────────────────────────────────────────────────

  /**
   * Initialise the isolated git directory if it doesn't exist yet.
   * Safe to call multiple times — idempotent.
   */
  async init(): Promise<void> {
    if (this._initialised) return
    fs.mkdirSync(this.gitDir, { recursive: true })
    try {
      // Check if already a git dir
      await this._run(`git --git-dir="${this.gitDir}" rev-parse --git-dir`)
    } catch {
      // Not yet initialised — do it now
      await this._run(`git init --bare "${this.gitDir}"`)
    }
    // Configure for speed & cross-platform safety
    const cfg = this._git('config')
    await Promise.all([
      this._run(`${cfg} core.autocrlf false`),
      this._run(`${cfg} core.longpaths true`),
      this._run(`${cfg} core.symlinks true`),
      this._run(`${cfg} core.fsmonitor false`),
    ])
    this._initialised = true
  }

  /**
   * Stage the current work-tree and write a tree object.
   * Returns the tree hash, which can later be passed to restore() / diff().
   * Files > 2 MB are excluded automatically.
   */
  async track(): Promise<string | null> {
    return this._withLock(async () => {
      await this.init()

      // Write size-based exclusions to info/exclude
      await this._updateExclusions()

      try {
        // Stage everything
        await this._run(this._git('add --sparse .'))
        // Write tree object → returns hash
        const hash = await this._run(this._git('write-tree'))
        return hash || null
      } catch (err) {
        // Non-fatal: snapshot failure should never break the tool
        console.error('[snapshot] track() failed:', err)
        return null
      }
    })
  }

  /**
   * Restore the entire work-tree to a previously tracked tree hash.
   * Overwrites all tracked files.
   */
  async restore(hash: string): Promise<void> {
    return this._withLock(async () => {
      await this.init()
      await this._run(this._git(`read-tree "${hash}"`))
      await this._run(this._git('checkout-index -a -f'))
    })
  }

  /**
   * Selectively revert specific files to their state at a given hash.
   * Files that didn't exist at the hash are deleted.
   */
  async revert(patches: RevertPatch[]): Promise<void> {
    return this._withLock(async () => {
      await this.init()
      for (const { hash, files } of patches) {
        for (const file of files) {
          try {
            // Check if file existed at that hash
            const rel = path.relative(this.workTree, path.resolve(this.workTree, file))
            const lsOut = await this._run(
              this._git(`ls-tree --name-only "${hash}" -- "${rel}"`),
            )
            if (lsOut.trim()) {
              // File existed — restore it
              await this._run(this._git(`checkout "${hash}" -- "${rel}"`))
            } else {
              // File didn't exist at hash — delete it
              const abs = path.join(this.workTree, rel)
              if (fs.existsSync(abs)) fs.unlinkSync(abs)
            }
          } catch {
            // Non-fatal per file
          }
        }
      }
    })
  }

  /**
   * Return a unified diff between a tracked hash and the current work-tree state.
   */
  async diff(fromHash: string): Promise<string> {
    return this._withLock(async () => {
      await this.init()
      try {
        await this._run(this._git(`read-tree "${fromHash}"`))
        const diffOut = await this._run(this._git('diff --cached'))
        return diffOut
      } catch {
        return ''
      }
    })
  }

  /**
   * Run git garbage collection to prune objects older than 7 days.
   * Call this once per day / session start; safe to skip on failure.
   */
  async cleanup(): Promise<void> {
    try {
      await this.init()
      await this._run(this._git('gc --prune=7.days --quiet'))
    } catch {
      // gc failure is non-fatal
    }
  }

  /**
   * G5: Return the list of files contained in a tracked tree hash.
   * Mirrors opencode's Snapshot.patch(hash) → { hash, files[] }.
   */
  async patch(hash: string): Promise<SnapshotPatch> {
    return this._withLock(async () => {
      await this.init()
      try {
        const out = await this._run(
          `git --git-dir="${this.gitDir}" ls-tree -r --name-only "${hash}"`,
        )
        const files = out
          .split('\n')
          .map(l => l.trim())
          .filter(Boolean)
        return { hash, files }
      } catch {
        return { hash, files: [] }
      }
    })
  }

  /**
   * G1: Return a structured per-file diff between a tracked hash and the
   * current work-tree state.
   * Mirrors opencode's Snapshot.diffFull(from, to) → FileDiff[].
   *
   * Implementation:
   *  1. git diff --numstat <hash>  — get additions/deletions per file
   *  2. git diff --unified=3 -- <file>  — get patch text per file
   *  3. Detect status (added/deleted/modified) from numstat special values
   */
  async diffFull(fromHash?: string): Promise<FileDiff[]> {
    return this._withLock(async () => {
      await this.init()
      try {
        // Read the tree into the index so diff-index works
        const hashArg = fromHash ?? (await this._run(this._git('write-tree')))
        await this._run(this._git(`read-tree "${hashArg}"`))

        // --numstat: "<additions>\t<deletions>\t<file>"
        // Special: "-" means binary. New files have 0 deletions, deleted have 0 additions.
        const numstatOut = await this._run(this._git('diff --cached --numstat'))
        if (!numstatOut.trim()) return []

        const results: FileDiff[] = []

        for (const line of numstatOut.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue

          // Format: "<add>\t<del>\t<file>"  (binary files use "-")
          const parts = trimmed.split('\t')
          if (parts.length < 3) continue

          const addStr = parts[0]!
          const delStr = parts[1]!
          const file = parts.slice(2).join('\t')  // handle tabs in filename

          const additions = addStr === '-' ? 0 : parseInt(addStr, 10) || 0
          const deletions = delStr === '-' ? 0 : parseInt(delStr, 10) || 0

          // Determine status: check if file exists in current work-tree
          const absPath = path.join(this.workTree, file)
          const existsNow = fs.existsSync(absPath)

          let status: FileDiff['status']
          if (deletions === 0 && !existsNow) {
            status = 'deleted'
          } else if (additions > 0 && deletions === 0) {
            // Check if file existed in the snapshot tree
            const inTree = await this._run(
              `git --git-dir="${this.gitDir}" ls-tree --name-only "${hashArg}" -- "${file}"`,
            ).catch(() => '')
            status = inTree.trim() ? 'modified' : 'added'
          } else {
            status = 'modified'
          }

          // Get unified patch for this file
          let patch = ''
          try {
            patch = await this._run(
              this._git(`diff --cached --unified=3 -- "${file}"`),
            )
          } catch {
            // ignore
          }

          results.push({ file, patch, additions, deletions, status })
        }

        return results
      } catch (err) {
        console.error('[snapshot] diffFull() failed:', err)
        return []
      }
    })
  }

  // ──────────────────────────────────────────────────────────
  //  Internals
  // ──────────────────────────────────────────────────────────

  /**
   * Write files > MAX_FILE_SIZE to info/exclude so git doesn't track them.
   * We do a best-effort walk of the work-tree (non-recursive, top-level only)
   * to keep it fast. Deep exclusions would require a full walk which is slow.
   */
  private async _updateExclusions(): Promise<void> {
    const excludeFile = path.join(this.gitDir, 'info', 'exclude')
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true })

    const lines: string[] = ['# auto-generated by universal-agent snapshot']

    try {
      const entries = fs.readdirSync(this.workTree, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile()) continue
        try {
          const stat = fs.statSync(path.join(this.workTree, entry.name))
          if (stat.size > MAX_FILE_SIZE) lines.push(entry.name)
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }

    fs.writeFileSync(excludeFile, lines.join('\n') + '\n')
  }
}

/** Singleton registry: one SnapshotService per project root */
const registry = new Map<string, SnapshotService>()

export function getSnapshotService(workTree?: string): SnapshotService {
  const root = workTree ?? process.cwd()
  const abs = path.resolve(root)
  let svc = registry.get(abs)
  if (!svc) {
    svc = new SnapshotService(abs)
    registry.set(abs, svc)
  }
  return svc
}
