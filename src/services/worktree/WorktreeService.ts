// @ts-nocheck
/**
 * R3: Git worktree sandbox isolation for sub-agents.
 *
 * Inspired by opencode's worktree/ module. When UAGENT_WORKTREE=1 is set,
 * sub-agents operate inside an isolated git worktree instead of the main
 * working directory, preventing accidental pollution of the main branch.
 *
 * Workflow:
 *   1. create(sessionId)  → git worktree add .uagent-worktrees/<id> -b ua/<id>
 *   2. Sub-agent writes files inside the worktree path
 *   3. merge(sessionId)   → git diff + merge back to main branch
 *   4. remove(sessionId)  → git worktree remove + branch delete
 *
 * Default: disabled. Enable with UAGENT_WORKTREE=1 env variable.
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'

const execAsync = promisify(exec)

export interface WorktreeInfo {
  sessionId: string
  path: string
  branch: string
  createdAt: Date
}

export interface MergeResult {
  diff: string
  filesChanged: string[]
  insertions: number
  deletions: number
}

export class WorktreeService {
  private readonly projectRoot: string
  private readonly worktreesDir: string
  /** In-memory registry of active worktrees */
  private readonly active = new Map<string, WorktreeInfo>()

  constructor(projectRoot?: string) {
    this.projectRoot = path.resolve(projectRoot ?? process.cwd())
    this.worktreesDir = path.join(this.projectRoot, '.uagent-worktrees')
  }

  // ──────────────────────────────────────────────────────────
  //  Public API
  // ──────────────────────────────────────────────────────────

  /**
   * Create an isolated git worktree for a sub-agent session.
   * Returns the absolute path to the worktree directory.
   * Throws if the project root is not a git repository.
   */
  async create(sessionId: string): Promise<string> {
    const worktreePath = path.join(this.worktreesDir, sessionId)
    const branch = `ua/${sessionId.slice(0, 12)}`

    // Ensure the project root is a git repository
    await this._git('rev-parse --git-dir')

    // Create the worktrees parent directory
    fs.mkdirSync(this.worktreesDir, { recursive: true })

    // Create the worktree on a new branch
    await this._git(`worktree add "${worktreePath}" -b "${branch}"`)

    const info: WorktreeInfo = {
      sessionId,
      path: worktreePath,
      branch,
      createdAt: new Date(),
    }
    this.active.set(sessionId, info)

    return worktreePath
  }

  /**
   * Get the worktree path for a session (if it exists).
   */
  get(sessionId: string): WorktreeInfo | undefined {
    return this.active.get(sessionId)
  }

  /**
   * List all active worktrees managed by this service.
   */
  list(): WorktreeInfo[] {
    return Array.from(this.active.values())
  }

  /**
   * Merge worktree changes back to the main branch.
   * Returns a summary diff of what changed.
   */
  async merge(sessionId: string): Promise<MergeResult> {
    const info = this.active.get(sessionId)
    if (!info) throw new Error(`No active worktree for session: ${sessionId}`)

    // Get diff stat from worktree branch vs current HEAD
    let diff = ''
    let filesChanged: string[] = []
    let insertions = 0
    let deletions = 0

    try {
      const currentBranch = await this._git('rev-parse --abbrev-ref HEAD')
      diff = await this._git(`diff ${currentBranch}...${info.branch}`)

      // Parse diff stat
      const stat = await this._git(
        `diff --stat ${currentBranch}...${info.branch}`,
      )
      filesChanged = stat
        .split('\n')
        .filter(l => l.includes('|'))
        .map(l => l.split('|')[0]!.trim())

      const lastLine = stat.split('\n').filter(Boolean).pop() ?? ''
      const insMatch = lastLine.match(/(\d+) insertion/)
      const delMatch = lastLine.match(/(\d+) deletion/)
      insertions = insMatch ? parseInt(insMatch[1]!) : 0
      deletions = delMatch ? parseInt(delMatch[1]!) : 0

      // Merge the worktree branch into current branch
      await this._git(`merge --no-ff ${info.branch} -m "chore: merge ua worktree ${sessionId.slice(0, 8)}"`)
    } catch (err) {
      throw new Error(`Merge failed: ${err}`)
    }

    return { diff, filesChanged, insertions, deletions }
  }

  /**
   * Discard worktree changes and remove the worktree + branch.
   */
  async remove(sessionId: string): Promise<void> {
    const info = this.active.get(sessionId)
    if (!info) return

    try {
      // Remove the worktree
      await this._git(`worktree remove "${info.path}" --force`)
    } catch {
      // If worktree dir is already gone, clean up manually
      if (fs.existsSync(info.path)) {
        fs.rmSync(info.path, { recursive: true, force: true })
      }
      try {
        await this._git(`worktree prune`)
      } catch {
        // ignore
      }
    }

    // Delete the branch
    try {
      await this._git(`branch -D "${info.branch}"`)
    } catch {
      // Branch may already be gone
    }

    this.active.delete(sessionId)
  }

  /**
   * Remove all managed worktrees (cleanup on session end).
   */
  async removeAll(): Promise<void> {
    for (const sessionId of this.active.keys()) {
      await this.remove(sessionId).catch(() => {})
    }
  }

  // ──────────────────────────────────────────────────────────
  //  Helpers
  // ──────────────────────────────────────────────────────────

  private async _git(subCmd: string): Promise<string> {
    const { stdout } = await execAsync(`git ${subCmd}`, {
      cwd: this.projectRoot,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return stdout.trim()
  }
}

/** Singleton per project root */
let _instance: WorktreeService | undefined

export function getWorktreeService(projectRoot?: string): WorktreeService {
  if (!_instance) {
    _instance = new WorktreeService(projectRoot)
  }
  return _instance
}

/**
 * Check if worktree sandboxing is enabled.
 * Controlled by UAGENT_WORKTREE=1 env variable.
 */
export function isWorktreeEnabled(): boolean {
  return process.env.UAGENT_WORKTREE === '1'
}
