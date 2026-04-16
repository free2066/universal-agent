/**
 * MCP server handling module
 * 
 * Contains functions for managing MCP server configurations.
 */

// Re-export from the main print.ts file
export {
  handleMcpSetServers,
  reconcileMcpServers,
} from '../print.js'

// Re-export types
export type {
  DynamicMcpState,
  SdkMcpState,
  McpSetServersResult,
} from './types.js'
