import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { stringify as yamlStringify } from 'yaml';
import { createLLMClient } from './llm-client.js';
import type { LLMClient } from './types.js';

export interface ModelProfile {
  name: string;
  provider: 'openai' | 'anthropic' | 'ollama' | 'custom';
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
      { name: 'gpt-4o', provider: 'openai', modelName: 'gpt-4o', maxTokens: 8192, contextLength: 128000, costPer1kInput: 0.0025, costPer1kOutput: 0.01, isActive: true },
      { name: 'gpt-4o-mini', provider: 'openai', modelName: 'gpt-4o-mini', maxTokens: 4096, contextLength: 128000, costPer1kInput: 0.00015, costPer1kOutput: 0.0006, isActive: true },
      { name: 'claude-3-5-sonnet', provider: 'anthropic', modelName: 'claude-3-5-sonnet-20241022', maxTokens: 8192, contextLength: 200000, costPer1kInput: 0.003, costPer1kOutput: 0.015, isActive: true },
      { name: 'claude-3-haiku', provider: 'anthropic', modelName: 'claude-3-haiku-20240307', maxTokens: 4096, contextLength: 200000, costPer1kInput: 0.00025, costPer1kOutput: 0.00125, isActive: true },
      { name: 'ollama:llama3', provider: 'ollama', modelName: 'llama3', maxTokens: 4096, contextLength: 8192, costPer1kInput: 0, costPer1kOutput: 0, isActive: true },
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
    return createLLMClient(
      profile.provider === 'ollama' ? `ollama:${profile.modelName}` : profile.modelName
    );
  }

  getCurrentModel(pointer: keyof ModelPointers = 'main'): string {
    return this.pointers[pointer];
  }

  setPointer(pointer: keyof ModelPointers, modelName: string) {
    if (!this.profiles.has(modelName)) {
      // Auto-create profile for unknown models
      this.profiles.set(modelName, {
        name: modelName, provider: 'openai', modelName,
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
