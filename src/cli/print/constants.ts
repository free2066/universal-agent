/**
 * Constants and state for print module
 */

import type { UUID } from './types.js'

// ============================================================================
// Team Shutdown Prompt
// ============================================================================

export const SHUTDOWN_TEAM_PROMPT = `<system-reminder>
You are running in non-interactive mode and cannot return a response to the user until your team is shut down.

You MUST shut down your team before preparing your final response:
1. Use requestShutdown to ask each team member to shut down gracefully
2. Wait for shutdown approvals
3. Use the cleanup operation to clean up the team
4. Only then provide your final response to the user

The user cannot receive your response until the team is completely shut down.
</system-reminder>

Shut down your team and prepare your final response for the user.`

// ============================================================================
// Message UUID Tracking
// ============================================================================

export const MAX_RECEIVED_UUIDS = 10_000

/** Set of UUIDs received during the current session runtime */
export const receivedMessageUuids = new Set<UUID>()

/** Ordered list of UUIDs for LRU eviction */
export const receivedMessageUuidsOrder: UUID[] = []

/**
 * Track a received message UUID, evicting oldest entries when at capacity.
 * @returns true if the UUID was new, false if it was a duplicate
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
