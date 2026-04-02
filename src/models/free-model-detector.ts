/**
 * Free Model Detector — Dynamically fetch the latest free models from OpenRouter at startup.
 *
 * Core strategy:
 *   1. Call OpenRouter /api/v1/models to get the live list of ALL available models
 *   2. Filter to models where pricing.prompt === "0" AND pricing.completion === "0" (truly free)
 *   3. Score each by context window + known quality signals (model name heuristics)
 *   4. Pick the best-scoring model and set it as the main model pointer
 *
 * Key handling:
 *   - OPENROUTER_API_KEY in env → use it (higher rate limits, no throttle)
 *   - No key → prompt user to get a free key via browser; wait for input; write to .env
 *   - User can skip key prompt → falls back to anonymous OpenRouter + other providers
 *
 * Fallback chain (if OpenRouter fails or is skipped):
 *   - Gemini  (GEMINI_API_KEY)     → free 1500 req/day
 *   - Groq    (GROQ_API_KEY)       → free 14400 req/day
 *   - Ollama  (local)              → no limits
 *
 * OpenRouter free model API:
 *   GET https://openrouter.ai/api/v1/models
 *   Filter: pricing.prompt === "0" && pricing.completion === "0"
 *   Sort: tool-support first, then quality score, then context length
 */

import { createInterface } from 'readline';
import { existsSync, readFileSync, appendFileSync } from 'fs';
import { resolve } from 'path';
import type { ModelPointers } from './model-manager.js';

// ── Key bootstrap helpers ─────────────────────────────────────────────────────

/**
 * Persist a key=value pair to the nearest .env file.
 * Tries cwd/.env first, then ~/.uagent/.env as fallback.
 */
function persistKeyToEnv(key: string, value: string): void {
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(process.env.HOME ?? '~', '.uagent', '.env'),
  ];
  const target = candidates.find(existsSync) ?? candidates[0];
  // If the key already exists in the file, don't append a duplicate
  try {
    const existing = readFileSync(target, 'utf-8');
    if (existing.includes(`${key}=`)) return; // already set
  } catch { /* file may not exist yet */ }
  appendFileSync(target, `\n${key}=${value}\n`);
}

/**
 * Open a URL in the default browser (cross-platform).
 * Silently ignores errors (e.g. headless environment).
 */
async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import('child_process');
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
}

/**
 * Interactively prompt the user to get an OpenRouter API key.
 * Opens the key page in their browser, then waits for them to paste the key.
 * Pressing Enter without a value = skip.
 *
 * Returns the key if provided, or null if skipped.
 */
async function promptForOpenRouterKey(): Promise<string | null> {
  const KEY_URL = 'https://openrouter.ai/keys';

  console.log('\n┌─────────────────────────────────────────────────────────────┐');
  console.log('│  🔑  OpenRouter API Key Setup (one-time, takes 30 seconds)  │');
  console.log('├─────────────────────────────────────────────────────────────┤');
  console.log('│  OpenRouter gives you FREE access to 100+ open-source LLMs. │');
  console.log('│  No credit card required.                                    │');
  console.log('│                                                              │');
  console.log(`│  1. Opening: ${KEY_URL}`);
  console.log('│  2. Sign in with GitHub / Google                             │');
  console.log('│  3. Click "Create Key" → copy the key                        │');
  console.log('│  4. Paste it below and press Enter                           │');
  console.log('│                                                              │');
  console.log('│  (Press Enter without typing to skip and use anonymous mode) │');
  console.log('└─────────────────────────────────────────────────────────────┘\n');

  // Try to open browser (non-blocking)
  await openBrowser(KEY_URL).catch(() => {});

  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('  Paste your OpenRouter API key: ', (answer) => {
      rl.close();
      const key = answer.trim();
      resolve(key || null);
    });
    // Timeout after 2 minutes — auto-skip if user doesn't respond
    setTimeout(() => { rl.close(); resolve(null); }, 120_000);
  });
}

// ── OpenRouter API types ──────────────────────────────────────────────────────

interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  context_length: number;
  pricing: {
    prompt: string;      // "0" = free
    completion: string;  // "0" = free
    request?: string;
    image?: string;
  };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
    is_moderated?: boolean;
  };
  architecture?: {
    modality?: string;
    tokenizer?: string;
    instruct_type?: string;
  };
  supported_generation_methods?: string[];
}

interface OpenRouterModelsResponse {
  data: OpenRouterModel[];
}

// ── Quality scoring heuristics ────────────────────────────────────────────────

/**
 * Known high-quality model families and their base quality scores (0-100).
 * Used to rank free models when we can't measure actual quality.
 * Higher = better for agentic/coding tasks.
 */
const MODEL_QUALITY_HINTS: Array<{ pattern: RegExp; score: number; supportsTools: boolean }> = [
  // Frontier free models (highest quality)
  { pattern: /gemini-2\.5/i,                  score: 95, supportsTools: true  },
  { pattern: /gemini-2\.0-flash/i,            score: 88, supportsTools: true  },
  { pattern: /deepseek-r1(?!.*distill)/i,     score: 90, supportsTools: false },
  { pattern: /deepseek-v3/i,                  score: 88, supportsTools: true  },
  { pattern: /deepseek-r1-distill.*70b/i,     score: 83, supportsTools: false },
  { pattern: /llama-4-maverick/i,             score: 87, supportsTools: true  },
  { pattern: /llama-4-scout/i,               score: 82, supportsTools: true  },
  { pattern: /llama-3\.3-70b/i,              score: 80, supportsTools: true  },
  { pattern: /qwen3-235b/i,                  score: 88, supportsTools: true  },
  { pattern: /qwen3-72b/i,                   score: 82, supportsTools: true  },
  { pattern: /qwen3-30b/i,                   score: 78, supportsTools: true  },
  { pattern: /qwq-32b/i,                     score: 80, supportsTools: false },
  { pattern: /gemma-3-27b/i,                 score: 76, supportsTools: false },
  { pattern: /gemma-3-12b/i,                 score: 70, supportsTools: false },
  { pattern: /mistral-7b/i,                  score: 60, supportsTools: false },
  { pattern: /phi-4/i,                       score: 72, supportsTools: false },
  { pattern: /llama-3\.1-70b/i,             score: 75, supportsTools: true  },
  { pattern: /llama-3\.1-8b/i,              score: 58, supportsTools: true  },
  // Small/fast models (lower quality but good for quick tasks)
  { pattern: /gemini-2\.5-flash-lite/i,      score: 80, supportsTools: true  },
  { pattern: /qwen3-8b/i,                    score: 65, supportsTools: true  },
  { pattern: /deepseek-r1-distill.*8b/i,     score: 62, supportsTools: false },
];

function scoreModel(model: OpenRouterModel): { score: number; supportsTools: boolean } {
  // Find matching quality hint
  for (const hint of MODEL_QUALITY_HINTS) {
    if (hint.pattern.test(model.id) || hint.pattern.test(model.name)) {
      return { score: hint.score, supportsTools: hint.supportsTools };
    }
  }
  // Unknown model: base score from context length (larger context = likely better model)
  const ctxScore = Math.min(30, Math.log2(model.context_length / 1000) * 5);
  return { score: Math.round(ctxScore), supportsTools: false };
}

// ── OpenRouter fetcher ────────────────────────────────────────────────────────

export interface RankedFreeModel {
  id: string;           // openrouter model id, e.g. "google/gemini-2.0-flash-exp:free"
  name: string;         // human-readable name
  score: number;        // composite quality score
  contextLength: number;
  supportsTools: boolean;
  isFree: boolean;
}

/**
 * Fetch the live list of free models from OpenRouter's public API.
 * Works with or without an API key (anonymous access is allowed).
 *
 * Returns models sorted by quality score descending.
 */
export async function fetchOpenRouterFreeModels(apiKey?: string): Promise<RankedFreeModel[]> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://github.com/free2066/universal-agent',
    'X-Title': 'universal-agent',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers,
    signal: AbortSignal.timeout(12000),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter models API returned ${res.status}: ${await res.text().catch(() => '')}`);
  }

  const data = await res.json() as OpenRouterModelsResponse;
  const models = data.data ?? [];

  // Filter to truly free models only (both prompt and completion cost = 0)
  const freeModels = models.filter((m) =>
    m.pricing.prompt === '0' && m.pricing.completion === '0',
  );

  // Score and rank
  const ranked: RankedFreeModel[] = freeModels.map((m) => {
    const { score, supportsTools } = scoreModel(m);
    return {
      id: m.id,
      name: m.name,
      score,
      contextLength: m.context_length,
      supportsTools,
      isFree: true,
    };
  });

  // Sort: tool-supporting models first, then by quality score, then context length
  ranked.sort((a, b) => {
    // Tool support is critical for agent functionality
    if (a.supportsTools !== b.supportsTools) return a.supportsTools ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    return b.contextLength - a.contextLength;
  });

  return ranked;
}

// ── Fallback providers (if OpenRouter not available) ─────────────────────────

async function tryGemini(): Promise<RankedFreeModel | null> {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 1 } }),
        signal: AbortSignal.timeout(8000),
      },
    );
    if (res.status === 200) {
      return { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', score: 95, contextLength: 1048576, supportsTools: true, isFree: true };
    }
  } catch { /* ignore */ }
  return null;
}

async function tryGroq(): Promise<RankedFreeModel | null> {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 200) {
      return { id: 'groq:llama-3.3-70b', name: 'Llama 3.3 70B (Groq)', score: 80, contextLength: 128000, supportsTools: true, isFree: true };
    }
  } catch { /* ignore */ }
  return null;
}

async function tryOllama(): Promise<RankedFreeModel | null> {
  try {
    const base = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = await res.json() as { models?: Array<{ name: string }> };
    const installed = (data.models ?? []).map((m) => m.name);
    // Prefer qwen3 > llama3.3 > deepseek-r1 if installed
    for (const preferred of ['qwen3', 'llama3.3', 'deepseek-r1', 'llama3']) {
      if (installed.some((n) => n.startsWith(preferred))) {
        return { id: `ollama:${preferred}`, name: `${preferred} (local Ollama)`, score: 70, contextLength: 32768, supportsTools: true, isFree: true };
      }
    }
    // Use whatever is installed
    if (installed.length > 0) {
      const first = installed[0].split(':')[0];
      return { id: `ollama:${first}`, name: `${first} (local Ollama)`, score: 60, contextLength: 32768, supportsTools: false, isFree: true };
    }
  } catch { /* ignore */ }
  return null;
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface DetectionResult {
  found: boolean;
  best: RankedFreeModel | null;
  bestQuick: RankedFreeModel | null;        // fastest/lightest model for quick tasks
  available: RankedFreeModel[];
  source: 'openrouter' | 'gemini' | 'groq' | 'ollama' | 'none';
  anonymous: boolean;                        // true = no API key, using anonymous OpenRouter
  totalFreeModels: number;                   // total free models found on OpenRouter
}

/**
 * Try OpenRouter with a given key and return ranked free models.
 * Returns null if OpenRouter is unreachable or returns no free models.
 */
async function tryOpenRouter(apiKey?: string, silent = false): Promise<RankedFreeModel[] | null> {
  try {
    const models = await fetchOpenRouterFreeModels(apiKey);
    return models.length > 0 ? models : null;
  } catch (err) {
    if (!silent) process.stdout.write(` ⚠️  OpenRouter: ${err instanceof Error ? err.message : String(err)}\n`);
    return null;
  }
}

/**
 * Main entry: detect best available free model.
 *
 * Flow:
 *   1. If OPENROUTER_API_KEY is set → use it directly
 *   2. If not set AND not silent → prompt user to get a free key (opens browser)
 *      - User pastes key → save to .env → retry OpenRouter with that key
 *      - User skips (Enter) → try anonymous OpenRouter (rate-limited)
 *   3. If OpenRouter fails/skipped → fallback to Gemini / Groq / Ollama
 *
 * @param silent - suppress all prompts and progress output (used in non-interactive contexts)
 */
export async function detectFreeModes(silent = false): Promise<DetectionResult> {
  let apiKey = process.env.OPENROUTER_API_KEY;

  // ── Step 1: Auto-prompt for key if not set (interactive mode only) ────────
  if (!apiKey && !silent) {
    process.stdout.write('\n');
    const newKey = await promptForOpenRouterKey();
    if (newKey) {
      // Persist to .env so future runs don't need to prompt again
      persistKeyToEnv('OPENROUTER_API_KEY', newKey);
      // Also set in current process so the rest of the session can use it
      process.env.OPENROUTER_API_KEY = newKey;
      apiKey = newKey;
      console.log('\n✅ Key saved! It will be used automatically from now on.\n');
    } else {
      console.log('\n⏩ Skipped. Using anonymous OpenRouter access (rate-limited).\n');
    }
  }

  const anonymous = !apiKey;

  // ── Step 2: Try OpenRouter (primary) ──────────────────────────────────────
  if (!silent) process.stdout.write('🔍 Fetching latest free models from OpenRouter...');
  const orModels = await tryOpenRouter(apiKey, silent);

  if (orModels) {
    if (!silent) process.stdout.write(` ✅ Found ${orModels.length} free model(s)\n`);
    const best = orModels[0];
    const bestQuick =
      orModels.find((m) => m.contextLength <= 32768 && m.supportsTools) ??
      orModels.find((m) => m.supportsTools) ??
      orModels[0];

    return {
      found: true,
      best,
      bestQuick,
      available: orModels.slice(0, 10),
      source: 'openrouter',
      anonymous,
      totalFreeModels: orModels.length,
    };
  }

  // ── Step 3: Fallback chain (Gemini / Groq / Ollama) ───────────────────────
  if (!silent) process.stdout.write('🔍 OpenRouter unavailable, trying fallback providers...');
  const [gemini, groq, ollama] = await Promise.all([tryGemini(), tryGroq(), tryOllama()]);
  const fallbacks = [gemini, groq, ollama].filter(Boolean) as RankedFreeModel[];
  fallbacks.sort((a, b) => b.score - a.score);

  if (fallbacks.length > 0) {
    if (!silent) process.stdout.write(` ✅ Found ${fallbacks.length} fallback model(s)\n`);
    return {
      found: true,
      best: fallbacks[0],
      bestQuick: fallbacks[fallbacks.length - 1],
      available: fallbacks,
      source: gemini ? 'gemini' : groq ? 'groq' : 'ollama',
      anonymous: false,
      totalFreeModels: fallbacks.length,
    };
  }

  if (!silent) process.stdout.write(' ❌ No free models found\n');
  return {
    found: false, best: null, bestQuick: null, available: [],
    source: 'none', anonymous, totalFreeModels: 0,
  };
}

/**
 * Build ModelPointers from detection result.
 */
export function buildPointersFromDetection(result: DetectionResult): Partial<ModelPointers> | null {
  if (!result.found || !result.best) return null;

  /**
   * Convert a RankedFreeModel id to the pointer string the LLM client factory expects.
   * OpenRouter model ids (e.g. "google/gemini-2.0-flash-exp:free") need the "openrouter:" prefix
   * UNLESS the model is actually served by a different provider we talk to directly
   * (gemini→GeminiClient, groq:→GroqClient, ollama:→OllamaClient).
   */
  const toPointer = (id: string): string => {
    if (result.source !== 'openrouter') return id;
    if (id.startsWith('gemini') || id.startsWith('groq:') || id.startsWith('ollama:')) return id;
    return `openrouter:${id}`;
  };

  const mainId = toPointer(result.best.id);
  const quickId = result.bestQuick ? toPointer(result.bestQuick.id) : mainId;

  return { main: mainId, task: mainId, compact: quickId, quick: quickId };
}

/**
 * Human-readable summary of what was detected.
 */
export function formatDetectionSummary(result: DetectionResult): string {
  const lines: string[] = [];

  if (result.found && result.best) {
    const modelLabel = result.best.name;
    lines.push(`✅ Auto-selected free model: **${modelLabel}**`);
    if (result.source === 'openrouter') {
      lines.push(`   Source: OpenRouter (${result.totalFreeModels} free models available${result.anonymous ? ', anonymous mode' : ''})`);
      if (result.bestQuick && result.bestQuick.id !== result.best.id) {
        lines.push(`⚡ Quick/compact model: **${result.bestQuick.name}**`);
      }
    }
    if (result.anonymous) {
      lines.push('');
      lines.push('💡 You are using OpenRouter in anonymous mode (rate-limited).');
      lines.push('   For higher limits, add your key to .env:');
      lines.push('   OPENROUTER_API_KEY=<your-key>   # Get free at: https://openrouter.ai/keys');
    }
  } else {
    lines.push('❌ No free models detected.');
    lines.push('');
    lines.push('Options:');
    lines.push('  1. Add to .env:  OPENROUTER_API_KEY=<key>   → https://openrouter.ai/keys (free)');
    lines.push('  2. Add to .env:  GEMINI_API_KEY=<key>       → https://aistudio.google.com/apikey (free)');
    lines.push('  3. Install Ollama locally                   → https://ollama.com → ollama pull qwen3');
  }

  return lines.join('\n');
}
