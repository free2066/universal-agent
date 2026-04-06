/**
 * models/llm/anthropic.ts — Anthropic Claude 实现
 *
 * 支持：claude-3-5-sonnet, claude-3-7-sonnet, claude-4, claude-opus…
 * 特性：extended thinking, streaming tool_calls, interleaved-thinking beta
 */

import Anthropic from '@anthropic-ai/sdk';
import type { LLMClient, ChatOptions, ChatResponse, Message } from '../types.js';
import { resolveAdaptiveThinking } from '../types.js';
import { withInferenceTimeout, safeParseJSON, toAnthropicContent, msgText } from './shared.js';

export class AnthropicClient implements LLMClient {
  private client: Anthropic;
  private model: string;

  constructor(model: string) {
    this.model = model;
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    const messages = this.convertMessages(options.messages);
    const hasTools = (options.tools?.length ?? 0) > 0;
    const maxTokens = parseInt(process.env.ANTHROPIC_MAX_TOKENS ?? '8192', 10);
    // Round 7: adaptive thinking level resolves based on model name
    const thinking = resolveAdaptiveThinking(options.thinkingLevel, this.model);
    const budgets: Record<string, number> = {
      low: 1024, medium: 8000, high: 16000,
      max: 32000, xhigh: 32000, maxOrXhigh: 32000,
    };
    const budgetTokens = thinking ? (budgets[thinking] ?? 1024) : undefined;
    const effectiveMax = budgetTokens ? Math.max(maxTokens, budgetTokens + 1024) : maxTokens;

    const msg = await this.client.messages.create({
      model: this.model,
      max_tokens: effectiveMax,
      system: options.systemPrompt,
      messages,
      ...(budgetTokens ? {
        thinking: { type: 'enabled', budget_tokens: budgetTokens },
        betas: ['interleaved-thinking-2025-05-14'],
      } : {}),
      ...(hasTools ? {
        tools: options.tools!.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters as Anthropic.Tool['input_schema'],
        })),
      } : {}),
    } as Parameters<typeof this.client.messages.create>[0]) as Anthropic.Message;

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
      };
    }

    return { type: 'text', content: textBlocks.map((b) => b.text).join('') };
  }

  async streamChat(options: ChatOptions, onChunk: (chunk: string) => void): Promise<ChatResponse> {
    return withInferenceTimeout(this.model, async (_signal) => {
      const messages = this.convertMessages(options.messages);
      const hasTools = (options.tools?.length ?? 0) > 0;
      const maxTokens = parseInt(process.env.ANTHROPIC_MAX_TOKENS ?? '8192', 10);
      // Round 7: adaptive thinking level resolves based on model name
      const thinking = resolveAdaptiveThinking(options.thinkingLevel, this.model);
      const budgets: Record<string, number> = {
        low: 1024, medium: 8000, high: 16000,
        max: 32000, xhigh: 32000, maxOrXhigh: 32000,
      };
      const budgetTokens = thinking ? (budgets[thinking] ?? 1024) : undefined;
      const effectiveMax = budgetTokens ? Math.max(maxTokens, budgetTokens + 1024) : maxTokens;

      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: effectiveMax,
        system: options.systemPrompt,
        messages,
        ...(budgetTokens ? {
          thinking: { type: 'enabled', budget_tokens: budgetTokens },
          betas: ['interleaved-thinking-2025-05-14'],
        } : {}),
        ...(hasTools ? {
          tools: options.tools!.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters as Anthropic.Tool['input_schema'],
          })),
        } : {}),
      } as Parameters<typeof this.client.messages.stream>[0]);

      let textContent = '';
      const toolUseBlocks: Array<{ id: string; name: string; inputJson: string }> = [];
      let currentToolUseIdx = -1;

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
            if (currentToolUseIdx >= 0 && toolUseBlocks[currentToolUseIdx]) {
              toolUseBlocks[currentToolUseIdx]!.inputJson += partialJson;
              // ── StreamingToolExecutor: eager tool call notification ──────
              // Notify the caller so it can start executing read-only tools
              // as soon as their argument JSON is complete, without waiting
              // for the whole LLM stream to finish.
              if (options.onToolCallDelta) {
                const tb = toolUseBlocks[currentToolUseIdx]!;
                options.onToolCallDelta(currentToolUseIdx, tb.name, partialJson, tb.id);
              }
            }
          }
        } else if (event.type === 'content_block_stop') {
          currentToolUseIdx = -1;
        }
      }

      if (toolUseBlocks.length > 0) {
        return {
          type: 'tool_calls',
          content: textContent,
          toolCalls: toolUseBlocks.map((tb) => ({
            id: tb.id,
            name: tb.name,
            arguments: safeParseJSON(tb.inputJson, tb.name),
          })),
        };
      }

      return { type: 'text', content: textContent };
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
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolMsg.toolCallId!,
            content: msgText(toolMsg.content),
          });
          i++;
        }
        result.push({ role: 'user', content: toolResults });
      } else {
        i++;
      }
    }
    return result;
  }
}
