/**
 * Type definitions for print module
 */

/**
 * Prompt value type - can be string or content blocks
 */
export type PromptValue = string | Array<{ type: string; text?: string; [key: string]: unknown }>

/**
 * Result of loading initial messages
 */
export interface LoadInitialMessagesResult {
  messages: import('../../types/message.js').Message[]
  fileStateCache: import('../../utils/fileStateCache.js').FileStateCache
  shouldCompact: boolean
}

/**
 * Dynamic MCP state for channel handling
 */
export interface DynamicMcpState {
  servers: import('../../services/mcp/types.js').McpSdkServerConfig[]
}

/**
 * SDK MCP state
 */
export interface SdkMcpState {
  servers: import('../../services/mcp/types.js').ScopedMcpServerConfig[]
}

/**
 * Result of setting MCP servers
 */
export interface McpSetServersResult {
  servers: import('../../services/mcp/types.js').MCPServerConnection[]
  errors: Array<{ name: string; error: Error }>
}
