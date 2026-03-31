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

export interface ChatResponse {
  type: 'text' | 'tool_calls';
  content: string;
  toolCalls: ToolCall[];
}

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
