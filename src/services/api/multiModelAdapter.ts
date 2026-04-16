/**
 * src/services/api/multiModelAdapter.ts
 *
 * Wraps UA's multi-model LLM clients (OpenAI/Gemini/Ollama/etc.) into an
 * Anthropic-SDK-compatible interface so CC's engine can call them transparently.
 *
 * The adapter intercepts `anthropic.beta.messages.create()` and routes it to
 * the correct provider via UA's createLLMClient() factory.
 */

import { randomUUID } from 'crypto'
import { appendFile } from 'fs/promises'
import { resolve as pathResolve, normalize as pathNormalize } from 'path'
import { createLLMClient } from '../../models/llm/factory.js'
import { getModelPromptRules } from '../modelPrompt/index.js'
import { sleep } from '../../utils/sleep.js'
import type {
  ContentBlock,
  ToolResultContentBlock,
  AnthropicBetaMessageParam,
  UAMessage,
  UAToolDefinition,
  AnthropicToolDefinition,
  UAChatResponse,
  AnthropicMessage,
  SSEEvent,
  AnthropicMessagesCreateParams,
  AnthropicMessagesCreateOptions,
  UAToolCall,
} from './types.js'

// ============================================================================
// UUID Short ID Generation (performance optimized)
// ============================================================================

/** 正则表达式常量，用于移除 UUID 中的连字符 */
const UUID_HYPHEN_REGEX = /-/g

/**
 * 生成 24 字符的短 ID（基于 UUID）
 * 用于 message_id 和 tool_use_id 的生成
 *
 * @param prefix - 可选前缀，如 'msg_' 或 'toolu_'
 * @returns 带前缀的 24 字符 ID
 */
function generateShortId(prefix: '' | 'msg_' | 'toolu_' = ''): string {
  return `${prefix}${randomUUID().replace(UUID_HYPHEN_REGEX, '').slice(0, 24)}`
}

// ============================================================================
// Fallback chain configuration caching
// ============================================================================

/** Cached fallback chain from environment variable */
let _fallbackChainCache: string[] | undefined
let _fallbackChainCacheEnv: string | undefined

/** Get fallback chain with caching */
function getFallbackChain(): string[] {
  const env = process.env.UA_FALLBACK_CHAIN
  if (env === _fallbackChainCacheEnv && _fallbackChainCache !== undefined) {
    return _fallbackChainCache
  }
  try {
    const parsed = JSON.parse(env || '[]')
    if (!Array.isArray(parsed)) {
      _fallbackChainCache = []
    } else {
      _fallbackChainCache = parsed.filter((m: unknown) => typeof m === 'string' && m.length > 0)
    }
    _fallbackChainCacheEnv = env
  } catch {
    _fallbackChainCache = []
    _fallbackChainCacheEnv = ''
  }
  return _fallbackChainCache
}

// MA-6: Validate UA_DEBUG_LOG path once at module load to prevent path traversal.
// Reject /proc, /sys, /etc and other dangerous system directories.
const _UA_LOG_PATH: string | null = (() => {
  const p = process.env.UA_DEBUG_LOG
  if (!p) return null
  try {
    const resolved = pathResolve(pathNormalize(p))
    const dangerous = ['/proc', '/sys', '/etc', '/dev', '/boot', '/root']
    if (dangerous.some(d => resolved === d || resolved.startsWith(d + '/'))) return null
    return resolved
  } catch { return null }
})()

// Cached timestamp prefix (refreshed every second)
let _cachedTimestamp: string | null = null
let _cachedTimestampTime: number = 0

function getTimestampPrefix(): string {
  const now = Date.now()
  if (_cachedTimestamp && now - _cachedTimestampTime < 1000) {
    return _cachedTimestamp
  }
  _cachedTimestamp = new Date(now).toISOString()
  _cachedTimestampTime = now
  return _cachedTimestamp
}

/** Async, non-blocking debug log helper. Silently swallows write errors. */
function uaLogAsync(msg: string): void {
  if (!_UA_LOG_PATH) return
  const line = `[${getTimestampPrefix()}] ${msg}\n`
  appendFile(_UA_LOG_PATH, line).catch(() => {})
}

// UA 修改：持久重试模式 - 默认开启持久重试
function isPersistentRetryEnabled(): boolean {
  const envValue = process.env.CLAUDE_CODE_UNATTENDED_RETRY
  if (envValue === undefined || envValue !== 'false') {
    return true
  }
  return false
}

/** Convert Anthropic BetaMessageStreamParams → UA ChatOptions messages array (NO system) */
function convertAnthropicMessagesToUA(params: AnthropicMessagesCreateParams): UAMessage[] {
  const messages: UAMessage[] = []

  // NOTE: system prompt is handled separately in _callModel as chatOptions.systemPrompt
  // Do NOT push system here to avoid duplication in OpenAIClient.convertMessages()

  // Conversation messages (user + assistant + tool_result only)
  for (const msg of params.messages || []) {
    if (msg.role === 'user') {
      // MA-7: a user message may contain BOTH text AND tool_result blocks.
      // Process both — emit text first, then tool results.
      const toolResults = extractToolResults(msg.content)
      const textContent = extractTextContent(msg.content)
      // Only push text if it exists and there are no tool results that already
      // represent the user turn (avoids duplicate user messages in most cases).
      // But if there's ALSO text alongside tool_results, we must keep it.
      if (toolResults.length > 0) {
        if (textContent) messages.push({ role: 'user', content: textContent })
        for (const tr of toolResults) {
          const trBlock = tr as ToolResultContentBlock
          const resultContent = Array.isArray(trBlock.content)
            ? trBlock.content.filter((b: ContentBlock) => b.type === 'text').map((b: ContentBlock & { text: string }) => b.text).join('\n')
            : (typeof trBlock.content === 'string' ? trBlock.content : JSON.stringify(trBlock.content))
          messages.push({
            role: 'tool',
            content: resultContent,
            toolCallId: trBlock.tool_use_id,
          })
        }
      } else {
        if (textContent) messages.push({ role: 'user', content: textContent })
      }
    } else if (msg.role === 'assistant') {
      const textContent = extractTextContent(msg.content)
      const toolUses = extractToolUses(msg.content)
      if (toolUses.length > 0) {
        messages.push({
          role: 'assistant',
          content: textContent,
          toolCalls: toolUses.map((tu: ContentBlock) => {
            const tuBlock = tu as ContentBlock & { id: string; name: string; input?: Record<string, unknown> }
            return {
              id: tuBlock.id,
              name: tuBlock.name,
              arguments: tuBlock.input || {},
            }
          }),
        })
      } else {
        messages.push({ role: 'assistant', content: textContent })
      }
    }
  }

  return messages
}

function extractTextContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  // P3: join with '' not '\n' — Anthropic text blocks are semantically flat;
  // using '\n' can break JSON content or introduce spurious whitespace.
  return content
    .filter((b: ContentBlock) => b.type === 'text')
    .map((b: ContentBlock & { text: string }) => b.text || '')
    .join('')
}

function extractToolUses(content: string | ContentBlock[]): ContentBlock[] {
  if (!Array.isArray(content)) return []
  return content.filter((b: ContentBlock) => b.type === 'tool_use')
}

function extractToolResults(content: string | ContentBlock[]): ContentBlock[] {
  if (!Array.isArray(content)) return []
  return content.filter((b: ContentBlock) => b.type === 'tool_result')
}

/** Convert Anthropic tool definitions → UA tool definitions */
function convertTools(anthropicTools: AnthropicToolDefinition[]): UAToolDefinition[] {
  if (!anthropicTools?.length) return []
  return anthropicTools
    .filter((t: AnthropicToolDefinition) => t.name)
    .map((t: AnthropicToolDefinition) => ({
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    }))
}

/**
 * Repair a tool name that the model returned with wrong casing.
 * Strategy (borrowed from opencode/packages/opencode/src/session/llm.ts):
 *   1. Try toLowerCase() — most models just capitalize the first letter
 *   2. If still unrecognized, leave as-is (CC will handle the unknown tool gracefully)
 *
 * We don't have access to the registered tool set here (that lives in CC's engine),
 * so we only normalize casing. CC's tool lookup is already case-sensitive; this
 * pre-normalizes before CC sees the name so mismatches don't cause "tool not found".
 */
function normalizeToolName(name: string): string {
  if (!name) return name
  const lower = name.toLowerCase()
  // If model returned e.g. "Bash", "READ", "Write" — normalize to lowercase.
  // This matches how CC registers all built-in tool names (all lowercase).
  if (lower !== name) {
    return lower
  }
  return name
}

/** Convert UA ChatResponse → Anthropic BetaMessage format */
function convertResponseToAnthropicMessage(
  response: UAChatResponse,
  model: string,
  inputTokens = 0,
  outputTokens = 0,
): AnthropicMessage {
  const content: ContentBlock[] = []

  if (response.type === 'tool_calls') {
    if (response.content) {
      content.push({ type: 'text', text: response.content })
    }
    for (const tc of response.toolCalls || []) {
      content.push({
        type: 'tool_use',
        id: tc.id || generateShortId('toolu_'),
        name: normalizeToolName(tc.name),
        input: tc.arguments || {},
      })
    }
  } else {
    content.push({ type: 'text', text: response.content || '' })
  }

  return {
    id: generateShortId('msg_'),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: response.type === 'tool_calls' ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  }
}

/**
 * Creates a fake streaming response (AsyncGenerator) that emits the exact
 * Anthropic SSE event shape CC's engine expects.
 */
async function* createFakeStream(
  response: UAChatResponse,
  model: string,
  inputTokens: number,
  outputTokens: number,
): AsyncGenerator<SSEEvent> {
  const message = convertResponseToAnthropicMessage(response, model, inputTokens, outputTokens)

  yield {
    type: 'message_start',
    message: {
      id: message.id,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }

  for (let idx = 0; idx < message.content.length; idx++) {
    const block = message.content[idx]
    yield { type: 'content_block_start', index: idx, content_block: { ...block, ...(block.type === 'tool_use' ? { input: {} } : {}) } }

    if (block.type === 'text') {
      const chunkSize = 80
      for (let i = 0; i < block.text.length; i += chunkSize) {
        yield {
          type: 'content_block_delta',
          index: idx,
          delta: { type: 'text_delta', text: block.text.slice(i, i + chunkSize) },
        }
      }
    } else if (block.type === 'tool_use') {
      yield {
        type: 'content_block_delta',
        index: idx,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) },
      }
    }

    yield { type: 'content_block_stop', index: idx }
  }

  yield {
    type: 'message_delta',
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  }

  yield { type: 'message_stop' }
}

/**
 * Build a streamResult that has the `.withResponse()` method CC's engine calls.
 * `.withResponse()` must return { data: AsyncIterable<events>, response: Response, request_id: string }
 */
function buildStreamResult(
  response: UAChatResponse,
  model: string,
  inputTokens: number,
  outputTokens: number,
): // eslint-disable-next-line @typescript-eslint/no-explicit-any
any {
  const fakeRequestId = `ua-${randomUUID()}`
  const finalMessage = convertResponseToAnthropicMessage(response, model, inputTokens, outputTokens)

  // MA-8: keep a single generator instance so Symbol.asyncIterator always returns the
  // SAME iterator — prevents duplicate SSE events if CC iterates the stream more than once.
  const streamInstance = createFakeStream(response, model, inputTokens, outputTokens)

  // Create a fake Response object with minimal interface CC needs
  const fakeResponse = new Response(null, { status: 200 })

  // The stream data object — an AsyncIterable with extra methods
  const data = Object.assign(streamInstance, {
    finalMessage: () => Promise.resolve(finalMessage),
    [Symbol.asyncIterator]: () => streamInstance,
    withResponse: () => ({ data, response: fakeResponse, request_id: fakeRequestId }),
  })

  // Return a thenable that resolves immediately (create() is awaited)
  // and also has .withResponse() for when CC calls create(...).withResponse()
  const result = Object.assign(
    {
      // MA-1: pass reject through so downstream Promise chains receive errors
      then: <T>(resolve: (value: unknown) => T | unknown, reject: (reason: unknown) => unknown) => Promise.resolve(data).then(resolve, reject),
      withResponse: () =>
        Promise.resolve({ data, response: fakeResponse, request_id: fakeRequestId }),
    },
    data,
  )

  return result
}

/**
 * Build a REAL streaming result that emits SSE events as tokens arrive.
 *
 * Uses a rolling Promise mechanism to avoid the race condition in the old
 * chunkDoneResolvers array approach:
 *
 * - Each onChunk call resolves the *current* notifyPromise and immediately
 *   creates a new one. The Generator always awaits the latest notifyPromise,
 *   so it can never miss a notification regardless of call order.
 * - Empty chunks (from reasoning_content phases in GLM-5/MiMo) advance the
 *   Generator without emitting any SSE output (filtered by `if (chunk)`).
 *
 * For tool_calls the text content is already accumulated in chunkQueue; tool
 * blocks are emitted after the stream completes.
 */
function buildRealStreamResult(
  streamChatPromise: Promise<any>,
  chunkQueue: string[],
  getNotifyPromise: () => Promise<void>,
  model: string,
  inputTokensFn: () => number,
  outputTokensFn: () => number,
): any {
  const fakeRequestId = `ua-${randomUUID()}`
  const fakeResponse = new Response(null, { status: 200 })

  const makeStream = () => realStream()

  async function* realStream(): AsyncGenerator<any> {
    const messageId = generateShortId('msg_')

    // Emit message_start immediately
    yield {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }

    // Emit content_block_start for the text block
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }

    let chunkIndex = 0
    let done = false

    // Wait for streamChat to complete and get the full response
    const fullResponsePromise = streamChatPromise.then(
      (r: any) => { done = true; return r },
      (e: any) => { done = true; throw e },
    )

    // Stream text chunks as they arrive
    while (!done || chunkIndex < chunkQueue.length) {
      if (chunkIndex >= chunkQueue.length) {
        if (done) break
        // Wait for next chunk notification (rolling Promise — never misses a signal)
        await getNotifyPromise()
        continue
      }

      // Emit all buffered chunks
      while (chunkIndex < chunkQueue.length) {
        const chunk = chunkQueue[chunkIndex++]
        if (chunk) {
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: chunk },
          }
        }
      }
    }

    // Get the final response (tool calls etc)
    let finalResponse: any
    try {
      finalResponse = await fullResponsePromise
    } catch (e: any) {
      throw e
    }

    const inputTokens = inputTokensFn()
    const outputTokens = outputTokensFn()

    // If tool_calls response, emit tool_use blocks
    if (finalResponse?.type === 'tool_calls') {
      yield { type: 'content_block_stop', index: 0 }

      for (let i = 0; i < (finalResponse.toolCalls || []).length; i++) {
        const tc = finalResponse.toolCalls[i]
        const toolId = tc.id || generateShortId('toolu_')
        yield {
          type: 'content_block_start',
          index: i + 1,
          content_block: { type: 'tool_use', id: toolId, name: normalizeToolName(tc.name), input: {} },
        }
        yield {
          type: 'content_block_delta',
          index: i + 1,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(tc.arguments || {}) },
        }
        yield { type: 'content_block_stop', index: i + 1 }
      }

      yield {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      }
    } else {
      yield { type: 'content_block_stop', index: 0 }
      yield {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      }
    }

    // MA-3: patch _storedFinalMessage BEFORE yielding message_stop.
    // CC calls finalMessage() immediately after seeing message_stop; if we patch
    // after the yield the generator hasn't resumed yet and finalMessage() returns
    // an empty content array.
    const finalContent: any[] = []
    // MA-9: streaming mode — always use chunkQueue as the authoritative text source
    const textContent = chunkQueue.join('') || finalResponse?.content || ''
    if (textContent) finalContent.push({ type: 'text', text: textContent })
    if (finalResponse?.type === 'tool_calls') {
      for (const tc of finalResponse.toolCalls || []) {
        finalContent.push({
          type: 'tool_use',
          id: tc.id || generateShortId('toolu_'),
          name: normalizeToolName(tc.name),
          input: tc.arguments || {},
        })
      }
    }
    if (_storedFinalMessage) {
      _storedFinalMessage.content = finalContent
      _storedFinalMessage.usage.input_tokens = inputTokens
      _storedFinalMessage.usage.output_tokens = outputTokens
      _storedFinalMessage.stop_reason = finalResponse?.type === 'tool_calls' ? 'tool_use' : 'end_turn'
    }

    yield { type: 'message_stop' }
  }

  // Placeholder for final message (filled in after stream completes)
  const _storedFinalMessage: any = {
    id: generateShortId('msg_'),
    type: 'message',
    role: 'assistant',
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }

  // MA-8: keep a single generator instance in the real stream too
  const realStreamInstance = makeStream()

  const data = Object.assign(realStreamInstance, {
    finalMessage: () => Promise.resolve(_storedFinalMessage),
    [Symbol.asyncIterator]: () => realStreamInstance,
    withResponse: () => ({ data, response: fakeResponse, request_id: fakeRequestId }),
  })

  const result = Object.assign(
    {
      // MA-1: pass reject through so downstream Promise chains receive errors
      then: (resolve: any, reject: any) => Promise.resolve(data).then(resolve, reject),
      withResponse: () =>
        Promise.resolve({ data, response: fakeResponse, request_id: fakeRequestId }),
    },
    data,
  )

  return result
}

/**
 * G3: Model-specific behavioral rules — now loaded from .md files for hot-reload support.
 *
 * Priority: ~/.uagent/model-prompts/{family}.md > builtin model-prompts/ directory
 * Use getModelPromptRules() from src/services/modelPrompt/index.ts
 *
 * Kept as a thin wrapper for backward compatibility with existing callers.
 */
function getModelSpecificPromptRules(modelName: string): string | null {
  return getModelPromptRules(modelName)
}

/**
 * MultiModelAnthropicAdapter — the main export.
 *
 * Mimics the minimum subset of Anthropic SDK's `beta.messages` interface
 * that CC's `claude.ts` engine actually calls.
 */
export class MultiModelAnthropicAdapter {
  private modelName: string
  private llmClient: ReturnType<typeof createLLMClient>

  constructor(modelName: string) {
    this.modelName = modelName
    this.llmClient = createLLMClient(modelName)
  }

  private async _callModel(
    params: AnthropicMessagesCreateParams,
    options?: AnthropicMessagesCreateOptions,
    retryCount = 0,
  ): Promise<{ chatResponse: UAChatResponse; inputTokens: number; outputTokens: number; _realStream?: unknown }> {
    // Extract system prompt and conversation messages separately
    // (UA LLM clients expect { systemPrompt, messages } not a merged array)
    let systemPrompt = ''
    if (params.system) {
      systemPrompt = Array.isArray(params.system)
        ? params.system.filter((b: ContentBlock) => b.type === 'text').map((b: ContentBlock & { text: string }) => b.text).join('\n')
        : String(params.system)
    }

    // Feature 12: Inject model-specific behavioral rules
    // Different model families have known behavioral tendencies that need correction
    const modelSpecificRules = getModelSpecificPromptRules(this.modelName)
    if (modelSpecificRules) {
      systemPrompt = systemPrompt
        ? `${systemPrompt}\n\n${modelSpecificRules}`
        : modelSpecificRules
    }

    const messages = convertAnthropicMessagesToUA(params)
    const tools = convertTools(params.tools || [])

    // Build UA-format ChatOptions (cast to any to avoid strict type mismatch)
    const chatOptions: any = {
      systemPrompt,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      maxTokens: params.max_tokens,
      signal: options?.signal,
    }

    // Write to UA debug log (MA-6: use async helper, not inline appendFileSync)
    uaLogAsync(`[UA:multiModel] model=${this.modelName} msgs=${messages.length} tools=${tools.length} stream=${!!params.stream} sys=${systemPrompt.length}chars`)

    let chatResponse: any
    try {
      if (this.llmClient.streamChat && params.stream) {
        // Real streaming with rolling Promise mechanism.
        //
        // Each onChunk call: resolve the *current* notifyPromise, then immediately
        // create a new one. The Generator always awaits the latest notifyPromise via
        // getNotifyPromise(), so it can never miss a notification regardless of whether
        // onChunk fires before or after the Generator reaches its await.
        //
        // Empty chunks (e.g. from reasoning_content in GLM-5/MiMo thinking phase)
        // advance the Generator without emitting SSE output (filtered by `if (chunk)`).
        const chunkQueue: string[] = []
        let outputLen = 0

        let notifyResolve: (() => void) | null = null
        let notifyPromise = new Promise<void>(r => { notifyResolve = r })

        const onChunk = (chunk: string) => {
          chunkQueue.push(chunk)
          outputLen += chunk.length
          const r = notifyResolve
          // Create next Promise before resolving current, so Generator's next await
          // gets a fresh Promise (not the already-resolved one)
          notifyPromise = new Promise<void>(res => { notifyResolve = res })
          r?.()
        }

        const inputLen = messages.reduce((s: number, m: any) => s + JSON.stringify(m).length, 0)
        // Fix: GLM-5 returns input_tokens=0, need to check for falsy values
        const inputTokensFn = () => {
          const usageInput = chatResponse?.usage?.input_tokens
          return usageInput && usageInput > 0 ? usageInput : Math.ceil(inputLen / 4)
        }
        const outputTokensFn = () => {
          const usageOutput = chatResponse?.usage?.output_tokens
          return usageOutput && usageOutput > 0 ? usageOutput : Math.ceil(outputLen / 4)
        }

        // Wrap streamChat in a retry helper so 429 rate-limit errors from the
        // streaming request are retried before the rejection propagates.
        // UA 修改：支持持久重试模式
        const persistent = isPersistentRetryEnabled()
        const baseDelays = [15_000, 30_000, 60_000]
        const getStreamDelay = (attempt: number): number => {
          if (persistent) {
            // 持久模式：指数退避，最大 5 分钟
            return Math.min(15_000 * Math.pow(2, attempt), 5 * 60 * 1000)
          }
          // 普通模式：固定延迟数组
          return baseDelays[attempt] ?? 60_000
        }
        
        const attemptStream = async (attempt: number): Promise<any> => {
          const delay = getStreamDelay(attempt)
          return this.llmClient.streamChat(chatOptions, onChunk).then(
            (r: any) => {
              chatResponse = r
              notifyResolve?.()
              uaLogAsync(`[UA:multiModel] realStream OK: type=${r?.type} toolCalls=${r?.toolCalls?.length || 0}`)
              return r
            },
            async (e: any) => {
              const is429 = e?.status === 429 || String(e?.message || '').includes('429')
              // MA-5: only retry BEFORE any tokens were sent to CC.
              // If chunkQueue has content, CC already consumed those tokens; retrying
              // would send duplicate events and corrupt the response.
              if (is429 && chunkQueue.length === 0) {
                const retryNum = attempt + 1
                if (persistent) {
                  process.stderr.write(`[UA:429] stream rate limited, persistent retry ${retryNum}, waiting ${delay / 1000}s...\n`)
                  // 分段睡眠，定期输出心跳
                  let remaining = delay
                  while (remaining > 0) {
                    const chunk = Math.min(remaining, 30_000)
                    await sleep(chunk)
                    remaining -= chunk
                    if (remaining > 0) {
                      process.stderr.write(`[UA:429] stream still waiting... ${remaining / 1000}s remaining\n`)
                    }
                  }
                } else {
                  process.stderr.write(`[UA:429] stream rate limited, retry ${retryNum}/${baseDelays.length} in ${delay / 1000}s...\n`)
                  await new Promise<void>(res => setTimeout(res, delay))
                }
                // Reset queue for the fresh attempt
                chunkQueue.length = 0
                outputLen = 0
                // IMPORTANT: resolve the old notifyPromise BEFORE replacing it so the
                // generator (which may already be awaiting it) can wake up and see the
                // empty queue, then go back to await the new notifyPromise.
                // Skipping this step orphans the old Promise and causes a permanent deadlock.
                const oldResolve = notifyResolve
                notifyPromise = new Promise<void>(res => { notifyResolve = res })
                oldResolve?.()
                return attemptStream(attempt + 1)
              }
              notifyResolve?.()
              throw e
            },
          )
        }

        const streamChatPromise = attemptStream(0)

        return Promise.resolve({
          chatResponse: null,
          inputTokens: Math.ceil(inputLen / 4),
          outputTokens: 0,
          _realStream: buildRealStreamResult(
            streamChatPromise,
            chunkQueue,
            () => notifyPromise,
            this.modelName,
            inputTokensFn,
            outputTokensFn,
          ),
        })
      } else {
        chatResponse = await this.llmClient.chat(chatOptions)
        const r = chatResponse
        uaLogAsync(`[UA:multiModel] chat OK: type=${r?.type} content=${(r?.content || '').slice(0, 80)}`)
      }
    } catch (err: any) {
      // ── 429 Rate-limit auto-retry ──────────────────────────────────────────
      // UA 修改：支持持久重试模式，避免长时间任务因限流中断
      // 普通模式：15s → 30s → 60s → give up (最多 3 次重试)
      // 持久模式：无限重试，每 30 秒输出心跳进度
      const is429 = err?.status === 429 || (err?.message ?? '').includes('429')
      if (is429) {
        const persistent = isPersistentRetryEnabled()
        const maxRetries = persistent ? Infinity : 3
        const baseDelays = [15_000, 30_000, 60_000]
        
        if (retryCount < maxRetries) {
          // 持久模式：使用指数退避，最大 5 分钟
          // 普通模式：使用固定延迟数组
          let delay: number
          if (persistent) {
            // 指数退避：15s → 30s → 60s → 120s → ... → 最大 5 分钟
            delay = Math.min(15_000 * Math.pow(2, retryCount), 5 * 60 * 1000)
          } else {
            delay = baseDelays[retryCount] ?? 60_000
          }
          
          const retryNum = retryCount + 1
          if (persistent) {
            process.stderr.write(
              `[UA:429] rate limited on ${this.modelName}, persistent retry ${retryNum}, waiting ${delay / 1000}s...\n`,
            )
            // 分段睡眠，定期输出心跳
            let remaining = delay
            while (remaining > 0) {
              const chunk = Math.min(remaining, 30_000)
              await sleep(chunk)
              remaining -= chunk
              if (remaining > 0) {
                process.stderr.write(`[UA:429] still waiting... ${remaining / 1000}s remaining\n`)
              }
            }
          } else {
            process.stderr.write(
              `[UA:429] rate limited on ${this.modelName}, retry ${retryNum}/3 in ${delay / 1000}s...\n`,
            )
            await new Promise<void>(resolve => setTimeout(resolve, delay))
          }
          return this._callModel(params, options, retryCount + 1)
        }
      }
      // ── /429 auto-retry ────────────────────────────────────────────────────

      // Log error details — 详细记录便于排查 (MA-6: use module-level uaLogAsync)
      uaLogAsync(`[UA:multiModel] ❌ ERROR calling ${this.modelName}`)
      uaLogAsync(`[UA:multiModel]   message: ${err?.message ?? err}`)
      uaLogAsync(`[UA:multiModel]   code: ${err?.code ?? 'n/a'}  status: ${err?.status ?? 'n/a'}`)
      uaLogAsync(`[UA:multiModel]   OPENAI_BASE_URL: ${process.env.OPENAI_BASE_URL ?? 'NOT SET'}`)
      // MA-2: never log key material
      uaLogAsync(`[UA:multiModel]   WQ_API_KEY: ${process.env.WQ_API_KEY ? '✓ set' : '✗ NOT SET'}`)
      uaLogAsync(`[UA:multiModel]   stack: ${(err?.stack ?? '').split('\n').slice(0, 3).join(' | ')}`)
      process.stderr.write(`[UA:multiModel] ERROR: ${this.modelName}: ${err?.message || err}\n`)

      // ── UA Fallback Chain ──────────────────────────────────────────────────
      // 如果 models.json 配置了 fallback 数组，当前模型失败时自动切换到下一个
      // Guard against cycles: only pick a model that appears AFTER the current
      // one in the chain and hasn't been tried yet in this call tree.
      // MA-4: validate fallback chain structure to prevent prototype pollution
      const fallbackChain = getFallbackChain()
      const triedModels: Set<string> = options?._triedModels instanceof Set
        ? options._triedModels
        : new Set([this.modelName])
      const currentIdx = fallbackChain.indexOf(this.modelName)
      const nextModel = currentIdx >= 0
        ? fallbackChain.slice(currentIdx + 1).find(m => !triedModels.has(m))
        : undefined

      if (nextModel) {
        // ── Fallback depth guard: prevent runaway A→B→A cycles when Set is broken
        const MAX_FALLBACK_DEPTH = 5
        if ((options?._fallbackDepth ?? 0) >= MAX_FALLBACK_DEPTH) {
          uaLogAsync(`[UA:fallback] ⚠️ fallback depth exceeded (${MAX_FALLBACK_DEPTH}) — giving up`)
          process.stderr.write(`[UA:fallback] Max fallback depth (${MAX_FALLBACK_DEPTH}) exceeded, aborting\n`)
        } else {
          uaLogAsync(`[UA:fallback] ⚠️ ${this.modelName} failed → trying fallback: ${nextModel}`)
          process.stderr.write(`[UA:fallback] Switching to fallback model: ${nextModel}\n`)
          triedModels.add(nextModel)
          const fallbackAdapter = new MultiModelAnthropicAdapter(nextModel)
          return fallbackAdapter._callModel(
            params,
            { ...options, _triedModels: triedModels, _fallbackDepth: (options?._fallbackDepth ?? 0) + 1 },
            0,
          )
        }
      }
      // ── /UA Fallback Chain ─────────────────────────────────────────────────

      const apiErr: any = new Error(
        `[UA MultiModel] Failed to call model ${this.modelName}: ${err?.message || 'Connection error'}`,
      )
      apiErr.status = err?.status || 503
      apiErr.code = err?.code || 'ECONNREFUSED'
      // MA-10: Properly handle headers from different LLM clients.
      // Some providers return headers as a plain object instead of Headers instance.
      // Convert to Headers if needed, otherwise leave undefined to avoid withRetry crash.
      if (err?.headers) {
        if (err.headers instanceof globalThis.Headers || (typeof err.headers.get === 'function')) {
          apiErr.headers = err.headers
        } else if (typeof err.headers === 'object') {
          // Convert plain object to Headers instance
          apiErr.headers = new globalThis.Headers(err.headers as Record<string, string>)
        }
        // else: leave undefined, which is safe for optional chaining
      }
      throw apiErr
    }

    const contentLen = typeof chatResponse?.content === 'string'
      ? chatResponse.content.length
      : JSON.stringify(chatResponse?.toolCalls || []).length
    const inputLen = messages.reduce((s, m) => s + JSON.stringify(m).length, 0)
    // Fix: GLM-5 returns input_tokens=0, need to check for falsy values
    const usageInput = chatResponse?.usage?.input_tokens
    const usageOutput = chatResponse?.usage?.output_tokens
    const inputTokens = usageInput && usageInput > 0 ? usageInput : Math.ceil(inputLen / 4)
    const outputTokens = usageOutput && usageOutput > 0 ? usageOutput : Math.ceil(contentLen / 4)

    return { chatResponse, inputTokens, outputTokens }
  }

  /** Mimic `anthropic.beta.messages` */
  get beta() {
    const self = this
    return {
      messages: {
        create(params: any, options?: any) {
          if (params.stream) {
            const promise = self._callModel(params, options).then((result) => {
              // Real stream path
              if (result._realStream) return result._realStream
              // Batch fallback (non-streamChat clients)
              return buildStreamResult(result.chatResponse, self.modelName, result.inputTokens, result.outputTokens)
            })
            // Return a thenable that also exposes .withResponse()
            return {
              then: (resolve: any, reject: any) => promise.then((r) => resolve(r), reject),
              withResponse: () =>
                promise.then((streamResult) => streamResult.withResponse()),
            }
          }
          // Non-streaming
          return self._callModel(params, options).then(({ chatResponse, inputTokens, outputTokens }) =>
            convertResponseToAnthropicMessage(chatResponse, self.modelName, inputTokens, outputTokens),
          )
        },
      },
    }
  }

  /** Top-level messages (some callers use anthropic.messages directly) */
  get messages() {
    return {
      create: (params: any, options?: any) => {
        // Delegate streaming calls to beta.messages.create which correctly
        // handles the _realStream path; non-streaming calls go directly.
        if (params.stream) {
          return this.beta.messages.create(params, options)
        }
        return this._callModel(params, options).then(({ chatResponse, inputTokens, outputTokens }) =>
          convertResponseToAnthropicMessage(chatResponse, this.modelName, inputTokens, outputTokens),
        )
      },
    }
  }
}

/**
 * Detect if a model name requires the multi-model adapter.
 * Returns true for non-Anthropic models.
 */
export function isNonAnthropicModel(modelName: string): boolean {
  if (!modelName) return false
  if (modelName.startsWith('claude-')) return false
  if (modelName.includes('anthropic.claude') || modelName.includes('claude@')) return false
  return true
}
