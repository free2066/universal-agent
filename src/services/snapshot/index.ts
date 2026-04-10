// @ts-nocheck
/**
 * R2: Snapshot service public exports.
 *
 * Usage:
 *   import { getSnapshotService } from '../snapshot/index.js'
 *   const snap = getSnapshotService()
 *   const hash = await snap.track()   // before AI edits
 *   await snap.revert([{hash, files}]) // undo specific files
 */

export { SnapshotService, getSnapshotService } from './SnapshotService.js'
export type { RevertPatch, SnapshotPatch, FileDiff } from './SnapshotService.js'
