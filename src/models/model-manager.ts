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
      // ── OpenAI ───────────────────────────────────────
      { name: 'gpt-4o',              provider: 'openai',   modelName: 'gpt-4o',                      maxTokens: 8192,  contextLength: 128000,  costPer1kInput: 0.0025,  costPer1kOutput: 0.01,     isActive: true },
      { name: 'gpt-4o-mini',         provider: 'openai',   modelName: 'gpt-4o-mini',                 maxTokens: 4096,  contextLength: 128000,  costPer1kInput: 0.00015, costPer1kOutput: 0.0006,   isActive: true },
      { name: 'o1',                  provider: 'openai',   modelName: 'o1',                          maxTokens: 32768, contextLength: 200000,  costPer1kInput: 0.015,   costPer1kOutput: 0.06,     isActive: true },
      { name: 'o3-mini',             provider: 'openai',   modelName: 'o3-mini',                     maxTokens: 65536, contextLength: 200000,  costPer1kInput: 0.0011,  costPer1kOutput: 0.0044,   isActive: true },
      // ── Anthropic ────────────────────────────────────
      { name: 'claude-3-5-sonnet',   provider: 'anthropic', modelName: 'claude-3-5-sonnet-20241022', maxTokens: 8192,  contextLength: 200000,  costPer1kInput: 0.003,   costPer1kOutput: 0.015,    isActive: true },
      { name: 'claude-3-5-haiku',    provider: 'anthropic', modelName: 'claude-3-5-haiku-20241022',  maxTokens: 8192,  contextLength: 200000,  costPer1kInput: 0.0008,  costPer1kOutput: 0.004,    isActive: true },
      { name: 'claude-3-opus',       provider: 'anthropic', modelName: 'claude-3-opus-20240229',     maxTokens: 4096,  contextLength: 200000,  costPer1kInput: 0.015,   costPer1kOutput: 0.075,    isActive: true },
      { name: 'claude-3-haiku',      provider: 'anthropic', modelName: 'claude-3-haiku-20240307',    maxTokens: 4096,  contextLength: 200000,  costPer1kInput: 0.00025, costPer1kOutput: 0.00125,  isActive: true },
      // ── Google Gemini ─────────────────────────────────
      { name: 'gemini-2.0-flash',    provider: 'gemini',   modelName: 'gemini-2.0-flash',            maxTokens: 8192,  contextLength: 1048576, costPer1kInput: 0.00015, costPer1kOutput: 0.0006,   isActive: true },
      { name: 'gemini-1.5-pro',      provider: 'gemini',   modelName: 'gemini-1.5-pro',              maxTokens: 8192,  contextLength: 2097152, costPer1kInput: 0.00125, costPer1kOutput: 0.005,    isActive: true },
      { name: 'gemini-1.5-flash',    provider: 'gemini',   modelName: 'gemini-1.5-flash',            maxTokens: 8192,  contextLength: 1048576, costPer1kInput: 0.000075,costPer1kOutput: 0.0003,   isActive: true },
      // ── DeepSeek ─────────────────────────────────────
      { name: 'deepseek-chat',       provider: 'deepseek', modelName: 'deepseek-chat',               maxTokens: 8192,  contextLength: 64000,   costPer1kInput: 0.00014, costPer1kOutput: 0.00028,  isActive: true },
      { name: 'deepseek-reasoner',   provider: 'deepseek', modelName: 'deepseek-reasoner',           maxTokens: 32768, contextLength: 64000,   costPer1kInput: 0.00055, costPer1kOutput: 0.00219,  isActive: true },
      // ── Moonshot / Kimi ───────────────────────────────
      { name: 'moonshot-v1-8k',      provider: 'moonshot', modelName: 'moonshot-v1-8k',              maxTokens: 4096,  contextLength: 8192,    costPer1kInput: 0.00012, costPer1kOutput: 0.00012,  isActive: true },
      { name: 'moonshot-v1-32k',     provider: 'moonshot', modelName: 'moonshot-v1-32k',             maxTokens: 8192,  contextLength: 32768,   costPer1kInput: 0.00024, costPer1kOutput: 0.00024,  isActive: true },
      { name: 'moonshot-v1-128k',    provider: 'moonshot', modelName: 'moonshot-v1-128k',            maxTokens: 8192,  contextLength: 131072,  costPer1kInput: 0.0006,  costPer1kOutput: 0.0006,   isActive: true },
      // ── Alibaba Qwen / Tongyi ─────────────────────────
      { name: 'qwen-max',            provider: 'qwen',     modelName: 'qwen-max',                    maxTokens: 8192,  contextLength: 32768,   costPer1kInput: 0.0016,  costPer1kOutput: 0.0016,   isActive: true },
      { name: 'qwen-plus',           provider: 'qwen',     modelName: 'qwen-plus',                   maxTokens: 8192,  contextLength: 131072,  costPer1kInput: 0.0004,  costPer1kOutput: 0.0004,   isActive: true },
      { name: 'qwen-turbo',          provider: 'qwen',     modelName: 'qwen-turbo',                  maxTokens: 8192,  contextLength: 1000000, costPer1kInput: 0.00006, costPer1kOutput: 0.00006,  isActive: true },
      { name: 'qwq-32b',             provider: 'qwen',     modelName: 'qwq-32b',                     maxTokens: 8192,  contextLength: 131072,  costPer1kInput: 0.0006,  costPer1kOutput: 0.0018,   isActive: true },
      // ── Mistral ───────────────────────────────────────
      { name: 'mistral-large',       provider: 'mistral',  modelName: 'mistral-large-latest',        maxTokens: 8192,  contextLength: 128000,  costPer1kInput: 0.002,   costPer1kOutput: 0.006,    isActive: true },
      { name: 'mistral-small',       provider: 'mistral',  modelName: 'mistral-small-latest',        maxTokens: 8192,  contextLength: 32000,   costPer1kInput: 0.001,   costPer1kOutput: 0.003,    isActive: true },
      { name: 'mixtral-8x7b',        provider: 'mistral',  modelName: 'open-mixtral-8x7b',           maxTokens: 8192,  contextLength: 32000,   costPer1kInput: 0.0007,  costPer1kOutput: 0.0007,   isActive: true },
      // ── Ollama (local) ────────────────────────────────
      { name: 'ollama:llama3',       provider: 'ollama',   modelName: 'llama3',                      maxTokens: 4096,  contextLength: 8192,    costPer1kInput: 0,       costPer1kOutput: 0,        isActive: true },
      { name: 'ollama:qwen2.5',      provider: 'ollama',   modelName: 'qwen2.5',                     maxTokens: 4096,  contextLength: 32768,   costPer1kInput: 0,       costPer1kOutput: 0,        isActive: true },
      { name: 'ollama:deepseek-r1',  provider: 'ollama',   modelName: 'deepseek-r1',                 maxTokens: 8192,  contextLength: 32768,   costPer1kInput: 0,       costPer1kOutput: 0,        isActive: true },
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
        case 'moonshot': return profile.modelName; // starts with 'moonshot'
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
        : modelName.startsWith('moonshot') || modelName.startsWith('kimi') ? 'moonshot'
        : modelName.startsWith('qwen') || modelName.startsWith('tongyi') ? 'qwen'
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
