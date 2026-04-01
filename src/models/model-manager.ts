import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { stringify as yamlStringify } from 'yaml';
import { createLLMClient } from './llm-client.js';
import type { LLMClient } from './types.js';

export interface ModelProfile {
  name: string;
  provider: 'openai' | 'anthropic' | 'ollama' | 'gemini' | 'deepseek' | 'moonshot' | 'qwen' | 'mistral' | 'custom';
  modelName: string;
  apiKey?: string;
  baseURL?: string;
  maxTokens: number;
  contextLength: number;
  costPer1kInput: number;   // USD
  costPer1kOutput: number;  // USD
  isActive: boolean;
}

export interface ModelPointers {
  main: string;    // primary model
  task: string;    // subagent model
  compact: string; // context compression
  quick: string;   // lightweight fast queries
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
  timestamp: number;
}

const CONFIG_DIR = resolve(process.env.HOME || '~', '.uagent');
const CONFIG_FILE = resolve(CONFIG_DIR, 'models.json');

export class ModelManager {
  private profiles: Map<string, ModelProfile> = new Map();
  private pointers: ModelPointers = {
    main: 'gpt-4o',
    task: 'gpt-4o-mini',
    compact: 'gpt-4o-mini',
    quick: 'gpt-4o-mini',
  };
  private usageHistory: TokenUsage[] = [];
  private sessionCost = 0;
  private sessionInputTokens = 0;
  private sessionOutputTokens = 0;

  constructor() {
    this.loadDefaults();
    this.loadFromDisk();
  }

  private loadDefaults() {
    const defaults: ModelProfile[] = [
      // ── OpenAI ─────────────────────────────────────────────────────────────────────
      // Latest flagship: GPT-4.1 series (April 2025)
      { name: 'gpt-4.1',            provider: 'openai',    modelName: 'gpt-4.1',                     maxTokens: 32768, contextLength: 1000000, costPer1kInput: 0.002,   costPer1kOutput: 0.008,    isActive: true },
      { name: 'gpt-4.1-mini',       provider: 'openai',    modelName: 'gpt-4.1-mini',                maxTokens: 32768, contextLength: 1000000, costPer1kInput: 0.0004,  costPer1kOutput: 0.0016,   isActive: true },
      { name: 'gpt-4.1-nano',       provider: 'openai',    modelName: 'gpt-4.1-nano',                maxTokens: 32768, contextLength: 1000000, costPer1kInput: 0.0001,  costPer1kOutput: 0.0004,   isActive: true },
      // o-series reasoning models
      { name: 'o3',                  provider: 'openai',    modelName: 'o3',                          maxTokens: 100000,contextLength: 200000,  costPer1kInput: 0.01,    costPer1kOutput: 0.04,     isActive: true },
      { name: 'o4-mini',             provider: 'openai',    modelName: 'o4-mini',                     maxTokens: 65536, contextLength: 200000,  costPer1kInput: 0.0011,  costPer1kOutput: 0.0044,   isActive: true },
      // Legacy (keep for compatibility)
      { name: 'gpt-4o',              provider: 'openai',    modelName: 'gpt-4o',                      maxTokens: 8192,  contextLength: 128000,  costPer1kInput: 0.0025,  costPer1kOutput: 0.01,     isActive: true },
      { name: 'gpt-4o-mini',         provider: 'openai',    modelName: 'gpt-4o-mini',                 maxTokens: 4096,  contextLength: 128000,  costPer1kInput: 0.00015, costPer1kOutput: 0.0006,   isActive: true },

      // ── Anthropic ──────────────────────────────────────────────────────────────────
      // Claude 4 series (May 2025)
      { name: 'claude-opus-4',       provider: 'anthropic', modelName: 'claude-opus-4-5',             maxTokens: 32768, contextLength: 200000,  costPer1kInput: 0.015,   costPer1kOutput: 0.075,    isActive: true },
      { name: 'claude-sonnet-4',     provider: 'anthropic', modelName: 'claude-sonnet-4-5',           maxTokens: 16384, contextLength: 200000,  costPer1kInput: 0.003,   costPer1kOutput: 0.015,    isActive: true },
      // Claude 3.5 series (legacy)
      { name: 'claude-3-5-sonnet',   provider: 'anthropic', modelName: 'claude-3-5-sonnet-20241022',  maxTokens: 8192,  contextLength: 200000,  costPer1kInput: 0.003,   costPer1kOutput: 0.015,    isActive: true },
      { name: 'claude-3-5-haiku',    provider: 'anthropic', modelName: 'claude-3-5-haiku-20241022',   maxTokens: 8192,  contextLength: 200000,  costPer1kInput: 0.0008,  costPer1kOutput: 0.004,    isActive: true },

      // ── Google Gemini ──────────────────────────────────────────────────────────────
      // Gemini 2.5 series (latest, 2025)
      { name: 'gemini-2.5-pro',      provider: 'gemini',    modelName: 'gemini-2.5-pro',              maxTokens: 65536, contextLength: 1048576, costPer1kInput: 0.00125, costPer1kOutput: 0.01,     isActive: true },
      { name: 'gemini-2.5-flash',    provider: 'gemini',    modelName: 'gemini-2.5-flash',            maxTokens: 65536, contextLength: 1048576, costPer1kInput: 0.00015, costPer1kOutput: 0.0006,   isActive: true },
      { name: 'gemini-2.5-flash-lite', provider: 'gemini',  modelName: 'gemini-2.5-flash-lite',       maxTokens: 32768, contextLength: 1048576, costPer1kInput: 0.000075,costPer1kOutput: 0.0003,   isActive: true },
      // Legacy
      { name: 'gemini-2.0-flash',    provider: 'gemini',    modelName: 'gemini-2.0-flash',            maxTokens: 8192,  contextLength: 1048576, costPer1kInput: 0.00015, costPer1kOutput: 0.0006,   isActive: true },

      // ── DeepSeek ───────────────────────────────────────────────────────────────────
      // V3.2 is the latest (Dec 2025); API IDs remain deepseek-chat / deepseek-reasoner
      { name: 'deepseek-chat',       provider: 'deepseek',  modelName: 'deepseek-chat',               maxTokens: 8192,  contextLength: 128000,  costPer1kInput: 0.00027, costPer1kOutput: 0.0011,   isActive: true },
      { name: 'deepseek-reasoner',   provider: 'deepseek',  modelName: 'deepseek-reasoner',           maxTokens: 32768, contextLength: 128000,  costPer1kInput: 0.00055, costPer1kOutput: 0.00219,  isActive: true },

      // ── Moonshot / Kimi ────────────────────────────────────────────────────────────
      // Kimi K2 (July 2025) — latest flagship MoE model
      { name: 'kimi-k2',             provider: 'moonshot',  modelName: 'kimi-k2',                     maxTokens: 16384, contextLength: 131072,  costPer1kInput: 0.0006,  costPer1kOutput: 0.0025,   isActive: true },
      { name: 'moonshot-v1-128k',    provider: 'moonshot',  modelName: 'moonshot-v1-128k',            maxTokens: 8192,  contextLength: 131072,  costPer1kInput: 0.0006,  costPer1kOutput: 0.0006,   isActive: true },
      { name: 'moonshot-v1-32k',     provider: 'moonshot',  modelName: 'moonshot-v1-32k',             maxTokens: 8192,  contextLength: 32768,   costPer1kInput: 0.00024, costPer1kOutput: 0.00024,  isActive: true },

      // ── Alibaba Qwen3 / Tongyi ─────────────────────────────────────────────────────
      // Qwen3 series (April 2025)
      { name: 'qwen3-235b',          provider: 'qwen',      modelName: 'qwen3-235b-a22b',             maxTokens: 16384, contextLength: 131072,  costPer1kInput: 0.0004,  costPer1kOutput: 0.0016,   isActive: true },
      { name: 'qwen3-72b',           provider: 'qwen',      modelName: 'qwen3-72b',                   maxTokens: 16384, contextLength: 131072,  costPer1kInput: 0.0002,  costPer1kOutput: 0.0006,   isActive: true },
      { name: 'qwen3-30b',           provider: 'qwen',      modelName: 'qwen3-30b-a3b',               maxTokens: 16384, contextLength: 131072,  costPer1kInput: 0.00012, costPer1kOutput: 0.0005,   isActive: true },
      { name: 'qwen3-8b',            provider: 'qwen',      modelName: 'qwen3-8b',                    maxTokens: 8192,  contextLength: 131072,  costPer1kInput: 0.00004, costPer1kOutput: 0.00016,  isActive: true },
      // qwen-max / qwq (kept as aliases)
      { name: 'qwen-max',            provider: 'qwen',      modelName: 'qwen-max',                    maxTokens: 8192,  contextLength: 32768,   costPer1kInput: 0.0016,  costPer1kOutput: 0.0016,   isActive: true },
      { name: 'qwq-32b',             provider: 'qwen',      modelName: 'qwq-32b',                     maxTokens: 8192,  contextLength: 131072,  costPer1kInput: 0.0006,  costPer1kOutput: 0.0018,   isActive: true },

      // ── Mistral ────────────────────────────────────────────────────────────────────
      // Medium 3.1 (Aug 2025) and Large are the current flagships
      { name: 'mistral-medium-3',    provider: 'mistral',   modelName: 'mistral-medium-2508',         maxTokens: 16384, contextLength: 128000,  costPer1kInput: 0.0004,  costPer1kOutput: 0.002,    isActive: true },
      { name: 'mistral-large',       provider: 'mistral',   modelName: 'mistral-large-latest',        maxTokens: 8192,  contextLength: 128000,  costPer1kInput: 0.002,   costPer1kOutput: 0.006,    isActive: true },
      { name: 'mistral-small',       provider: 'mistral',   modelName: 'mistral-small-latest',        maxTokens: 8192,  contextLength: 32000,   costPer1kInput: 0.0002,  costPer1kOutput: 0.0006,   isActive: true },

      // ── Ollama (local) ─────────────────────────────────────────────────────────────
      { name: 'ollama:llama3.3',     provider: 'ollama',    modelName: 'llama3.3',                    maxTokens: 8192,  contextLength: 131072,  costPer1kInput: 0,       costPer1kOutput: 0,        isActive: true },
      { name: 'ollama:qwen3',        provider: 'ollama',    modelName: 'qwen3',                       maxTokens: 8192,  contextLength: 131072,  costPer1kInput: 0,       costPer1kOutput: 0,        isActive: true },
      { name: 'ollama:deepseek-r1',  provider: 'ollama',    modelName: 'deepseek-r1',                 maxTokens: 8192,  contextLength: 32768,   costPer1kInput: 0,       costPer1kOutput: 0,        isActive: true },
      { name: 'ollama:gemma3',       provider: 'ollama',    modelName: 'gemma3',                      maxTokens: 8192,  contextLength: 131072,  costPer1kInput: 0,       costPer1kOutput: 0,        isActive: true },
    ];
    for (const p of defaults) this.profiles.set(p.name, p);
  }

  private loadFromDisk() {
    if (!existsSync(CONFIG_FILE)) return;
    try {
      const data = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
      if (data.profiles) {
        for (const p of data.profiles) this.profiles.set(p.name, p);
      }
      if (data.pointers) this.pointers = { ...this.pointers, ...data.pointers };
    } catch { /* ignore */ }
  }

  saveToDisk() {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify({
      profiles: Array.from(this.profiles.values()),
      pointers: this.pointers,
    }, null, 2));
  }

  getClient(pointer: keyof ModelPointers = 'main'): LLMClient {
    const modelName = this.pointers[pointer];
    const profile = this.profiles.get(modelName);
    if (!profile) return createLLMClient(modelName);
    // Build the model string the factory expects
    const factoryId = (() => {
      switch (profile.provider) {
        case 'ollama':   return `ollama:${profile.modelName}`;
        case 'gemini':   return profile.modelName; // starts with 'gemini'
        case 'deepseek': return profile.modelName; // starts with 'deepseek'
        case 'moonshot': return profile.modelName.startsWith('kimi') ? profile.modelName : profile.modelName;
        case 'qwen':     return profile.modelName; // starts with 'qwen'
        case 'mistral':  return profile.modelName; // starts with 'mistral'/'mixtral'
        case 'custom':   return `openai-compat:${profile.modelName}`;
        default:         return profile.modelName; // openai / anthropic
      }
    })();
    return createLLMClient(factoryId);
  }

  getCurrentModel(pointer: keyof ModelPointers = 'main'): string {
    return this.pointers[pointer];
  }

  setPointer(pointer: keyof ModelPointers, modelName: string) {
    if (!this.profiles.has(modelName)) {
      // Auto-create profile — infer provider from model name prefix
      const provider = modelName.startsWith('claude') ? 'anthropic'
        : modelName.startsWith('gemini') ? 'gemini'
        : modelName.startsWith('deepseek') ? 'deepseek'
        : modelName.startsWith('moonshot') || modelName.startsWith('kimi') || modelName.startsWith('kimi-k') ? 'moonshot'
        : modelName.startsWith('qwen') || modelName.startsWith('qwq') || modelName.startsWith('tongyi') ? 'qwen'
        : modelName.startsWith('mistral') || modelName.startsWith('mixtral') ? 'mistral'
        : modelName.startsWith('ollama:') ? 'ollama'
        : 'openai';
      this.profiles.set(modelName, {
        name: modelName, provider, modelName,
        maxTokens: 8192, contextLength: 128000, costPer1kInput: 0, costPer1kOutput: 0, isActive: true,
      });
    }
    this.pointers[pointer] = modelName;
    this.saveToDisk();
  }

  addProfile(profile: ModelProfile) {
    this.profiles.set(profile.name, profile);
    this.saveToDisk();
  }

  listProfiles(): ModelProfile[] {
    return Array.from(this.profiles.values()).filter(p => p.isActive);
  }

  getPointers(): ModelPointers {
    return { ...this.pointers };
  }

  recordUsage(inputTokens: number, outputTokens: number, model: string) {
    const profile = this.profiles.get(model) ||
      Array.from(this.profiles.values()).find(p => p.modelName === model);
    const costIn = (inputTokens / 1000) * (profile?.costPer1kInput || 0);
    const costOut = (outputTokens / 1000) * (profile?.costPer1kOutput || 0);
    this.sessionCost += costIn + costOut;
    this.sessionInputTokens += inputTokens;
    this.sessionOutputTokens += outputTokens;
    this.usageHistory.push({ inputTokens, outputTokens, model, timestamp: Date.now() });
  }

  getCostSummary(): string {
    const lines = [
      `📊 Session Token Usage:`,
      `  Input tokens:  ${this.sessionInputTokens.toLocaleString()}`,
      `  Output tokens: ${this.sessionOutputTokens.toLocaleString()}`,
      `  Total cost:    $${this.sessionCost.toFixed(4)}`,
      ``,
      `📌 Model Pointers:`,
      `  main:    ${this.pointers.main}`,
      `  task:    ${this.pointers.task}`,
      `  compact: ${this.pointers.compact}`,
      `  quick:   ${this.pointers.quick}`,
    ];
    return lines.join('\n');
  }

  exportYAML(): string {
    return yamlStringify({
      version: 1,
      profiles: Array.from(this.profiles.values()).map(p => ({
        ...p,
        apiKey: p.apiKey ? { fromEnv: `${p.provider.toUpperCase()}_API_KEY` } : undefined,
      })),
      pointers: this.pointers,
    });
  }

  cycleMainModel(): string {
    const active = this.listProfiles().map(p => p.name);
    if (!active.length) return this.pointers.main;
    const idx = active.indexOf(this.pointers.main);
    const next = active[(idx + 1) % active.length];
    this.pointers.main = next;
    this.saveToDisk();
    return next;
  }
}

// Singleton
export const modelManager = new ModelManager();
