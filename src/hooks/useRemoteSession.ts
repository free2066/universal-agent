// @ts-nocheck
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { BoundedUUIDSet } from '../bridge/bridgeMessaging.js'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import type { SpinnerMode } from '../components/Spinner/types.js'
import {
  type RemotePermissionResponse,
  type RemoteSessionConfig,
  RemoteSessionManager,
} from '../remote/RemoteSessionManager.js'
import {
  createSyntheticAssistantMessage,
  createToolStub,
} from '../remote/remotePermissionBridge.js'
import {
  convertSDKMessage,
  isSessionEndMessage,
} from '../remote/sdkMessageAdapter.js'
import { useSetAppState } from '../state/AppState.js'
import type { AppState } from '../state/AppStateStore.js'
import type { Tool } from '../Tool.js'
import { findToolByName } from '../Tool.js'
import type { Message as MessageType } from '../types/message.js'
import type { PermissionAskDecision } from '../types/permissions.js'
import { logForDebugging } from '../utils/debug.js'
import { truncateToWidth } from '../utils/format.js'
import {
  createSystemMessage,
  extractTextContent,
  handleMessageFromStream,
  type StreamingToolUse,
} from '../utils/messages.js'
import { generateSessionTitle } from '../utils/sessionTitle.js'
import type { RemoteMessageContent } from '../utils/teleport/api.js'
import { updateSessionTitle } from '../utils/teleport/api.js'

// ============================================================================
// Precompiled regex patterns for noise line detection (performance optimization)
// ============================================================================
const NOISE_PREFIX_RE = /^(?:Command|Directory|Working directory|Path|Exit code|Stdout|Stderr):/i
const FULL_OUTPUT_RE = /^Full output saved to:/i
const READ_LINES_RE = /^Read \d+ lines?(?: \(from line \d+ to \d+\))?\.?$/
const FOUND_LINES_RE = /^Found \d+ lines in \d+ files(?: \(\d+ms\))?\.?$/
const FOUND_FILES_RE = /^Found \d+ files(?: in \d+ms)?\.?$/
const BRACKET_RE = /^[\[{(]$/

// Precompiled regex patterns for error message detection
const EISDIR_RE = /EISDIR:\s*illegal operation on a directory,\s*read/i
const LINE_RANGE_INVALID_RE = /(?:line (?:numbers?|range)|offset).*(?:invalid|illegal|out of range)|start_line_one_indexed|end_line_one_indexed/i
const ENOENT_RE = /\bENOENT\b|No such file or directory|File does not exist/i
const EACCES_RE = /\b(?:EACCES|EPERM)\b|Permission denied/i
const ENOTDIR_RE = /\bENOTDIR\b/i
const ERROR_PREFIX_RE = /^(?:Error:|Agent execution error:)\s*/
const SENTENCE_END_RE = /[.!?…]$/

function describeTaskTerminalStatus(status: string): string {
  switch (status) {
    case 'failed':
      return 'failed'
    case 'stopped':
      return 'stopped'
    default:
      return 'completed'
  }
}

function buildTaskStartedMessage(sdkMessage: {
  description: string
  task_type?: string
  workflow_name?: string
}): string | null {
  const description = sdkMessage.description?.trim()
  if (!description) {
    return null
  }

  const kind = sdkMessage.workflow_name?.trim() || sdkMessage.task_type?.trim()
  return kind
    ? `Started background ${kind}: ${description}`
    : `Started background task: ${description}`
}

function buildTaskProgressMessage(sdkMessage: {
  description: string
  summary?: string
  last_tool_name?: string
  usage?: { duration_ms?: number }
}): string | null {
  const summary = sdkMessage.summary?.trim()
  if (summary) {
    return `Background task update: ${summary}`
  }

  const toolName = sdkMessage.last_tool_name?.trim()
  if (!toolName) {
    return null
  }

  const durationMs = sdkMessage.usage?.duration_ms
  const durationSuffix =
    typeof durationMs === 'number' && durationMs >= 0
      ? ` (${Math.max(0, Math.round(durationMs / 1000))}s)`
      : ''
  const description = sdkMessage.description?.trim()
  if (description) {
    return `Background task is using ${toolName}${durationSuffix}: ${description}`
  }
  return `Background task is using ${toolName}${durationSuffix}`
}

function buildTaskNotificationMessage(sdkMessage: {
  status: string
  summary?: string
  output_file?: string
  description?: string
}): { content: string; level: 'info' | 'warning' } | null {
  const status = describeTaskTerminalStatus(sdkMessage.status)
  const summary = sdkMessage.summary?.trim()
  const outputFile = sdkMessage.output_file?.trim()
  const description = sdkMessage.description?.trim()
  const parts: string[] = []

  parts.push(
    status === 'failed'
      ? 'Background task failed.'
      : status === 'stopped'
        ? 'Background task stopped.'
        : 'Background task completed.',
  )

  if (description && !summary) {
    parts.push(description)
  }
  if (summary) {
    parts.push(summary)
  }
  if (outputFile) {
    parts.push(`Output saved to ${outputFile}.`)
  }

  return {
    content: parts.join(' '),
    level: status === 'failed' ? 'warning' : 'info',
  }
}

function getToolResultBlockText(block: { content?: unknown }): string {
  const content = block?.content
  if (typeof content === 'string') {
    return content.trim()
  }
  if (Array.isArray(content)) {
    return extractTextContent(content, '\n').trim()
  }
  return ''
}

function getFirstNonEmptyLine(text: string): string | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) {
      return trimmed
    }
  }
  return null
}

function getFirstMatchingNonEmptyLine(
  text: string,
  predicate: (line: string) => boolean,
): string | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed && predicate(trimmed)) {
      return trimmed
    }
  }
  return null
}

type TodoLikeItem = {
  id?: string
  content?: string
  status?: string
}

function getToolUseResultReturnDisplay(source: unknown): unknown {
  if (!source || typeof source !== 'object') {
    return null
  }
  return (source as { returnDisplay?: unknown }).returnDisplay ?? null
}

function getNestedToolResultValue(source: unknown, path: string[]): unknown {
  let current: unknown = source
  for (const key of path) {
    if (!current || typeof current !== 'object') {
      return null
    }
    current = (current as Record<string, unknown>)[key]
  }
  return current ?? null
}

function getToolUseResultReturnDisplayObject(
  source: unknown,
): Record<string, unknown> | null {
  const returnDisplay = getToolUseResultReturnDisplay(source)
  return returnDisplay && typeof returnDisplay === 'object'
    ? (returnDisplay as Record<string, unknown>)
    : null
}

function coerceTodoItems(source: unknown): TodoLikeItem[] {
  if (!Array.isArray(source)) {
    return []
  }
  return source.reduce<TodoLikeItem[]>((acc, item) => {
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>
      acc.push({
        id:
          typeof record.id === 'string' && record.id.trim()
            ? record.id.trim()
            : undefined,
        content:
          typeof record.content === 'string' && record.content.trim()
            ? record.content.trim()
            : undefined,
        status:
          typeof record.status === 'string' && record.status.trim()
            ? record.status.trim()
            : undefined,
      })
    }
    return acc
  }, [])
}

function getTodoItemsFromPaths(
  source: unknown,
  paths: string[][],
): TodoLikeItem[] {
  for (const path of paths) {
    const todos = coerceTodoItems(getNestedToolResultValue(source, path))
    if (todos.length > 0) {
      return todos
    }
  }
  return []
}

function getTodoIdentity(todo: TodoLikeItem): string | null {
  return todo.id ?? todo.content ?? null
}

function getTodoStatusMap(todos: TodoLikeItem[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const todo of todos) {
    const key = getTodoIdentity(todo)
    if (!key || !todo.status) {
      continue
    }
    map.set(key, todo.status)
  }
  return map
}

function getTodoItemsByStatusTransition(
  oldTodos: TodoLikeItem[],
  newTodos: TodoLikeItem[],
  status: string,
): TodoLikeItem[] {
  const oldStatusByTodo = getTodoStatusMap(oldTodos)
  return newTodos.filter(todo => {
    const key = getTodoIdentity(todo)
    if (!key || todo.status !== status) {
      return false
    }
    return oldStatusByTodo.get(key) !== status
  })
}

function summarizeTodoItems(todos: TodoLikeItem[]): string {
  const titles = todos
    .map(todo => todo.content?.trim())
    .filter((title): title is string => !!title)
  if (titles.length === 0) {
    return `${todos.length} item${todos.length === 1 ? '' : 's'}`
  }
  const shown = titles
    .slice(0, 2)
    .map(title => `"${truncateToWidth(title, 80)}"`)
  const extra = titles.length - shown.length
  return extra > 0 ? `${shown.join(', ')} +${extra} more` : shown.join(', ')
}

function getToolUseResultLlmContent(source: unknown): string | null {
  if (!source || typeof source !== 'object') {
    return null
  }
  const llmContent = (source as { llmContent?: unknown }).llmContent
  return typeof llmContent === 'string' && llmContent.trim()
    ? llmContent.trim()
    : null
}

function getToolUseResultOutputPath(source: unknown): string | null {
  if (!source || typeof source !== 'object') {
    return null
  }
  const outputPath = (source as { outputPath?: unknown }).outputPath
  return typeof outputPath === 'string' && outputPath.trim()
    ? outputPath.trim()
    : null
}

function getToolUseResultToolName(source: unknown): string | null {
  if (!source || typeof source !== 'object') {
    return null
  }
  const toolName =
    (source as { toolName?: unknown; tool_name?: unknown }).toolName ??
    (source as { toolName?: unknown; tool_name?: unknown }).tool_name
  return typeof toolName === 'string' && toolName.trim() ? toolName.trim() : null
}

function getToolUseResultIsError(source: unknown): boolean {
  if (!source || typeof source !== 'object') {
    return false
  }
  const isError =
    (source as { isError?: unknown; is_error?: unknown }).isError ??
    (source as { isError?: unknown; is_error?: unknown }).is_error
  return isError === true
}

function getToolResultSourceText(source: unknown): string | null {
  if (typeof source === 'string') {
    return source.trim() || null
  }
  if (source && typeof source === 'object' && 'content' in source) {
    const text = getToolResultBlockText(source as { content?: unknown })
    return text || null
  }
  const llmContent = getToolUseResultLlmContent(source)
  if (llmContent) {
    return llmContent
  }
  const returnDisplay = getToolUseResultReturnDisplay(source)
  return typeof returnDisplay === 'string' && returnDisplay.trim()
    ? returnDisplay.trim()
    : null
}

function ensureTrailingPeriod(text: string): string {
  return SENTENCE_END_RE.test(text) ? text : `${text}.`
}

function isNoiseToolResultLine(line: string): boolean {
  const normalized = line.replace(/\s+/g, ' ').trim()
  return (
    !normalized ||
    NOISE_PREFIX_RE.test(normalized) ||
    FULL_OUTPUT_RE.test(normalized) ||
    READ_LINES_RE.test(normalized) ||
    FOUND_LINES_RE.test(normalized) ||
    FOUND_FILES_RE.test(normalized) ||
    BRACKET_RE.test(normalized)
  )
}

function getFallbackToolErrorDetail(text: string): string | null {
  const detail = getFirstMatchingNonEmptyLine(
    text,
    line => !isNoiseToolResultLine(line),
  )
  return detail ? detail.replace(/\s+/g, ' ').trim() : null
}

function buildTodoWriteFeedback(
  source: unknown,
): { content: string; level: 'info' | 'warning' } | null {
  const text = getToolResultSourceText(source) ?? ''
  const toolName = getToolUseResultToolName(source)?.toLowerCase()
  const returnDisplay = getToolUseResultReturnDisplayObject(source)
  const isTodoWrite =
    text.includes('Todos have been modified successfully') ||
    returnDisplay?.type === 'todo_write' ||
    toolName === 'todowrite' ||
    toolName === 'todo_write'
  if (!isTodoWrite) {
    return null
  }

  const oldTodos = getTodoItemsFromPaths(source, [
    ['oldTodos'],
    ['data', 'oldTodos'],
    ['result', 'oldTodos'],
    ['structuredContent', 'oldTodos'],
  ])
  const newTodos = getTodoItemsFromPaths(source, [
    ['newTodos'],
    ['data', 'newTodos'],
    ['result', 'newTodos'],
    ['structuredContent', 'newTodos'],
    ['input', 'todos'],
  ])
  const completed = getTodoItemsByStatusTransition(oldTodos, newTodos, 'completed')
  if (completed.length > 0) {
    return {
      content:
        completed.length === 1
          ? `Completed todo: ${summarizeTodoItems(completed)}`
          : `Completed todos: ${summarizeTodoItems(completed)}`,
      level: 'info',
    }
  }

  const started = getTodoItemsByStatusTransition(oldTodos, newTodos, 'in_progress')
  if (started.length > 0) {
    return {
      content:
        started.length === 1
          ? `Started todo: ${summarizeTodoItems(started)}`
          : `Started todos: ${summarizeTodoItems(started)}`,
      level: 'info',
    }
  }

  const completedCount = newTodos.filter(todo => todo.status === 'completed').length
  const inProgressCount = newTodos.filter(todo => todo.status === 'in_progress').length
  if (completedCount > 0 || inProgressCount > 0) {
    const parts: string[] = []
    if (completedCount > 0) {
      parts.push(`${completedCount} completed`)
    }
    if (inProgressCount > 0) {
      parts.push(`${inProgressCount} in progress`)
    }
    return {
      content: `Todo progress updated: ${parts.join(', ')}.`,
      level: 'info',
    }
  }

  return { content: 'Todo list updated successfully.', level: 'info' }
}

function buildAgentResultFeedback(
  source: unknown,
): { content: string; level: 'info' | 'warning' } | null {
  const returnDisplay = getToolUseResultReturnDisplayObject(source)
  if (returnDisplay?.type === 'agent_result') {
    const status = typeof returnDisplay.status === 'string' ? returnDisplay.status : ''
    const description =
      typeof returnDisplay.description === 'string'
        ? returnDisplay.description.trim()
        : ''
    const agentType =
      typeof returnDisplay.agentType === 'string'
        ? returnDisplay.agentType.trim()
        : ''
    const detail =
      typeof returnDisplay.content === 'string'
        ? getFirstNonEmptyLine(returnDisplay.content)
        : null
    const subject = description || agentType || 'Sub-agent task'
    if (status === 'failed') {
      return {
        content: detail
          ? `Sub-agent failed: ${subject} — ${detail}`
          : `Sub-agent failed: ${subject}`,
        level: 'warning',
      }
    }
    if (status === 'completed') {
      return {
        content: `Sub-agent completed: ${subject}`,
        level: 'info',
      }
    }
    if (status === 'stopped' || status === 'killed') {
      return {
        content: `Sub-agent stopped: ${subject}`,
        level: 'warning',
      }
    }
  }

  if (typeof source !== 'string') {
    return null
  }

  const successMatch = source.match(/^Sub-agent \(([^)]+)\) completed successfully:/m)
  if (successMatch) {
    return {
      content: `Sub-agent completed: ${successMatch[1]!.trim()}`,
      level: 'info',
    }
  }

  const failureMatch = source.match(/^Sub-agent \(([^)]+)\) failed:/m)
  if (failureMatch) {
    const detail =
      source.match(/Agent execution error:\s*([^\n]+)/)?.[1]?.trim() || null
    return {
      content: detail
        ? `Sub-agent failed: ${failureMatch[1]!.trim()} — ${detail}`
        : `Sub-agent failed: ${failureMatch[1]!.trim()}`,
      level: 'warning',
    }
  }

  return null
}

function getQueryToolScaleSummary(text: string): string | null {
  const summaryLine = getFirstMatchingNonEmptyLine(text, line => {
    const normalized = line.replace(/\s+/g, ' ').trim()
    return (
      /^Read \d+ lines?(?: \(from line \d+ to \d+\))?\.?$/.test(normalized) ||
      /^Found \d+ lines in \d+ files(?: \(\d+ms\))?\.?$/.test(normalized) ||
      /^Found \d+ files(?: in \d+ms)?\.?$/.test(normalized)
    )
  })
  return summaryLine ? ensureTrailingPeriod(summaryLine.replace(/\s+/g, ' ').trim()) : null
}

function isQueryToolName(toolName: string | null): boolean {
  return !!toolName && /(read|grep|search|glob|list|find|outline|lint|ls)/i.test(toolName)
}

function isHighValueToolSummaryLine(line: string): boolean {
  const normalized = line.replace(/\s+/g, ' ').trim()
  if (isNoiseToolResultLine(normalized)) {
    return false
  }
  return /^(?:No linter errors found|Bundled \d+ modules in \d+(?:ms|s)|Build passed|Compilation succeeded|已(?:完成|定位|修复|检查|确认|分析|更新|补齐|实现|运行|同步|读取|审查|创建)|构建通过|编译通过)/.test(
    normalized,
  )
}

function getHighValueToolSummary(text: string): string | null {
  const summaryLine = getFirstMatchingNonEmptyLine(text, isHighValueToolSummaryLine)
  return summaryLine
    ? ensureTrailingPeriod(summaryLine.replace(/\s+/g, ' ').trim())
    : null
}

function buildQueryToolFeedback(
  source: unknown,
): { content: string; level: 'info' | 'warning' } | null {
  const text = getToolResultSourceText(source) ?? ''
  const toolName = getToolUseResultToolName(source)
  const scaleSummary = getQueryToolScaleSummary(text)
  if (!scaleSummary && !isQueryToolName(toolName)) {
    return null
  }
  const summary = getHighValueToolSummary(text) ?? scaleSummary
  if (!summary) {
    return null
  }
  const outputPath = extractFullOutputSavedPaths(text)[0] ?? getToolUseResultOutputPath(source)
  return {
    content: outputPath ? `${summary} Full output saved to ${outputPath}.` : summary,
    level: 'info',
  }
}

function humanizeToolFailureDetail(detail: string): string {
  const normalized = detail.replace(/\s+/g, ' ').trim()
  if (EISDIR_RE.test(normalized)) {
    return 'Target is a directory, not a file.'
  }
  if (LINE_RANGE_INVALID_RE.test(normalized)) {
    return 'Requested line range is invalid.'
  }
  if (ENOENT_RE.test(normalized)) {
    return 'File or directory not found.'
  }
  if (EACCES_RE.test(normalized)) {
    return 'Permission denied.'
  }
  if (ENOTDIR_RE.test(normalized)) {
    return 'A path segment is not a directory.'
  }
  return ensureTrailingPeriod(normalized.replace(ERROR_PREFIX_RE, ''))
}

function buildGenericToolFailureFeedback(
  source: unknown,
): { content: string; level: 'info' | 'warning' } | null {
  const returnDisplay = getToolUseResultReturnDisplayObject(source)
  if (returnDisplay?.type === 'agent_result' || returnDisplay?.type === 'todo_write') {
    return null
  }

  const text = getToolResultSourceText(source)
  if (!text) {
    return null
  }

  const detail =
    getFirstMatchingNonEmptyLine(text, line =>
      /^(?:ENOENT|EACCES|EPERM|ENOTDIR|EISDIR|Error:|Agent execution error:|Command failed:?|Cannot\b|Failed\b)/.test(
        line.replace(/\s+/g, ' ').trim(),
      ),
    )
      ?.replace(/\s+/g, ' ')
      .trim() ??
    (getToolUseResultIsError(source) ? getFallbackToolErrorDetail(text) : null)
  if (!detail && !getToolUseResultIsError(source)) {
    return null
  }

  const toolName = getToolUseResultToolName(source)
  const humanized = detail ? humanizeToolFailureDetail(detail) : null
  return {
    content: toolName
      ? humanized
        ? `${toolName} failed: ${humanized}`
        : `${toolName} failed.`
      : humanized ?? 'Tool failed.',
    level: 'warning',
  }
}

function buildOutputPathFeedback(
  source: unknown,
): { content: string; level: 'info' | 'warning' } | null {
  const text = getToolResultSourceText(source) ?? ''
  const outputPath =
    getToolUseResultOutputPath(source) ?? extractFullOutputSavedPaths(text)[0] ?? null
  return outputPath
    ? {
        content: `Full output saved to ${outputPath}.`,
        level: 'info',
      }
    : null
}

function extractFullOutputSavedPaths(text: string): string[] {
  return [...text.matchAll(/Full output saved to:\s*(\S+)/g)]
    .map(match => match[1]?.trim())
    .filter((path): path is string => !!path)
}

function extractHighValueToolResultFeedback(sdkMessage: {
  type: string
  tool_use_result?: unknown
  message?: { content?: unknown }
}): Array<{ content: string; level: 'info' | 'warning' }> {
  if (sdkMessage.type !== 'user') {
    return []
  }

  const content = sdkMessage.message?.content
  if (!Array.isArray(content)) {
    return []
  }

  const toolResultBlocks = content.filter(block => block.type === 'tool_result')
  if (toolResultBlocks.length === 0) {
    return []
  }

  const feedback: Array<{ content: string; level: 'info' | 'warning' }> = []
  const seen = new Set<string>()
  const addFeedback = (
    item: { content: string; level: 'info' | 'warning' } | null,
  ) => {
    if (!item) {
      return
    }
    const key = `${item.level}:${item.content}`
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    feedback.push(item)
  }

  addFeedback(buildTodoWriteFeedback(sdkMessage.tool_use_result))
  addFeedback(buildAgentResultFeedback(sdkMessage.tool_use_result))
  const topQueryFeedback = buildQueryToolFeedback(sdkMessage.tool_use_result)
  addFeedback(topQueryFeedback)
  addFeedback(buildGenericToolFailureFeedback(sdkMessage.tool_use_result))
  if (!topQueryFeedback?.content.includes('Full output saved to ')) {
    addFeedback(buildOutputPathFeedback(sdkMessage.tool_use_result))
  }

  for (const block of toolResultBlocks) {
    addFeedback(buildTodoWriteFeedback(getToolResultBlockText(block)))
    addFeedback(buildAgentResultFeedback(getToolResultBlockText(block)))
    const queryFeedback = buildQueryToolFeedback(block)
    addFeedback(queryFeedback)
    addFeedback(buildGenericToolFailureFeedback(block))
    if (!queryFeedback?.content.includes('Full output saved to ')) {
      addFeedback(buildOutputPathFeedback(block))
    }
  }

  return feedback
}

// How long to wait for a response before showing a warning
const RESPONSE_TIMEOUT_MS = 60_000 // 60 seconds
// Extended timeout during compaction — compact API calls take 5-30s and
// block other SDK messages, so the normal 60s timeout isn't enough when
// compaction itself runs close to the edge.
const COMPACTION_TIMEOUT_MS = 180000 // 3 minutes

type UseRemoteSessionProps = {
  config: RemoteSessionConfig | undefined
  setMessages: React.Dispatch<React.SetStateAction<MessageType[]>>
  setIsLoading: (loading: boolean) => void
  onInit?: (slashCommands: string[]) => void
  setToolUseConfirmQueue: React.Dispatch<React.SetStateAction<ToolUseConfirm[]>>
  tools: Tool[]
  setStreamingToolUses?: React.Dispatch<
    React.SetStateAction<StreamingToolUse[]>
  >
  setStreamMode?: React.Dispatch<React.SetStateAction<SpinnerMode>>
  setInProgressToolUseIDs?: (f: (prev: Set<string>) => Set<string>) => void
}

type UseRemoteSessionResult = {
  isRemoteMode: boolean
  sendMessage: (
    content: RemoteMessageContent,
    opts?: { uuid?: string },
  ) => Promise<boolean>
  cancelRequest: () => void
  disconnect: () => void
}

/**
 * Hook for managing a remote CCR session in the REPL.
 *
 * Handles:
 * - WebSocket connection to CCR
 * - Converting SDK messages to REPL messages
 * - Sending user input to CCR via HTTP POST
 * - Permission request/response flow via existing ToolUseConfirm queue
 */
export function useRemoteSession({
  config,
  setMessages,
  setIsLoading,
  onInit,
  setToolUseConfirmQueue,
  tools,
  setStreamingToolUses,
  setStreamMode,
  setInProgressToolUseIDs,
}: UseRemoteSessionProps): UseRemoteSessionResult {
  const isRemoteMode = !!config

  const setAppState = useSetAppState()
  const setConnStatus = useCallback(
    (s: AppState['remoteConnectionStatus']) =>
      setAppState(prev =>
        prev.remoteConnectionStatus === s
          ? prev
          : { ...prev, remoteConnectionStatus: s },
      ),
    [setAppState],
  )

  // Event-sourced count of subagents running inside the remote daemon child.
  // The viewer's own AppState.tasks is empty — tasks live in a different
  // process. task_started/task_notification reach us via the bridge WS.
  const runningTaskIdsRef = useRef(new Set<string>())
  const writeTaskCount = useCallback(() => {
    const n = runningTaskIdsRef.current.size
    setAppState(prev =>
      prev.remoteBackgroundTaskCount === n
        ? prev
        : { ...prev, remoteBackgroundTaskCount: n },
    )
  }, [setAppState])

  // Timer for detecting stuck sessions
  const responseTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Track whether the remote session is compacting. During compaction the
  // CLI worker is busy with an API call and won't emit messages for a while;
  // use a longer timeout and suppress spurious "unresponsive" warnings.
  const isCompactingRef = useRef(false)

  const managerRef = useRef<RemoteSessionManager | null>(null)

  // Track whether we've already updated the session title (for no-initial-prompt sessions)
  const hasUpdatedTitleRef = useRef(false)

  // UUIDs of user messages we POSTed locally — the WS echoes them back and
  // we must filter them out when convertUserTextMessages is on, or the viewer
  // sees every typed message twice (once from local createUserMessage, once
  // from the echo). A single POST can echo MULTIPLE times with the same uuid:
  // the server may broadcast the POST directly to /subscribe, AND the worker
  // (cowork desktop / CLI daemon) echoes it again on its write path. A
  // delete-on-first-match Set would let the second echo through — use a
  // bounded ring instead. Cap is generous: users don't type 50 messages
  // faster than echoes arrive.
  // NOTE: this does NOT dedup history-vs-live overlap at attach time (nothing
  // seeds the set from history UUIDs; only sendMessage populates it).
  const sentUUIDsRef = useRef(new BoundedUUIDSet(50))

  // Keep a ref to tools so the WebSocket callback doesn't go stale
  const toolsRef = useRef(tools)
  useEffect(() => {
    toolsRef.current = tools
  }, [tools])

  // Initialize and connect to remote session
  useEffect(() => {
    // Skip if not in remote mode
    if (!config) {
      return
    }

    logForDebugging(
      `[useRemoteSession] Initializing for session ${config.sessionId}`,
    )

    const manager = new RemoteSessionManager(config, {
      onMessage: sdkMessage => {
        const parts = [`type=${sdkMessage.type}`]
        if ('subtype' in sdkMessage) parts.push(`subtype=${sdkMessage.subtype}`)
        if (sdkMessage.type === 'user') {
          const c = sdkMessage.message?.content
          parts.push(
            `content=${Array.isArray(c) ? c.map(b => b.type).join(',') : typeof c}`,
          )
        }
        logForDebugging(`[useRemoteSession] Received ${parts.join(' ')}`)

        // Clear response timeout on any message received — including the WS
        // echo of our own POST, which acts as a heartbeat. This must run
        // BEFORE the echo filter, or slow-to-stream agents (compaction, cold
        // start) spuriously trip the 60s unresponsive warning + reconnect.
        if (responseTimeoutRef.current) {
          clearTimeout(responseTimeoutRef.current)
          responseTimeoutRef.current = null
        }

        // Echo filter: drop user messages we already added locally before POST.
        // The server and/or worker round-trip our own send back on the WS with
        // the same uuid we passed to sendEventToRemoteSession. DO NOT delete on
        // match — the same uuid can echo more than once (server broadcast +
        // worker echo), and BoundedUUIDSet already caps growth via its ring.
        if (
          sdkMessage.type === 'user' &&
          sdkMessage.uuid &&
          sentUUIDsRef.current.has(sdkMessage.uuid)
        ) {
          logForDebugging(
            `[useRemoteSession] Dropping echoed user message ${sdkMessage.uuid}`,
          )
          return
        }
        // Handle init message - extract available slash commands
        if (
          sdkMessage.type === 'system' &&
          sdkMessage.subtype === 'init' &&
          onInit
        ) {
          logForDebugging(
            `[useRemoteSession] Init received with ${sdkMessage.slash_commands.length} slash commands`,
          )
          onInit(sdkMessage.slash_commands)
        }

        // Track remote subagent lifecycle for the "N in background" counter.
        // All task types (Agent/teammate/workflow/bash) flow through
        // registerTask() → task_started, and complete via task_notification.
        if (sdkMessage.type === 'system') {
          if (sdkMessage.subtype === 'task_started') {
            runningTaskIdsRef.current.add(sdkMessage.task_id)
            writeTaskCount()
            const taskStartedMessage = buildTaskStartedMessage(sdkMessage)
            if (taskStartedMessage) {
              setMessages(prev => [
                ...prev,
                createSystemMessage(taskStartedMessage, 'info'),
              ])
            }
            return
          }
          if (sdkMessage.subtype === 'task_notification') {
            runningTaskIdsRef.current.delete(sdkMessage.task_id)
            writeTaskCount()
            const taskNotificationMessage = buildTaskNotificationMessage(sdkMessage)
            if (taskNotificationMessage) {
              setMessages(prev => [
                ...prev,
                createSystemMessage(
                  taskNotificationMessage.content,
                  taskNotificationMessage.level,
                ),
              ])
            }
            return
          }
          if (sdkMessage.subtype === 'task_progress') {
            const taskProgressMessage = buildTaskProgressMessage(sdkMessage)
            if (taskProgressMessage) {
              setMessages(prev => [
                ...prev,
                createSystemMessage(taskProgressMessage, 'info'),
              ])
            }
            return
          }
          // Track compaction state. The CLI emits status='compacting' at
          // the start and status=null when done; compact_boundary also
          // signals completion. Repeated 'compacting' status messages
          // (keep-alive ticks) update the ref but don't append to messages.
          if (sdkMessage.subtype === 'status') {
            const wasCompacting = isCompactingRef.current
            isCompactingRef.current = sdkMessage.status === 'compacting'
            if (wasCompacting && isCompactingRef.current) {
              return
            }
          }
          if (sdkMessage.subtype === 'compact_boundary') {
            isCompactingRef.current = false
          }
        }

        // Check if session ended
        if (isSessionEndMessage(sdkMessage)) {
          isCompactingRef.current = false
          setIsLoading(false)
        }

        // Clear in-progress tool_use IDs when their tool_result arrives.
        // Must read the RAW sdkMessage: in non-viewerOnly mode,
        // convertSDKMessage returns {type:'ignored'} for user messages, so the
        // delete would never fire post-conversion. Mirrors the add site below
        // and inProcessRunner.ts; without this the set grows unbounded for the
        // session lifetime (BQ: CCR cohort shows 5.2x higher RSS slope).
        if (setInProgressToolUseIDs && sdkMessage.type === 'user') {
          const content = sdkMessage.message?.content
          if (Array.isArray(content)) {
            const resultIds: string[] = []
            for (const block of content) {
              if (block.type === 'tool_result') {
                resultIds.push(block.tool_use_id)
              }
            }
            if (resultIds.length > 0) {
              setInProgressToolUseIDs(prev => {
                const next = new Set(prev)
                for (const id of resultIds) next.delete(id)
                return next.size === prev.size ? prev : next
              })
            }
          }
        }

        const highValueFeedbackMessages =
          sdkMessage.type === 'user'
            ? extractHighValueToolResultFeedback(sdkMessage).map(
                ({ content, level }) => createSystemMessage(content, level),
              )
            : []

        // Convert SDK message to REPL message. In viewerOnly mode, the
        // remote agent runs BriefTool (SendUserMessage) — its tool_use block
        // renders empty (userFacingName() === ''), actual content is in the
        // tool_result. So we must convert tool_results to render them.
        const converted = convertSDKMessage(
          sdkMessage,
          config.viewerOnly
            ? { convertToolResults: true, convertUserTextMessages: true }
            : undefined,
        )

        if (converted.type === 'message') {
          // When we receive a complete message, clear streaming tool uses
          // since the complete message replaces the partial streaming state
          setStreamingToolUses?.(prev => (prev.length > 0 ? [] : prev))

          // Mark tool_use blocks as in-progress so the UI shows the correct
          // spinner state instead of "Waiting…" (queued). In local sessions,
          // toolOrchestration.ts handles this, but remote sessions receive
          // pre-built assistant messages without running local tool execution.
          if (
            setInProgressToolUseIDs &&
            converted.message.type === 'assistant'
          ) {
            const toolUseIds = converted.message.message.content
              .reduce<string[]>((acc, block) => {
                if (block.type === 'tool_use') acc.push(block.id)
                return acc
              }, [])
            if (toolUseIds.length > 0) {
              setInProgressToolUseIDs(prev => {
                const next = new Set(prev)
                for (const id of toolUseIds) {
                  next.add(id)
                }
                return next
              })
            }
          }

          setMessages(prev => [
            ...prev,
            ...highValueFeedbackMessages,
            converted.message,
          ])
          // Note: Don't stop loading on assistant messages - the agent may still be
          // working (tool use loops). Loading stops only on session end or permission request.
        } else if (converted.type === 'stream_event') {
          // Process streaming events to update UI in real-time
          if (setStreamingToolUses && setStreamMode) {
            handleMessageFromStream(
              converted.event,
              message => setMessages(prev => [...prev, message]),
              () => {
                // No-op for response length - remote sessions don't track this
              },
              setStreamMode,
              setStreamingToolUses,
            )
          } else {
            logForDebugging(
              `[useRemoteSession] Stream event received but streaming callbacks not provided`,
            )
          }
        } else if (highValueFeedbackMessages.length > 0) {
          setMessages(prev => [...prev, ...highValueFeedbackMessages])
        }
        // 'ignored' messages are silently dropped
      },
      onPermissionRequest: (request, requestId) => {
        logForDebugging(
          `[useRemoteSession] Permission request for tool: ${request.tool_name}`,
        )

        // Look up the Tool object by name, or create a stub for unknown tools
        const tool =
          findToolByName(toolsRef.current, request.tool_name) ??
          createToolStub(request.tool_name)

        const syntheticMessage = createSyntheticAssistantMessage(
          request,
          requestId,
        )

        const permissionResult: PermissionAskDecision = {
          behavior: 'ask',
          message:
            request.description ?? `${request.tool_name} requires permission`,
          suggestions: request.permission_suggestions,
          blockedPath: request.blocked_path,
        }

        const toolUseConfirm: ToolUseConfirm = {
          assistantMessage: syntheticMessage,
          tool,
          description:
            request.description ?? `${request.tool_name} requires permission`,
          input: request.input,
          toolUseContext: {} as ToolUseConfirm['toolUseContext'],
          toolUseID: request.tool_use_id,
          permissionResult,
          permissionPromptStartTimeMs: Date.now(),
          onUserInteraction() {
            // No-op for remote — classifier runs on the container
          },
          onAbort() {
            const response: RemotePermissionResponse = {
              behavior: 'deny',
              message: 'User aborted',
            }
            manager.respondToPermissionRequest(requestId, response)
            setToolUseConfirmQueue(queue =>
              queue.filter(item => item.toolUseID !== request.tool_use_id),
            )
          },
          onAllow(updatedInput, _permissionUpdates, _feedback) {
            const response: RemotePermissionResponse = {
              behavior: 'allow',
              updatedInput,
            }
            manager.respondToPermissionRequest(requestId, response)
            setToolUseConfirmQueue(queue =>
              queue.filter(item => item.toolUseID !== request.tool_use_id),
            )
            // Resume loading indicator after approving
            setIsLoading(true)
          },
          onReject(feedback?: string) {
            const response: RemotePermissionResponse = {
              behavior: 'deny',
              message: feedback ?? 'User denied permission',
            }
            manager.respondToPermissionRequest(requestId, response)
            setToolUseConfirmQueue(queue =>
              queue.filter(item => item.toolUseID !== request.tool_use_id),
            )
          },
          async recheckPermission() {
            // No-op for remote — permission state is on the container
          },
        }

        setToolUseConfirmQueue(queue => [...queue, toolUseConfirm])
        // Pause loading indicator while waiting for permission
        setIsLoading(false)
      },
      onPermissionCancelled: (requestId, toolUseId) => {
        logForDebugging(
          `[useRemoteSession] Permission request cancelled: ${requestId}`,
        )
        const idToRemove = toolUseId ?? requestId
        setToolUseConfirmQueue(queue =>
          queue.filter(item => item.toolUseID !== idToRemove),
        )
        setIsLoading(true)
      },
      onConnected: () => {
        logForDebugging('[useRemoteSession] Connected')
        setConnStatus('connected')
      },
      onReconnecting: () => {
        logForDebugging('[useRemoteSession] Reconnecting')
        setConnStatus('reconnecting')
        // WS gap = we may miss task_notification events. Clear rather than
        // drift high forever. Undercounts tasks that span the gap; accepted.
        runningTaskIdsRef.current.clear()
        writeTaskCount()
        // Same for tool_use IDs: missed tool_result during the gap would
        // leave stale spinner state forever.
        setInProgressToolUseIDs?.(prev => (prev.size > 0 ? new Set() : prev))
      },
      onDisconnected: () => {
        logForDebugging('[useRemoteSession] Disconnected')
        setConnStatus('disconnected')
        setIsLoading(false)
        runningTaskIdsRef.current.clear()
        writeTaskCount()
        setInProgressToolUseIDs?.(prev => (prev.size > 0 ? new Set() : prev))
      },
      onError: error => {
        logForDebugging(`[useRemoteSession] Error: ${error.message}`)
      },
    })

    managerRef.current = manager
    manager.connect()

    return () => {
      logForDebugging('[useRemoteSession] Cleanup - disconnecting')
      // Clear any pending timeout
      if (responseTimeoutRef.current) {
        clearTimeout(responseTimeoutRef.current)
        responseTimeoutRef.current = null
      }
      manager.disconnect()
      managerRef.current = null
    }
  }, [
    config,
    setMessages,
    setIsLoading,
    onInit,
    setToolUseConfirmQueue,
    setStreamingToolUses,
    setStreamMode,
    setInProgressToolUseIDs,
    setConnStatus,
    writeTaskCount,
  ])

  // Send a user message to the remote session
  const sendMessage = useCallback(
    async (
      content: RemoteMessageContent,
      opts?: { uuid?: string },
    ): Promise<boolean> => {
      const manager = managerRef.current
      if (!manager) {
        logForDebugging('[useRemoteSession] Cannot send - no manager')
        return false
      }

      // Clear any existing timeout
      if (responseTimeoutRef.current) {
        clearTimeout(responseTimeoutRef.current)
      }

      setIsLoading(true)

      // Track locally-added message UUIDs so the WS echo can be filtered.
      // Must record BEFORE the POST to close the race where the echo arrives
      // before the POST promise resolves.
      if (opts?.uuid) sentUUIDsRef.current.add(opts.uuid)

      const success = await manager.sendMessage(content, opts)

      if (!success) {
        // No need to undo the pre-POST add — BoundedUUIDSet's ring evicts it.
        setIsLoading(false)
        return false
      }

      // Update the session title after the first message when no initial prompt was provided.
      // This gives the session a meaningful title on claude.ai instead of "Background task".
      // Skip in viewerOnly mode — the remote agent owns the session title.
      if (
        !hasUpdatedTitleRef.current &&
        config &&
        !config.hasInitialPrompt &&
        !config.viewerOnly
      ) {
        hasUpdatedTitleRef.current = true
        const sessionId = config.sessionId
        // Extract plain text from content (may be string or content block array)
        const description =
          typeof content === 'string'
            ? content
            : extractTextContent(content, ' ')
        if (description) {
          // generateSessionTitle never rejects (wraps body in try/catch,
          // returns null on failure), so no .catch needed on this chain.
          void generateSessionTitle(
            description,
            new AbortController().signal,
          ).then(title => {
            void updateSessionTitle(
              sessionId,
              title ?? truncateToWidth(description, 75),
            )
          })
        }
      }

      // Start timeout to detect stuck sessions. Skip in viewerOnly mode —
      // the remote agent may be idle-shut and take >60s to respawn.
      // Use a longer timeout when the remote session is compacting, since
      // the CLI worker is busy with an API call and won't emit messages.
      if (!config?.viewerOnly) {
        const timeoutMs = isCompactingRef.current
          ? COMPACTION_TIMEOUT_MS
          : RESPONSE_TIMEOUT_MS
        responseTimeoutRef.current = setTimeout(
          (setMessages, manager) => {
            logForDebugging(
              '[useRemoteSession] Response timeout - attempting reconnect',
            )
            // Add a warning message to the conversation
            const warningMessage = createSystemMessage(
              isCompactingRef.current
                ? 'Remote session is still compacting context. Waiting a bit longer before reconnecting…'
                : 'Remote session may be unresponsive. Attempting to reconnect…',
              'warning',
            )
            setMessages(prev => [...prev, warningMessage])

            // Attempt to reconnect the WebSocket - the subscription may have become stale
            manager.reconnect()
          },
          timeoutMs,
          setMessages,
          manager,
        )
      }

      return success
    },
    [config, setIsLoading, setMessages],
  )

  // Cancel the current request on the remote session
  const cancelRequest = useCallback(() => {
    // Clear any pending timeout
    if (responseTimeoutRef.current) {
      clearTimeout(responseTimeoutRef.current)
      responseTimeoutRef.current = null
    }

    // Send interrupt signal to CCR. Skip in viewerOnly mode — Ctrl+C
    // should never interrupt the remote agent.
    if (!config?.viewerOnly) {
      managerRef.current?.cancelSession()
    }

    setIsLoading(false)
  }, [config, setIsLoading])

  // Disconnect from the session
  const disconnect = useCallback(() => {
    // Clear any pending timeout
    if (responseTimeoutRef.current) {
      clearTimeout(responseTimeoutRef.current)
      responseTimeoutRef.current = null
    }
    managerRef.current?.disconnect()
    managerRef.current = null
  }, [])

  // All four fields are already stable (boolean derived from a prop that
  // doesn't change mid-session, three useCallbacks with stable deps). The
  // result object is consumed by REPL's onSubmit useCallback deps — without
  // memoization the fresh literal invalidates onSubmit on every REPL render,
  // which in turn churns PromptInput's props and downstream memoization.
  return useMemo(
    () => ({ isRemoteMode, sendMessage, cancelRequest, disconnect }),
    [isRemoteMode, sendMessage, cancelRequest, disconnect],
  )
}
