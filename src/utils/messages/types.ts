/**
 * Type definitions for messages module
 */

import type {
  Message,
  NormalizedMessage,
  NormalizedAssistantMessage,
  NormalizedUserMessage,
} from '../../types/message.js'
import type {
  ToolResultBlockParam,
  ContentBlockParam,
} from '@anthropic-ai/sdk/resources/messages'

/**
 * Message lookups for efficient queries
 */
export interface MessageLookups {
  /** Map from tool_use_id to tool result message UUID */
  toolResultUuids: Map<string, string>
  /** Map from tool_use_id to tool use message UUID */
  toolUseUuids: Map<string, string>
  /** Map from tool_use_id to progress message UUIDs */
  progressUuids: Map<string, Set<string>>
  /** Map from tool_use_id to tool name */
  toolNames: Map<string, string>
  /** Map from tool_use_id to set of hook attachments */
  hookAttachments: Map<string, Set<string>>
  /** Map from UUID to message */
  messageByUuid: Map<string, NormalizedMessage>
  /** Set of tool_use_ids with unresolved hooks */
  unresolvedHooks: Set<string>
}

/**
 * Tool use request message type
 */
export type ToolUseRequestMessage = NormalizedAssistantMessage & {
  content: Array<{ type: 'tool_use'; id: string; name: string; input: unknown }>
}

/**
 * Tool use result message type
 */
export type ToolUseResultMessage = NormalizedUserMessage & {
  content: Array<{ type: 'tool_result'; tool_use_id: string }>
}

/**
 * Streaming tool use type
 */
export interface StreamingToolUse {
  id: string
  name: string
  input: string
  inputJson: unknown
}

/**
 * Streaming thinking type
 */
export interface StreamingThinking {
  type: 'thinking' | 'redacted_thinking'
  thinking: string
}

/**
 * Tool result content item type
 */
export type ToolResultContentItem = Extract<
  ToolResultBlockParam['content'],
  readonly unknown[]
>[number]

/**
 * Hook attachment with name type
 */
export type HookAttachmentWithName = Exclude<
  Extract<ContentBlockParam, { type: 'hook_attachment' }>,
  { type: 'permission_decision' }
>
