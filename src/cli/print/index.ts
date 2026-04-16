/**
 * Print module entry point
 * 
 * Re-exports all public functions from the split modules.
 * Import from 'src/cli/print.js' for backward compatibility.
 */

// Re-export constants and state
export {
  SHUTDOWN_TEAM_PROMPT,
  MAX_RECEIVED_UUIDS,
  receivedMessageUuids,
  receivedMessageUuidsOrder,
  trackReceivedMessageUuid,
} from './constants.js'

// Re-export types
export type {
  PromptValue,
  LoadInitialMessagesResult,
  DynamicMcpState,
  SdkMcpState,
  McpSetServersResult,
  UUID,
} from './types.js'

// Re-export utility functions
export {
  toBlocks,
  joinPromptValues,
  canBatchWith,
} from './utils.js'

// Re-export main functions from print.ts (only functions that are actually exported)
export {
  runHeadless,
  runHeadlessStreaming,
  createCanUseToolWithPermissionPrompt,
  getCanUseToolFn,
  removeInterruptedMessage,
  handleOrphanedPermissionResponse,
  handleMcpSetServers,
  reconcileMcpServers,
} from '../print.js'
