// Shared type definitions across the agent framework

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
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
}

export interface ChatOptions {
  systemPrompt: string;
  messages: Message[];
  tools?: ToolDefinition[];
  stream?: boolean;
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
