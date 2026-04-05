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
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let textContent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const lines = decoder.decode(value, { stream: true }).split('\n').filter(Boolean);
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

      return { type: 'text', content: textContent };
    });
  }

  private convertMessages(messages: Message[], systemPrompt: string) {
    const result: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
    ];
    for (const msg of messages) {
      if (msg.role === 'tool') {
        result.push({ role: 'assistant', content: `[Tool result]\n${msgText(msg.content)}` });
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        result.push({ role: msg.role, content: msgText(msg.content) });
      }
    }
    return result;
  }
}
