import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type {
  LLMClient,
  ChatOptions,
  ChatResponse,
  Message,
} from './types.js';

// ──────────────────────────────────────────
// Factory
// ──────────────────────────────────────────
export function createLLMClient(model: string): LLMClient {
  // Anthropic Claude
  if (model.startsWith('claude')) return new AnthropicClient(model);

  // Local Ollama
  if (model.startsWith('ollama:')) return new OllamaClient(model.replace('ollama:', ''));

  // Google Gemini
  if (model.startsWith('gemini')) return new GeminiClient(model);

  // DeepSeek (uses OpenAI-compat API)
  if (model.startsWith('deepseek')) return new DeepSeekClient(model);

  // kimi-k2 model name starts with 'kimi', not 'moonshot', so factory needs to handle both
  if (model.startsWith('kimi')) return new MoonshotClient(model);

  // Alibaba Qwen / Tongyi
  if (model.startsWith('qwen') || model.startsWith('tongyi')) return new QwenClient(model);

  // Mistral
  if (model.startsWith('mistral') || model.startsWith('mixtral')) return new MistralClient(model);

  // Groq (free tier — llama3/deepseek-r1/qwen, ultra-fast)
  if (model.startsWith('groq:')) return new GroqClient(model.replace('groq:', ''));

  // SiliconFlow (free open-source models)
  if (model.startsWith('siliconflow:')) return new SiliconFlowClient(model.replace('siliconflow:', ''));

  // OpenRouter (many free models via :free suffix)
  if (model.startsWith('openrouter:')) return new OpenRouterClient(model.replace('openrouter:', ''));

  // Generic OpenAI-compatible (any model name, custom baseURL via env)
  if (model.startsWith('openai-compat:')) {
    return new OpenAICompatClient(model.replace('openai-compat:', ''));
  }

  // Default: OpenAI
  return new OpenAIClient(model);
}

// ──────────────────────────────────────────
// OpenAI Client  (gpt-4o, gpt-4o-mini, o1…)
// ──────────────────────────────────────────
class OpenAIClient implements LLMClient {
  protected client: OpenAI;
  protected model: string;

  constructor(model: string, apiKey?: string, baseURL?: string) {
    this.model = model;
    this.client = new OpenAI({
      apiKey: apiKey ?? process.env.OPENAI_API_KEY,
      baseURL: baseURL ?? process.env.OPENAI_BASE_URL ?? undefined,
    });
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    const messages = this.convertMessages(options);
    const hasTools = (options.tools?.length ?? 0) > 0;

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
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
          arguments: safeParseJSON(tc.function.arguments, tc.function.name),
        })),
      };
    }

    return { type: 'text', content: msg.content || '' };
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

  protected convertMessages(options: ChatOptions): OpenAI.ChatCompletionMessageParam[] {
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
    }

    return messages;
  }
}

// ──────────────────────────────────────────
// DeepSeek  (deepseek-chat, deepseek-coder)
// OpenAI-compatible API at api.deepseek.com
// ──────────────────────────────────────────
class DeepSeekClient extends OpenAIClient {
  constructor(model: string) {
    super(
      model,
      process.env.DEEPSEEK_API_KEY,
      process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
    );
  }
}

// ──────────────────────────────────────────
// Moonshot / Kimi  (moonshot-v1-8k, etc.)
// ──────────────────────────────────────────
class MoonshotClient extends OpenAIClient {
  constructor(model: string) {
    super(
      model,
      process.env.MOONSHOT_API_KEY,
      process.env.MOONSHOT_BASE_URL ?? 'https://api.moonshot.cn/v1',
    );
  }
}

// ──────────────────────────────────────────
// Alibaba Qwen / Tongyi  (qwen-turbo, qwen-plus, qwen-max …)
// Uses DashScope OpenAI-compat endpoint
// ──────────────────────────────────────────
class QwenClient extends OpenAIClient {
  constructor(model: string) {
    super(
      model,
      process.env.DASHSCOPE_API_KEY ?? process.env.QWEN_API_KEY,
      process.env.QWEN_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
  }
}

// ──────────────────────────────────────────
// Mistral  (mistral-large, mixtral-8x7b …)
// ──────────────────────────────────────────
class MistralClient extends OpenAIClient {
  constructor(model: string) {
    super(
      model,
      process.env.MISTRAL_API_KEY,
      process.env.MISTRAL_BASE_URL ?? 'https://api.mistral.ai/v1',
    );
  }
}

// ──────────────────────────────────────────
// Generic OpenAI-Compatible
// Usage: openai-compat:my-model-name
// Set OPENAI_COMPAT_BASE_URL + OPENAI_COMPAT_API_KEY in env
// ──────────────────────────────────────────
class OpenAICompatClient extends OpenAIClient {
  constructor(model: string) {
    super(
      model,
      process.env.OPENAI_COMPAT_API_KEY ?? process.env.OPENAI_API_KEY,
      process.env.OPENAI_COMPAT_BASE_URL ?? process.env.OPENAI_BASE_URL,
    );
  }
}

// ──────────────────────────────────────────
// Anthropic Client  (claude-3-5-sonnet …)
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
    const hasTools = (options.tools?.length ?? 0) > 0;
    // Respect profile.maxTokens when available (falls back to 8192 for compatibility).
    // modelManager may not be available here (llm-client has no hard dep on it), so we
    // read from the environment variable ANTHROPIC_MAX_TOKENS as a soft override.
    const maxTokens = parseInt(process.env.ANTHROPIC_MAX_TOKENS ?? '8192', 10);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
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

    return { type: 'text', content: textBlocks.map((b) => b.text).join('') };
  }

  async streamChat(options: ChatOptions, onChunk: (chunk: string) => void): Promise<void> {
    const messages = this.convertMessages(options.messages);
    const maxTokens = parseInt(process.env.ANTHROPIC_MAX_TOKENS ?? '8192', 10);
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: maxTokens,
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
// Google Gemini  (gemini-1.5-pro, gemini-2.0-flash …)
// Uses Google AI REST API directly (no extra SDK required)
// ──────────────────────────────────────────
class GeminiClient implements LLMClient {
  private model: string;
  private apiKey: string;
  private baseURL: string;

  constructor(model: string) {
    this.model = model;
    this.apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '';
    this.baseURL = process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta';
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    const body = this.buildRequest(options);
    const url = `${this.baseURL}/models/${this.model}:generateContent?key=${this.apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gemini error ${res.status}: ${text}`);
    }

    const data = await res.json() as GeminiResponse;
    return this.parseResponse(data);
  }

  async streamChat(options: ChatOptions, onChunk: (chunk: string) => void): Promise<void> {
    const body = this.buildRequest(options);
    const url = `${this.baseURL}/models/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });

    if (!res.ok) throw new Error(`Gemini stream error: ${res.status}`);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = decoder.decode(value, { stream: true }).split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const chunk = JSON.parse(line.slice(6)) as GeminiResponse;
          const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) onChunk(text);
        } catch { /* skip */ }
      }
    }
  }

  private buildRequest(options: ChatOptions) {
    // Convert system prompt + messages to Gemini format
    // System instruction as a special "user" turn (Gemini uses systemInstruction field)
    const contents = options.messages.map((msg) => {
      const role = msg.role === 'assistant' ? 'model' : 'user';
      if (msg.role === 'tool') {
        return {
          role: 'user' as const,
          parts: [{ text: `[Tool result]\n${msg.content}` }],
        };
      }
      return { role: role as 'user' | 'model', parts: [{ text: msg.content }] };
    });

    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: options.systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: 8192 },
    };

    // Add tools if present
    if (options.tools?.length) {
      body.tools = [{
        functionDeclarations: options.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      }];
    }

    return body;
  }

  private parseResponse(data: GeminiResponse): ChatResponse {
    const parts = data.candidates?.[0]?.content?.parts ?? [];

    // Check for function calls
    const funcCalls = parts.filter((p) => p.functionCall);
    if (funcCalls.length) {
      // Use a unique suffix to avoid callId collision when multiple tool calls land
      // in the same millisecond (consistent with agent.ts callId fix).
      const callIdBase = `gemini-call-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      return {
        type: 'tool_calls',
        content: parts.filter((p) => p.text).map((p) => p.text ?? '').join(''),
        toolCalls: funcCalls.map((p, idx) => ({
          id: `${callIdBase}-${idx}`,
          name: p.functionCall!.name,
          arguments: p.functionCall!.args as Record<string, unknown>,
        })),
      };
    }

    const text = parts.filter((p) => p.text).map((p) => p.text ?? '').join('');
    return { type: 'text', content: text };
  }
}

// Gemini API types (minimal)
interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}
interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: unknown };
  functionResponse?: { name: string; response: unknown };
}
interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
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
    return { type: 'text', content: data.message?.content || '' };
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
          const data = JSON.parse(line) as { message?: { content?: string } };
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
// ──────────────────────────────────────────
// Groq  (llama3/deepseek-r1/qwen, free tier)
// OpenAI-compatible at api.groq.com/openai/v1
// Free: 14,400 req/day, ultra-fast inference
// Get key: https://console.groq.com
// ──────────────────────────────────────────
class GroqClient extends OpenAIClient {
  constructor(model: string) {
    super(
      model,
      process.env.GROQ_API_KEY,
      'https://api.groq.com/openai/v1',
    );
  }
}

// ──────────────────────────────────────────
// SiliconFlow  (many open-source models)
// OpenAI-compatible at api.siliconflow.cn/v1
// Free: 14M tokens/month on free tier
// Get key: https://siliconflow.cn
// ──────────────────────────────────────────
class SiliconFlowClient extends OpenAIClient {
  constructor(model: string) {
    super(
      model,
      process.env.SILICONFLOW_API_KEY,
      'https://api.siliconflow.cn/v1',
    );
  }
}

// ──────────────────────────────────────────
// OpenRouter  (aggregates many free models)
// OpenAI-compatible at openrouter.ai/api/v1
// Many models with :free suffix are entirely free
// Get key: https://openrouter.ai
// ──────────────────────────────────────────
//
// NOTE: This class does NOT extend OpenAIClient because the parent constructor
// always creates its own OpenAI client without defaultHeaders, and there is no
// clean way to pass defaultHeaders through super() with the current OpenAI SDK.
// Using composition avoids the "super() then hack override" anti-pattern.
class OpenRouterClient implements LLMClient {
  private client: OpenAI;
  private model: string;

  constructor(model: string) {
    this.model = model;
    // OpenRouter supports anonymous access — when no key is set we use the
    // string 'anonymous' as a placeholder so the OpenAI SDK still sends the
    // Authorization header (OpenRouter ignores it for anonymous requests).
    // The HTTP-Referer + X-Title headers are required by OpenRouter to identify the app.
    const apiKey = process.env.OPENROUTER_API_KEY || 'anonymous';
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/free2066/universal-agent',
        'X-Title': 'universal-agent',
      },
    });
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    const hasTools = (options.tools?.length ?? 0) > 0;
    const messages = this.convertMessages(options);
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      ...(hasTools ? {
        tools: options.tools!.map((t) => ({ type: 'function' as const, function: t })),
        tool_choice: 'auto' as const,
      } : {}),
    });

    const choice = response.choices[0];
    if (!choice) throw new Error('No choices returned from OpenRouter');
    const msg = choice.message;

    if (msg.tool_calls?.length) {
      return {
        type: 'tool_calls',
        content: msg.content || '',
        toolCalls: msg.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: safeParseJSON(tc.function.arguments, tc.function.name),
        })),
      };
    }

    return {
      type: 'text',
      content: msg.content ?? '',
    };
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

  /** Convert universal Message[] to OpenAI chat format */
  private convertMessages(options: ChatOptions): OpenAI.Chat.ChatCompletionMessageParam[] {
    const msgs: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (options.systemPrompt) {
      msgs.push({ role: 'system', content: options.systemPrompt });
    }
    for (const m of options.messages) {
      if (m.role === 'tool') {
        msgs.push({ role: 'tool', content: String(m.content), tool_call_id: m.toolCallId ?? '' });
      } else if (m.role === 'assistant' && m.toolCalls?.length) {
        msgs.push({
          role: 'assistant',
          content: m.content as string | null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        });
      } else {
        msgs.push({ role: m.role as 'user' | 'assistant', content: m.content as string });
      }
    }
    return msgs;
  }
}

function safeParseJSON(raw: string, toolName: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    console.warn(`[llm-client] Failed to parse tool arguments for "${toolName}": ${raw}`);
    return { _raw: raw };
  }
}
