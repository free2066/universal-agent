/**
 * services/mcpClient/index.ts — MCP (Model Context Protocol) client service
 *
 * Mirrors claude-code's services/mcpClient/index.ts.
 * Provides the MCP server management and tool invocation service.
 */

export {
  MCPScope,
  MCPServer,
  MCPConfig,
  MCPManager,
  loadMCPConfig,
} from '../../core/mcp-manager.js';
