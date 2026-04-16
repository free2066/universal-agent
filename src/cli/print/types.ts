/**
 * Type definitions for print module
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/src/resources/messages.js'

// ============================================================================
// UUID Tracking Types
// ============================================================================

export type UUID = string

// ============================================================================
// Prompt Types
// ============================================================================

export type PromptValue = string | ContentBlockParam[]

// ============================================================================
// Message Loading Types
// ============================================================================

export type LoadInitialMessagesResult = {
  messages: import('../../types/message.js').Message[]
  permissionPromptTool: import('../../utils/queryHelpers.js').PermissionPromptTool | undefined
}

// ============================================================================
// MCP Types
// ============================================================================

export type DynamicMcpState = {
  mcpServers: import('../../services/mcp/types.js').ScopedMcpServerConfig[]
}

export type SdkMcpState = {
  mcpServers: import('../../services/mcp/types.js').McpSdkServerConfig[]
}

export type McpSetServersResult = {
  dynamicState: DynamicMcpState | null
  sdkState: SdkMcpState | null
}
