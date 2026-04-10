// @ts-nocheck
/**
 * G4: SyncEvent bus public exports.
 *
 * Usage:
 *   import { bus, SessionEvents, FileEvents } from '../syncEvent/index.js'
 *
 *   // Subscribe
 *   const unsub = bus.subscribe(SessionEvents.created, (e) => {
 *     console.log('New session:', e.data.sessionId)
 *   })
 *
 *   // Publish
 *   bus.publish(SessionEvents.created, sessionId, { sessionId, cwd: '/foo' })
 *
 *   // Persist
 *   bus.flush()
 */

import { SyncEventBus } from './SyncEventBus.js'

export { SyncEventBus } from './SyncEventBus.js'
export type { SyncEventDef, SyncEvent } from './SyncEventBus.js'

/** Process-level singleton SyncEventBus */
export const bus = new SyncEventBus()

// Re-export pre-defined events (imported after `bus` is available)
export {
  SessionEvents,
  FileEvents,
  SnapshotEvents,
  WorktreeEvents,
  PermissionEvents,
} from './events.js'
