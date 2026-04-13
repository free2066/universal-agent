// @ts-nocheck
import type {
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKFilesPersistedEvent,
  SDKHookResponseMessage,
  SDKHookStartedMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKStatusMessage,
  SDKSystemMessage,
  SDKToolProgressMessage,
} from '../entrypoints/agentSdkTypes.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemMessage,
} from '../types/message.js'
import { logForDebugging } from '../utils/debug.js'
import { fromSDKCompactMetadata } from '../utils/messages/mappers.js'
import { createUserMessage } from '../utils/messages.js'

let lastRateLimitEventKey: string | null = null

function getRateLimitEventKey(
  info: Extract<SDKMessage, { type: 'rate_limit_event' }>['rate_limit_info'],
): string {
  return [
    info.status,
    info.rateLimitType ?? '',
    info.isUsingOverage ? '1' : '0',
    info.overageStatus ?? '',
  ].join(':')
}

function resetRateLimitEventState(): void {
  lastRateLimitEventKey = null
}

/**
 * Converts SDKMessage from CCR to REPL Message types.
 *
 * The CCR backend sends SDK-format messages via WebSocket. The REPL expects
 * internal Message types for rendering. This adapter bridges the two.
 */

/**
 * Convert an SDKAssistantMessage to an AssistantMessage
 */
function convertAssistantMessage(msg: SDKAssistantMessage): AssistantMessage {
  return {
    type: 'assistant',
    message: msg.message,
    uuid: msg.uuid,
    requestId: undefined,
    timestamp: new Date().toISOString(),
    error: msg.error,
  }
}

/**
 * Convert an SDKPartialAssistantMessage (streaming) to a StreamEvent
 */
function convertStreamEvent(msg: SDKPartialAssistantMessage): StreamEvent {
  return {
    type: 'stream_event',
    event: msg.event,
  }
}

/**
 * Convert an SDKResultMessage to a SystemMessage
 */
function convertResultMessage(msg: SDKResultMessage): SystemMessage {
  const isError = msg.subtype !== 'success'
  const content = isError
    ? msg.errors?.join(', ') || 'Unknown error'
    : 'Session completed successfully'

  return {
    type: 'system',
    subtype: 'informational',
    content,
    level: isError ? 'warning' : 'info',
    uuid: msg.uuid,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Convert an SDKSystemMessage (init) to a SystemMessage
 */
function convertInitMessage(msg: SDKSystemMessage): SystemMessage {
  return {
    type: 'system',
    subtype: 'informational',
    content: `Remote session initialized (model: ${msg.model})`,
    level: 'info',
    uuid: msg.uuid,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Convert an SDKStatusMessage to a SystemMessage
 */
function humanizeStatus(status: string): string {
  return status
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/^./, char => char.toUpperCase())
}

function formatElapsedSeconds(elapsedSeconds: number): string {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
    return '0s'
  }

  if (elapsedSeconds < 60) {
    return `${Math.round(elapsedSeconds)}s`
  }

  const minutes = Math.floor(elapsedSeconds / 60)
  const seconds = Math.round(elapsedSeconds % 60)
  if (seconds === 0) {
    return `${minutes}m`
  }
  return `${minutes}m ${seconds}s`
}

function formatResetSuffix(resetAt?: number): string {
  if (resetAt === undefined || !Number.isFinite(resetAt)) {
    return ''
  }

  const resetTime = new Date(resetAt * 1000)
  if (Number.isNaN(resetTime.getTime())) {
    return ''
  }

  return ` Resets at ${resetTime.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })}.`
}

function convertStatusMessage(msg: SDKStatusMessage): SystemMessage | null {
  if (!msg.status) {
    return null
  }

  const content =
    msg.status === 'compacting'
      ? 'Compacting conversation to stay within context limits…'
      : `Working… ${humanizeStatus(msg.status)}`

  return {
    type: 'system',
    subtype: 'informational',
    content,
    level: 'info',
    uuid: msg.uuid,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Convert an SDKToolProgressMessage to a SystemMessage.
 * We use a system message instead of ProgressMessage since the Progress type
 * is a complex union that requires tool-specific data we don't have from CCR.
 */
function convertToolProgressMessage(
  msg: SDKToolProgressMessage,
): SystemMessage {
  return {
    type: 'system',
    subtype: 'informational',
    content: `Tool ${msg.tool_name} is still running (${formatElapsedSeconds(msg.elapsed_time_seconds)})…`,
    level: 'info',
    uuid: msg.uuid,
    timestamp: new Date().toISOString(),
    toolUseID: msg.tool_use_id,
  }
}

/**
 * Convert an SDKCompactBoundaryMessage to a SystemMessage
 */
function convertCompactBoundaryMessage(
  msg: SDKCompactBoundaryMessage,
): SystemMessage {
  const compactMetadata = fromSDKCompactMetadata(msg.compact_metadata)
  const summarizedCount = compactMetadata?.messagesSummarized
  const content = summarizedCount
    ? `Conversation compacted to stay within context limits · summarized ${summarizedCount} earlier ${summarizedCount === 1 ? 'message' : 'messages'}`
    : 'Conversation compacted to stay within context limits'

  return {
    type: 'system',
    subtype: 'compact_boundary',
    content,
    level: 'info',
    uuid: msg.uuid,
    timestamp: new Date().toISOString(),
    compactMetadata,
  }
}

function convertRateLimitEventMessage(
  msg: Extract<SDKMessage, { type: 'rate_limit_event' }>,
): SystemMessage | null {
  const info = msg.rate_limit_info
  const rateLimitEventKey = getRateLimitEventKey(info)
  if (rateLimitEventKey === lastRateLimitEventKey) {
    return null
  }
  lastRateLimitEventKey = rateLimitEventKey

  if (info.isUsingOverage) {
    return {
      type: 'system',
      subtype: 'informational',
      content:
        info.overageStatus === 'allowed_warning'
          ? 'Using extra usage and approaching the spending limit.'
          : 'Using extra usage to keep requests running.',
      level: info.overageStatus === 'allowed_warning' ? 'warning' : 'info',
      uuid: msg.uuid,
      timestamp: new Date().toISOString(),
    }
  }

  if (info.status === 'allowed_warning') {
    const utilization =
      typeof info.utilization === 'number'
        ? ` (${Math.round(info.utilization * 100)}% used)`
        : ''
    return {
      type: 'system',
      subtype: 'informational',
      content: `Approaching the current usage limit${utilization}.${formatResetSuffix(info.resetsAt)}`.trim(),
      level: 'warning',
      uuid: msg.uuid,
      timestamp: new Date().toISOString(),
    }
  }

  if (info.status === 'rejected') {
    const prefix =
      info.rateLimitType === 'overage'
        ? 'Extra usage limit reached.'
        : 'Requests are currently rate limited.'
    return {
      type: 'system',
      subtype: 'informational',
      content: `${prefix}${formatResetSuffix(info.resetsAt)}`.trim(),
      level: 'warning',
      uuid: msg.uuid,
      timestamp: new Date().toISOString(),
    }
  }

  return null
}

function convertHookStartedMessage(
  msg: Extract<SDKMessage, { type: 'system'; subtype: 'hook_started' }>,
): SystemMessage | null {
  // Only show a brief loading-style message to let the user know something is happening remotely
  return {
    type: 'system',
    subtype: 'informational',
    content: `Running hook: ${msg.hook_name}…`,
    level: 'info',
    uuid: msg.uuid,
    timestamp: new Date().toISOString(),
  }
}

function convertHookResponseMessage(
  msg: Extract<SDKMessage, { type: 'system'; subtype: 'hook_response' }>,
): SystemMessage | null {
  // We primarily want to surface errors so users aren't left wondering why a hook silently failed.
  // Success responses are generally too noisy unless the user is actively debugging.
  if (msg.outcome === 'error') {
    const errorDetails = msg.stderr || msg.output || 'Unknown error'
    // Trim excessively long hook output so it doesn't flood the transcript
    const trimmedDetails =
      errorDetails.length > 500
        ? `${errorDetails.slice(0, 500)}… (output truncated)`
        : errorDetails

    return {
      type: 'system',
      subtype: 'informational',
      content: `Hook "${msg.hook_name}" (${msg.hook_event}) failed:
${trimmedDetails}`,
      level: 'warning',
      uuid: msg.uuid,
      timestamp: new Date().toISOString(),
    }
  }
  return null
}

function convertFilesPersistedEventMessage(
  msg: Extract<SDKMessage, { type: 'system'; subtype: 'files_persisted' }>,
): SystemMessage | null {
  if (msg.failed && msg.failed.length > 0) {
    const failures = msg.failed
      .map(f => `${f.filename}: ${f.error}`)
      .join('\n')
    return {
      type: 'system',
      subtype: 'informational',
      content: `Failed to persist ${msg.failed.length} file(s):\n${failures}`,
      level: 'warning',
      uuid: msg.uuid,
      timestamp: new Date().toISOString(),
    }
  }
  return null
}

function convertToolUseSummaryMessage(
  msg: Extract<SDKMessage, { type: 'tool_use_summary' }>,
): SystemMessage | null {
  const summary = msg.summary?.trim()
  if (!summary) {
    return null
  }

  return {
    type: 'system',
    subtype: 'informational',
    content: `Completed tool work: ${summary}`,
    level: 'info',
    uuid: msg.uuid,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Result of converting an SDKMessage
 */
export type ConvertedMessage =
  | { type: 'message'; message: Message }
  | { type: 'stream_event'; event: StreamEvent }
  | { type: 'ignored' }

type ConvertOptions = {
  /** Convert user messages containing tool_result content blocks into UserMessages.
   * Used by direct connect mode where tool results come from the remote server
   * and need to be rendered locally. CCR mode ignores user messages since they
   * are handled differently. */
  convertToolResults?: boolean
  /**
   * Convert user text messages into UserMessages for display. Used when
   * converting historical events where user-typed messages need to be shown.
   * In live WS mode these are already added locally by the REPL so they're
   * ignored by default.
   */
  convertUserTextMessages?: boolean
}

/**
 * Convert an SDKMessage to REPL message format
 */
export function convertSDKMessage(
  msg: SDKMessage,
  opts?: ConvertOptions,
): ConvertedMessage {
  switch (msg.type) {
    case 'assistant':
      return { type: 'message', message: convertAssistantMessage(msg) }

    case 'user': {
      const content = msg.message?.content
      // Tool result messages from the remote server need to be converted so
      // they render and collapse like local tool results. Detect via content
      // shape (tool_result blocks) — parent_tool_use_id is NOT reliable: the
      // agent-side normalizeMessage() hardcodes it to null for top-level
      // tool results, so it can't distinguish tool results from prompt echoes.
      const isToolResult =
        Array.isArray(content) && content.some(b => b.type === 'tool_result')
      if (opts?.convertToolResults && isToolResult) {
        return {
          type: 'message',
          message: createUserMessage({
            content,
            toolUseResult: msg.tool_use_result,
            uuid: msg.uuid,
            timestamp: msg.timestamp,
          }),
        }
      }
      // When converting historical events, user-typed messages need to be
      // rendered (they weren't added locally by the REPL). Skip tool_results
      // here — already handled above.
      if (opts?.convertUserTextMessages && !isToolResult) {
        if (typeof content === 'string' || Array.isArray(content)) {
          return {
            type: 'message',
            message: createUserMessage({
              content,
              toolUseResult: msg.tool_use_result,
              uuid: msg.uuid,
              timestamp: msg.timestamp,
            }),
          }
        }
      }
      // User-typed messages (string content) are already added locally by REPL.
      // In CCR mode, all user messages are ignored (tool results handled differently).
      return { type: 'ignored' }
    }

    case 'stream_event':
      return { type: 'stream_event', event: convertStreamEvent(msg) }

    case 'result':
      resetRateLimitEventState()
      // Only show result messages for errors. Success results are noise
      // in multi-turn sessions (isLoading=false is sufficient signal).
      if (msg.subtype !== 'success') {
        return { type: 'message', message: convertResultMessage(msg) }
      }
      return { type: 'ignored' }

    case 'system':
      if (msg.subtype === 'init') {
        resetRateLimitEventState()
        return { type: 'message', message: convertInitMessage(msg) }
      }
      if (msg.subtype === 'status') {
        const statusMsg = convertStatusMessage(msg)
        return statusMsg
          ? { type: 'message', message: statusMsg }
          : { type: 'ignored' }
      }
      if (msg.subtype === 'compact_boundary') {
        return {
          type: 'message',
          message: convertCompactBoundaryMessage(msg),
        }
      }
      if (msg.subtype === 'hook_started') {
        const startedMsg = convertHookStartedMessage(msg)
        return startedMsg
          ? { type: 'message', message: startedMsg }
          : { type: 'ignored' }
      }
      if (msg.subtype === 'hook_response') {
        const responseMsg = convertHookResponseMessage(msg)
        return responseMsg
          ? { type: 'message', message: responseMsg }
          : { type: 'ignored' }
      }
      if (msg.subtype === 'files_persisted') {
        const persistedMsg = convertFilesPersistedEventMessage(msg)
        return persistedMsg
          ? { type: 'message', message: persistedMsg }
          : { type: 'ignored' }
      }
      if (msg.subtype === 'auth_status') {
        const aMsg = msg as Extract<SDKMessage, { subtype: 'auth_status' }>
        if (aMsg.status === 'not_authenticated' || aMsg.status === 'expired') {
          return {
            type: 'message',
            message: {
              type: 'system',
              subtype: 'informational',
              content: 'Remote session authentication expired or not authenticated. Please re-authenticate.',
              level: 'warning',
              uuid: msg.uuid,
              timestamp: new Date().toISOString(),
            },
          }
        }
        return { type: 'ignored' }
      }
      if (msg.subtype === 'api_error') {
        const apiMsg = msg as Extract<SDKMessage, { subtype: 'api_error' }>
        return {
          type: 'message',
          message: {
            type: 'system',
            subtype: 'informational',
            content: `Remote API error: ${apiMsg.error}`,
            level: 'warning',
            uuid: msg.uuid,
            timestamp: new Date().toISOString(),
          },
        }
      }
      if (msg.subtype === 'api_retry') {
        const arMsg = msg as Extract<SDKMessage, { subtype: 'api_retry' }>
        return {
          type: 'message',
          message: {
            type: 'system',
            subtype: 'informational',
            content: `Retrying API request: ${arMsg.error} (Attempt ${arMsg.attempt}/${arMsg.max_attempts})`,
            level: 'warning',
            uuid: msg.uuid,
            timestamp: new Date().toISOString(),
          },
        }
      }
      // other subtypes
      logForDebugging(
        `[sdkMessageAdapter] Ignoring system message subtype: ${msg.subtype}`,
      )
      return { type: 'ignored' }

    case 'tool_progress':
      return { type: 'message', message: convertToolProgressMessage(msg) }

    case 'auth_status':
      // Auth status is handled separately, not converted to a display message
      logForDebugging('[sdkMessageAdapter] Ignoring auth_status message')
      return { type: 'ignored' }

    case 'tool_use_summary': {
      const summaryMsg = convertToolUseSummaryMessage(msg)
      return summaryMsg
        ? { type: 'message', message: summaryMsg }
        : { type: 'ignored' }
    }

    case 'rate_limit_event': {
      const rateLimitMsg = convertRateLimitEventMessage(msg)
      return rateLimitMsg
        ? { type: 'message', message: rateLimitMsg }
        : { type: 'ignored' }
    }

    default: {
      // Gracefully ignore unknown message types. The backend may send new
      // types before the client is updated; logging helps with debugging
      // without crashing or losing the session.
      logForDebugging(
        `[sdkMessageAdapter] Unknown message type: ${(msg as { type: string }).type}`,
      )
      return { type: 'ignored' }
    }
  }
}

/**
 * Check if an SDKMessage indicates the session has ended
 */
export function isSessionEndMessage(msg: SDKMessage): boolean {
  return msg.type === 'result'
}

/**
 * Check if an SDKResultMessage indicates success
 */
export function isSuccessResult(msg: SDKResultMessage): boolean {
  return msg.subtype === 'success'
}

/**
 * Extract the result text from a successful SDKResultMessage
 */
export function getResultText(msg: SDKResultMessage): string | null {
  if (msg.subtype === 'success') {
    return msg.result
  }
  return null
}
