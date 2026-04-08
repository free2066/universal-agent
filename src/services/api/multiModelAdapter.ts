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
        name: tc.name,
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
        let accumulated = ''
        chatResponse = await this.llmClient.streamChat(
          chatOptions,
          (chunk: string) => { accumulated += chunk },
        )
        // Log success after streamChat completes
        if (process.env.UA_DEBUG_LOG) {
          try {
            const r = chatResponse
            require('fs').appendFileSync(process.env.UA_DEBUG_LOG,
              `[UA:multiModel] streamChat OK: type=${r?.type} toolCalls=${r?.toolCalls?.length || 0} content=${(r?.content || '').slice(0, 80)}\n`)
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
      const uaLog = process.env.UA_DEBUG_LOG
      if (uaLog) {
        try {
          const { appendFileSync } = require('fs')
          const ts = new Date().toISOString()
          appendFileSync(uaLog,
            `[${ts}] [UA:multiModel] ❌ ERROR calling ${this.modelName}\n` +
            `[UA:multiModel]   message: ${err?.message ?? err}\n` +
            `[UA:multiModel]   code: ${err?.code ?? 'n/a'}  status: ${err?.status ?? 'n/a'}\n` +
            `[UA:multiModel]   OPENAI_BASE_URL: ${process.env.OPENAI_BASE_URL ?? 'NOT SET'}\n` +
            `[UA:multiModel]   WQ_API_KEY: ${process.env.WQ_API_KEY ? '✓ ***' + process.env.WQ_API_KEY.slice(-4) : '✗ NOT SET'}\n` +
            `[UA:multiModel]   stack: ${(err?.stack ?? '').split('\n').slice(0, 3).join(' | ')}\n`
          )
        } catch {}
      }
      process.stderr.write(`[UA:multiModel] ERROR: ${this.modelName}: ${err?.message || err}\n`)
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
            // Streaming: return an object that has .withResponse()
            const promise = self._callModel(params, options).then(({ chatResponse, inputTokens, outputTokens }) =>
              buildStreamResult(chatResponse, self.modelName, inputTokens, outputTokens),
            )
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
