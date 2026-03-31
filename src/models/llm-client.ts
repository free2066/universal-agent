import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type {
  LLMClient,
  ChatOptions,
  ChatResponse,
  Message,
  ToolCall,
} from './types.js';

export function createLLMClient(model: string): LLMClient {
  if (model.startsWith('claude')) {
    return new AnthropicClient(model);
  }
  if (model.startsWith('ollama:')) {
    return new OllamaClient(model.replace('ollama:', ''));
  }
  return new OpenAIClient(model);
}

// ──────────────────────────────────────────
// OpenAI Client
// ──────────────────────────────────────────
class OpenAIClient implements LLMClient {
  private client: OpenAI;
  private model: string;

  constructor(model: string) {
    this.model = model;
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
    });
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    const messages = this.convertMessages(options);

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      tools: options.tools?.map((t) => ({ type: 'function' as const, function: t })),
      tool_choice: options.tools?.length ? 'auto' : undefined,
    });

    const choice = response.choices[0];
    const msg = choice.message;

    if (msg.tool_calls?.length) {
      return {
        type: 'tool_calls',
        content: msg.content || '',
        toolCalls: msg.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments || '{}'),
        })),
      };
    }

    return { type: 'text', content: msg.content || '', toolCalls: [] };
  }

  async streamChat(options: ChatOptions, onChunk: (chunk: string) => void): Promise<void> {
    const messages = this.convertMessages(options);

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) onChunk(delta);
    }
  }

  private convertMessages(options: ChatOptions) {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: options.systemPrompt },
    ];

    for (const msg of options.messages) {
      if (msg.role === 'tool') {
        messages.push({
          role: 'tool',
          tool_call_id: msg.toolCallId!,
          content: msg.content,
        });
      } else if (msg.role === 'assistant' && msg.toolCalls?.length) {
        messages.push({
          role: 'assistant',
          content: msg.content || null,
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        });
      } else {
        messages.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        });
      }
    }

    return messages;
  }
}

// ──────────────────────────────────────────
// Anthropic Client
// ──────────────────────────────────────────
class AnthropicClient implements LLMClient {
  private client: Anthropic;
  private model: string;

  constructor(model: string) {
    this.model = model;
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    const messages = this.convertMessages(options.messages);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 8192,
      system: options.systemPrompt,
      messages,
      tools: options.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Tool['input_schema'],
      })),
    });

    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use') as Anthropic.ToolUseBlock[];
    const textBlocks = response.content.filter((b) => b.type === 'text') as Anthropic.TextBlock[];

    if (toolUseBlocks.length) {
      return {
        type: 'tool_calls',
        content: textBlocks.map((b) => b.text).join(''),
        toolCalls: toolUseBlocks.map((b) => ({
          id: b.id,
          name: b.name,
          arguments: b.input as Record<string, unknown>,
        })),
      };
    }

    return {
      type: 'text',
      content: textBlocks.map((b) => b.text).join(''),
      toolCalls: [],
    };
  }

  async streamChat(options: ChatOptions, onChunk: (chunk: string) => void): Promise<void> {
    const messages = this.convertMessages(options.messages);

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 8192,
      system: options.systemPrompt,
      messages,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        onChunk(event.delta.text);
      }
    }
  }

  private convertMessages(messages: Message[]): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'user') {
        result.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        if (msg.toolCalls?.length) {
          result.push({
            role: 'assistant',
            content: [
              ...(msg.content ? [{ type: 'text' as const, text: msg.content }] : []),
              ...msg.toolCalls.map((tc) => ({
                type: 'tool_use' as const,
                id: tc.id,
                name: tc.name,
                input: tc.arguments,
              })),
            ],
          });
        } else {
          result.push({ role: 'assistant', content: msg.content });
        }
      } else if (msg.role === 'tool') {
        const lastMsg = result[result.length - 1];
        if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
          (lastMsg.content as unknown[]).push({
            type: 'tool_result',
            tool_use_id: msg.toolCallId!,
            content: msg.content,
          });
        } else {
          result.push({
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: msg.toolCallId!,
                content: msg.content,
              } as never,
            ],
          });
        }
      }
    }

    return result;
  }
}

// ──────────────────────────────────────────
// Ollama Client (Local Models)
// ──────────────────────────────────────────
class OllamaClient implements LLMClient {
  private model: string;
  private baseURL: string;

  constructor(model: string) {
    this.model = model;
    this.baseURL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    const messages = [
      { role: 'system', content: options.systemPrompt },
      ...options.messages.filter((m) => m.role !== 'tool').map((m) => ({
        role: m.role,
        content: m.content,
      })),
    ];

    const res = await fetch(`${this.baseURL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages, stream: false }),
    });

    if (!res.ok) throw new Error(`Ollama error: ${res.statusText}`);
    const data = await res.json() as { message: { content: string } };
    return { type: 'text', content: data.message.content, toolCalls: [] };
  }

  async streamChat(options: ChatOptions, onChunk: (chunk: string) => void): Promise<void> {
    const messages = [
      { role: 'system', content: options.systemPrompt },
      ...options.messages.filter((m) => m.role !== 'tool').map((m) => ({
        role: m.role,
        content: m.content,
      })),
    ];

    const res = await fetch(`${this.baseURL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages, stream: true }),
    });

    if (!res.ok) throw new Error(`Ollama error: ${res.statusText}`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = decoder.decode(value).split('\n').filter(Boolean);
      for (const line of lines) {
        const data = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
        if (data.message?.content) onChunk(data.message.content);
      }
    }
  }
}
