/**
 * Free Model Detector — Auto-detect available free LLM APIs at startup.
 *
 * Problem: Users have to manually set API keys and model names.
 * Solution: On startup, probe all known free-tier providers in parallel,
 *           pick the best available one, and auto-set model pointers.
 *
 * Detection strategy (in priority order):
 *   1. Check which API keys are configured in env
 *   2. Send a minimal "ping" request (1-2 tokens) to verify the key actually works
 *   3. Score each candidate by: quality tier × context window × cost=0
 *   4. Set model-manager pointers to the best available free model
 *
 * Free providers supported:
 *   - Google Gemini     (GEMINI_API_KEY)     — gemini-2.5-flash, 1M ctx, 1500 req/day
 *   - Groq              (GROQ_API_KEY)       — llama-3.3-70b, deepseek-r1, ultra-fast
 *   - DeepSeek          (DEEPSEEK_API_KEY)   — deepseek-chat, free signup credits
 *   - Alibaba Qwen      (DASHSCOPE_API_KEY)  — qwen3-8b free tier
 *   - Ollama (local)    (no key needed)      — any locally installed model
 *   - SiliconFlow       (SILICONFLOW_API_KEY)— many open-source models free
 *   - OpenRouter        (OPENROUTER_API_KEY) — many free models available
 */

import type { ModelPointers } from './model-manager.js';

export interface FreeModelCandidate {
  /** Unique name used as model pointer (e.g. 'gemini-2.5-flash') */
  name: string;
  /** Display name for UI */
  displayName: string;
  /** Provider identifier */
  provider: string;
  /** API key env var name (empty string = no key needed, e.g. Ollama) */
  keyEnvVar: string;
  /** Model name to pass to the API */
  modelName: string;
  /** Base URL for the API */
  baseURL: string;
  /** Context window in tokens */
  contextLength: number;
  /** Quality score 1-10 (higher = better for complex tasks) */
  qualityScore: number;
  /** Speed score 1-10 (higher = faster response) */
  speedScore: number;
  /** Whether this model supports function calling / tool use */
  supportsTools: boolean;
  /** Whether this is truly free (no credit card required) */
  isTrulyFree: boolean;
  /** Free tier limits description */
  freeTierNote: string;
}

export interface DetectionResult {
  /** Whether auto-detection found any usable free model */
  found: boolean;
  /** Best available free model for the main pointer */
  best: FreeModelCandidate | null;
  /** Best lightweight model for quick/task/compact */
  bestQuick: FreeModelCandidate | null;
  /** All available candidates sorted by score */
  available: FreeModelCandidate[];
  /** Providers that have keys configured but failed ping test */
  failed: string[];
  /** Providers with no key configured at all */
  unconfigured: string[];
}

// ── Free model catalog (priority-ordered) ────────────────────────────────────
// Each candidate is probed in parallel. The first group that responds wins.

const FREE_CANDIDATES: FreeModelCandidate[] = [
  // ── Group 1: Best quality free models ─────────────────────────────────────
  {
    name: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash (Google AI Studio)',
    provider: 'gemini',
    keyEnvVar: 'GEMINI_API_KEY',
    modelName: 'gemini-2.5-flash',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    contextLength: 1048576,
    qualityScore: 9,
    speedScore: 8,
    supportsTools: true,
    isTrulyFree: true,
    freeTierNote: '1500 req/day, 1M token context, no credit card',
  },
  {
    name: 'gemini-2.5-flash-lite',
    displayName: 'Gemini 2.5 Flash Lite (Google AI Studio)',
    provider: 'gemini',
    keyEnvVar: 'GEMINI_API_KEY',
    modelName: 'gemini-2.5-flash-lite',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    contextLength: 1048576,
    qualityScore: 7,
    speedScore: 10,
    supportsTools: true,
    isTrulyFree: true,
    freeTierNote: '1500 req/day free, ultra-fast',
  },
  {
    name: 'gemini-2.0-flash',
    displayName: 'Gemini 2.0 Flash (Google AI Studio)',
    provider: 'gemini',
    keyEnvVar: 'GEMINI_API_KEY',
    modelName: 'gemini-2.0-flash',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    contextLength: 1048576,
    qualityScore: 8,
    speedScore: 9,
    supportsTools: true,
    isTrulyFree: true,
    freeTierNote: '1500 req/day free, 1M token context',
  },

  // ── Group 2: Groq (ultra-fast inference, free tier) ────────────────────────
  {
    name: 'groq:llama-3.3-70b',
    displayName: 'Llama 3.3 70B via Groq (ultra-fast)',
    provider: 'groq',
    keyEnvVar: 'GROQ_API_KEY',
    modelName: 'llama-3.3-70b-versatile',
    baseURL: 'https://api.groq.com/openai/v1',
    contextLength: 128000,
    qualityScore: 8,
    speedScore: 10,
    supportsTools: true,
    isTrulyFree: true,
    freeTierNote: '14,400 req/day free, blazing fast',
  },
  {
    name: 'groq:deepseek-r1',
    displayName: 'DeepSeek R1 via Groq (reasoning)',
    provider: 'groq',
    keyEnvVar: 'GROQ_API_KEY',
    modelName: 'deepseek-r1-distill-llama-70b',
    baseURL: 'https://api.groq.com/openai/v1',
    contextLength: 128000,
    qualityScore: 9,
    speedScore: 7,
    supportsTools: false,
    isTrulyFree: true,
    freeTierNote: 'Free tier available, strong reasoning',
  },
  {
    name: 'groq:qwen3-32b',
    displayName: 'Qwen3 32B via Groq',
    provider: 'groq',
    keyEnvVar: 'GROQ_API_KEY',
    modelName: 'qwen-qwq-32b',
    baseURL: 'https://api.groq.com/openai/v1',
    contextLength: 128000,
    qualityScore: 8,
    speedScore: 8,
    supportsTools: true,
    isTrulyFree: true,
    freeTierNote: 'Free tier, good reasoning',
  },

  // ── Group 3: SiliconFlow (many free open-source models) ───────────────────
  {
    name: 'siliconflow:qwen3-8b',
    displayName: 'Qwen3 8B via SiliconFlow',
    provider: 'siliconflow',
    keyEnvVar: 'SILICONFLOW_API_KEY',
    modelName: 'Qwen/Qwen3-8B',
    baseURL: 'https://api.siliconflow.cn/v1',
    contextLength: 32768,
    qualityScore: 7,
    speedScore: 9,
    supportsTools: true,
    isTrulyFree: true,
    freeTierNote: '14M tokens/month free',
  },
  {
    name: 'siliconflow:deepseek-v3',
    displayName: 'DeepSeek V3 via SiliconFlow',
    provider: 'siliconflow',
    keyEnvVar: 'SILICONFLOW_API_KEY',
    modelName: 'deepseek-ai/DeepSeek-V3',
    baseURL: 'https://api.siliconflow.cn/v1',
    contextLength: 65536,
    qualityScore: 9,
    speedScore: 7,
    supportsTools: true,
    isTrulyFree: true,
    freeTierNote: 'Free credits on signup',
  },

  // ── Group 4: OpenRouter (many free models) ─────────────────────────────────
  {
    name: 'openrouter:gemma3-27b',
    displayName: 'Gemma 3 27B via OpenRouter',
    provider: 'openrouter',
    keyEnvVar: 'OPENROUTER_API_KEY',
    modelName: 'google/gemma-3-27b-it:free',
    baseURL: 'https://openrouter.ai/api/v1',
    contextLength: 96000,
    qualityScore: 8,
    speedScore: 7,
    supportsTools: false,
    isTrulyFree: true,
    freeTierNote: 'Free tier, no credit card',
  },
  {
    name: 'openrouter:llama4-scout',
    displayName: 'Llama 4 Scout via OpenRouter',
    provider: 'openrouter',
    keyEnvVar: 'OPENROUTER_API_KEY',
    modelName: 'meta-llama/llama-4-scout:free',
    baseURL: 'https://openrouter.ai/api/v1',
    contextLength: 512000,
    qualityScore: 8,
    speedScore: 7,
    supportsTools: false,
    isTrulyFree: true,
    freeTierNote: 'Free tier via OpenRouter',
  },

  // ── Group 5: DeepSeek direct API ──────────────────────────────────────────
  {
    name: 'deepseek-chat',
    displayName: 'DeepSeek Chat (deepseek.com)',
    provider: 'deepseek',
    keyEnvVar: 'DEEPSEEK_API_KEY',
    modelName: 'deepseek-chat',
    baseURL: 'https://api.deepseek.com/v1',
    contextLength: 128000,
    qualityScore: 9,
    speedScore: 7,
    supportsTools: true,
    isTrulyFree: false,
    freeTierNote: 'Free credits on signup, very cheap after',
  },

  // ── Group 6: Ollama (local, no key needed) ─────────────────────────────────
  {
    name: 'ollama:qwen3',
    displayName: 'Qwen3 (local Ollama)',
    provider: 'ollama',
    keyEnvVar: '',
    modelName: 'qwen3',
    baseURL: '',
    contextLength: 32768,
    qualityScore: 7,
    speedScore: 5,
    supportsTools: true,
    isTrulyFree: true,
    freeTierNote: 'Fully local, no API limits',
  },
  {
    name: 'ollama:llama3.3',
    displayName: 'Llama 3.3 (local Ollama)',
    provider: 'ollama',
    keyEnvVar: '',
    modelName: 'llama3.3',
    baseURL: '',
    contextLength: 131072,
    qualityScore: 7,
    speedScore: 5,
    supportsTools: true,
    isTrulyFree: true,
    freeTierNote: 'Fully local, no API limits',
  },
  {
    name: 'ollama:deepseek-r1',
    displayName: 'DeepSeek R1 (local Ollama)',
    provider: 'ollama',
    keyEnvVar: '',
    modelName: 'deepseek-r1',
    baseURL: '',
    contextLength: 32768,
    qualityScore: 8,
    speedScore: 4,
    supportsTools: false,
    isTrulyFree: true,
    freeTierNote: 'Fully local, no API limits',
  },
];

// ── Ping testers per provider ─────────────────────────────────────────────────

async function pingGemini(apiKey: string, modelName: string, baseURL: string): Promise<boolean> {
  try {
    const url = `${baseURL}/models/${modelName}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 1 } }),
      signal: AbortSignal.timeout(8000),
    });
    return res.status === 200;
  } catch { return false; }
}

async function pingOpenAICompat(apiKey: string, modelName: string, baseURL: string, extraHeaders?: Record<string, string>): Promise<boolean> {
  try {
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        ...extraHeaders,
      },
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(10000),
    });
    return res.status === 200;
  } catch { return false; }
}

async function pingOllama(modelName: string): Promise<boolean> {
  try {
    const baseURL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    // First check if Ollama is running
    const listRes = await fetch(`${baseURL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!listRes.ok) return false;
    const data = await listRes.json() as { models?: Array<{ name: string }> };
    // Check if the specific model is installed
    return (data.models ?? []).some((m) => m.name.startsWith(modelName));
  } catch { return false; }
}

async function pingCandidate(c: FreeModelCandidate): Promise<boolean> {
  const key = c.keyEnvVar ? (process.env[c.keyEnvVar] ?? '') : '';

  // Skip if key required but not set
  if (c.keyEnvVar && !key) return false;

  switch (c.provider) {
    case 'gemini':
      return pingGemini(key, c.modelName, c.baseURL);

    case 'groq':
    case 'siliconflow':
    case 'deepseek':
      return pingOpenAICompat(key, c.modelName, c.baseURL);

    case 'openrouter':
      return pingOpenAICompat(key, c.modelName, c.baseURL, {
        'HTTP-Referer': 'https://github.com/free2066/universal-agent',
        'X-Title': 'universal-agent',
      });

    case 'ollama':
      return pingOllama(c.modelName);

    default:
      return false;
  }
}

// ── Main detector ─────────────────────────────────────────────────────────────

/**
 * Probe all free model candidates in parallel.
 * Returns sorted list of available ones with the best candidate first.
 *
 * @param silent - suppress console output (default: false)
 */
export async function detectFreeModes(silent = false): Promise<DetectionResult> {
  if (!silent) {
    process.stdout.write('🔍 Detecting available free models...');
  }

  // Group candidates by whether they have a key configured
  const withKey: FreeModelCandidate[] = [];
  const noKey: FreeModelCandidate[] = [];
  const unconfigured: string[] = [];

  for (const c of FREE_CANDIDATES) {
    if (!c.keyEnvVar) {
      // Ollama — no key needed, always probe
      withKey.push(c);
    } else if (process.env[c.keyEnvVar]) {
      withKey.push(c);
    } else {
      // Deduplicate provider names in unconfigured list
      if (!unconfigured.includes(c.provider)) unconfigured.push(c.provider);
      noKey.push(c);
    }
  }

  // Probe all candidates with keys in parallel (with timeout)
  const results = await Promise.allSettled(
    withKey.map(async (c) => ({ candidate: c, ok: await pingCandidate(c) })),
  );

  const available: FreeModelCandidate[] = [];
  const failed: string[] = [];

  for (const r of results) {
    if (r.status === 'fulfilled') {
      if (r.value.ok) {
        available.push(r.value.candidate);
      } else {
        // Had a key but ping failed
        const provider = r.value.candidate.provider;
        if (r.value.candidate.keyEnvVar && !failed.includes(provider)) {
          failed.push(provider);
        }
      }
    }
  }

  // Sort available by composite score: quality * 0.6 + speed * 0.4
  // Prefer models that support tools (needed for agent functionality)
  available.sort((a, b) => {
    const scoreA = a.qualityScore * 0.6 + a.speedScore * 0.4 + (a.supportsTools ? 1 : 0);
    const scoreB = b.qualityScore * 0.6 + b.speedScore * 0.4 + (b.supportsTools ? 1 : 0);
    return scoreB - scoreA;
  });

  if (!silent) {
    if (available.length > 0) {
      process.stdout.write(` ✅ Found ${available.length} free model(s)\n`);
    } else {
      process.stdout.write(` ❌ No free models detected\n`);
    }
  }

  // Best for main: highest composite score that supports tools (for agent use)
  const best = available.find((c) => c.supportsTools) ?? available[0] ?? null;

  // Best for quick/compact: highest speed score
  const bestQuick = [...available]
    .sort((a, b) => b.speedScore - a.speedScore)[0] ?? null;

  return {
    found: available.length > 0,
    best,
    bestQuick,
    available,
    failed,
    unconfigured,
  };
}

/**
 * Build recommended ModelPointers from a detection result.
 * Returns null if no free models were found.
 */
export function buildPointersFromDetection(result: DetectionResult): Partial<ModelPointers> | null {
  if (!result.found || !result.best) return null;

  const main = result.best.name;
  const quick = result.bestQuick?.name ?? main;

  return {
    main,
    task: main,
    compact: quick,
    quick,
  };
}

/**
 * Generate a human-readable summary of detected free models.
 */
export function formatDetectionSummary(result: DetectionResult): string {
  const lines: string[] = [];

  if (result.found) {
    lines.push(`✅ Auto-selected free model: **${result.best?.displayName}**`);
    if (result.best?.name !== result.bestQuick?.name) {
      lines.push(`⚡ Quick model: **${result.bestQuick?.displayName}**`);
    }
    if (result.available.length > 1) {
      lines.push(`\n📋 All available free models:`);
      for (const c of result.available) {
        lines.push(`   • ${c.displayName} (score: ${(c.qualityScore * 0.6 + c.speedScore * 0.4).toFixed(1)}) — ${c.freeTierNote}`);
      }
    }
  } else {
    lines.push(`❌ No free models detected.`);
    lines.push(`\nTo use a free model, set one of these env vars in your .env file:`);
    lines.push(`   GEMINI_API_KEY=...        # Google AI Studio (1500 req/day free)`);
    lines.push(`   GROQ_API_KEY=...          # Groq (14400 req/day free)`);
    lines.push(`   SILICONFLOW_API_KEY=...   # SiliconFlow (14M tokens/month free)`);
    lines.push(`   OPENROUTER_API_KEY=...    # OpenRouter (many free models)`);
    lines.push(`\nOr install Ollama locally (no API key needed):`);
    lines.push(`   https://ollama.com → ollama pull qwen3`);
  }

  if (result.failed.length > 0) {
    lines.push(`\n⚠️  Key configured but ping failed: ${result.failed.join(', ')}`);
  }

  return lines.join('\n');
}
