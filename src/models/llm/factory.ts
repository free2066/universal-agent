/**
 * models/llm/factory.ts — LLM 客户端工厂函数
 *
 * 根据模型名称前缀路由到正确的 Provider 实现。
 * 支持友好名称映射（从 ~/.uagent/models.json 读取 displayName → 实际模型 ID）
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';
import type { LLMClient } from '../types.js';
import { OpenAIClient, DeepSeekClient, MoonshotClient, QwenClient, MistralClient, GroqClient, SiliconFlowClient, OpenAICompatClient, OpenRouterClient } from './openai.js';
import { AnthropicClient } from './anthropic.js';
import { GeminiClient } from './gemini.js';
import { OllamaClient } from './ollama.js';

/**
 * 模型名称映射缓存（友好名称 → 实际模型 ID）
 * 从 ~/.uagent/models.json 的 profiles 加载
 */
let modelNameCache: Map<string, string> | null = null;

function getModelNameCache(): Map<string, string> {
  if (modelNameCache) return modelNameCache;
  
  modelNameCache = new Map();
  
  try {
    const configPath = resolve(homedir(), '.uagent', 'models.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    
    if (config.profiles && Array.isArray(config.profiles)) {
      for (const profile of config.profiles) {
        // 映射 name 和 displayName（如果有）指向实际模型名
        if (profile.name && profile.modelName) {
          modelNameCache.set(profile.name.toLowerCase(), profile.modelName);
        }
        if (profile.displayName && profile.modelName) {
          modelNameCache.set(profile.displayName.toLowerCase(), profile.modelName);
        }
      }
    }
  } catch {
    // 忽略读取错误，使用空映射
  }
  
  return modelNameCache;
}

/**
 * 解析模型名称：
 * 1. 如果是友好名称，返回实际模型 ID
 * 2. 否则返回原名称
 */
function resolveModelName(model: string): string {
  const cache = getModelNameCache();
  const resolved = cache.get(model.toLowerCase());
  return resolved || model;
}

export function createLLMClient(model: string): LLMClient {
  if (!model) return new OpenAIClient(model);

  // 解析友好名称（如 "glm5" → "ep-vquxqj-..."）
  const resolvedModel = resolveModelName(model);

  const m = resolvedModel.toLowerCase();

  // Anthropic Claude
  if (m.startsWith('claude')) return new AnthropicClient(resolvedModel);

  // Local Ollama
  if (m.startsWith('ollama:')) return new OllamaClient(resolvedModel.slice('ollama:'.length));

  // Google Gemini
  if (m.startsWith('gemini')) return new GeminiClient(resolvedModel);

  // DeepSeek (uses OpenAI-compat API)
  if (m.startsWith('deepseek')) return new DeepSeekClient(resolvedModel);

  // Moonshot / Kimi — LLM-1: also route moonshot-v1-* prefix
  if (m.startsWith('kimi') || m.startsWith('moonshot')) return new MoonshotClient(resolvedModel);

  // Alibaba Qwen / Tongyi
  if (m.startsWith('qwen') || m.startsWith('tongyi')) return new QwenClient(resolvedModel);

  // Mistral
  if (m.startsWith('mistral') || m.startsWith('mixtral')) return new MistralClient(resolvedModel);

  // Groq (free tier — llama3/deepseek-r1/qwen, ultra-fast)
  if (m.startsWith('groq:')) return new GroqClient(resolvedModel.slice('groq:'.length));

  // SiliconFlow (free open-source models)
  if (m.startsWith('siliconflow:')) return new SiliconFlowClient(resolvedModel.slice('siliconflow:'.length));

  // OpenRouter (many free models via :free suffix)
  if (m.startsWith('openrouter:')) return new OpenRouterClient(resolvedModel.slice('openrouter:'.length));

  // Generic OpenAI-compatible (any model name, custom baseURL via env)
  if (m.startsWith('openai-compat:')) {
    return new OpenAICompatClient(resolvedModel.slice('openai-compat:'.length));
  }

  // 万擎 (Wanqing) internal API
  const wqKey = process.env.WQ_API_KEY ?? process.env.OPENAI_API_KEY;
  const wqBase = process.env.OPENAI_BASE_URL;
  if (m.startsWith('wanqing/')) {
    return new OpenAIClient(resolvedModel.slice('wanqing/'.length), wqKey, wqBase);
  }
  if (m.startsWith('ep-') || m.startsWith('wanqing-')) {
    return new OpenAIClient(resolvedModel, wqKey, wqBase);
  }

  // Default: OpenAI
  return new OpenAIClient(resolvedModel);
}
