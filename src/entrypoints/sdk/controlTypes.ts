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
