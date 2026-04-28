/**
 * models/llm/ollama.ts — Ollama 本地模型实现
 *
 * 支持：任何 Ollama 托管的模型（llama3, qwen2.5, phi4…）
 * 默认连接 http://localhost:11434
 * 使用：ollama:<model-name>
 */

import type { LLMClient, ChatOptions, ChatResponse, Message } from '../types.js';
import { withInferenceTimeout, msgText } from './shared.js';

export class OllamaClient implements LLMClient {
  private model: string;
  private baseURL: string;

  constructor(model: string) {
    this.model = model;
    this.baseURL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    // P2: use withInferenceTimeout + respect options.signal for abort (Ctrl+C)
    return withInferenceTimeout(this.model, async (inferSignal) => {
      const messages = this.convertMessages(options.messages, options.systemPrompt);
      const signal = options.signal
        ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([inferSignal, options.signal]) : inferSignal)
        : inferSignal;

      const res = await fetch(`${this.baseURL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, messages, stream: false }),
        signal,
      });

      if (!res.ok) throw new Error(`Ollama error: ${res.status} ${res.statusText}`);
      const data = await res.json() as { message?: { content?: string }; error?: string };
      if (data.error) throw new Error(`Ollama error: ${data.error}`);
      return { type: 'text', content: data.message?.content || '' };
    });
  }

  async streamChat(options: ChatOptions, onChunk: (chunk: string) => void): Promise<ChatResponse> {
    return withInferenceTimeout(this.model, async (signal) => {
      const messages = this.convertMessages(options.messages, options.systemPrompt);

      const res = await fetch(`${this.baseURL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, messages, stream: true }),
        signal,
      });

      if (!res.ok) throw new Error(`Ollama error: ${res.status} ${res.statusText}`);
      // P0: guard against null body; add finally to release reader on any exit path
      if (!res.body) throw new Error(`[Ollama] streamChat: response body is null for model ${this.model}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let textContent = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const lines = decoder.decode(value, { stream: true }).split('\n').filter((s): s is string => !!s);
          for (const line of lines) {
            try {
              const data = JSON.parse(line) as { message?: { content?: string } };
              if (data.message?.content) { onChunk(data.message.content); textContent += data.message.content; }
            } catch (err) {
              if (line.length > 2) {
                process.stderr.write(`[llm-client:ollama] Failed to parse chunk (${line.length} chars): ${String(err)}\n`);
              }
            }
          }
        }
      } finally {
        reader.cancel().catch(() => {});
      }

      return { type: 'text', content: textContent };
    });
  }

  private convertMessages(messages: Message[], systemPrompt: string) {
    const result: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
    ];
    for (const msg of messages) {
      if (msg.role === 'tool') {
        // LLM-9: tool results should be 'user' role (not 'assistant') for Ollama OpenAI-compat API.
        // 'assistant' is semantically wrong \u2014 the tool result comes from the tool/user, not the model.
        result.push({ role: 'user', content: `[Tool result]\n${msgText(msg.content)}` });
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        result.push({ role: msg.role, content: msgText(msg.content) });
      }
    }
    return result;
  }
}
