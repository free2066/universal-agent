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
  // Anthropic Claude
  if (model.startsWith('claude')) return new AnthropicClient(model);

  // Local Ollama
  if (model.startsWith('ollama:')) return new OllamaClient(model.replace('ollama:', ''));

  // Google Gemini
  if (model.startsWith('gemini')) return new GeminiClient(model);

  // DeepSeek (uses OpenAI-compat API)
  if (model.startsWith('deepseek')) return new DeepSeekClient(model);

  // Moonshot / Kimi — LLM-1: also route moonshot-v1-* prefix
  if (model.startsWith('kimi') || model.startsWith('moonshot')) return new MoonshotClient(model);

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

  // 万擎 (Wanqing) internal API
  if (model.startsWith('wanqing/')) {
    const actualModel = model.slice('wanqing/'.length);
    const key = process.env.WQ_API_KEY ?? process.env.OPENAI_API_KEY;
    const base = process.env.OPENAI_BASE_URL;
    return new OpenAIClient(actualModel, key, base);
  }
  if (model.startsWith('ep-') || model.startsWith('api-') || model.startsWith('wanqing-')) {
    const key = process.env.WQ_API_KEY ?? process.env.OPENAI_API_KEY;
    const base = process.env.OPENAI_BASE_URL;
    return new OpenAIClient(model, key, base);
  }

  // Default: OpenAI
  return new OpenAIClient(model);
}
