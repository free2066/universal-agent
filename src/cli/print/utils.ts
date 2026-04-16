/**
 * Utility functions for CLI print module
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages.js'
import type { PromptValue } from './types.js'
import type { QueuedCommand } from '../../types/textInputTypes.js'
import { MAX_RECEIVED_UUIDS, receivedMessageUuids, receivedMessageUuidsOrder } from './constants.js'
import type { UUID } from '../../types.js'

// ============================================================================
// Content Block Utilities
// ============================================================================

/**
 * Convert a prompt value to content blocks
 */
export function toBlocks(v: PromptValue): ContentBlockParam[] {
  return typeof v === 'string' ? [{ type: 'text', text: v }] : v
}

/**
 * Join prompt values from multiple queued commands into one. Strings are
 * newline-joined; if any value is a block array, all values are normalized
 * to blocks and concatenated.
 */
export function joinPromptValues(values: PromptValue[]): PromptValue {
  if (values.length === 1) return values[0]!
  if (values.every(v => typeof v === 'string')) {
    return values.join('\n')
  }
  return values.flatMap(toBlocks)
}

// ============================================================================
// Command Batching
// ============================================================================

/**
 * Whether `next` can be batched into the same ask() call as `head`. Only
 * prompt-mode commands batch, and only when the workload tag matches (so the
 * combined turn is attributed correctly) and the isMeta flag matches (so a
 * proactive tick can't merge into a user prompt and lose its hidden-in-
 * transcript marking when the head is spread over the merged command).
 */
export function canBatchWith(
  head: QueuedCommand,
  next: QueuedCommand | undefined,
): boolean {
  return (
    next !== undefined &&
    next.mode === 'prompt' &&
    next.workload === head.workload &&
    next.isMeta === head.isMeta
  )
}

// ============================================================================
// Message UUID Tracking
// ============================================================================

/**
 * Track a received message UUID for deduplication
 * @returns true if the UUID is new, false if it was already seen
 */
export function trackReceivedMessageUuid(uuid: UUID): boolean {
  if (receivedMessageUuids.has(uuid)) {
    return false // duplicate
  }
  receivedMessageUuids.add(uuid)
  receivedMessageUuidsOrder.push(uuid)
  // Evict oldest entries when at capacity
  if (receivedMessageUuidsOrder.length > MAX_RECEIVED_UUIDS) {
    const toEvict = receivedMessageUuidsOrder.splice(
      0,
      receivedMessageUuidsOrder.length - MAX_RECEIVED_UUIDS,
    )
    for (const old of toEvict) {
      receivedMessageUuids.delete(old)
    }
  }
  return true // new UUID
}
