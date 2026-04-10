// @ts-nocheck
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
import { createLLMClient } from '../../models/llm/factory.js'
import { getModelPromptRules } from '../modelPrompt/index.js'

/** Convert Anthropic BetaMessageStreamParams → UA ChatOptions messages array (NO system) */
function convertAnthropicMessagesToUA(params: any): any[] {
  const messages: any[] = []

  // NOTE: system prompt is handled separately in _callModel as chatOptions.systemPrompt
  // Do NOT push system here to avoid duplication in OpenAIClient.convertMessages()

  // Conversation messages (user + assistant + tool_result only)
  for (const msg of params.messages || []) {
    if (msg.role === 'user') {
      const toolResults = extractToolResults(msg.content)
      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          const resultContent = Array.isArray(tr.content)
            ? tr.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
            : (typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content))
          messages.push({
            role: 'tool',
            content: resultContent,
            toolCallId: tr.tool_use_id,
          })
        }
      } else {
        const content = extractTextContent(msg.content)
        if (content) messages.push({ role: 'user', content })
      }
    } else if (msg.role === 'assistant') {
      const textContent = extractTextContent(msg.content)
      const toolUses = extractToolUses(msg.content)
      if (toolUses.length > 0) {
        messages.push({
          role: 'assistant',
          content: textContent,
          toolCalls: toolUses.map((tu: any) => ({
            id: tu.id,
            name: tu.name,
            arguments: tu.input || {},
          })),
        })
      } else {
        messages.push({ role: 'assistant', content: textContent })
      }
    }
  }

  return messages
}

function extractTextContent(content: any): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text || '')
    .join('\n')
}

function extractToolUses(content: any): any[] {
  if (!Array.isArray(content)) return []
  return content.filter((b: any) => b.type === 'tool_use')
}

function extractToolResults(content: any): any[] {
  if (!Array.isArray(content)) return []
  return content.filter((b: any) => b.type === 'tool_result')
}

/** Convert Anthropic tool definitions → UA tool definitions */
function convertTools(anthropicTools: any[]): any[] {
  if (!anthropicTools?.length) return []
  return anthropicTools
    .filter((t: any) => t.name)
    .map((t: any) => ({
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
  response: any,
  model: string,
  inputTokens = 0,
  outputTokens = 0,
): any {
  const content: any[] = []

  if (response.type === 'tool_calls') {
    if (response.content) {
      content.push({ type: 'text', text: response.content })
    }
    for (const tc of response.toolCalls || []) {
      content.push({
        type: 'tool_use',
        id: tc.id || `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        name: normalizeToolName(tc.name),
        input: tc.arguments || {},
      })
    }
  } else {
    content.push({ type: 'text', text: response.content || '' })
  }

  return {
    id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
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
  response: any,
  model: string,
  inputTokens: number,
  outputTokens: number,
): AsyncGenerator<any> {
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
    usage: { output_tokens: outputTokens },
  }

  yield { type: 'message_stop' }
}

/**
 * Build a streamResult that has the `.withResponse()` method CC's engine calls.
 * `.withResponse()` must return { data: AsyncIterable<events>, response: Response, request_id: string }
 */
function buildStreamResult(
  response: any,
  model: string,
  inputTokens: number,
  outputTokens: number,
): any {
  const fakeRequestId = `ua-${randomUUID()}`
  const finalMessage = convertResponseToAnthropicMessage(response, model, inputTokens, outputTokens)

  // Create a re-usable generator factory (can only iterate once, but CC only iterates once)
  const makeStream = () => createFakeStream(response, model, inputTokens, outputTokens)

  // Create a fake Response object with minimal interface CC needs
  const fakeResponse = new Response(null, { status: 200 })

  // The stream data object — an AsyncIterable with extra methods
  const data = Object.assign(makeStream(), {
    finalMessage: () => Promise.resolve(finalMessage),
    [Symbol.asyncIterator]: makeStream,
    withResponse: () => ({ data, response: fakeResponse, request_id: fakeRequestId }),
  })

  // Return a thenable that resolves immediately (create() is awaited)
  // and also has .withResponse() for when CC calls create(...).withResponse()
  const result = Object.assign(
    {
      then: (resolve: any, _reject: any) => Promise.resolve(data).then(resolve),
      withResponse: () =>
        Promise.resolve({ data, response: fakeResponse, request_id: fakeRequestId }),
    },
    data,
  )

  return result
}

/**
 * G6: Build a REAL streaming result that emits SSE events as tokens arrive.
 *
 * Instead of waiting for the full response before emitting events (batch mode),
 * this function starts emitting text deltas in real-time as the underlying
 * LLM client's streamChat onChunk callback fires.
 *
 * For tool_calls responses we fall back to batch mode (tool calls must arrive complete).
 *
 * Architecture:
 * - streamChat() is called with an onChunk callback that pushes tokens into a queue
 * - An async generator reads from the queue and yields SSE events
 * - The queue uses a Promise-based notify mechanism to avoid busy-waiting
 */
function buildRealStreamResult(
  streamChatPromise: Promise<any>,
  chunkQueue: string[],
  notifyChunk: () => void,
  chunkDoneResolvers: Array<() => void>,
  model: string,
  inputTokensFn: () => number,
  outputTokensFn: () => number,
): any {
  const fakeRequestId = `ua-${randomUUID()}`
  const fakeResponse = new Response(null, { status: 200 })

  const makeStream = () => realStream()

  async function* realStream(): AsyncGenerator<any> {
    const messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`

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
        // Wait for more chunks or completion
        await new Promise<void>((resolve) => {
          chunkDoneResolvers.push(resolve)
        })
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
        const toolId = tc.id || `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`
        yield {
          type: 'content_block_start',
          index: i + 1,
          content_block: { type: 'tool_use', id: toolId, name: tc.name, input: {} },
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
        usage: { output_tokens: outputTokens },
      }
    } else {
      yield { type: 'content_block_stop', index: 0 }
      yield {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: outputTokens },
      }
    }

    yield { type: 'message_stop' }

    // Patch the final message into the stream data (CC reads it via .finalMessage())
    const finalContent: any[] = []
    const textContent = finalResponse?.content || chunkQueue.join('')
    if (textContent) finalContent.push({ type: 'text', text: textContent })
    if (finalResponse?.type === 'tool_calls') {
      for (const tc of finalResponse.toolCalls || []) {
        finalContent.push({
          type: 'tool_use',
          id: tc.id || `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          name: tc.name,
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
  }

  // Placeholder for final message (filled in after stream completes)
  const _storedFinalMessage: any = {
    id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }

  const data = Object.assign(makeStream(), {
    finalMessage: () => Promise.resolve(_storedFinalMessage),
    [Symbol.asyncIterator]: makeStream,
    withResponse: () => ({ data, response: fakeResponse, request_id: fakeRequestId }),
  })

  const result = Object.assign(
    {
      then: (resolve: any, _reject: any) => Promise.resolve(data).then(resolve),
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
  private llmClient: any

  constructor(modelName: string) {
    this.modelName = modelName
    this.llmClient = createLLMClient(modelName)
  }

  private async _callModel(params: any, options?: any): Promise<any> {
    // Extract system prompt and conversation messages separately
    // (UA LLM clients expect { systemPrompt, messages } not a merged array)
    let systemPrompt = ''
    if (params.system) {
      systemPrompt = Array.isArray(params.system)
        ? params.system.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
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

    // Build UA-format ChatOptions
    const chatOptions: any = {
      systemPrompt,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      maxTokens: params.max_tokens,
      signal: options?.signal,
    }

    // Write to UA debug log
    const logLine = `[UA:multiModel] model=${this.modelName} msgs=${messages.length} tools=${tools.length} stream=${!!params.stream} sys=${systemPrompt.length}chars\n`
    if (process.env.UA_DEBUG_LOG) {
      try { require('fs').appendFileSync(process.env.UA_DEBUG_LOG, logLine) } catch {}
    }

    let chatResponse: any
    try {
      if (this.llmClient.streamChat && params.stream) {
        // Batch mode: wait for full response, then emit SSE via buildStreamResult.
        // Real streaming was reverted because models that emit only reasoning_content
        // (GLM-5, MiMo) during the thinking phase never trigger onChunk, causing the
        // chunkDoneResolvers Promise to hang indefinitely (stream stall).
        chatResponse = await this.llmClient.streamChat(chatOptions, () => {})
        if (process.env.UA_DEBUG_LOG) {
          try {
            const r = chatResponse
            require('fs').appendFileSync(process.env.UA_DEBUG_LOG,
              `[UA:multiModel] streamChat(batch) OK: type=${r?.type} toolCalls=${r?.toolCalls?.length || 0}\n`)
          } catch {}
        }
      } else {
        chatResponse = await this.llmClient.chat(chatOptions)
        if (process.env.UA_DEBUG_LOG) {
          try {
            const r = chatResponse
            require('fs').appendFileSync(process.env.UA_DEBUG_LOG,
              `[UA:multiModel] chat OK: type=${r?.type} content=${(r?.content || '').slice(0, 80)}\n`)
          } catch {}
        }
      }
    } catch (err: any) {
      // Log error details — 详细记录便于排查
      const uaLogFile = process.env.UA_DEBUG_LOG
      const uaLog = uaLogFile
        ? (msg: string) => { try { require('fs').appendFileSync(uaLogFile, `[${new Date().toISOString()}] ${msg}\n`) } catch {} }
        : undefined
      if (uaLog) {
        uaLog(`[UA:multiModel] ❌ ERROR calling ${this.modelName}`)
        uaLog(`[UA:multiModel]   message: ${err?.message ?? err}`)
        uaLog(`[UA:multiModel]   code: ${err?.code ?? 'n/a'}  status: ${err?.status ?? 'n/a'}`)
        uaLog(`[UA:multiModel]   OPENAI_BASE_URL: ${process.env.OPENAI_BASE_URL ?? 'NOT SET'}`)
        uaLog(`[UA:multiModel]   WQ_API_KEY: ${process.env.WQ_API_KEY ? '✓ ***' + process.env.WQ_API_KEY.slice(-4) : '✗ NOT SET'}`)
        uaLog(`[UA:multiModel]   stack: ${(err?.stack ?? '').split('\n').slice(0, 3).join(' | ')}`)
      }
      process.stderr.write(`[UA:multiModel] ERROR: ${this.modelName}: ${err?.message || err}\n`)

      // ── UA Fallback Chain ──────────────────────────────────────────────────
      // 如果 models.json 配置了 fallback 数组，当前模型失败时自动切换到下一个
      const fallbackChain: string[] = (() => {
        try { return JSON.parse(process.env.UA_FALLBACK_CHAIN || '[]') } catch { return [] }
      })()
      const currentIdx = fallbackChain.indexOf(this.modelName)
      const nextModel = currentIdx >= 0 && currentIdx < fallbackChain.length - 1
        ? fallbackChain[currentIdx + 1]
        : undefined

      if (nextModel) {
        uaLog?.(`[UA:fallback] ⚠️ ${this.modelName} failed → trying fallback: ${nextModel}`)
        process.stderr.write(`[UA:fallback] Switching to fallback model: ${nextModel}\n`)
        const fallbackAdapter = new MultiModelAnthropicAdapter(nextModel)
        return fallbackAdapter._callModel(params, options)
      }
      // ── /UA Fallback Chain ─────────────────────────────────────────────────

      const apiErr: any = new Error(
        `[UA MultiModel] Failed to call model ${this.modelName}: ${err?.message || 'Connection error'}`,
      )
      apiErr.status = err?.status || 503
      apiErr.code = err?.code || 'ECONNREFUSED'
      throw apiErr
    }

    const contentLen = typeof chatResponse?.content === 'string'
      ? chatResponse.content.length
      : JSON.stringify(chatResponse?.toolCalls || []).length
    const inputLen = messages.reduce((s, m) => s + JSON.stringify(m).length, 0)
    const inputTokens = Math.ceil(inputLen / 4)
    const outputTokens = Math.ceil(contentLen / 4)

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
      create: (params: any, options?: any) =>
        this._callModel(params, options).then(({ chatResponse, inputTokens, outputTokens }) =>
          convertResponseToAnthropicMessage(chatResponse, this.modelName, inputTokens, outputTokens),
        ),
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
