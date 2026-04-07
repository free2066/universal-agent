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
 *
 * Also includes HTTP 529 "Overloaded" — per kstack article #15375, Claude Code
 * observed real production data showing the 529 pattern warrants immediate fallback
 * rather than retrying the same overloaded endpoint.
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
  // HTTP 529 — non-standard "Overloaded" status used by Anthropic API
  '529',
  'status 529',
  'statuscode: 529',
  'http 529',
];

/**
 * Circuit breaker for 529 overload errors (kstack article #15375).
 *
 * When the primary model returns 529 repeatedly, a circuit breaker prevents
 * hammering an endpoint that is clearly overwhelmed.  After MAX_529_FAILURES
 * consecutive 529 responses, the primary model is considered "circuit open"
 * for the rest of the session, and all calls go directly to the fallback chain.
 *
 * Claude Code production data: without this, overloaded endpoints received
 * thousands of retries per minute, making the overload worse.
 *
 * Instance-level state (each ModelFallbackChain instance has its own counters).
 */
const MAX_529_FAILURES = 3;

function is529Error(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes('529') || msg.includes('overloaded') || msg.includes('status code: 529');
}

function isFallbackUseless(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return NON_FALLBACK_PATTERNS.some((p) => msg.includes(p));
}

function isImmediateFallback(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return IMMEDIATE_FALLBACK_PATTERNS.some((p) => msg.includes(p));
}

export interface ModelFallbackOptions {
  clientFactory?: (modelName: string) => LLMClient;
}

/** Reset the 529 circuit breaker — now operates on instance state */
export function reset529CircuitBreaker(): void {
  // Legacy module-level reset kept for API compatibility; instance reset via chain.reset()
}

export class ModelFallbackChain {
  private readonly fallbackModels: string[];
  private readonly clientFactory: ((modelName: string) => LLMClient) | null;
  // 实例级别的 circuit breaker 状态，不再污染全局
  private _consecutive529Failures = 0;
  private _primaryCircuitOpen = false;

  constructor(fallbackModels: string[], opts: ModelFallbackOptions = {}) {
    this.fallbackModels = fallbackModels;
    this.clientFactory = opts.clientFactory ?? null;
  }

  /** 重置此实例的 circuit breaker（如模型切换、新会话时调用）*/
  reset(): void {
    this._consecutive529Failures = 0;
    this._primaryCircuitOpen = false;
  }

  /**
   * Stream version of call(): calls primary.streamChat() first; on failure,
   * tries each fallback model in order. Text chunks are forwarded to onChunk
   * in real-time. Returns a full ChatResponse (including tool_calls) on completion.
   */
  async callStream(
    primary: LLMClient,
    options: ChatOptions,
    onChunk: (chunk: string) => void,
  ): Promise<ChatResponse> {
    if (this._primaryCircuitOpen) {
      log.warn(`Primary model circuit open (529 overload) — routing directly to fallbacks (stream)`);
      return this._tryFallbacksStream(options, onChunk, new Error('Primary circuit open: 529 overload'));
    }

    try {
      const response = await primary.streamChat(options, onChunk);
      if (this._consecutive529Failures > 0) {
        log.info(`Primary model recovered after ${this._consecutive529Failures} 529 failures`);
        this._consecutive529Failures = 0;
      }
      return response;
    } catch (err) {
      if (isFallbackUseless(err)) {
        log.warn(`Primary model error is non-fallbackable (stream): ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
      if (is529Error(err)) {
        this._consecutive529Failures++;
        if (this._consecutive529Failures >= MAX_529_FAILURES) {
          this._primaryCircuitOpen = true;
          log.warn(`Primary model circuit breaker OPENED after ${this._consecutive529Failures} consecutive 529 errors.`);
        }
      }
      return this._tryFallbacksStream(options, onChunk, err);
    }
  }

  private async _tryFallbacksStream(
    options: ChatOptions,
    onChunk: (chunk: string) => void,
    primaryErr: unknown,
  ): Promise<ChatResponse> {
    const createClient: (modelName: string) => LLMClient = this.clientFactory ?? _createLLMClient;
    let lastErr: unknown = primaryErr;
    for (let i = 0; i < this.fallbackModels.length; i++) {
      const modelName = this.fallbackModels[i];
      log.info(`Fallback stream ${i + 1}/${this.fallbackModels.length}: trying ${modelName}`);
      try {
        const client = createClient(modelName);
        const response = await client.streamChat(options, onChunk);
        log.info(`Fallback stream succeeded with ${modelName}`);
        return response;
      } catch (err) {
        log.warn(`Fallback stream ${modelName} failed: ${err instanceof Error ? err.message : String(err)}`);
        lastErr = err;
      }
    }
    throw new Error(
      `All models failed (primary + ${this.fallbackModels.length} fallbacks). Last error: ${
        lastErr instanceof Error ? (lastErr as Error).message : String(lastErr)
      }`,
    );
  }

  /**
   * Call the primary LLM client; on failure, try each fallback model in order.
   */
  async call(primary: LLMClient, options: ChatOptions): Promise<ChatResponse> {
    // ── 529 circuit breaker (kstack article #15375) ──────────────────────────
    // If the primary endpoint has returned 529 (Overloaded) MAX_529_FAILURES
    // consecutive times, skip calling it entirely and go straight to fallbacks.
    // This prevents hammering an already-overloaded endpoint and making it worse.
    if (this._primaryCircuitOpen) {
      log.warn(`Primary model circuit open (529 overload) — routing directly to fallbacks`);
      return this._tryFallbacks(options, new Error('Primary circuit open: 529 overload'));
    }

    try {
      const response = await primary.chat(options);
      // Success: reset the 529 counter
      if (this._consecutive529Failures > 0) {
        log.info(`Primary model recovered after ${this._consecutive529Failures} 529 failures`);
        this._consecutive529Failures = 0;
      }
      return response;
    } catch (err) {
      if (isFallbackUseless(err)) {
        log.warn(`Primary model error is non-fallbackable: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }

      if (is529Error(err)) {
        this._consecutive529Failures++;
        if (this._consecutive529Failures >= MAX_529_FAILURES) {
          this._primaryCircuitOpen = true;
          log.warn(
            `Primary model circuit breaker OPENED after ${this._consecutive529Failures} consecutive 529 errors. ` +
            `All calls will use fallback models for the rest of this session.`,
          );
        } else {
          log.warn(
            `Primary model 529 overload (${this._consecutive529Failures}/${MAX_529_FAILURES} before circuit opens) — trying fallbacks`,
          );
        }
      } else if (isImmediateFallback(err)) {
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
