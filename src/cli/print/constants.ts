/**
 * Constants for print module
 */

import type { UUID } from 'crypto'

/**
 * Prompt for shutting down team in non-interactive mode
 */
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

/**
 * Maximum number of received message UUIDs to track
 */
export const MAX_RECEIVED_UUIDS = 10_000
