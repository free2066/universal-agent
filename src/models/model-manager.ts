import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { stringify as yamlStringify } from 'yaml';
import { HOME_DIR } from '../utils/env.js';
import { createLLMClient } from './llm-client.js';
import { detectFreeModes, buildPointersFromDetection, formatDetectionSummary } from './free-model-detector.js';
import { usageTracker } from './usage-tracker.js';
import type { LLMClient } from './types.js';

export interface ModelProfile {
  name: string;
  provider: 'openai' | 'anthropic' | 'ollama' | 'gemini' | 'deepseek' | 'moonshot' | 'qwen' | 'mistral' | 'groq' | 'siliconflow' | 'openrouter' | 'custom';
  modelName: string;
  apiKey?: string;
  baseURL?: string;
  maxTokens: number;
  contextLength: number;
  /**
   * Optional explicit input token limit (distinct from contextLength).
   * Some providers expose a separate "max input tokens" that is smaller than
   * the full context window (e.g. context=200k but input limit=160k because
   * 40k is reserved for KV cache). When set, autoCompact uses this value
   * instead of contextLength - maxTokens to determine overflow.
   *
   * Inspired by opencode/packages/opencode/src/session/overflow.ts:
   *   usable = model.limit.input ? model.limit.input - reserved : context - maxOutput
   */
  inputLimit?: number;
  costPer1kInput: number;          // USD per 1k input tokens
  costPer1kOutput: number;         // USD per 1k output tokens
  costPer1mCacheWrite?: number;    // USD per 1M cache_creation tokens (≈1.25× input price)
  costPer1mCacheRead?: number;     // USD per 1M cache_read tokens (≈0.10× input price)
  costPerWebSearch?: number;       // USD per web_search tool invocation (default 0.01)
  isActive: boolean;
}

/** Detailed per-call token breakdown passed to recordUsage() */
export interface TokenUsageDetail {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;      // prompt_cache_read_input_tokens
  cacheWriteTokens?: number;     // prompt_cache_creation_input_tokens
  webSearchRequests?: number;    // number of web search tool calls billed this turn
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

const CONFIG_DIR = resolve(HOME_DIR, '.uagent');
const CONFIG_FILE = resolve(CONFIG_DIR, 'models.json');

/**
 * Infer the LLM provider from a model name prefix.
 * Used when auto-creating a ModelProfile in setPointer() to avoid duplicating
 * the if-chain in multiple places inside the class.
 */
function inferProviderFromModelName(modelName: string): ModelProfile['provider'] {
  // 万擎 (Kuaishou internal) — format: "wanqing/<model-id>"
  // Uses OpenAI-compatible API with WQ_API_KEY + OPENAI_BASE_URL
  if (modelName.startsWith('wanqing/'))                                         return 'custom';
  if (modelName.startsWith('claude'))                                          return 'anthropic';
  if (modelName.startsWith('gemini'))                                          return 'gemini';
  if (modelName.startsWith('deepseek'))                                        return 'deepseek';
  if (modelName.startsWith('moonshot') || modelName.startsWith('kimi'))        return 'moonshot';
  if (modelName.startsWith('qwen') || modelName.startsWith('qwq')
      || modelName.startsWith('tongyi'))                                        return 'qwen';
  if (modelName.startsWith('mistral') || modelName.startsWith('mixtral'))      return 'mistral';
  if (modelName.startsWith('ollama:'))                                          return 'ollama';
  if (modelName.startsWith('groq:'))                                             return 'groq';
  if (modelName.startsWith('siliconflow:'))                                      return 'siliconflow';
  if (modelName.startsWith('openrouter:'))                                       return 'openrouter';
  return 'openai';
}

export class ModelManager {
  private profiles: Map<string, ModelProfile> = new Map();
  private _userSelectedMain = false;
  private pointers: ModelPointers = {
    // Default to free-tier models. Override via `uagent models set main <model>` or env vars.
    // Free options (no credit card needed):
    //   gemini-2.5-flash  — 1500 req/day free (Google AI Studio, GEMINI_API_KEY)
    //   gemini-2.0-flash  — same free tier, slightly lighter
    //   deepseek-chat     — free credits on signup (DEEPSEEK_API_KEY)
    main:    process.env.UAGENT_MODEL         ?? 'gemini-2.5-flash',
    task:    process.env.UAGENT_TASK_MODEL    ?? 'gemini-2.5-flash',
    compact: process.env.UAGENT_COMPACT_MODEL ?? 'gemini-2.5-flash',
    quick:   process.env.UAGENT_QUICK_MODEL   ?? 'gemini-2.5-flash',
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
        const validProviders = new Set(['openai', 'anthropic', 'ollama', 'gemini', 'deepseek', 'moonshot', 'qwen', 'mistral', 'groq', 'siliconflow', 'openrouter', 'custom']);
        for (const p of data.profiles) {
          // Validate each profile before loading: must have a known provider and non-empty modelName.
          // This prevents test-injected garbage (e.g. 'non-existent-model-12345') from
          // polluting the active profile list across sessions (fix g3).
          // Also skip wanqing/* profiles — they are CodeFlicker IDE internal aliases that
          // don't map to real API endpoint IDs.
          if (p && typeof p.name === 'string' && typeof p.modelName === 'string'
              && p.modelName.length > 0 && validProviders.has(p.provider)
              && !p.name.startsWith('wanqing/') && !p.modelName.startsWith('wanqing/')) {
            this.profiles.set(p.name, p);
          }
        }
      }
      if (data.pointers) {
        const validKeys = new Set<string>(['main', 'task', 'compact', 'quick']);
        for (const [k, v] of Object.entries(data.pointers)) {
          if (validKeys.has(k) && typeof v === 'string' && v.length > 0) {
            // Skip wanqing/* model names — they are CodeFlicker IDE internal aliases,
            // not real API endpoint IDs. Storing them as pointers causes 400 errors
            // because the API doesn't recognize the alias format.
            // autoSelectFreeModel() will resolve the correct ep-* ID at runtime.
            if (typeof v === 'string' && v.startsWith('wanqing/')) continue;
            (this.pointers as unknown as Record<string, string>)[k] = v;
            if (k === 'main') this._userSelectedMain = true;
          }
        }
      }
    } catch (err) {
      // Model config is corrupt or missing — warn so users know their configured
      // profiles (custom model names, API endpoints, pointers) were NOT loaded.
      console.warn(`[model-manager] Failed to load model config from ${CONFIG_FILE}, using defaults. Error: ${String(err)}`);
    }
  }

  saveToDisk() {
    mkdirSync(CONFIG_DIR, { recursive: true });
    // Only persist profiles that have a valid provider — filters out any test
    // or placeholder profiles that may have been created by setPointer() during testing.
    const validProviders = new Set(['openai', 'anthropic', 'ollama', 'gemini', 'deepseek', 'moonshot', 'qwen', 'mistral', 'groq', 'siliconflow', 'openrouter', 'custom']);
    const profilesToSave = Array.from(this.profiles.values())
      .filter(p => validProviders.has(p.provider) && p.modelName.length > 0);
    writeFileSync(CONFIG_FILE, JSON.stringify({
      profiles: profilesToSave,
      pointers: this.getPointers(),
    }, null, 2));
  }

  /**
   * Cache for LLMClient instances, keyed by factoryId.
   * Avoids creating a new HTTP client object on every getClient() call.
   * Cache is invalidated whenever setPointer() or addProfile() is called,
   * since those may change which factory string a pointer resolves to.
   */
  private clientCache = new Map<string, LLMClient>();

  getClient(pointer: keyof ModelPointers = 'main'): LLMClient {
    const modelName = this.pointers[pointer];
    if (!modelName) {
      throw new Error(`No model configured for pointer "${pointer}". Run: uagent models set ${pointer} <model-name>`);
    }
    const profile = this.profiles.get(modelName);
    if (!profile) {
      // Bug #6: unknown model name — give a clear error instead of crashing on undefined.startsWith()
      throw new Error(
        `Unknown model "${modelName}" (pointer: ${pointer}).\n` +
        `  Run: uagent models list  — to see available models\n` +
        `  Or run: uagent models set ${pointer} <model-name>  — to change the pointer`
      );
    }
    // Build the model string the factory expects
    const factoryId = (() => {
      switch (profile.provider) {
        case 'ollama':      return `ollama:${profile.modelName}`;
        case 'gemini':      return profile.modelName; // starts with 'gemini'
        case 'deepseek':    return profile.modelName; // starts with 'deepseek'
        case 'moonshot':    return profile.modelName;
        case 'qwen':        return profile.modelName; // starts with 'qwen'
        case 'mistral':     return profile.modelName; // starts with 'mistral'/'mixtral'
        case 'groq':        return `groq:${profile.modelName}`;
        case 'siliconflow': return `siliconflow:${profile.modelName}`;
        case 'openrouter':  return `openrouter:${profile.modelName}`;
        case 'custom':
          // 万擎 models use "wanqing/" prefix — pass as-is so createLLMClient strips the prefix
          if (profile.modelName.startsWith('wanqing/')) return profile.modelName;
          return `openai-compat:${profile.modelName}`;
        default:            return profile.modelName; // openai / anthropic
      }
    })();
    // Return cached instance to avoid allocating a new HTTP client per call
    const cached = this.clientCache.get(factoryId);
    if (cached) return cached;
    const client = createLLMClient(factoryId);
    this.clientCache.set(factoryId, client);
    return client;
  }

  getCurrentModel(pointer: keyof ModelPointers = 'main'): string {
    return this.pointers[pointer];
  }

  /** Valid pointer names — validated in setPointer to prevent config pollution (bug #5)
   *  inferProviderFromModelName is a module-level helper defined just before this class.
   */
  private static readonly VALID_POINTERS: ReadonlySet<keyof ModelPointers> = new Set<keyof ModelPointers>(['main', 'task', 'compact', 'quick']);

  setPointer(pointer: keyof ModelPointers, modelName: string) {
    // Bug #5: validate pointer name to prevent unknown keys polluting saved config
    if (!ModelManager.VALID_POINTERS.has(pointer)) {
      throw new Error(`Unknown model pointer "${pointer}". Valid pointers: ${[...ModelManager.VALID_POINTERS].join(', ')}`);
    }
    if (!this.profiles.has(modelName)) {
      // Auto-create a minimal profile so getClient() can function with the new model.
      // Provider is inferred from the model name prefix via the shared helper.
      const provider = inferProviderFromModelName(modelName);
      this.profiles.set(modelName, {
        name: modelName, provider, modelName,
        maxTokens: 8192, contextLength: 128000, costPer1kInput: 0, costPer1kOutput: 0, isActive: true,
      });
    }
    this.pointers[pointer] = modelName;
    if (pointer === 'main') this._userSelectedMain = true;
    // Invalidate cached client for this pointer so next getClient() creates a fresh one.
    this.clientCache.clear();
    this.saveToDisk();
  }

  /** Invalidate the LLM client cache (call after updating API keys at runtime). */
  clearClientCache(): void {
    this.clientCache.clear();
  }

  addProfile(profile: ModelProfile) {
    this.profiles.set(profile.name, profile);
    this.clientCache.clear(); // invalidate cache since a new profile may change factory routing
    this.saveToDisk();
  }

  removeProfile(name: string): boolean {
    if (!this.profiles.has(name)) return false;
    this.profiles.delete(name);
    this.clientCache.clear();
    this.saveToDisk();
    return true;
  }

  listProfiles(): ModelProfile[] {
    return Array.from(this.profiles.values()).filter(p => p.isActive);
  }

  getPointers(): ModelPointers {
    // Return only the four canonical pointer keys — never expose stale/invalid
    // keys that may linger in the in-memory object from old config files (fix f3).
    return {
      main:    this.pointers.main,
      task:    this.pointers.task,
      compact: this.pointers.compact,
      quick:   this.pointers.quick,
    };
  }

  recordUsage(usage: TokenUsageDetail, model: string) {
    const { inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0, webSearchRequests = 0 } = usage;
    const profile = this.profiles.get(model) ||
      Array.from(this.profiles.values()).find(p => p.modelName === model);

    // Standard input/output cost
    const costIn    = (inputTokens  / 1000) * (profile?.costPer1kInput  || 0);
    const costOut   = (outputTokens / 1000) * (profile?.costPer1kOutput || 0);
    // Cache write is slightly more expensive than input (~1.25× for Anthropic)
    const costCacheW = cacheWriteTokens > 0
      ? (cacheWriteTokens / 1_000_000) * (profile?.costPer1mCacheWrite ?? (profile?.costPer1kInput ?? 0) * 1.25 * 1000)
      : 0;
    // Cache read is much cheaper than input (~0.10× for Anthropic)
    const costCacheR = cacheReadTokens > 0
      ? (cacheReadTokens / 1_000_000) * (profile?.costPer1mCacheRead ?? (profile?.costPer1kInput ?? 0) * 0.1 * 1000)
      : 0;
    // Web search billed per-request (default $0.01 each)
    // P2: free-tier models (zero input+output cost) should not accrue web search fees
    const isFreeModel = (profile?.costPer1kInput ?? 0) === 0 && (profile?.costPer1kOutput ?? 0) === 0
    const costWebSearch = isFreeModel ? 0 : webSearchRequests * (profile?.costPerWebSearch ?? 0.01);

    const costUSD = costIn + costOut + costCacheW + costCacheR + costWebSearch;
    this.sessionCost += costUSD;
    this.sessionInputTokens  += inputTokens;
    this.sessionOutputTokens += outputTokens;
    this.usageHistory.push({ inputTokens, outputTokens, model, timestamp: Date.now() });
    // Persist to disk & check daily limits
    const check = usageTracker.recordCall(
      inputTokens, outputTokens, model, costUSD,
      cacheReadTokens, cacheWriteTokens, webSearchRequests,
    );
    if (check.status === 'warn' && check.message) {
      process.stderr.write('\n' + check.message + '\n');
    } else if (check.status === 'block') {
      throw new Error(check.message ?? 'Daily usage limit reached');
    }
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

  /**
   * Auto-detect the best available free model and update all pointers.
   * Called at startup when no explicit model is configured.
   * Returns a human-readable summary string.
   */
  async autoSelectFreeModel(silent = false): Promise<string> {
    const result = await detectFreeModes(silent);
    const summary = formatDetectionSummary(result);

    if (result.found) {
      const pointers = buildPointersFromDetection(result);
      if (pointers) {
        // Register profiles for dynamically-detected models so getClient() can resolve them.
        // Without this, the pointer points to a model name that has no profile entry,
        // causing getClient() to throw "Unknown model" error.
        for (const m of result.available) {
          // 万擎 (wanqing) models use their raw id — no openrouter: prefix
          const pointerId = result.source === 'openrouter' && !m.id.startsWith('ep-') && !m.id.startsWith('api-')
            ? `openrouter:${m.id}`
            : m.id;
          const detectedCtx = m.contextLength ?? 128000;
          if (!this.profiles.has(pointerId)) {
            const provider = inferProviderFromModelName(pointerId);
            this.profiles.set(pointerId, {
              name: pointerId,
              provider,
              modelName: m.id,    // The raw model id without prefix (used by factory)
              maxTokens: 8192,
              contextLength: detectedCtx,
              costPer1kInput: 0,
              costPer1kOutput: 0,
              isActive: true,
            });
          } else {
            // Profile already exists (loaded from disk) — always sync contextLength
            // from the freshly-detected value (WQ_MODELS 3rd field or WQ_CTX_* env var).
            // This ensures changes to WQ_MODELS context size take effect on next restart
            // without manually editing ~/.uagent/models.json every time.
            const existing = this.profiles.get(pointerId)!;
            if (existing.contextLength !== detectedCtx) {
              this.profiles.set(pointerId, { ...existing, contextLength: detectedCtx });
            }
          }
        }

        // 万擎 source: override pointers, but RESPECT the user's previous selection.
        // Rules:
        //   - If user already picked a valid ep-* or api-* model (via /model or models set),
        //     keep their choice — only update task/compact/quick if needed.
        //   - If the stored main pointer is empty OR was a stale wanqing/* alias
        //     (IDE internal name, not a real endpoint), override it with the detected ep-*.
        //   - For non-wanqing sources, always respect _userSelectedMain.
        const isWanqing = result.source === 'wanqing';
        const currentMain = this.pointers.main;
        // A valid wanqing endpoint ID starts with 'ep-' or 'api-' (never 'wanqing/')
        const currentMainIsValidWanqingEp =
          currentMain && (currentMain.startsWith('ep-') || currentMain.startsWith('api-'));
        if (isWanqing) {
          if (!currentMainIsValidWanqingEp && pointers.main) {
            // No valid ep-* stored yet (first run, or stale alias) → use auto-detected endpoint
            this.pointers.main    = pointers.main;
            this.pointers.task    = pointers.task    ?? pointers.main;
            this.pointers.compact = pointers.compact ?? pointers.main;
            this.pointers.quick   = pointers.quick   ?? pointers.main;
          }
          // If user already has a valid ep-* selected, keep it — don't override
        } else {
          if (!process.env.UAGENT_MODEL && pointers.main && !this._userSelectedMain) {
            this.pointers.main = pointers.main;
            this.pointers.task = pointers.task ?? pointers.main;
          }
          if (!process.env.UAGENT_QUICK_MODEL && pointers.quick) {
            this.pointers.quick   = pointers.quick;
            this.pointers.compact = pointers.compact ?? pointers.quick;
          }
        }
        // Save detected model ids for /model cycle (only cycle available models)
        this._detectedModels = result.available.map(m => {
          if (result.source === 'openrouter' && !m.id.startsWith('ep-') && !m.id.startsWith('api-')) {
            return `openrouter:${m.id}`;
          }
          return m.id;
        });
        this.clientCache.clear(); // invalidate cache
      }
    }

    return summary;
  }

  /** Models detected at startup by autoSelectFreeModel — only these are cycled by /model */
  private _detectedModels: string[] = [];

  cycleMainModel(): string {
    // If we have a detected-models list (set by autoSelectFreeModel), cycle only those.
    // This prevents /model from cycling into gpt-4.1 / claude when the user hasn't
    // configured those providers.
    if (this._detectedModels.length >= 1) {
      const idx = this._detectedModels.indexOf(this.pointers.main)
      const next = this._detectedModels[(Math.max(0, idx) + 1) % this._detectedModels.length]
      this.pointers.main = next;
      this.saveToDisk();
      return next;
    }

    // Fallback: original behaviour (cycle all real profiles)
    const isRealProfile = (name: string) =>
      !name.includes('non-existent') &&
      !name.includes('invalid') &&
      !name.startsWith('test-') &&
      name.length > 0;

    const active = this.listProfiles()
      .map(p => p.name)
      .filter(isRealProfile);

    if (!active.length) return this.pointers.main;
    const idx = active.indexOf(this.pointers.main);
    const next = active[(Math.max(0, idx) + 1) % active.length];
    this.pointers.main = next;
    this.saveToDisk();
    return next;
  }
}

// Singleton
export const modelManager = new ModelManager();
