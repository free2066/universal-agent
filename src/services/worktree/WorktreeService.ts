// @ts-nocheck
/**
 * F2 + G2: WorktreeService — thin wrapper over the canonical utils/worktree.ts.
 *
 * The real implementation lives in src/utils/worktree.ts which is used by
 * EnterWorktreeTool and ExitWorktreeTool. This module re-exports those
 * functions so any code importing from services/worktree gets the same
 * behaviour without duplication.
 */

export {
  createWorktreeForSession,
  getCurrentWorktreeSession,
  worktreeBranchName,
  generateTmuxSessionName,
  resetWorktree,
  runWorktreeStartCommand,
} from '../../utils/worktree.js'

export function isWorktreeEnabled(): boolean {
  return process.env.UAGENT_WORKTREE === '1'
}
