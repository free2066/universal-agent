/**
 * Type definitions for print module
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/src/resources/messages.js'

// ============================================================================
// UUID Type (re-export from crypto for consistency)
// ============================================================================

export type { UUID } from 'crypto'

// ============================================================================
// Prompt Types
// ============================================================================

export type PromptValue = string | ContentBlockParam[]

// ============================================================================
// Message Loading Types
// ============================================================================

export type LoadInitialMessagesResult = {
  messages: import('../../types/message.js').Message[]
  turnInterruptionState?: import('../../utils/conversationRecovery.js').TurnInterruptionState
  agentSetting?: string
}

// ============================================================================
// MCP Types
// ============================================================================

export type DynamicMcpState = {
  clients: import('../../services/mcp/types.js').MCPServerConnection[]
  tools: import('../../Tool.js').Tools
  configs: Record<string, import('../../services/mcp/types.js').ScopedMcpServerConfig>
}

export type SdkMcpState = {
  configs: Record<string, import('../../services/mcp/types.js').McpSdkServerConfig>
  clients: import('../../services/mcp/types.js').MCPServerConnection[]
  tools: import('../../Tool.js').Tools
}

export type McpSetServersResult = {
  response: import('../../entrypoints/sdk/controlTypes.js').SDKControlMcpSetServersResponse
  newSdkState: SdkMcpState
  newDynamicState: DynamicMcpState
  sdkServersChanged: boolean
}
