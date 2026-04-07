/**
 * types/message.ts — Core message types for the claude-code agent loop
 * Stub: using permissive types to maintain compatibility with CC's private type system
 */

export type MessageType = string

export type UserMessage = {
  type: 'user'
  message: {
    role: 'user'
    content: any[]
  }
  uuid: string
  isMeta?: boolean
  [key: string]: any
}

export type NormalizedUserMessage = UserMessage

export type AssistantMessage = {
  type: 'assistant'
  message: {
    role: 'assistant'
    content: any[]
    model?: string
    stop_reason?: string | null
    usage?: any
    [key: string]: any
  }
  uuid: string
  costUSD?: number
  durationMs?: number
  requestId?: string
  [key: string]: any
}

export type NormalizedAssistantMessage = AssistantMessage

export type ProgressMessageType = 'progress'
export type ProgressMessage = {
  type: 'progress'
  toolUseId: string
  toolName: string
  data: any
  uuid: string
  [key: string]: any
}

export type SystemInformationalMessage = {
  type: 'system'
  subtype: 'info'
  content: string
  uuid: string
  [key: string]: any
}

export type SystemAPIErrorMessage = {
  type: 'system'
  subtype: 'api_error'
  error: any
  uuid: string
  [key: string]: any
}

export type SystemMemorySavedMessage = {
  type: 'system'
  subtype: 'memory_saved'
  filename: string
  uuid: string
  [key: string]: any
}

export type SystemBridgeStatusMessage = {
  type: 'system'
  subtype: 'bridge_status'
  status: string
  uuid: string
  [key: string]: any
}

export type SystemThinkingMessage = {
  type: 'system'
  subtype: 'thinking'
  content: string
  uuid: string
  [key: string]: any
}

export type SystemTurnDurationMessage = {
  type: 'system'
  subtype: 'turn_duration'
  durationMs: number
  uuid: string
  [key: string]: any
}

export type SystemStopHookSummaryMessage = {
  type: 'system'
  subtype: 'stop_hook_summary'
  summary: string
  uuid: string
  [key: string]: any
}

export type SystemMessage = {
  type: 'system'
  subtype: string
  uuid: string
  [key: string]: any
}

export type AttachmentMessageType = 'attachment'
export type AttachmentMessage = {
  type: 'attachment'
  filename?: string
  content?: string
  uuid: string
  [key: string]: any
}

export type HookResultMessage = {
  type: 'hookResult'
  hookType?: string
  result?: any
  uuid: string
  [key: string]: any
}

export type GroupedToolUseMessageType = 'groupedToolUse'
export type GroupedToolUseMessage = {
  type: 'groupedToolUse'
  toolUses?: any[]
  uuid: string
  [key: string]: any
}

export type QueueOperationMessage = {
  type: 'queueOperation'
  operation?: string
  uuid: string
  [key: string]: any
}

export type CollapsedReadSearchGroupType = 'collapsedReadSearchGroup'
export type CollapsedReadSearchGroup = {
  type: 'collapsedReadSearchGroup'
  messages?: Message[]
  uuid: string
  [key: string]: any
}

export type PartialCompactDirection = 'before' | 'after'

export type StreamEvent = {
  type: string
  [key: string]: any
}

export type Message = {
  type: string
  uuid: string
  [key: string]: any
}

export type NormalizedMessage = Message

export type RenderableMessage = Message
