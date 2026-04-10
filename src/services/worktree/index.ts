// @ts-nocheck
/**
 * F2: Worktree service public exports — thin wrapper over utils/worktree.ts.
 */

export {
  createWorktreeForSession,
  getCurrentWorktreeSession,
  worktreeBranchName,
  generateTmuxSessionName,
} from '../../utils/worktree.js'

export { isWorktreeEnabled } from './WorktreeService.js'
