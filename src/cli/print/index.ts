/**
 * Print module entry point
 * 
 * This module re-exports all public functions from print.ts for backward compatibility.
 * New code should import from the specific sub-modules when possible.
 */

// Re-export constants
export {
  SHUTDOWN_TEAM_PROMPT,
  MAX_RECEIVED_UUIDS,
  receivedMessageUuids,
  receivedMessageUuidsOrder,
  trackReceivedMessageUuid,
} from './constants.js'

// Re-export utilities
export {
  toBlocks,
  joinPromptValues,
  canBatchWith,
} from './utils.js'

// Re-export types
export type {
  PromptValue,
  LoadInitialMessagesResult,
  DynamicMcpState,
  SdkMcpState,
  McpSetServersResult,
} from './types.js'

// Re-export main functions from print.ts (temporary until full migration)
// These are re-exported from the main print.ts file
export {
  runHeadless,
  createCanUseToolWithPermissionPrompt,
  getCanUseToolFn,
  removeInterruptedMessage,
  handleOrphanedPermissionResponse,
  handleMcpSetServers,
  reconcileMcpServers,
} from '../print.js'
