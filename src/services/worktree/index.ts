// @ts-nocheck
/**
 * R3: Worktree service public exports.
 *
 * Usage:
 *   import { getWorktreeService, isWorktreeEnabled } from '../worktree/index.js'
 *
 *   if (isWorktreeEnabled()) {
 *     const wt = getWorktreeService()
 *     const wtPath = await wt.create(sessionId)
 *     // ... run sub-agent with CWD = wtPath ...
 *     const result = await wt.merge(sessionId)
 *   }
 */

export {
  WorktreeService,
  getWorktreeService,
  isWorktreeEnabled,
} from './WorktreeService.js'
export type { WorktreeInfo, MergeResult } from './WorktreeService.js'
