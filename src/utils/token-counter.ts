/**
 * token-counter.ts — Precise token counting
 *
 * Upgraded to match claude-code's tokenCountWithEstimation() strategy:
 *
 *  Primary strategy (no network, always available):
 *    1. Find last assistant message with usage data (from LLM API response)
 *    2. Handle parallel tool calls: multiple assistant records share same messageId —
 *       backtrack to the earliest sibling to include all intermediate tool_results
 *    3. usage (precise) + rough estimate for messages after last usage point
 *    4. Include cache tokens: cache_creation_input_tokens + cache_read_input_tokens
 *
 *  Optional precise mode (beta API, on-demand):
 *    POST /v1/messages/count_tokens — use for diagnostics only
 *
 * Usage:
 *   // Fast local computation (default, no network)
 *   const result = countTokensFromHistory(messages);
 *
 *   // Precise via API (optional, requires ANTHROPIC_API_KEY)
 *   const result = await countTokensViaApi(messages, options);
 */

import type { Message } from '../models/types.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MessageUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// Extend Message with optional usage field (attached by agent-loop after each LLM call)
export interface MessageWithUsage extends Message {
  usage?: MessageUsage;
  /** Unique message ID (for parallel tool call sibling detection) */
  messageId?: string;
}

export interface CountTokensOptions {
  systemPrompt?: string;
  tools?: unknown[];
  model?: string;
}

export interface TokenCountResult {
  inputTokens: number;
  method: 'usage+estimate' | 'api' | 'estimate';
  error?: string;
}

// ── Rough estimation fallback ─────────────────────────────────────────────────

function roughEstimateTokens(messages: Message[]): number {
  return messages.reduce((acc, m) => {
    const text = typeof m.content === 'string'
      ? m.content
      : JSON.stringify(m.content);
    return acc + Math.ceil(text.length / 4) + 4; // +4 per-message overhead
  }, 0);
}

// ── Usage-based counting (claude-code tokenCountWithEstimation parity) ────────

/**
 * Get total token count from a usage object, including cache tokens.
 * Mirrors claude-code's getTokenCountFromUsage().
 */
export function getTokenCountFromUsage(usage: MessageUsage): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    usage.output_tokens
  );
}

/**
 * Count tokens from conversation history using LLM usage data + rough estimate.
 *
 * Algorithm (mirrors claude-code's tokenCountWithEstimation):
 *  1. Find the last assistant message that has .usage data
 *  2. Backtrack to find the EARLIEST sibling with same messageId
 *     (parallel tool calls produce multiple assistant records sharing one messageId)
 *  3. Use precise usage count up to that sibling
 *  4. Add rough estimate for messages after that sibling
 *
 * This is always available (no network) and handles the parallel tool call
 * edge case where naive "last assistant" scanning would undercount.
 */
export function countTokensFromHistory(messages: MessageWithUsage[]): TokenCountResult {
  // Scan backwards for last assistant message with usage
  let lastUsageIdx = -1;
  let lastUsage: MessageUsage | undefined;
  let lastMessageId: string | undefined;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as MessageWithUsage;
    if (m.role === 'assistant' && m.usage) {
      lastUsageIdx = i;
      lastUsage = m.usage;
      lastMessageId = m.messageId;
      break;
    }
  }

  if (!lastUsage || lastUsageIdx === -1) {
    // No usage data available → pure estimate
    const estimated = roughEstimateTokens(messages) +
      (messages.length > 0 ? 300 : 0); // rough system prompt overhead
    return { inputTokens: estimated, method: 'estimate' };
  }

  // ── Parallel tool call sibling backtrack ──────────────────────────────────
  // claude-code: "parallel tool call produces multiple AssistantMessage records
  // sharing the same message.id. Need to backtrack to earliest sibling."
  let earliestSiblingIdx = lastUsageIdx;
  if (lastMessageId) {
    for (let i = lastUsageIdx - 1; i >= 0; i--) {
      const m = messages[i] as MessageWithUsage;
      if (m.messageId === lastMessageId) {
        earliestSiblingIdx = i;
      } else if (i < lastUsageIdx - 20) {
        // Stop backtracking after 20 messages to avoid O(n²) in pathological cases
        break;
      }
    }
  }

  // Precise count up to the earliest sibling + rough estimate for newer messages
  const preciseTokens = getTokenCountFromUsage(lastUsage);
  const newerMessages = messages.slice(earliestSiblingIdx + 1);
  const roughTokens = roughEstimateTokens(newerMessages);

  return {
    inputTokens: preciseTokens + roughTokens,
    method: 'usage+estimate',
  };
}

// ── Anthropic countTokens beta API (optional/on-demand) ───────────────────────
//
// Only call this for explicit diagnostics — normal /context should use
// countTokensFromHistory() which requires no network round-trip.

export async function countTokensViaApi(
  messages: Message[],
  options: CountTokensOptions = {},
): Promise<TokenCountResult> {
  try {
    const { modelManager } = await import('../models/model-manager.js');
    const model = options.model ?? modelManager.getCurrentModel('main');
    if (!model.includes('claude')) {
      return countTokensFromHistory(messages as MessageWithUsage[]);
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return countTokensFromHistory(messages as MessageWithUsage[]);

    const apiMessages = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      }));
    if (!apiMessages.length) return countTokensFromHistory(messages as MessageWithUsage[]);

    const body: Record<string, unknown> = { model, messages: apiMessages };
    if (options.systemPrompt) body.system = options.systemPrompt;
    if (options.tools?.length) body.tools = options.tools;

    const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'anthropic-beta': 'token-counting-2024-11-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { input_tokens?: number };
    if (typeof data.input_tokens !== 'number') throw new Error('Invalid response');

    return { inputTokens: data.input_tokens, method: 'api' };
  } catch (err) {
    // Fallback to local computation
    const fallback = countTokensFromHistory(messages as MessageWithUsage[]);
    return { ...fallback, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Count tokens — primary entry point.
 * Uses local usage+estimate strategy by default (no network).
 * Pass precise=true to call Anthropic API (requires ANTHROPIC_API_KEY).
 */
export async function countTokens(
  messages: Message[],
  options: CountTokensOptions & { precise?: boolean } = {},
): Promise<TokenCountResult> {
  if (options.precise) {
    return countTokensViaApi(messages, options);
  }
  return countTokensFromHistory(messages as MessageWithUsage[]);
}
