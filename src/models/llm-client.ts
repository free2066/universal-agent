import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type {
  LLMClient,
  ChatOptions,
  ChatResponse,
  Message,
} from './types.js';

/** Map thinking level → budget tokens (used by Anthropic + Gemini) */
const THINKING_BUDGETS: Record<string, number> = { low: 1024, medium: 8000, high: 16000 };
/** Map thinking level → OpenAI reasoning_effort string (o1/o3/o4 series) */
const REASONING_EFFORT: Record<string, string> = { low: 'low', medium: 'medium', high: 'high' };

/**
 * Inference timeout for streaming LLM calls.
 *
 * Problem: AbortSignal.timeout(N) on fetch() only covers the FIRST chunk.
 * Once streaming begins, reader.read() / for-await loops run indefinitely
 * if the server hangs or stops sending data without closing the connection.
 * This causes agent sessions to freeze permanently (observed with MiMo-V2-Pro
 * and other third-party OpenAI-compat endpoints that silently stall mid-stream).
 *
 * Fix: wrap the entire streamChat body in withInferenceTimeout(), which installs
 * a hard AbortController that fires after INFERENCE_TIMEOUT_MS regardless of
 * whether data has been flowing. Both the initial fetch AND the stream loop
 * are cancelled atomically when the timer fires.
 *
 * Default: 3 minutes. Override with env var UAGENT_INFERENCE_TIMEOUT_MS.
 */
const _parsed = parseInt(process.env.UAGENT_INFERENCE_TIMEOUT_MS ?? '', 10);
/**
 * Hard wall-clock timeout for streaming LLM calls.
 * If UAGENT_INFERENCE_TIMEOUT_MS is set but not a valid positive integer
 * (e.g. "abc", "0", negative), we fall back to the 3-minute default rather
 * than silently setting the timer to 0/NaN (which would abort every request
 * immediately or behave non-deterministically).
 */
const INFERENCE_TIMEOUT_MS = Number.isFinite(_parsed) && _parsed > 0 ? _parsed : 3 * 60 * 1000;

/**
 * Run `fn(signal)` with a hard wall-clock timeout.
 * Throws an error with a user-friendly message when the timeout fires.
 * The AbortController is shared — pass `signal` to fetch() so both
 * the connection and the stream loop are cancelled together.
 */
async function withInferenceTimeout<T>(
  model: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new Error(
        `[llm-client] Inference timeout after ${INFERENCE_TIMEOUT_MS / 1000}s — ` +
        `model "${model}" did not complete streaming. ` +
        `Increase timeout with UAGENT_INFERENCE_TIMEOUT_MS env var.`,
      ),
    );
  }, INFERENCE_TIMEOUT_MS);
  try {
    return await fn(controller.signal);
  } catch (err) {
    // Re-wrap AbortError with a friendlier message so it surfaces clearly in UI
    if (err instanceof Error && err.name === 'AbortError') {
      const reason = controller.signal.reason;
      throw reason instanceof Error ? reason : new Error(String(reason ?? err.message));
    }
    throw err;
  } finally {
    clearTimeout(timer);
    // Always abort the controller on exit — whether fn completed normally, threw,
    // or was timed-out.  Without this, a successfully-completed fetch() keeps the
    // underlying TCP socket alive until GC collects the AbortController, which can
    // exhaust connection-pool slots under rapid successive requests (e.g. subagent
    // parallel runs).  Aborting after completion is a no-op for the caller but
    // signals to fetch's internal machinery to release the connection immediately.
    if (!controller.signal.aborted) {
      controller.abort();
    }
  }
}

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

  // 万擎 (Wanqing) internal API — model IDs start with 'ep-' or 'api-'
  // Uses WQ_API_KEY + OPENAI_BASE_URL from env.
  if (model.startsWith('ep-') || model.startsWith('api-') || model.startsWith('wanqing-')) {
    const key = process.env.WQ_API_KEY ?? process.env.OPENAI_API_KEY;
    const base = process.env.OPENAI_BASE_URL;
    return new OpenAIClient(model, key, base);
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
      // Key priority: explicit arg → WQ_API_KEY (万擎) → OPENAI_API_KEY
      apiKey: apiKey ?? process.env.WQ_API_KEY ?? process.env.OPENAI_API_KEY,
      baseURL: baseURL ?? process.env.OPENAI_BASE_URL ?? undefined,
    });
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    const messages = this.convertMessages(options);
    const hasTools = (options.tools?.length ?? 0) > 0;
    const isReasoning = /^o\d/.test(this.model.split('/').pop() ?? this.model);
    const extraOpts: Record<string, unknown> = {};
    if (options.thinkingLevel && isReasoning) {
      extraOpts.reasoning_effort = options.thinkingLevel; // 'low'|'medium'|'high' all valid
    }

    const response = (await this.client.chat.completions.create({
      model: this.model,
      messages,
      ...extraOpts,
      ...(hasTools ? {
        tools: options.tools!.map((t) => ({ type: 'function' as const, function: t })),
        tool_choice: 'auto' as const,
      } : {}),
    } as OpenAI.ChatCompletionCreateParamsNonStreaming)) as OpenAI.ChatCompletion;

    const choice = response.choices[0];
    if (!choice) throw new Error('No choices returned from OpenAI');
    const msg = choice.message;

    if (msg.tool_calls?.length) {
      return {
        type: 'tool_calls',
        content: msg.content || '',
        toolCalls: msg.tool_calls.map((tc: OpenAI.ChatCompletionMessageToolCall) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: safeParseJSON(tc.function.arguments, tc.function.name),
        })),
      };
    }

    return { type: 'text', content: msg.content || '' };
  }

  async streamChat(options: ChatOptions, onChunk: (chunk: string) => void): Promise<void> {
    return withInferenceTimeout(this.model, async (signal) => {
      const messages = this.convertMessages(options);
      const isReasoning = /^o\d/.test(this.model.split('/').pop() ?? this.model);
      const extraOpts: Record<string, unknown> = {};
      if (options.thinkingLevel && isReasoning) {
        extraOpts.reasoning_effort = options.thinkingLevel;
      }
      // Pass AbortSignal via httpAgent option — OpenAI SDK v4 accepts signal in
      // the request options object (second argument to create()).
      const stream = (await this.client.chat.completions.create(
        {
          model: this.model,
          messages,
          stream: true,
          ...extraOpts,
        } as OpenAI.ChatCompletionCreateParamsStreaming,
        { signal },
      )) as unknown as AsyncIterable<OpenAI.ChatCompletionChunk>;
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) onChunk(delta);
      }
    });
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
// DeepSeek  (deepseek-chat, deepseek-coder, deepseek-reasoner)
// OpenAI-compatible API at api.deepseek.com
// deepseek-reasoner supports thinking via extra body param
// ──────────────────────────────────────────
class DeepSeekClient extends OpenAIClient {
  constructor(model: string) {
    super(
      model,
      process.env.DEEPSEEK_API_KEY,
      process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
    );
  }

  override async chat(options: ChatOptions): Promise<ChatResponse> {
    const isReasoner = this.model.includes('reasoner') || this.model.includes('r1');
    if (isReasoner && options.thinkingLevel) {
      const messages = this.convertMessages(options);
      const hasTools = (options.tools?.length ?? 0) > 0;
      const response = (await this.client.chat.completions.create({
        model: this.model,
        messages,
        ...(hasTools ? {
          tools: options.tools!.map((t) => ({ type: 'function' as const, function: t })),
          tool_choice: 'auto' as const,
        } : {}),
      } as OpenAI.ChatCompletionCreateParamsNonStreaming)) as OpenAI.ChatCompletion;
      const choice = response.choices[0];
      if (!choice) throw new Error('No choices from DeepSeek');
      const msg = choice.message;
      if (msg.tool_calls?.length) {
        return {
          type: 'tool_calls',
          content: msg.content || '',
          toolCalls: msg.tool_calls.map((tc: OpenAI.ChatCompletionMessageToolCall) => ({
            id: tc.id,
            name: tc.function.name,
            arguments: safeParseJSON(tc.function.arguments, tc.function.name),
          })),
        };
      }
      return { type: 'text', content: msg.content || '' };
    }
    return super.chat(options);
  }

  override async streamChat(options: ChatOptions, onChunk: (chunk: string) => void): Promise<void> {
    const isReasoner = this.model.includes('reasoner') || this.model.includes('r1');
    if (isReasoner && options.thinkingLevel) {
      return withInferenceTimeout(this.model, async (signal) => {
        const messages = this.convertMessages(options);
        const stream = (await this.client.chat.completions.create(
          {
            model: this.model,
            messages,
            stream: true,
          } as OpenAI.ChatCompletionCreateParamsStreaming,
          { signal },
        )) as unknown as AsyncIterable<OpenAI.ChatCompletionChunk>;
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta as { content?: string; reasoning_content?: string };
          if (delta?.content) onChunk(delta.content);
        }
      });
    }
    return super.streamChat(options, onChunk);
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
// Alibaba Qwen / Tongyi  (qwen-turbo, qwen-plus, qwen-max, qwen3-* …)
// Uses DashScope OpenAI-compat endpoint
// Qwen3 models support enable_thinking=true for extended thinking
// ──────────────────────────────────────────
class QwenClient extends OpenAIClient {
  constructor(model: string) {
    super(
      model,
      process.env.DASHSCOPE_API_KEY ?? process.env.QWEN_API_KEY,
      process.env.QWEN_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
  }

  /** Qwen3 models support enable_thinking via extra_body */
  private isThinkingCapable(): boolean {
    return /^qwen3|qwq/i.test(this.model);
  }

  override async streamChat(options: ChatOptions, onChunk: (chunk: string) => void): Promise<void> {
    if (this.isThinkingCapable() && options.thinkingLevel) {
      return withInferenceTimeout(this.model, async (signal) => {
        const messages = this.convertMessages(options);
        const stream = (await this.client.chat.completions.create(
          {
            model: this.model,
            messages,
            stream: true,
            extra_body: { enable_thinking: true },
          } as OpenAI.ChatCompletionCreateParamsStreaming,
          { signal },
        )) as unknown as AsyncIterable<OpenAI.ChatCompletionChunk>;
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta as { content?: string; reasoning_content?: string };
          if (delta?.content) onChunk(delta.content);
        }
      });
    }
    return super.streamChat(options, onChunk);
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
    const maxTokens = parseInt(process.env.ANTHROPIC_MAX_TOKENS ?? '8192', 10);
    const thinking = options.thinkingLevel;
    const budgets: Record<string, number> = { low: 1024, medium: 8000, high: 16000 };
    const budgetTokens = thinking ? budgets[thinking] ?? 1024 : undefined;
    // Extended thinking requires a higher max_tokens (must exceed budget_tokens)
    const effectiveMax = budgetTokens ? Math.max(maxTokens, budgetTokens + 1024) : maxTokens;

    const msg = await this.client.messages.create({
      model: this.model,
      max_tokens: effectiveMax,
      system: options.systemPrompt,
      messages,
      ...(budgetTokens ? {
        thinking: { type: 'enabled', budget_tokens: budgetTokens },
        betas: ['interleaved-thinking-2025-05-14'],
      } : {}),
      ...(hasTools ? {
        tools: options.tools!.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters as Anthropic.Tool['input_schema'],
        })),
      } : {}),
    } as Parameters<typeof this.client.messages.create>[0]) as Anthropic.Message;

    const toolUseBlocks = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    const textBlocks    = msg.content.filter((b): b is Anthropic.TextBlock    => b.type === 'text');

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
    return withInferenceTimeout(this.model, async (_signal) => {
      // Note: Anthropic SDK uses its own internal AbortController; we can't inject
      // our signal directly into messages.stream(). The outer withInferenceTimeout
      // will still abort after the TTL by throwing, which unwinds the for-await loop.
      const messages = this.convertMessages(options.messages);
      const maxTokens = parseInt(process.env.ANTHROPIC_MAX_TOKENS ?? '8192', 10);
      const thinking = options.thinkingLevel;
      const budgets: Record<string, number> = { low: 1024, medium: 8000, high: 16000 };
      const budgetTokens = thinking ? budgets[thinking] ?? 1024 : undefined;
      const effectiveMax = budgetTokens ? Math.max(maxTokens, budgetTokens + 1024) : maxTokens;

      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: effectiveMax,
        system: options.systemPrompt,
        messages,
        ...(budgetTokens ? {
          thinking: { type: 'enabled', budget_tokens: budgetTokens },
          betas: ['interleaved-thinking-2025-05-14'],
        } : {}),
      } as Parameters<typeof this.client.messages.stream>[0]);
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          onChunk(event.delta.text);
        }
        // thinking_delta — we don't stream it to user, but it still counts toward context
      }
    });
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
    return withInferenceTimeout(this.model, async (signal) => {
      const body = this.buildRequest(options);
      const url = `${this.baseURL}/models/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        // Compose with per-chunk connection timeout; inference timeout covers the whole stream
        signal,
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
          } catch (err) {
            // Debug only — malformed SSE lines are expected (empty lines, keep-alive pings, etc.).
            // Only log if it looks like non-trivial content (length > 10) to avoid log spam.
            if (line.length > 16) {
              process.stderr.write(`[llm-client:gemini] Failed to parse SSE chunk (${line.length} chars): ${String(err)}\n`);
            }
          }
        }
      }
    });
  }

  private buildRequest(options: ChatOptions) {
    // Convert system prompt + messages to Gemini format
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

    const generationConfig: Record<string, unknown> = { maxOutputTokens: 8192 };
    // Gemini 2.0 Flash / 2.5 support thinkingConfig.thinkingBudget
    if (options.thinkingLevel) {
      const budgetTokens = THINKING_BUDGETS[options.thinkingLevel] ?? 1024;
      generationConfig.thinkingConfig = { thinkingBudget: budgetTokens };
    }

    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: options.systemPrompt }] },
      contents,
      generationConfig,
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
    return withInferenceTimeout(this.model, async (signal) => {
      const messages = this.convertMessages(options.messages, options.systemPrompt);

      const res = await fetch(`${this.baseURL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, messages, stream: true }),
        signal,
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
          } catch (err) {
            // Ollama may emit incomplete JSON fragments at chunk boundaries — log
            // at debug level so operators can diagnose persistent parse failures.
            if (line.length > 2) {
              process.stderr.write(`[llm-client:ollama] Failed to parse chunk (${line.length} chars): ${String(err)}\n`);
            }
          }
        }
      }
    });
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
    return withInferenceTimeout(this.model, async (signal) => {
      const messages = this.convertMessages(options);
      const stream = await this.client.chat.completions.create(
        { model: this.model, messages, stream: true },
        { signal },
      );
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) onChunk(delta);
      }
    });
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
