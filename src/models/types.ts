// Shared type definitions across the agent framework

/** Vision image block — base64 encoded, compatible with OpenAI and Anthropic vision APIs */
export interface ImageBlock {
  type: 'image';
  /** base64-encoded image data (WITHOUT the "data:..." URI prefix) */
  data: string;
  /** MIME type, e.g. "image/png" */
  mimeType: string;
}

/** URL-referenced image block (OpenAI vision image_url format) */
export interface ImageUrlBlock {
  type: 'image_url';
  url: string;
}

/** A single content block in a multimodal message */
export type ContentBlock = string | ImageBlock | ImageUrlBlock;

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Either a plain string or a multimodal content array */
  content: string | ContentBlock[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

/** Extract the plain-text portion of a message's content (for logging / display). */
export function getContentText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((b) => {
      if (typeof b === 'string') return b;
      if (b.type === 'image') return '[image]';
      if (b.type === 'image_url') return `[image: ${b.url}]`;
      return '';
    })
    .join('');
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ParameterSchema>;
    required?: string[];
  };
}

export interface ParameterSchema {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
  items?: ParameterSchema;
  /** For object-typed parameters: nested property definitions */
  properties?: Record<string, ParameterSchema>;
  required?: string[];
}

/** Claude extended-thinking budget levels */
export type ThinkingLevel =
  | 'low' | 'medium' | 'high'    // all providers
  | 'max' | 'xhigh' | 'maxOrXhigh'; // extended (Claude / advanced)

/** Budget tokens per level (aligns with Anthropic docs) */
export const THINKING_BUDGETS: Record<ThinkingLevel, number> = {
  low:          1_024,
  medium:       8_000,
  high:        16_000,
  max:         32_000,
  xhigh:       32_000,
  maxOrXhigh:  32_000,   // prefer xhigh; fall back to max on unsupported models
};

export interface ChatOptions {
  systemPrompt: string;
  messages: Message[];
  tools?: ToolDefinition[];
  stream?: boolean;
  /** Claude extended-thinking level (only applied for claude-* models) */
  thinkingLevel?: ThinkingLevel;
}

/**
 * ChatResponse uses a discriminated union to let TypeScript narrow the type
 * in conditional branches:
 *
 *   if (response.type === 'text') { /* response.toolCalls is never here *\/ }
 *   if (response.type === 'tool_calls') { /* response.toolCalls is ToolCall[] here *\/ }
 *
 * This prevents accidentally reading toolCalls on a text-only response and
 * makes every LLMClient implementation's return types self-documenting.
 */
export type ChatResponse =
  | { type: 'text';       content: string; toolCalls?: never }
  | { type: 'tool_calls'; content: string; toolCalls: ToolCall[] };

export interface LLMClient {
  chat(options: ChatOptions): Promise<ChatResponse>;
  streamChat(options: ChatOptions, onChunk: (chunk: string) => void): Promise<void>;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export interface DomainPlugin {
  name: string;
  description: string;
  keywords: string[];
  systemPrompt: string;
  tools: ToolRegistration[];
}

export interface ToolRegistration {
  definition: ToolDefinition;
  handler: ToolHandler;
}
