/**
 * Model Fallback Chain
 *
 * Inspired by kwaibi's ModelFallbackInterceptor pattern.
 *
 * Tries the primary model call first. On failure, automatically tries
 * fallback model names in sequence (lazy instantiation — each fallback
 * LLMClient is only created when actually needed).
 *
 * Usage:
 *   const fallback = new ModelFallbackChain(['gpt-4o-mini', 'claude-3-5-haiku']);
 *   const response = await fallback.call(primaryLlm, chatOptions);
 */

import type { LLMClient, ChatOptions, ChatResponse } from '../models/types.js';
import { createLogger } from './logger.js';
import { createLLMClient as _createLLMClient } from '../models/llm-client.js';

const log = createLogger('model-fallback');

/**
 * Errors that indicate a fallback won't help (context limit exceeded, etc.)
 * and should be propagated immediately without trying fallbacks.
 */
const NON_FALLBACK_PATTERNS = [
  'context_length_exceeded',
  'maximum context length',
  'token limit',
  'context window',
  'too many tokens',
];

/**
 * Errors that indicate we should fallback immediately to the next model,
 * because the primary model can't serve this request at all.
 * Includes quota exhaustion and rate limits (retrying same model wastes time).
 */
const IMMEDIATE_FALLBACK_PATTERNS = [
  'rate_limit_exceeded',
  'rate limit',
  'insufficient_quota',
  'quota exceeded',
  'billing',
  'exceeded your current quota',
  'model is currently overloaded',
  'overloaded',
];

function isFallbackUseless(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return NON_FALLBACK_PATTERNS.some((p) => msg.includes(p));
}

function isImmediateFallback(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return IMMEDIATE_FALLBACK_PATTERNS.some((p) => msg.includes(p));
}

export interface ModelFallbackOptions {
  /**
   * Factory function to create an LLMClient for a given model name.
   * When provided, this is used instead of the default `createLLMClient`.
   * Useful for testing or custom model routing.
   */
  clientFactory?: (modelName: string) => LLMClient;
}

export class ModelFallbackChain {
  private readonly fallbackModels: string[];
  // clientFactory is stored and actually used in _tryFallbacks
  private readonly clientFactory: ((modelName: string) => LLMClient) | null;

  constructor(fallbackModels: string[], opts: ModelFallbackOptions = {}) {
    this.fallbackModels = fallbackModels;
    // null means "use the default createLLMClient via dynamic import"
    this.clientFactory = opts.clientFactory ?? null;
  }

  /**
   * Call the primary LLM client; on failure, try each fallback model in order.
   * NOTE: Only wraps `chat()`. Streaming (`streamChat`) is NOT covered by this
   * fallback chain — if streaming support is needed in the future, add a
   * `callStream(primary, options, onChunk)` method here.
   *
   * TODO: Implement callStream() for streaming fallback when agent.ts enables
   *       the `stream: true` path.
   */
  async call(primary: LLMClient, options: ChatOptions): Promise<ChatResponse> {
    try {
      return await primary.chat(options);
    } catch (err) {
      if (isFallbackUseless(err)) {
        log.warn(`Primary model error is non-fallbackable: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }

      if (isImmediateFallback(err)) {
        log.warn(`Primary model rate-limited or quota exceeded — skipping retry, going straight to fallback`);
      } else {
        log.warn(`Primary model failed: ${err instanceof Error ? err.message : String(err)} — trying fallbacks`);
      }

      return this._tryFallbacks(options, err);
    }
  }

  private async _tryFallbacks(options: ChatOptions, primaryErr: unknown): Promise<ChatResponse> {
    // Resolve the client factory: use the stored one or fall back to the statically
    // imported createLLMClient.  Previously used dynamic import() on every fallback
    // call which caused a micro-delay and bypassed Node's module cache in some
    // bundler configs.  Static import is resolved once at module load time.
    const createClient: (modelName: string) => LLMClient =
      this.clientFactory ?? _createLLMClient;

    let lastErr: unknown = primaryErr;

    for (let i = 0; i < this.fallbackModels.length; i++) {
      const modelName = this.fallbackModels[i];
      log.info(`Fallback ${i + 1}/${this.fallbackModels.length}: trying ${modelName}`);
      try {
        const client = createClient(modelName);
        const response = await client.chat(options);
        log.info(`Fallback succeeded with ${modelName}`);
        return response;
      } catch (err) {
        log.warn(`Fallback ${modelName} failed: ${err instanceof Error ? err.message : String(err)}`);
        lastErr = err;
      }
    }

    // lastErr is always set here (at minimum to primaryErr)
    throw new Error(
      `All models failed (primary + ${this.fallbackModels.length} fallbacks). Last error: ${
        lastErr instanceof Error ? (lastErr as Error).message : String(lastErr)
      }`,
    );
  }
}
