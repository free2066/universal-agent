// @ts-nocheck
/**
 * models/llm/anthropic.ts -- Anthropic Claude implementation
 *
 * Supports: claude-3-5-sonnet, claude-3-7-sonnet, claude-4, claude-opus...
 * Features: extended thinking, streaming tool_calls, interleaved-thinking beta
 *
 * A25: PromptCaching -- insert cache_control markers on system prompt and messages
 *   Mirrors claude-code src/services/api/claude.ts L602-L691 (enablePromptCaching)
 *   Adds ephemeral cache_control to:
 *     1. Last block of system prompt (longest-lived, highest cache hit rate)
 *     2. Last message in the conversation (or 2nd-to-last for skipCacheWrite)
 *   Disabled by: ANTHROPIC_ENABLE_PROMPT_CACHE=false
 */

import Anthropic from '@anthropic-ai/sdk';
import type { LLMClient, ChatOptions, ChatResponse, Message } from '../types.js';
import { resolveAdaptiveThinking } from '../types.js';
import { withInferenceTimeout, safeParseJSON, toAnthropicContent, msgText } from './shared.js';

// ── A25: PromptCaching helpers ────────────────────────────────────────────────

const THINKING_BUDGETS: Record<string, number> = {
  low: 1024, medium: 8000, high: 16000,
  max: 32000, xhigh: 32000, maxOrXhigh: 32000,
}

/**
 * A25: isPromptCachingEnabled -- check if Anthropic Prompt Cache is active.
 * Default: true (enabled). Disable with ANTHROPIC_ENABLE_PROMPT_CACHE=false.
 */
function isPromptCachingEnabled(): boolean {
  const env = process.env.ANTHROPIC_ENABLE_PROMPT_CACHE;
  return env === undefined || env === '' || env === 'true' || env === '1';
}

/**
 * A25: insertPromptCacheMarker -- add cache_control to messages.
 *
 * Inserts cache_control: { type: 'ephemeral' } on the last content block
 * of the target message, enabling Anthropic Prompt Cache (5-min TTL).
 *
 * @param messages  Converted Anthropic MessageParam array
 * @param skipCacheWrite  If true (fork/fire-and-forget), mark 2nd-to-last instead.
 *                        This prevents fork requests from polluting the main cache key.
 *                        Mirrors claude-code api/claude.ts L689-L691 skipCacheWrite logic.
 *
 * Mirrors claude-code api/claude.ts L602-L691 enablePromptCaching logic.
 */
function insertPromptCacheMarker(
  messages: Anthropic.MessageParam[],
  opts: { skipCacheWrite?: boolean } = {},
): Anthropic.MessageParam[] {
  if (messages.length === 0 || !isPromptCachingEnabled()) return messages;

  // skipCacheWrite: mark 2nd-to-last message (fork scenario)
  const markerIndex = opts.skipCacheWrite
    ? Math.max(0, messages.length - 2)
    : messages.length - 1;

  const cloned = [...messages];
  const target = cloned[markerIndex];
  if (!target) return cloned;

  const targetClone = { ...target };

  if (typeof targetClone.content === 'string') {
    // String content -> wrap in a text block with cache_control
    targetClone.content = [
      {
        type: 'text' as const,
        text: targetClone.content,
        cache_control: { type: 'ephemeral' },
      } as unknown as Anthropic.TextBlockParam,
    ];
  } else if (Array.isArray(targetClone.content) && targetClone.content.length > 0) {
    // Array content -> add cache_control to the last block
    const contentArr = [...targetClone.content];
    const lastBlock = { ...contentArr[contentArr.length - 1] } as Record<string, unknown>;
    lastBlock['cache_control'] = { type: 'ephemeral' };
    contentArr[contentArr.length - 1] = lastBlock as unknown as Anthropic.ContentBlockParam;
    targetClone.content = contentArr;
  }

  cloned[markerIndex] = targetClone as Anthropic.MessageParam;
  return cloned;
}

/**
 * A25: addSystemCacheControl -- add cache_control to system prompt.
 *
 * The system prompt changes infrequently, so caching it achieves the highest
 * token savings (cache hit rate ~95%+ in long sessions).
 *
 * Mirrors claude-code api/claude.ts L591 system prompt cache handling.
 */
function addSystemCacheControl(
  systemPrompt: string | Anthropic.TextBlockParam[] | undefined,
): string | Anthropic.TextBlockParam[] | undefined {
  if (!isPromptCachingEnabled() || !systemPrompt) return systemPrompt;

  if (typeof systemPrompt === 'string') {
    // Wrap string system prompt in a text block with cache_control
    return [
      {
        type: 'text' as const,
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      } as Anthropic.TextBlockParam,
    ];
  }

  if (Array.isArray(systemPrompt) && systemPrompt.length > 0) {
    // Add cache_control to last block
    const arr = [...systemPrompt];
    const last = { ...arr[arr.length - 1] } as Anthropic.TextBlockParam & Record<string, unknown>;
    last['cache_control'] = { type: 'ephemeral' };
    arr[arr.length - 1] = last;
    return arr;
  }

  return systemPrompt;
}

// ── A25: Usage extraction helper ──────────────────────────────────────────────

/** A25: _extractUsage -- safely extract token counts including cache stats. */
function _extractUsage(usage: Anthropic.Usage): {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
} {
  const u = usage as unknown as Record<string, number>;
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    ...(u['cache_creation_input_tokens'] !== undefined
      ? { cache_creation_input_tokens: u['cache_creation_input_tokens'] }
      : {}),
    ...(u['cache_read_input_tokens'] !== undefined
      ? { cache_read_input_tokens: u['cache_read_input_tokens'] }
      : {}),
  };
}

export class AnthropicClient implements LLMClient {
  private client: Anthropic;
  private model: string;

  constructor(model: string) {
    this.model = model;
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    // P0: wrap in withInferenceTimeout to prevent indefinite hang (matches streamChat behavior)
    return withInferenceTimeout(this.model, async (signal) => {
      const rawMessages = this.convertMessages(options.messages);
      // A25: insert prompt cache markers on messages and system prompt
      const messages = insertPromptCacheMarker(rawMessages, {
        skipCacheWrite: (options as ChatOptions & { skipCacheWrite?: boolean }).skipCacheWrite,
      });
      const cachedSystem = addSystemCacheControl(
        options.systemPrompt as string | Anthropic.TextBlockParam[] | undefined,
      );

      const hasTools = (options.tools?.length ?? 0) > 0;
      const maxTokens = parseInt(process.env.ANTHROPIC_MAX_TOKENS ?? '8192', 10);
      // Round 7: adaptive thinking level resolves based on model name
      const thinking = resolveAdaptiveThinking(options.thinkingLevel, this.model);
      const budgetTokens = thinking ? (THINKING_BUDGETS[thinking] ?? 1024) : undefined;
      const effectiveMax = budgetTokens ? Math.max(maxTokens, budgetTokens + 1024) : maxTokens;

      // A25: add prompt-caching beta header when cache_control is used
      const extraBetas: string[] = isPromptCachingEnabled() ? ['prompt-caching-2024-07-31'] : [];

      // Merge inference timeout signal with caller's AbortSignal
      const abortSignal = options.signal
        ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, options.signal]) : signal)
        : signal;

      const msg = await this.client.messages.create({
        model: this.model,
        max_tokens: effectiveMax,
        system: cachedSystem as string,
        messages,
        ...(budgetTokens ? {
          thinking: { type: 'enabled', budget_tokens: budgetTokens },
          betas: ['interleaved-thinking-2025-05-14', ...extraBetas],
        } : (extraBetas.length > 0 ? { betas: extraBetas } : {})),
        ...(hasTools ? {
          tools: options.tools!.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters as Anthropic.Tool['input_schema'],
          })),
        } : {}),
      } as Parameters<typeof this.client.messages.create>[0], { signal: abortSignal }) as Anthropic.Message;

      const toolUseBlocks = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      const textBlocks    = msg.content.filter((b): b is Anthropic.TextBlock    => b.type === 'text');

      if (toolUseBlocks.length) {
        return {
          type: 'tool_calls',
          content: textBlocks.map((b) => b.text).join(''),
          toolCalls: toolUseBlocks.map((b) => ({
            id: b.id,
            name: b.name,
            arguments: b.input as Record<string, unknown>,
          })),
          // A25: expose cache stats from usage field
          usage: _extractUsage(msg.usage),
        };
      }

      return {
        type: 'text',
        content: textBlocks.map((b) => b.text).join(''),
        // A25: expose cache stats from usage field
        usage: _extractUsage(msg.usage),
      };
    });
  }

  async streamChat(options: ChatOptions, onChunk: (chunk: string) => void): Promise<ChatResponse> {
    return withInferenceTimeout(this.model, async (_signal) => {
      const rawMessages = this.convertMessages(options.messages);
      // A25: insert prompt cache markers
      const messages = insertPromptCacheMarker(rawMessages, {
        skipCacheWrite: (options as ChatOptions & { skipCacheWrite?: boolean }).skipCacheWrite,
      });
      const cachedSystem = addSystemCacheControl(
        options.systemPrompt as string | Anthropic.TextBlockParam[] | undefined,
      );

      const hasTools = (options.tools?.length ?? 0) > 0;
      const maxTokens = parseInt(process.env.ANTHROPIC_MAX_TOKENS ?? '8192', 10);
      // Round 7: adaptive thinking level resolves based on model name
      const thinking = resolveAdaptiveThinking(options.thinkingLevel, this.model);
      const budgetTokens = thinking ? (THINKING_BUDGETS[thinking] ?? 1024) : undefined;
      const effectiveMax = budgetTokens ? Math.max(maxTokens, budgetTokens + 1024) : maxTokens;

      // A19: Combine inference timeout signal with caller's AbortSignal (user Ctrl+C).
      // LLM-6: when AbortSignal.any is unavailable (Node < 20.3), manually race the two
      // signals so the inference timeout is never silently discarded.
      let combinedSignal: AbortSignal;
      if (options.signal) {
        if (typeof AbortSignal.any === 'function') {
          combinedSignal = AbortSignal.any([_signal, options.signal]);
        } else {
          // Manual race: first abort wins
          const merged = new AbortController();
          const onAbort = (reason: unknown) => { if (!merged.signal.aborted) merged.abort(reason); };
          _signal.addEventListener('abort', () => onAbort(_signal.reason), { once: true });
          options.signal.addEventListener('abort', () => onAbort(options.signal!.reason), { once: true });
          combinedSignal = merged.signal;
        }
      } else {
        combinedSignal = _signal;
      }

      // A25: add prompt-caching beta header when cache_control is used
      const extraBetas: string[] = isPromptCachingEnabled() ? ['prompt-caching-2024-07-31'] : [];

      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: effectiveMax,
        system: cachedSystem as string,
        messages,
        ...(budgetTokens ? {
          thinking: { type: 'enabled', budget_tokens: budgetTokens },
          betas: ['interleaved-thinking-2025-05-14', ...extraBetas],
        } : (extraBetas.length > 0 ? { betas: extraBetas } : {})),
        ...(hasTools ? {
          tools: options.tools!.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters as Anthropic.Tool['input_schema'],
          })),
        } : {}),
      } as Parameters<typeof this.client.messages.stream>[0], { signal: combinedSignal });

      let textContent = '';
      const toolUseBlocks: Array<{ id: string; name: string; inputJson: string }> = [];
      let currentToolUseIdx = -1;
      // A25: capture usage from stream_end event for cache stats
      let streamUsage: Record<string, number> | undefined;

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          if ((event.content_block as { type: string }).type === 'tool_use') {
            const tb = event.content_block as { type: string; id: string; name: string };
            currentToolUseIdx = toolUseBlocks.length;
            toolUseBlocks.push({ id: tb.id, name: tb.name, inputJson: '' });
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            onChunk(event.delta.text);
            textContent += event.delta.text;
          } else if ((event.delta as { type: string; partial_json?: string }).type === 'input_json_delta') {
            const partialJson = (event.delta as { type: string; partial_json?: string }).partial_json ?? '';
            const tb = toolUseBlocks[currentToolUseIdx];
            if (currentToolUseIdx >= 0 && tb) {
              tb.inputJson += partialJson;
              // StreamingToolExecutor: eager tool call notification
              if (options.onToolCallDelta) {
                options.onToolCallDelta(currentToolUseIdx, tb.name, partialJson, tb.id);
              }
            }
          }
        } else if (event.type === 'content_block_stop') {
          currentToolUseIdx = -1;
        } else if (event.type === 'message_delta') {
          // A25: capture usage stats including cache tokens
          const ev = event as unknown as { usage?: Record<string, number> };
          if (ev.usage) streamUsage = ev.usage;
        }
      }

      // Try to get usage from final message
      try {
        const finalMsg = await stream.finalMessage();
        streamUsage = _extractUsage(finalMsg.usage) as Record<string, number>;
      } catch { /* non-fatal: finalMessage() may not always be available */ }

      // B31: parse Anthropic rate-limit response headers for early quota warning
      // Mirrors claude-code claudeAiLimits.ts extractQuotaStatusFromHeaders()
      try {
        const httpResponse = (stream as unknown as { response?: { headers?: Record<string, string> } }).response;
        if (httpResponse?.headers) {
          const { parseAiLimitHeaders } = await import('../../core/services/ai-limits.js');
          parseAiLimitHeaders(httpResponse.headers);
        }
      } catch { /* B31: non-fatal */ }

      if (toolUseBlocks.length > 0) {
        return {
          type: 'tool_calls',
          content: textContent,
          toolCalls: toolUseBlocks.map((tb) => ({
            id: tb.id,
            name: tb.name,
            arguments: safeParseJSON(tb.inputJson, tb.name),
          })),
          ...(streamUsage ? { usage: streamUsage as ChatResponse['usage'] } : {}),
        };
      }

      return {
        type: 'text',
        content: textContent,
        ...(streamUsage ? { usage: streamUsage as ChatResponse['usage'] } : {}),
      };
    });
  }

  private convertMessages(messages: Message[]): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];
    let i = 0;
    while (i < messages.length) {
      const msg = messages[i];
      if (msg.role === 'user') {
        result.push({ role: 'user', content: toAnthropicContent(msg.content) as string | Anthropic.ContentBlockParam[] });
        i++;
      } else if (msg.role === 'assistant') {
        if (msg.toolCalls?.length) {
          result.push({
            role: 'assistant',
            content: [
              ...(msg.content ? [{ type: 'text' as const, text: msgText(msg.content) }] : []),
              ...msg.toolCalls.map((tc) => ({
                type: 'tool_use' as const,
                id: tc.id,
                name: tc.name,
                input: tc.arguments,
              })),
            ],
          });
        } else {
          result.push({ role: 'assistant', content: msg.content ? [{ type: 'text' as const, text: msgText(msg.content) }] : [] });
        }
        i++;
      } else if (msg.role === 'tool') {
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        while (i < messages.length && messages[i].role === 'tool') {
          const toolMsg = messages[i];
          // LLM-10: toolCallId is optional; skip with warning if missing
          if (!toolMsg.toolCallId) {
            process.stderr.write(`[llm-client:anthropic] Skipping tool message with missing toolCallId\n`);
            i++;
            continue;
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolMsg.toolCallId,
            content: msgText(toolMsg.content),
          });
          i++;
        }
        if (toolResults.length > 0) result.push({ role: 'user', content: toolResults });
      } else {
        i++;
      }
    }
    return result;
  }
}
