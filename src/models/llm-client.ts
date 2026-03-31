import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type {
  LLMClient,
  ChatOptions,
  ChatResponse,
  Message,
} from './types.js';

export function createLLMClient(model: string): LLMClient {
  if (model.startsWith('claude')) return new AnthropicClient(model);
  if (model.startsWith('ollama:')) return new OllamaClient(model.replace('ollama:', ''));
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
      baseURL: process.env.OPENAI_BASE_URL || undefined,
    });
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    const messages = this.convertMessages(options);
    const hasTools = options.tools && options.tools.length > 0;

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      // Only pass tools/tool_choice when there are actual tools — avoids API errors
      ...(hasTools ? {
        tools: options.tools!.map((t) => ({ type: 'function' as const, function: t })),
        tool_choice: 'auto' as const,
      } : {}),
    });

    const choice = response.choices[0];
    if (!choice) throw new Error('No choices returned from OpenAI');
    const msg = choice.message;

    if (msg.tool_calls?.length) {
      return {
        type: 'tool_calls',
        content: msg.content || '',
        toolCalls: msg.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          // Safely parse arguments — malformed JSON from LLM should not crash
          arguments: safeParseJSON(tc.function.arguments, tc.function.name),
        })),
      };
    }

    return { type: 'text', content: msg.content || '', toolCalls: [] };
  }

  async streamChat(options: ChatOptions, onChunk: (chunk: string) => void): Promise<void> {
    const messages = this.convertMessages(options);
    const stream = await this.client.chat.completions.create({ model: this.model, messages, stream: true });
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) onChunk(delta);
    }
  }

  private convertMessages(options: ChatOptions): OpenAI.ChatCompletionMessageParam[] {
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
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        });
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({ role: msg.role, content: msg.content });
      }
      // Skip 'system' role in messages array (already in systemPrompt)
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
    const hasTools = options.tools && options.tools.length > 0;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 8192,
      system: options.systemPrompt,
      messages,
      ...(hasTools ? {
        tools: options.tools!.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters as Anthropic.Tool['input_schema'],
        })),
      } : {}),
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

  /**
   * Convert internal Message[] → Anthropic MessageParam[].
   *
   * Key correctness rule (Anthropic API):
   * - After an assistant message with tool_use blocks, ALL tool_result blocks
   *   must be in ONE user message (not spread across multiple user messages).
   *   We batch consecutive tool-role messages into a single user message here.
   */
  private convertMessages(messages: Message[]): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];

    let i = 0;
    while (i < messages.length) {
      const msg = messages[i];

      if (msg.role === 'user') {
        result.push({ role: 'user', content: msg.content });
        i++;
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
        i++;
      } else if (msg.role === 'tool') {
        // Collect ALL consecutive tool results into one user message
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        while (i < messages.length && messages[i].role === 'tool') {
          const toolMsg = messages[i];
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolMsg.toolCallId!,
            content: toolMsg.content,
          });
          i++;
        }
        result.push({ role: 'user', content: toolResults });
      } else {
        i++;
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
    // Flatten tool results into assistant messages for Ollama (no native tool support)
    const messages = this.convertMessages(options.messages, options.systemPrompt);

    const res = await fetch(`${this.baseURL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages, stream: false }),
      signal: AbortSignal.timeout(120000),
    });

    if (!res.ok) throw new Error(`Ollama error: ${res.status} ${res.statusText}`);
    const data = await res.json() as { message?: { content?: string }; error?: string };
    if (data.error) throw new Error(`Ollama error: ${data.error}`);
    return { type: 'text', content: data.message?.content || '', toolCalls: [] };
  }

  async streamChat(options: ChatOptions, onChunk: (chunk: string) => void): Promise<void> {
    const messages = this.convertMessages(options.messages, options.systemPrompt);

    const res = await fetch(`${this.baseURL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages, stream: true }),
      signal: AbortSignal.timeout(120000),
    });

    if (!res.ok) throw new Error(`Ollama error: ${res.status} ${res.statusText}`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = decoder.decode(value, { stream: true }).split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const data = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
          if (data.message?.content) onChunk(data.message.content);
        } catch { /* skip malformed line */ }
      }
    }
  }

  private convertMessages(messages: Message[], systemPrompt: string) {
    const result: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
    ];
    for (const msg of messages) {
      if (msg.role === 'tool') {
        // Represent tool result as an assistant turn for Ollama
        result.push({ role: 'assistant', content: `[Tool result]\n${msg.content}` });
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        result.push({ role: msg.role, content: msg.content });
      }
    }
    return result;
  }
}

// ──────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────
function safeParseJSON(raw: string, toolName: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    // If the LLM emits malformed JSON, return the raw string under a key
    // so the tool handler can at least receive something meaningful
    console.warn(`[llm-client] Failed to parse tool arguments for "${toolName}": ${raw}`);
    return { _raw: raw };
  }
}
