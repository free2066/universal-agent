/**
 * models/llm/shared.ts — LLM 客户端公共工具函数和常量
 *
 * 从 llm-client.ts 提取，供各 Provider 实现共享。
 */

import type { ContentBlock, ImageBlock, ImageUrlBlock } from '../types.js';
import { getContentText } from '../types.js';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { logForDebugging } from '../../utils/debug.js';

// ── Vision content helpers ────────────────────────────────────────────────────

/** Build an OpenAI-style user content part array (supports images). */
export function toOpenAIUserContent(
  content: string | ContentBlock[],
): string | OpenAI.ChatCompletionContentPart[] {
  if (typeof content === 'string') return content;
  const hasBin = content.some(b => typeof b !== 'string');
  if (!hasBin) return getContentText(content);
  return content.map((b): OpenAI.ChatCompletionContentPart => {
    if (typeof b === 'string') return { type: 'text', text: b };
    if (b.type === 'image') {
      return { type: 'image_url', image_url: { url: `data:${(b as ImageBlock).mimeType};base64,${(b as ImageBlock).data}` } };
    }
    if (b.type === 'image_url') {
      return { type: 'image_url', image_url: { url: (b as ImageUrlBlock).url } };
    }
    return { type: 'text', text: '' };
  });
}

/** Build an Anthropic-style content array (supports images). */
export function toAnthropicContent(
  content: string | ContentBlock[],
): string | Anthropic.ContentBlockParam[] {
  if (typeof content === 'string') return content;
  const hasBin = content.some(b => typeof b !== 'string');
  if (!hasBin) return getContentText(content);
  return content.map((b): Anthropic.ContentBlockParam => {
    if (typeof b === 'string') return { type: 'text', text: b };
    if (b.type === 'image') {
      return { type: 'image', source: { type: 'base64', media_type: (b as ImageBlock).mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: (b as ImageBlock).data } };
    }
    if (b.type === 'image_url') {
      return { type: 'image', source: { type: 'url', url: (b as ImageUrlBlock).url } as unknown as Anthropic.Base64ImageSource };
    }
    return { type: 'text', text: '' };
  });
}

/** Safe plain-text extraction for logging/token counting */
export function msgText(content: string | ContentBlock[]): string {
  return getContentText(content);
}

// ── Thinking budget constants ─────────────────────────────────────────────────

export const THINKING_BUDGETS: Record<string, number> = { low: 1024, medium: 8000, high: 16000 };

/** Map thinking level → OpenAI reasoning_effort string (o1/o3/o4 series) */
export const REASONING_EFFORT: Record<string, string> = { low: 'low', medium: 'medium', high: 'high' };

// ── Inference timeout ─────────────────────────────────────────────────────────

const _parsed = parseInt(process.env.UAGENT_INFERENCE_TIMEOUT_MS ?? '', 10);
/**
 * Hard wall-clock timeout for streaming LLM calls.
 * Default: 10 minutes (raised from 3min — complex tasks with tool execution
 * like mvn compile/tsc can easily consume 3+ minutes during streaming).
 * Override with env var UAGENT_INFERENCE_TIMEOUT_MS.
 */
export const INFERENCE_TIMEOUT_MS = Number.isFinite(_parsed) && _parsed > 0 ? _parsed : 10 * 60 * 1000;

/**
 * Run `fn(signal)` with a hard wall-clock timeout.
 * Throws an error with a user-friendly message when the timeout fires.
 */
export async function withInferenceTimeout<T>(
  model: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new Error(
        `[llm-client] Inference timeout after ${INFERENCE_TIMEOUT_MS / 1000}s — ` +
        `model "${model}" did not complete streaming. ` +
        `Increase timeout with UAGENT_INFERENCE_TIMEOUT_MS env var.`,
      ),
    );
  }, INFERENCE_TIMEOUT_MS);
  try {
    return await fn(controller.signal);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      const reason = controller.signal.reason;
      throw reason instanceof Error ? reason : new Error(String(reason ?? err.message));
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (!controller.signal.aborted) {
      controller.abort();
    }
  }
}

// ── JSON helpers ─────────────────────────────────────────────────────────────

export function safeParseJSON(raw: string, toolName: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    logForDebugging(`[llm-client] Failed to parse tool arguments for "${toolName}": ${raw}`)
    return { _raw: raw };
  }
}
