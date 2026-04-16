/**
 * Message handling module
 * 
 * Contains functions for loading initial messages and handling orphaned permissions.
 */

// Re-export from the main print.ts file
export {
  removeInterruptedMessage,
  handleOrphanedPermissionResponse,
} from '../print.js'

// Re-export types from print.ts
export type {
  LoadInitialMessagesResult,
} from '../print.js'
