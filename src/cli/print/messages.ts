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

// Re-export types
export type {
  LoadInitialMessagesResult,
} from './types.js'
