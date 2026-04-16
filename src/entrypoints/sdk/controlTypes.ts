/**
 * entrypoints/sdk/controlTypes.ts — SDK control protocol types
 */

export type SDKControlPermissionRequest = {
  type: 'permission_request'
  id: string
  toolName: string
  input: unknown
}

export type SDKControlResponse = {
  type: 'permission_response'
  id: string
  approved: boolean
  reason?: string
}

export type StdoutMessage = {
  type: 'stdout'
  content: string
}

/**
 * Response type for mcp_set_servers control message.
 */
export type SDKControlMcpSetServersResponse = {
  added: string[]
  removed: string[]
  errors: Record<string, string>
}

/**
 * Response type for reload_plugins control message.
 */
export type SDKControlReloadPluginsResponse = {
  commands: unknown[]
  agents: unknown[]
  plugins: unknown[]
}
