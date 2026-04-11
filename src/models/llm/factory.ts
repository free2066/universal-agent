/**
 * models/llm/factory.ts — LLM 客户端工厂函数
 *
 * 根据模型名称前缀路由到正确的 Provider 实现。
 */

import type { LLMClient } from '../types.js';
import { OpenAIClient, DeepSeekClient, MoonshotClient, QwenClient, MistralClient, GroqClient, SiliconFlowClient, OpenAICompatClient, OpenRouterClient } from './openai.js';
import { AnthropicClient } from './anthropic.js';
import { GeminiClient } from './gemini.js';
import { OllamaClient } from './ollama.js';

export function createLLMClient(model: string): LLMClient {
  if (!model) return new OpenAIClient(model);

  const m = model.toLowerCase();

  // Anthropic Claude
  if (m.startsWith('claude')) return new AnthropicClient(model);

  // Local Ollama
  if (m.startsWith('ollama:')) return new OllamaClient(model.slice('ollama:'.length));

  // Google Gemini
  if (m.startsWith('gemini')) return new GeminiClient(model);

  // DeepSeek (uses OpenAI-compat API)
  if (m.startsWith('deepseek')) return new DeepSeekClient(model);

  // Moonshot / Kimi — LLM-1: also route moonshot-v1-* prefix
  if (m.startsWith('kimi') || m.startsWith('moonshot')) return new MoonshotClient(model);

  // Alibaba Qwen / Tongyi
  if (m.startsWith('qwen') || m.startsWith('tongyi')) return new QwenClient(model);

  // Mistral
  if (m.startsWith('mistral') || m.startsWith('mixtral')) return new MistralClient(model);

  // Groq (free tier — llama3/deepseek-r1/qwen, ultra-fast)
  if (m.startsWith('groq:')) return new GroqClient(model.slice('groq:'.length));

  // SiliconFlow (free open-source models)
  if (m.startsWith('siliconflow:')) return new SiliconFlowClient(model.slice('siliconflow:'.length));

  // OpenRouter (many free models via :free suffix)
  if (m.startsWith('openrouter:')) return new OpenRouterClient(model.slice('openrouter:'.length));

  // Generic OpenAI-compatible (any model name, custom baseURL via env)
  if (m.startsWith('openai-compat:')) {
    return new OpenAICompatClient(model.slice('openai-compat:'.length));
  }

  // 万擎 (Wanqing) internal API
  const wqKey = process.env.WQ_API_KEY ?? process.env.OPENAI_API_KEY;
  const wqBase = process.env.OPENAI_BASE_URL;
  if (m.startsWith('wanqing/')) {
    return new OpenAIClient(model.slice('wanqing/'.length), wqKey, wqBase);
  }
  if (m.startsWith('ep-') || m.startsWith('wanqing-')) {
    return new OpenAIClient(model, wqKey, wqBase);
  }

  // Default: OpenAI
  return new OpenAIClient(model);
}
