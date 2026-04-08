// @ts-nocheck
/**
 * models/llm/gemini.ts — Google Gemini 实现
 *
 * 支持：gemini-1.5-pro, gemini-2.0-flash, gemini-2.5-pro…
 * 使用 Google AI REST API 直接调用（无需额外 SDK）。
 * 支持 thinkingConfig.thinkingBudget（Gemini 2.0/2.5）。
 */

import type { LLMClient, ChatOptions, ChatResponse } from '../types.js';
import { withInferenceTimeout, THINKING_BUDGETS, msgText } from './shared.js';

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

export class GeminiClient implements LLMClient {
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

  async streamChat(options: ChatOptions, onChunk: (chunk: string) => void): Promise<ChatResponse> {
    return withInferenceTimeout(this.model, async (signal) => {
      const body = this.buildRequest(options);
      const url = `${this.baseURL}/models/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) throw new Error(`Gemini stream error: ${res.status}`);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let textContent = '';
      const toolCallsAccum: GeminiPart[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const lines = decoder.decode(value, { stream: true }).split('\n');
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const chunk = JSON.parse(line.slice(6)) as GeminiResponse;
            const parts = chunk.candidates?.[0]?.content?.parts ?? [];
            for (const part of parts) {
              if (part.text) { onChunk(part.text); textContent += part.text; }
              if (part.functionCall) toolCallsAccum.push(part);
            }
          } catch (err) {
            if (line.length > 16) {
              process.stderr.write(`[llm-client:gemini] Failed to parse SSE chunk (${line.length} chars): ${String(err)}\n`);
            }
          }
        }
      }

      if (toolCallsAccum.length > 0) {
        const callIdBase = `gemini-call-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        return {
          type: 'tool_calls',
          content: textContent,
          toolCalls: toolCallsAccum.map((p, idx) => ({
            id: `${callIdBase}-${idx}`,
            name: p.functionCall!.name,
            arguments: p.functionCall!.args as Record<string, unknown>,
          })),
        };
      }

      return { type: 'text', content: textContent };
    });
  }

  /**
   * Sanitize a JSON Schema object for Gemini compatibility.
   *
   * Gemini's function-calling API is stricter than OpenAI's and rejects several
   * common schema patterns. Based on opencode/packages/opencode/src/provider/transform.ts:
   *
   * 1. Integer enums → convert to string enum (Gemini only accepts string enums)
   * 2. Array items missing type → add "type: string"
   * 3. Properties of non-object/non-array types → strip (Gemini ignores them,
   *    but some providers 400 on unexpected fields)
   * 4. additionalProperties → strip (not supported by Gemini)
   * 5. $schema → strip
   */
  private sanitizeGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
    if (!schema || typeof schema !== 'object') return schema;

    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(schema)) {
      // Strip fields Gemini doesn't accept
      if (key === '$schema' || key === 'additionalProperties') continue;

      if (key === 'type' && value === 'integer') {
        // Gemini doesn't support 'integer' type — use 'number' instead
        result[key] = 'number';
        continue;
      }

      if (key === 'enum' && Array.isArray(value)) {
        // Convert all enum values to strings (Gemini only supports string enums)
        result[key] = value.map((v) => String(v));
        continue;
      }

      if (key === 'properties' && typeof value === 'object' && value !== null) {
        // Recursively sanitize each property definition
        const props: Record<string, unknown> = {};
        for (const [propKey, propVal] of Object.entries(value as Record<string, unknown>)) {
          props[propKey] = this.sanitizeGeminiSchema(propVal as Record<string, unknown>);
        }
        result[key] = props;
        continue;
      }

      if (key === 'items' && typeof value === 'object' && value !== null) {
        const items = value as Record<string, unknown>;
        // Ensure items has a type field (Gemini requires it)
        const sanitized = this.sanitizeGeminiSchema(items);
        if (!sanitized.type) sanitized.type = 'string';
        result[key] = sanitized;
        continue;
      }

      if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
        // Flatten to the first non-null variant — Gemini doesn't support union types
        const variants = value as unknown[];
        const nonNull = variants.filter((v: any) => v?.type !== 'null');
        if (nonNull.length === 1) {
          // Merge the single variant into the parent
          const merged = this.sanitizeGeminiSchema(nonNull[0] as Record<string, unknown>);
          Object.assign(result, merged);
          continue;
        }
        // Multiple variants — keep as-is and let Gemini error if unsupported
        result[key] = variants.map((v) => this.sanitizeGeminiSchema(v as Record<string, unknown>));
        continue;
      }

      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        result[key] = this.sanitizeGeminiSchema(value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  private buildRequest(options: ChatOptions) {
    const contents = options.messages.map((msg) => {
      const role = msg.role === 'assistant' ? 'model' : 'user';
      if (msg.role === 'tool') {
        return {
          role: 'user' as const,
          parts: [{ text: `[Tool result]\n${msgText(msg.content)}` }],
        };
      }
      return { role: role as 'user' | 'model', parts: [{ text: msgText(msg.content) }] };
    });

    const generationConfig: Record<string, unknown> = { maxOutputTokens: 8192 };
    if (options.thinkingLevel) {
      const budgetTokens = THINKING_BUDGETS[options.thinkingLevel] ?? 1024;
      generationConfig.thinkingConfig = { thinkingBudget: budgetTokens };
    }

    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: options.systemPrompt }] },
      contents,
      generationConfig,
    };

    if (options.tools?.length) {
      body.tools = [{
        functionDeclarations: options.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: this.sanitizeGeminiSchema(t.parameters as Record<string, unknown>),
        })),
      }];
    }

    return body;
  }

  private parseResponse(data: GeminiResponse): ChatResponse {
    const parts = data.candidates?.[0]?.content?.parts ?? [];

    const funcCalls = parts.filter((p) => p.functionCall);
    if (funcCalls.length) {
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
