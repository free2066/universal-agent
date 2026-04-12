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
 *   - OPENROUTER_API_KEY in env → use it (higher rate limits)
 *   - No key → OpenRouter ANONYMOUS mode works out-of-the-box (rate-limited but usable)
 *     No prompts, no interruptions. A one-line tip is shown suggesting users add a key.
 *
 * Fallback chain (if OpenRouter unreachable):
 *   - Gemini  (GEMINI_API_KEY)     → free 1500 req/day
 *   - Groq    (GROQ_API_KEY)       → free 14400 req/day
 *   - Ollama  (local)              → no limits
 */

import type { ModelPointers } from './model-manager.js';
import { errorMessage } from '../utils/errors.js';

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
    // P1: use request header instead of URL query string to prevent key from appearing in logs
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 1 } }),
        signal: AbortSignal.timeout(8000),
      },
    );
    if (res.status === 200) {
      return { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', score: 95, contextLength: 1048576, supportsTools: true, isFree: true };
    }
  } catch (err) {
    // Gemini API probe failed — log at debug so users can diagnose auth/network issues
    // during first-run detection (they would otherwise see no model and no hint why).
    process.stderr.write(`[free-model-detector] Gemini probe failed: ${String(err)}\n`);
  }
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
  } catch (err) {
    process.stderr.write(`[free-model-detector] Groq probe failed: ${String(err)}\n`);
  }
  return null;
}

async function tryOllama(): Promise<RankedFreeModel | null> {
  try {
    const base = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = await res.json() as { models?: Array<{ name: string }> };
    const installed = (data.models ?? []).map((m) => m.name).filter((n): n is string => typeof n === 'string');
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
  } catch (err) {
    process.stderr.write(`[free-model-detector] Ollama probe failed: ${String(err)}\n`);
  }
  return null;
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface DetectionResult {
  found: boolean;
  best: RankedFreeModel | null;
  bestQuick: RankedFreeModel | null;        // fastest/lightest model for quick tasks
  available: RankedFreeModel[];
  source: 'openrouter' | 'gemini' | 'groq' | 'ollama' | 'wanqing' | 'none';
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
    if (!silent) process.stdout.write(` ⚠️  OpenRouter: ${errorMessage(err)}\n`);
    return null;
  }
}

/**
 * Main entry: detect best available free model.
 *
 * Flow (zero friction for new users):
 *   1. Try OpenRouter with key if available, otherwise anonymous (no key needed)
 *   2. Anonymous OpenRouter works out-of-the-box — rate limited but usable
 *   3. If OpenRouter fails → fallback to Gemini / Groq / Ollama (if keys set)
 *
 * No interactive prompts are shown during detection.
 * After a successful anonymous session, a one-line tip is shown once.
 *
 * @param silent - suppress all output (for non-interactive / CI contexts)
 */
export async function detectFreeModes(silent = false): Promise<DetectionResult> {
  // ── Step 0: 万擎 (Wanqing) internal API ───────────────────────────────────
  // If WQ_API_KEY is set, the user has configured the Kuaishou internal model
  // service.  We trust the key is valid and return immediately — no network
  // probe needed (internal endpoints may not be reachable from everywhere).
  const wqKey = process.env.WQ_API_KEY;
  // 防御性解析：UAGENT_MODEL 可能误写成 ep-xxx:名称 格式，只取冒号前的 ID 部分
  const wqModel = (process.env.UAGENT_MODEL || '').split(':')[0].trim() || undefined;
  const wqBase = process.env.OPENAI_BASE_URL;
  // WQ_MODELS 支持逗号分隔多个万擎 endpoint
  // 格式：ep-xxx  或  ep-xxx:显示名称  或  ep-xxx:显示名称:contextLength(k)
  // 示例：ep-abc123:MiMo-V2-Pro:1000k,ep-def456:Kimi-K2:128k
  const wqModelsRaw = process.env.WQ_MODELS || '';

  interface WqModelEntry { id: string; contextLength: number; }
  const extraModelEntries: WqModelEntry[] = wqModelsRaw
    .split(',')
    .map(s => {
      const parts = s.trim().split(':');
      const id = parts[0]?.trim() ?? '';
      // 第三段可选：contextLength，支持 "1000k"/"1000000"/"128k"/"200k" 等写法
      let ctxLen = 128000;
      const ctxRaw = parts[2]?.trim();
      if (ctxRaw) {
        const match = ctxRaw.match(/^(\d+(?:\.\d+)?)(k|m)?$/i);
        if (match) {
          const num = parseFloat(match[1]!);
          const unit = (match[2] ?? '').toLowerCase();
          ctxLen = unit === 'm' ? Math.round(num * 1_000_000)
                 : unit === 'k' ? Math.round(num * 1_000)
                 : Math.round(num);
        }
      }
      return { id, contextLength: ctxLen };
    })
    .filter(e => e.id && !e.id.startsWith('ep-xxxxxx') && (e.id.startsWith('ep-') || e.id.startsWith('api-')));
  const extraModels = extraModelEntries.map(e => e.id);
  // Build id→contextLength map for WQ_MODELS entries
  const wqCtxMap = new Map<string, number>(extraModelEntries.map(e => [e.id, e.contextLength]));

  // 万擎识别条件：有 WQ_API_KEY，且满足以下任一：
  //   1. UAGENT_MODEL 已填（不是占位符）
  //   2. OPENAI_BASE_URL 指向万擎
  //   3. WQ_MODELS 里有有效 endpoint（UAGENT_MODEL 可能因 dotenv 加载时序问题未被 shell 读到）
  const isWanqing = wqKey && (
    (wqModel && !wqModel.startsWith('ep-xxxxxx')) ||
    (wqBase && (wqBase.includes('wanqing') || wqBase.includes('wanqing.internal'))) ||
    extraModels.length > 0
  );
  if (isWanqing) {
    // primaryId 优先取 UAGENT_MODEL，其次取 WQ_MODELS 第一项，最后兜底
    const primaryId = (wqModel && !wqModel.startsWith('ep-xxxxxx'))
      ? wqModel
      : (extraModels[0] ?? 'wanqing-default');
    // 合并主模型 + WQ_MODELS 里的额外模型，去重
    const allIds = [primaryId, ...extraModels.filter(id => id !== primaryId)];
    if (!silent) process.stdout.write(`✅ Using 万擎 (Wanqing) internal API: ${primaryId}${allIds.length > 1 ? ` (+${allIds.length - 1} more)` : ''}\n`);

    // Infer contextLength for a WQ endpoint:
    //   1. If explicitly set in WQ_MODELS (ep-xxx:name:ctxLen), use that value.
    //   2. Otherwise fall back to 128k default.
    //   Users can also pass WQ_CTX_<EPID>=1000000 env var for fine-grained control.
    const inferWqCtx = (id: string): number => {
      // Explicit WQ_MODELS third-field value takes priority
      const fromMap = wqCtxMap.get(id);
      if (fromMap) return fromMap;
      // Env var override: WQ_CTX_EP_ABC123 (replace - with _)
      const envKey = `WQ_CTX_${id.replace(/-/g, '_').toUpperCase()}`;
      const envVal = process.env[envKey];
      if (envVal) {
        const match = envVal.match(/^(\d+(?:\.\d+)?)(k|m)?$/i);
        if (match) {
          const num = parseFloat(match[1]!);
          const unit = (match[2] ?? '').toLowerCase();
          return unit === 'm' ? Math.round(num * 1_000_000)
               : unit === 'k' ? Math.round(num * 1_000)
               : Math.round(num);
        }
      }
      return 128000;
    };

    const models: RankedFreeModel[] = allIds.map((id, i) => ({
      id,
      name: `万擎: ${id}`,
      score: 100 - i,   // 第一个得分最高，作为默认
      contextLength: inferWqCtx(id),
      supportsTools: true,
      isFree: true,
    }));
    return {
      found: true,
      best: models[0],
      bestQuick: models[0],
      available: models,
      source: 'wanqing',
      anonymous: false,
      totalFreeModels: models.length,
    };
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  // NOTE: OpenRouter no longer supports anonymous access (HTTP 401 without a key).
  // Only attempt OpenRouter when a valid key is configured.
  const anonymous = !apiKey;

  // ── Step 1: Try OpenRouter (only when API key is present) ─────────────────
  if (apiKey) {
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
  }

  // ── Step 2: Fallback chain (Gemini / Groq / Ollama) ───────────────────────
  if (!silent) process.stdout.write('🔍 Checking available free providers (Gemini / Groq / Ollama)...');
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

  if (!silent) process.stdout.write(' ❌ No free models available\n');
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
    // 万擎模型 (ep-xxx) 走 OpenAIClient + OPENAI_BASE_URL，不需要 openrouter: 前缀
    if (id.startsWith('ep-')) return id;
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
    const src = result.source === 'openrouter'
      ? `OpenRouter${result.anonymous ? ' (anonymous)' : ''}`
      : result.source;
    lines.push(`✅ Using free model: ${result.best.name}  [${src}]`);
    // One-line tip for anonymous mode — non-intrusive
    if (result.anonymous) {
      lines.push(`   💡 Tip: set OPENROUTER_API_KEY in .env for higher rate limits → https://openrouter.ai/keys`);
    }
  } else {
    lines.push('⚠️  No free models available. Add a key to .env to get started:');
    lines.push('   OPENROUTER_API_KEY=<key>   → https://openrouter.ai/keys (free, no credit card)');
    lines.push('   Or: GEMINI_API_KEY=<key>   → https://aistudio.google.com/apikey');
    lines.push('   Run: uagent config — for interactive setup');
  }

  return lines.join('\n');
}
