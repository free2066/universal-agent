/**
 * Type definitions for MultiModelAdapter
 * 
 * These types define the interfaces between Anthropic SDK format
 * and UA's internal ChatOptions format.
 */

// ============================================================================
// Content Block Types (Anthropic format)
// ============================================================================

export interface TextContentBlock {
  type: 'text'
  text: string
}

export interface ImageContentBlock {
  type: 'image'
  source: {
    type: 'base64'
    media_type: string
    data: string
  }
}

export interface ToolUseContentBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultContentBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | ContentBlock[]
  is_error?: boolean
}

export type ContentBlock =
  | TextContentBlock
  | ImageContentBlock
  | ToolUseContentBlock
  | ToolResultContentBlock

// ============================================================================
// Message Types (Anthropic format)
// ============================================================================

export interface AnthropicMessageParam {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

export interface AnthropicBetaMessageParam {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

// ============================================================================
// Tool Types
// ============================================================================

export interface AnthropicToolDefinition {
  name: string
  description?: string
  input_schema: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
  }
}

export interface UAToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
  }
}

// ============================================================================
// Response Types
// ============================================================================

export interface UAToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface UAChatResponse {
  type: 'text' | 'tool_calls'
  content?: string
  toolCalls?: UAToolCall[]
  usage?: {
    input_tokens: number
    output_tokens: number
  }
}

export interface AnthropicMessage {
  id: string
  type: 'message'
  role: 'assistant'
  model: string
  content: ContentBlock[]
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | null
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  }
}

// ============================================================================
// API Params Types
// ============================================================================

export interface AnthropicMessagesCreateParams {
  messages: AnthropicBetaMessageParam[]
  model: string
  max_tokens: number
  system?: string | TextContentBlock[]
  tools?: AnthropicToolDefinition[]
  stream?: boolean
  [key: string]: unknown
}

export interface AnthropicMessagesCreateOptions {
  signal?: AbortSignal
  _triedModels?: Set<string>
  _fallbackDepth?: number
  [key: string]: unknown
}

// ============================================================================
// Internal Message Types (UA format)
// ============================================================================

export interface UAMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: UAToolCall[]
  toolCallId?: string
}

// ============================================================================
// SSE Event Types
// ============================================================================

export interface SSEMessageStartEvent {
  type: 'message_start'
  message: {
    id: string
    type: 'message'
    role: 'assistant'
    content: ContentBlock[]
    model: string
    stop_reason: string | null
    stop_sequence: string | null
    usage: {
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens: number
      cache_read_input_tokens: number
    }
  }
}

export interface SSEContentBlockStartEvent {
  type: 'content_block_start'
  index: number
  content_block: ContentBlock
}

export interface SSEContentBlockDeltaEvent {
  type: 'content_block_delta'
  index: number
  delta:
    | { type: 'text_delta'; text: string }
    | { type: 'input_json_delta'; partial_json: string }
}

export interface SSEContentBlockStopEvent {
  type: 'content_block_stop'
  index: number
}

export interface SSEMessageDeltaEvent {
  type: 'message_delta'
  delta: {
    stop_reason: string | null
    stop_sequence: string | null
  }
  usage: {
    output_tokens: number
  }
}

export interface SSEMessageStopEvent {
  type: 'message_stop'
}

export type SSEEvent =
  | SSEMessageStartEvent
  | SSEContentBlockStartEvent
  | SSEContentBlockDeltaEvent
  | SSEContentBlockStopEvent
  | SSEMessageDeltaEvent
  | SSEMessageStopEvent

// ============================================================================
// Error Types
// ============================================================================

export interface APIError extends Error {
  status?: number
  code?: string
  headers?: Headers
}
