// @ts-nocheck
/**
 * models/llm/openai.ts — OpenAI 及兼容 Provider 实现
 *
 * 包含：
 *  - OpenAIClient        (gpt-4o, gpt-4o-mini, o1, o3, o4…)
 *  - DeepSeekClient      (deepseek-chat, deepseek-reasoner)
 *  - MoonshotClient      (moonshot-v1-8k, kimi-k2…)
 *  - QwenClient          (qwen-turbo, qwen3-*…)
 *  - MistralClient       (mistral-large, mixtral…)
 *  - GroqClient          (llama3, deepseek-r1 via Groq)
 *  - SiliconFlowClient   (open-source via siliconflow.cn)
 *  - OpenAICompatClient  (generic openai-compat: prefix)
 *  - OpenRouterClient    (many free models via openrouter.ai)
 */

import OpenAI from 'openai';
import type { LLMClient, ChatOptions, ChatResponse, Message } from '../types.js';
import { withInferenceTimeout, safeParseJSON, toOpenAIUserContent, msgText } from './shared.js';

// ── OpenAI ────────────────────────────────────────────────────────────────────

export class OpenAIClient implements LLMClient {
  protected client: OpenAI;
  protected model: string;

  constructor(model: string, apiKey?: string, baseURL?: string) {
    this.model = model;
    this.client = new OpenAI({
      apiKey: apiKey ?? process.env.WQ_API_KEY ?? process.env.OPENAI_API_KEY,
      baseURL: baseURL ?? process.env.OPENAI_BASE_URL ?? undefined,
      timeout: parseInt(process.env.UAGENT_CONNECT_TIMEOUT_MS || '30000', 10), // 30s default
    });
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    return withInferenceTimeout(this.model, async (signal) => {
      const messages = this.convertMessages(options);
      const hasTools = (options.tools?.length ?? 0) > 0;
      const isReasoning = /^o\d/.test(this.model.split('/').pop() ?? this.model);
      const extraOpts: Record<string, unknown> = {};
      if (options.thinkingLevel && isReasoning) {
        const effortMap: Record<string, string> = {
          low: 'low', medium: 'medium', high: 'high',
          max: 'high', xhigh: 'high', maxOrXhigh: 'high',
        };
        extraOpts.reasoning_effort = effortMap[options.thinkingLevel] ?? options.thinkingLevel;
      }

      const response = (await this.client.chat.completions.create({
        model: this.model,
        messages,
        ...extraOpts,
        ...(hasTools ? {
          tools: options.tools!.map((t) => ({ type: 'function' as const, function: t })),
          tool_choice: 'auto' as const,
        } : {}),
      } as OpenAI.ChatCompletionCreateParamsNonStreaming, { signal })) as OpenAI.ChatCompletion;

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
    });
  }

  async streamChat(options: ChatOptions, onChunk: (chunk: string) => void): Promise<ChatResponse> {
    return withInferenceTimeout(this.model, async (inferSignal) => {
      // Merge inference timeout signal with caller's AbortSignal (e.g. user Ctrl+C)
      const signal = options.signal
        ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([inferSignal, options.signal]) : inferSignal)
        : inferSignal;
      const messages = this.convertMessages(options);
      const hasTools = (options.tools?.length ?? 0) > 0;
      const isReasoning = /^o\d/.test(this.model.split('/').pop() ?? this.model);
      const extraOpts: Record<string, unknown> = {};
      if (options.thinkingLevel && isReasoning) {
        const effortMap: Record<string, string> = {
          low: 'low', medium: 'medium', high: 'high',
          max: 'high', xhigh: 'high', maxOrXhigh: 'high',
        };
        extraOpts.reasoning_effort = effortMap[options.thinkingLevel] ?? options.thinkingLevel;
      }

      const stream = (await this.client.chat.completions.create(
        {
          model: this.model,
          messages,
          stream: true,
          ...extraOpts,
          ...(hasTools ? {
            tools: options.tools!.map((t) => ({ type: 'function' as const, function: t })),
            tool_choice: 'auto' as const,
          } : {}),
        } as OpenAI.ChatCompletionCreateParamsStreaming,
        { signal },
      )) as unknown as AsyncIterable<OpenAI.ChatCompletionChunk>;

      let textContent = '';
      const toolCallMap = new Map<number, { id: string; name: string; args: string }>();

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta as {
          content?: string;
          reasoning_content?: string;
          tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
        };
        if (!delta) continue;

        if (delta.content) {
          onChunk(delta.content);
          textContent += delta.content;
        } else if ((delta as any).reasoning_content) {
          // GLM-5/MiMo: reasoning phase only emits reasoning_content, not content.
          // Call onChunk with empty string so downstream stream generators (buildRealStreamResult)
          // don't deadlock waiting for the first real-content chunk.
          onChunk('');
        }

        const toolCallDeltas = delta.tool_calls;
        if (toolCallDeltas) {
          for (const tc of toolCallDeltas) {
            if (!toolCallMap.has(tc.index)) {
              toolCallMap.set(tc.index, { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' });
            } else {
              const entry = toolCallMap.get(tc.index);
              if (entry) {
                if (tc.id) entry.id = tc.id;
                if (tc.function?.name) entry.name = tc.function.name;
              }
            }
            if (tc.function?.arguments) {
              const e = toolCallMap.get(tc.index);
              if (e) e.args += tc.function.arguments;
            }
          }
        }
      }

      if (toolCallMap.size > 0) {
        const toolCalls = Array.from(toolCallMap.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([, tc]) => ({
            id: tc.id,
            name: tc.name,
            arguments: safeParseJSON(tc.args, tc.name),
          }));
        return { type: 'tool_calls', content: textContent, toolCalls };
      }

      return { type: 'text', content: textContent };
    });
  }

  protected convertMessages(options: ChatOptions): OpenAI.ChatCompletionMessageParam[] {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: options.systemPrompt },
    ];

    for (const msg of options.messages) {
      if (msg.role === 'tool') {
        // LLM-10: toolCallId is optional; skip with a warning rather than passing undefined
        if (!msg.toolCallId) {
          process.stderr.write(`[llm-client:openai] Skipping tool message with missing toolCallId (content: ${String(msg.content).slice(0, 60)})\n`);
          continue;
        }
        messages.push({
          role: 'tool',
          tool_call_id: msg.toolCallId,
          content: msgText(msg.content),
        });
      } else if (msg.role === 'assistant' && msg.toolCalls?.length) {
        messages.push({
          role: 'assistant',
          content: msgText(msg.content) || null,
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        });
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({ role: msg.role, content: toOpenAIUserContent(msg.content) as string });
      }
    }
    return messages;
  }
}

// ── DeepSeek ──────────────────────────────────────────────────────────────────

export class DeepSeekClient extends OpenAIClient {
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
      // LLM-4: wrap reasoner branch in withInferenceTimeout to prevent indefinite hang
      return withInferenceTimeout(this.model, async (signal) => {
        const messages = this.convertMessages(options);
        const hasTools = (options.tools?.length ?? 0) > 0;
        const response = (await this.client.chat.completions.create({
          model: this.model,
          messages,
          ...(hasTools ? {
            tools: options.tools!.map((t) => ({ type: 'function' as const, function: t })),
            tool_choice: 'auto' as const,
          } : {}),
        } as OpenAI.ChatCompletionCreateParamsNonStreaming, { signal })) as OpenAI.ChatCompletion;
        const choice = response.choices[0];
        if (!choice) throw new Error('No choices from DeepSeek');
        const msg = choice.message;
        if (msg.tool_calls?.length) {
          return {
            type: 'tool_calls',
            content: typeof msg.content === 'string' ? msg.content || '' : '',
            toolCalls: msg.tool_calls.map((tc: OpenAI.ChatCompletionMessageToolCall) => ({
              id: tc.id,
              name: tc.function.name,
              arguments: safeParseJSON(tc.function.arguments, tc.function.name),
            })),
          };
        }
        return { type: 'text', content: typeof msg.content === 'string' ? msg.content || '' : '' };
      });
    }
    return super.chat(options);
  }

  override async streamChat(options: ChatOptions, onChunk: (chunk: string) => void): Promise<ChatResponse> {
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
        let textContent = '';
        const toolCallMap = new Map<number, { id: string; name: string; args: string }>();
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta as {
            content?: string;
            reasoning_content?: string;
            tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
          };
          if (delta?.content) { onChunk(delta.content); textContent += delta.content; }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (!toolCallMap.has(tc.index)) {
                toolCallMap.set(tc.index, { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' });
              } else {
                const entry = toolCallMap.get(tc.index);
                if (entry) {
                  if (tc.id) entry.id = tc.id;
                  if (tc.function?.name) entry.name = tc.function.name;
                }
              }
              if (tc.function?.arguments) {
                const e = toolCallMap.get(tc.index);
                if (e) e.args += tc.function.arguments;
              }
            }
          }
        }
        if (toolCallMap.size > 0) {
          const toolCalls = Array.from(toolCallMap.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([, tc]) => ({ id: tc.id, name: tc.name, arguments: safeParseJSON(tc.args, tc.name) }));
          return { type: 'tool_calls', content: textContent, toolCalls };
        }
        return { type: 'text', content: textContent };
      });
    }
    return super.streamChat(options, onChunk);
  }
}

// ── Moonshot / Kimi ───────────────────────────────────────────────────────────

export class MoonshotClient extends OpenAIClient {
  constructor(model: string) {
    super(
      model,
      process.env.MOONSHOT_API_KEY,
      process.env.MOONSHOT_BASE_URL ?? 'https://api.moonshot.cn/v1',
    );
  }
}

// ── Alibaba Qwen / Tongyi ─────────────────────────────────────────────────────

export class QwenClient extends OpenAIClient {
  constructor(model: string) {
    super(
      model,
      process.env.DASHSCOPE_API_KEY ?? process.env.QWEN_API_KEY,
      process.env.QWEN_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
  }

  private isThinkingCapable(): boolean {
    return /^qwen3|qwq/i.test(this.model);
  }

  override async streamChat(options: ChatOptions, onChunk: (chunk: string) => void): Promise<ChatResponse> {
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
        let textContent = '';
        const toolCallMap = new Map<number, { id: string; name: string; args: string }>();
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta as {
            content?: string;
            reasoning_content?: string;
            tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
          };
          if (delta?.content) { onChunk(delta.content); textContent += delta.content; }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (!toolCallMap.has(tc.index)) {
                toolCallMap.set(tc.index, { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' });
              } else {
                const entry = toolCallMap.get(tc.index);
                if (entry) {
                  if (tc.id) entry.id = tc.id;
                  if (tc.function?.name) entry.name = tc.function.name;
                }
              }
              if (tc.function?.arguments) {
                const e = toolCallMap.get(tc.index);
                if (e) e.args += tc.function.arguments;
              }
            }
          }
        }
        if (toolCallMap.size > 0) {
          const toolCalls = Array.from(toolCallMap.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([, tc]) => ({ id: tc.id, name: tc.name, arguments: safeParseJSON(tc.args, tc.name) }));
          return { type: 'tool_calls', content: textContent, toolCalls };
        }
        return { type: 'text', content: textContent };
      });
    }
    return super.streamChat(options, onChunk);
  }
}

// ── Mistral ───────────────────────────────────────────────────────────────────

export class MistralClient extends OpenAIClient {
  constructor(model: string) {
    super(
      model,
      process.env.MISTRAL_API_KEY,
      process.env.MISTRAL_BASE_URL ?? 'https://api.mistral.ai/v1',
    );
  }
}

// ── Groq (free tier) ──────────────────────────────────────────────────────────

export class GroqClient extends OpenAIClient {
  constructor(model: string) {
    super(
      model,
      process.env.GROQ_API_KEY,
      'https://api.groq.com/openai/v1',
    );
  }
}

// ── SiliconFlow ───────────────────────────────────────────────────────────────

export class SiliconFlowClient extends OpenAIClient {
  constructor(model: string) {
    super(
      model,
      process.env.SILICONFLOW_API_KEY,
      'https://api.siliconflow.cn/v1',
    );
  }
}

// ── Generic OpenAI-Compatible ─────────────────────────────────────────────────

export class OpenAICompatClient extends OpenAIClient {
  constructor(model: string) {
    super(
      model,
      process.env.OPENAI_COMPAT_API_KEY ?? process.env.OPENAI_API_KEY,
      process.env.OPENAI_COMPAT_BASE_URL ?? process.env.OPENAI_BASE_URL,
    );
  }
}

// ── OpenRouter ────────────────────────────────────────────────────────────────

export class OpenRouterClient implements LLMClient {
  private client: OpenAI;
  private model: string;

  constructor(model: string) {
    this.model = model;
    // LLM-2: OpenRouter no longer supports anonymous access (HTTP 401 without a key).
    // Fail fast with a clear error rather than silently sending 'anonymous'.
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        '[OpenRouterClient] OPENROUTER_API_KEY is not set. ' +
        'Get a free key at https://openrouter.ai/keys and set it in ~/.uagent/.env',
      );
    }
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
    // LLM-3: wrap in withInferenceTimeout to match streamChat and prevent indefinite hang
    return withInferenceTimeout(this.model, async (signal) => {
      const hasTools = (options.tools?.length ?? 0) > 0;
      const messages = this._convertMessages(options);
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages,
        ...(hasTools ? {
          tools: options.tools!.map((t) => ({ type: 'function' as const, function: t })),
          tool_choice: 'auto' as const,
        } : {}),
      } as OpenAI.ChatCompletionCreateParamsNonStreaming, { signal });

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

      return { type: 'text', content: msg.content || '' };
    });
  }

  async streamChat(options: ChatOptions, onChunk: (chunk: string) => void): Promise<ChatResponse> {
    return withInferenceTimeout(this.model, async (inferSignal) => {
      // Merge inference timeout signal with caller's AbortSignal (e.g. user Ctrl+C)
      const signal = options.signal
        ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([inferSignal, options.signal]) : inferSignal)
        : inferSignal;
      const hasTools = (options.tools?.length ?? 0) > 0;
      const messages = this._convertMessages(options);
      const stream = await this.client.chat.completions.create(
        {
          model: this.model, messages, stream: true,
          ...(hasTools ? {
            tools: options.tools!.map((t) => ({ type: 'function' as const, function: t })),
            tool_choice: 'auto' as const,
          } : {}),
        },
        { signal },
      );
      let textContent = '';
      const toolCallMap = new Map<number, { id: string; name: string; args: string }>();
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (delta.content) { onChunk(delta.content); textContent += delta.content; }
        const tcDeltas = (delta as { tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }).tool_calls;
        if (tcDeltas) {
          for (const tc of tcDeltas) {
            if (!toolCallMap.has(tc.index)) {
              toolCallMap.set(tc.index, { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' });
            } else {
              const e = toolCallMap.get(tc.index);
              if (e) { if (tc.id) e.id = tc.id; if (tc.function?.name) e.name = tc.function.name; }
            }
            if (tc.function?.arguments) {
              const e = toolCallMap.get(tc.index);
              if (e) e.args += tc.function.arguments;
            }
          }
        }
      }
      if (toolCallMap.size > 0) {
        return { type: 'tool_calls', content: textContent, toolCalls: Array.from(toolCallMap.entries()).sort((a, b) => a[0] - b[0]).map(([, tc]) => ({ id: tc.id, name: tc.name, arguments: safeParseJSON(tc.args, tc.name) })) };
      }
      return { type: 'text', content: textContent };
    });
  }

  private _convertMessages(options: ChatOptions): OpenAI.Chat.ChatCompletionMessageParam[] {
    const msgs: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (options.systemPrompt) {
      msgs.push({ role: 'system', content: options.systemPrompt });
    }
    for (const m of options.messages) {
      if (m.role === 'tool') {
        // Skip tool messages with missing toolCallId — an empty string causes API invalid_request_error
        if (!m.toolCallId) {
          process.stderr.write(`[llm-client:openrouter] Skipping tool message with missing toolCallId (content: ${String(m.content).slice(0, 60)})\n`);
          continue;
        }
        msgs.push({ role: 'tool', content: msgText(m.content), tool_call_id: m.toolCallId });
      } else if (m.role === 'assistant' && m.toolCalls?.length) {
        msgs.push({
          role: 'assistant',
          content: typeof m.content === 'string' ? m.content || null : null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        });
      } else {
        msgs.push({ role: m.role as 'user' | 'assistant', content: toOpenAIUserContent(m.content) as string });
      }
    }
    return msgs;
  }
}
