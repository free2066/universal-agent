/**
 * types/tools.ts — Progress types for tool execution
 * Stub: using permissive types for CC compatibility
 */

export type Progress = {
  type: string
  [key: string]: any
}

export type BashProgress = Progress
export type ShellProgress = Progress
export type PowerShellProgress = Progress
export type MCPProgress = Progress
export type AgentToolProgress = Progress
export type SkillToolProgress = Progress
export type WebSearchProgress = Progress
export type TaskOutputProgress = Progress
export type SdkWorkflowProgress = Progress
