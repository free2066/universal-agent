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
 * 统一的 models.json 配置缓存
 * 避免多次读取同一文件
 */
interface ModelsConfig {
  profiles?: Array<{ name?: string; displayName?: string; modelName?: string }>;
  agentModels?: Record<string, string>;
}

let configCache: ModelsConfig | null = null;

function loadModelsConfig(): ModelsConfig {
  if (configCache) return configCache;
  
  try {
    const configPath = resolve(homedir(), '.uagent', 'models.json');
    configCache = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    configCache = {};
  }
  
  return configCache;
}

/**
 * 模型名称映射缓存（友好名称 → 实际模型 ID）
 * 从 ~/.uagent/models.json 的 profiles 加载
 */
let modelNameCache: Map<string, string> | null = null;

function getModelNameCache(): Map<string, string> {
  if (modelNameCache) return modelNameCache;
  
  modelNameCache = new Map();
  
  const config = loadModelsConfig();
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

/**
 * Agent 模型自动映射配置
 * 从 ~/.uagent/models.json 的 agentModels 加载
 * 格式: { "claude-haiku-4-5": "glm-5", "claude-opus-4-6": "mimov2pro", ... }
 * 
 * 这样 OMC 更新时，agent 文件里的 claude-* 模型会自动替换为用户配置的模型
 */
let agentModelMapCache: Map<string, string> | null = null;

function getAgentModelMap(): Map<string, string> {
  if (agentModelMapCache) return agentModelMapCache;

  agentModelMapCache = new Map();

  const config = loadModelsConfig();
  // 从 agentModels 配置读取映射
  if (config.agentModels && typeof config.agentModels === 'object') {
    for (const [fromModel, toModel] of Object.entries(config.agentModels)) {
      if (fromModel && toModel) {
        agentModelMapCache.set(fromModel.toLowerCase(), toModel);
      }
    }
  }

  return agentModelMapCache;
}

/**
 * 解析 agent 模型名称：
 * - 如果 models.json 配置了 agentModels 映射表，用配置的模型替换
 * - 例如: "claude-haiku-4-5" → "glm-5" → "ep-vquxqj-..."
 * - 这样 OMC 更新 agent 时无需手动修改模型配置
 */
export function resolveAgentModel(model: string): string {
  const agentMap = getAgentModelMap();
  const mapped = agentMap.get(model.toLowerCase());
  if (mapped) {
    // 先映射，再解析友好名称
    return resolveModelName(mapped);
  }
  // 没有配置映射，直接解析友好名称
  return resolveModelName(model);
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

/**
 * 清除配置缓存（用于配置更新后重新加载）
 */
export function clearModelsConfigCache(): void {
  configCache = null;
  modelNameCache = null;
  agentModelMapCache = null;
}
