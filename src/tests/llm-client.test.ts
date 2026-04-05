/**
 * llm-client.test.ts
 * 测试 LLM 客户端各层：factory、shared helpers、openai client（mock）
 *
 * 策略：mock OpenAI SDK，不发真实网络请求。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// suppress unused import warning — used in some test suites
void vi;

// Set dummy API keys at module level so OpenAI SDK doesn't throw during client construction
// in factory routing tests. These are never used for real network calls.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? 'sk-test-dummy-for-unit-tests';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-dummy';
process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? 'sk-deepseek-dummy';
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY ?? 'gsk-dummy';
process.env.SILICONFLOW_API_KEY = process.env.SILICONFLOW_API_KEY ?? 'sf-dummy';
process.env.MOONSHOT_API_KEY = process.env.MOONSHOT_API_KEY ?? 'ms-dummy';
process.env.DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY ?? 'ds-dummy';
process.env.MISTRAL_API_KEY = process.env.MISTRAL_API_KEY ?? 'ms2-dummy';
import { safeParseJSON, withInferenceTimeout, INFERENCE_TIMEOUT_MS, msgText, toOpenAIUserContent } from '../models/llm/shared.js';
import { createLLMClient } from '../models/llm/factory.js';

// ── safeParseJSON ─────────────────────────────────────────────────────────────

describe('safeParseJSON', () => {
  it('parses valid JSON', () => {
    expect(safeParseJSON('{"key":"value"}', 'tool')).toEqual({ key: 'value' });
  });

  it('returns empty object for empty string', () => {
    expect(safeParseJSON('', 'tool')).toEqual({});
  });

  it('returns { _raw } for invalid JSON', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = safeParseJSON('{invalid', 'myTool');
    expect(result).toHaveProperty('_raw', '{invalid');
    warnSpy.mockRestore();
  });

  it('logs warning on parse failure', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    safeParseJSON('not-json', 'someTool');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('someTool'),
    );
    warnSpy.mockRestore();
  });

  it('handles nested JSON objects', () => {
    const result = safeParseJSON('{"a":{"b":1},"c":[1,2,3]}', 'tool');
    expect(result).toEqual({ a: { b: 1 }, c: [1, 2, 3] });
  });
});

// ── msgText ───────────────────────────────────────────────────────────────────

describe('msgText', () => {
  it('returns string content as-is', () => {
    expect(msgText('hello world')).toBe('hello world');
  });

  it('extracts text from string-ContentBlock array', () => {
    // ContentBlock can be a string directly
    const blocks = ['part 1', ' part 2'];
    expect(msgText(blocks)).toBe('part 1 part 2');
  });

  it('handles empty string', () => {
    expect(msgText('')).toBe('');
  });
});

// ── toOpenAIUserContent ───────────────────────────────────────────────────────

describe('toOpenAIUserContent', () => {
  it('passes string through unchanged', () => {
    expect(toOpenAIUserContent('hello')).toBe('hello');
  });

  it('converts pure-text ContentBlock[] (string items) to string', () => {
    // ContentBlock items that are plain strings — no binary content, so returns a single string
    const blocks = ['foo', 'bar'];
    expect(toOpenAIUserContent(blocks)).toBe('foobar');
  });

  it('converts image ContentBlock to image_url part', () => {
    const blocks = [
      { type: 'image' as const, mimeType: 'image/png', data: 'base64data' },
    ];
    const result = toOpenAIUserContent(blocks) as Array<{ type: string; image_url?: { url: string } }>;
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]?.type).toBe('image_url');
    expect(result[0]?.image_url?.url).toContain('base64data');
  });

  it('converts image_url ContentBlock to image_url part', () => {
    const blocks = [
      { type: 'image_url' as const, url: 'https://example.com/img.png' },
    ];
    const result = toOpenAIUserContent(blocks) as Array<{ type: string; image_url?: { url: string } }>;
    expect(result[0]?.image_url?.url).toBe('https://example.com/img.png');
  });
});

// ── withInferenceTimeout ──────────────────────────────────────────────────────

describe('withInferenceTimeout', () => {
  it('resolves when fn completes before timeout', async () => {
    const result = await withInferenceTimeout('test-model', async () => 'ok');
    expect(result).toBe('ok');
  });

  it('passes an AbortSignal to fn', async () => {
    let receivedSignal: AbortSignal | null = null;
    await withInferenceTimeout('test-model', async (signal) => {
      receivedSignal = signal;
    });
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });

  it('aborts the signal after fn completes', async () => {
    let signal: AbortSignal | null = null;
    await withInferenceTimeout('test-model', async (s) => { signal = s; });
    // After completion, signal should be aborted (resource cleanup)
    expect(signal!.aborted).toBe(true);
  });

  it('re-throws fn errors without wrapping', async () => {
    await expect(
      withInferenceTimeout('test-model', async () => {
        throw new Error('fn error');
      }),
    ).rejects.toThrow('fn error');
  });

  it('INFERENCE_TIMEOUT_MS is a positive number (defaults to 3 min)', () => {
    expect(typeof INFERENCE_TIMEOUT_MS).toBe('number');
    expect(INFERENCE_TIMEOUT_MS).toBeGreaterThan(0);
    // Default 3 minutes = 180000ms (unless env var overrides)
    if (!process.env.UAGENT_INFERENCE_TIMEOUT_MS) {
      expect(INFERENCE_TIMEOUT_MS).toBe(180000);
    }
  });
});

// ── createLLMClient factory ───────────────────────────────────────────────────

describe('createLLMClient factory routing', () => {
  it('routes claude-* to a client with chat/streamChat methods', () => {
    const client = createLLMClient('claude-3-5-sonnet');
    expect(typeof client.chat).toBe('function');
    expect(typeof client.streamChat).toBe('function');
  });

  it('routes gpt-* to a client with chat/streamChat methods', () => {
    const client = createLLMClient('gpt-4o');
    expect(typeof client.chat).toBe('function');
    expect(typeof client.streamChat).toBe('function');
  });

  it('routes gemini-* to a client', () => {
    const client = createLLMClient('gemini-1.5-pro');
    expect(typeof client.chat).toBe('function');
  });

  it('routes deepseek-* to a client', () => {
    const client = createLLMClient('deepseek-chat');
    expect(typeof client.chat).toBe('function');
  });

  it('routes ollama: prefix to a client', () => {
    const client = createLLMClient('ollama:llama3');
    expect(typeof client.chat).toBe('function');
  });

  it('routes groq: prefix to a client', () => {
    const client = createLLMClient('groq:llama3-70b');
    expect(typeof client.chat).toBe('function');
  });

  it('routes siliconflow: prefix to a client', () => {
    const client = createLLMClient('siliconflow:Qwen/Qwen2.5-7B-Instruct');
    expect(typeof client.chat).toBe('function');
  });

  it('routes openrouter: prefix to a client', () => {
    const client = createLLMClient('openrouter:mistralai/mistral-7b-instruct:free');
    expect(typeof client.chat).toBe('function');
  });

  it('routes openai-compat: prefix to a client', () => {
    const client = createLLMClient('openai-compat:my-custom-model');
    expect(typeof client.chat).toBe('function');
  });

  it('routes kimi-* to a client (Moonshot)', () => {
    const client = createLLMClient('kimi-k2');
    expect(typeof client.chat).toBe('function');
  });

  it('routes qwen-* to a client', () => {
    const client = createLLMClient('qwen-turbo');
    expect(typeof client.chat).toBe('function');
  });

  it('routes mistral-* to a client', () => {
    const client = createLLMClient('mistral-large');
    expect(typeof client.chat).toBe('function');
  });

  it('routes wanqing/ prefix to a client', () => {
    const client = createLLMClient('wanqing/claude-4-sonnet');
    expect(typeof client.chat).toBe('function');
  });

  it('routes ep-* to a client (Wanqing bare)', () => {
    const client = createLLMClient('ep-xxxxx');
    expect(typeof client.chat).toBe('function');
  });

  it('defaults unknown model to OpenAI client', () => {
    const client = createLLMClient('some-future-model');
    expect(typeof client.chat).toBe('function');
  });
});
