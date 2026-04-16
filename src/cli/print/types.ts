/**
 * Type definitions for CLI print module
 * 
 * Extracted from print.ts for better organization
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages.js'
import type { MCPServerConnection, McpSdkServerConfig, ScopedMcpServerConfig } from '../services/mcp/types.js'
import type { Message } from '../types/message.js'
import type { Tools } from '../Tool.js'
import type { TurnInterruptionState } from '../utils/conversationRecovery.js'
import type { SessionExternalMetadata } from '../utils/sessionState.js'

// ============================================================================
// Basic Types
// ============================================================================

/**
 * Prompt value can be a string or an array of content blocks
 */
export type PromptValue = string | ContentBlockParam[]

// ============================================================================
// Message Loading Types
// ============================================================================

/**
 * Result of loading initial messages for a session
 */
export type LoadInitialMessagesResult = {
  messages: Message[]
  turnInterruptionState?: TurnInterruptionState
  agentSetting?: string
}

/**
 * Options for loading initial messages
 */
export type LoadInitialMessagesOptions = {
  continue: boolean | undefined
  teleport: string | true | null | undefined
  resume: string | boolean | undefined
  resumeSessionAt: string | undefined
  forkSession: boolean | undefined
  outputFormat: string | undefined
  sessionStartHooksPromise?: ReturnType<typeof import('../utils/hooks.js').processSessionStartHooks>
  restoredWorkerState: Promise<SessionExternalMetadata | null>
}

// ============================================================================
// MCP Types
// ============================================================================

/**
 * State for dynamically added MCP servers
 */
export type DynamicMcpState = {
  clients: MCPServerConnection[]
  tools: Tools
  configs: Record<string, ScopedMcpServerConfig>
}

/**
 * State for SDK MCP servers that run in the SDK process
 */
export type SdkMcpState = {
  configs: Record<string, McpSdkServerConfig>
  clients: MCPServerConnection[]
  tools: Tools
}

/**
 * Result of handleMcpSetServers - contains new state and response data
 */
export type McpSetServersResult = {
  response: import('../services/mcp/channelNotification.js').SDKControlMcpSetServersResponse
  newSdkState: SdkMcpState
  newDynamicState: DynamicMcpState
  sdkServersChanged: boolean
}
