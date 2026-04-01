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

const log = createLogger('model-fallback');

/**
 * Errors that indicate a fallback won't help (context limit exceeded, etc.)
 * and should be propagated immediately.
 */
const NON_FALLBACK_PATTERNS = [
  'context_length_exceeded',
  'maximum context length',
  'token limit',
  'context window',
  'too many tokens',
];

function isFallbackUseless(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return NON_FALLBACK_PATTERNS.some((p) => msg.includes(p));
}

export interface ModelFallbackOptions {
  /**
   * Factory function to create an LLMClient for a given model name.
   * Defaults to using `createLLMClient` from the LLM client module.
   */
  clientFactory?: (modelName: string) => LLMClient;
}

export class ModelFallbackChain {
  private readonly fallbackModels: string[];
  private readonly clientFactory: (modelName: string) => LLMClient;

  constructor(fallbackModels: string[], opts: ModelFallbackOptions = {}) {
    this.fallbackModels = fallbackModels;
    // Lazy import to avoid circular dependency at module load time
    this.clientFactory = opts.clientFactory ?? ((model: string) => {
      // We resolve this lazily when first needed
      return { _lazyModel: model } as unknown as LLMClient;
    });
  }

  /**
   * Call the primary LLM client; on failure, try each fallback model in order.
   */
  async call(primary: LLMClient, options: ChatOptions): Promise<ChatResponse> {
    try {
      return await primary.chat(options);
    } catch (err) {
      if (isFallbackUseless(err)) {
        log.warn(`Primary model error is non-fallbackable: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }

      log.warn(`Primary model failed: ${err instanceof Error ? err.message : String(err)} — trying fallbacks`);
      return this._tryFallbacks(options, err);
    }
  }

  private async _tryFallbacks(options: ChatOptions, lastErr: unknown): Promise<ChatResponse> {
    const { createLLMClient } = await import('../models/llm-client.js');

    for (let i = 0; i < this.fallbackModels.length; i++) {
      const modelName = this.fallbackModels[i];
      log.info(`Fallback ${i + 1}/${this.fallbackModels.length}: trying ${modelName}`);
      try {
        const client = createLLMClient(modelName);
        const response = await client.chat(options);
        log.info(`Fallback succeeded with ${modelName}`);
        return response;
      } catch (err) {
        log.warn(`Fallback ${modelName} failed: ${err instanceof Error ? err.message : String(err)}`);
        lastErr = err;
      }
    }

    throw new Error(
      `All models failed (primary + ${this.fallbackModels.length} fallbacks). Last error: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
    );
  }
}
