/**
 * Constants for messages module
 */

/**
 * Memory correction hint for tool results
 */
export const MEMORY_CORRECTION_HINT =
  "\n\nNote: If the user's feedback was about a specific file, they may have been referring to a stale version. Please re-read the file before applying any changes."

/**
 * Tool reference turn boundary marker
 */
export const TOOL_REFERENCE_TURN_BOUNDARY = 'Tool loaded.'

/**
 * Interrupt message for user interruption
 */
export const INTERRUPT_MESSAGE = '[Request interrupted by user]'

/**
 * Interrupt message for tool use interruption
 */
export const INTERRUPT_MESSAGE_FOR_TOOL_USE = '[Request interrupted by user for tool use]'

/**
 * Cancel message for user cancellation
 */
export const CANCEL_MESSAGE =
  "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed."

/**
 * Reject message for tool rejection
 */
export const REJECT_MESSAGE =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."

/**
 * Reject message with reason prefix
 */
export const REJECT_MESSAGE_WITH_REASON_PREFIX =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n"

/**
 * Subagent reject message
 */
export const SUBAGENT_REJECT_MESSAGE =
  'Permission for this tool use was denied. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). Try a different approach or report the limitation to complete your task.'

/**
 * Subagent reject message with reason prefix
 */
export const SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX =
  'Permission for this tool use was denied. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). The user said:\n'

/**
 * Plan rejection prefix
 */
export const PLAN_REJECTION_PREFIX =
  'The agent proposed a plan that was rejected by the user. The user chose to stay in plan mode rather than proceed with implementation.\n\nRejected plan:\n'

/**
 * Denial workaround guidance
 */
export const DENIAL_WORKAROUND_GUIDANCE = `IMPORTANT:
- If you feel you need more information to complete a task, use the appropriate tool (e.g. Read, Grep, Glob) to get that information.
- Do NOT ask the user for this information.
- If you are unable to complete a task, explain why and suggest alternatives.`

/**
 * No response requested message
 */
export const NO_RESPONSE_REQUESTED = 'No response requested.'

/**
 * Synthetic tool result placeholder
 */
export const SYNTHETIC_TOOL_RESULT_PLACEHOLDER =
  '[Tool result missing due to internal error]'

/**
 * Auto mode rejection prefix
 */
export const AUTO_MODE_REJECTION_PREFIX =
  'Permission for this action has been denied. Reason:  '

/**
 * Synthetic model identifier
 */
export const SYNTHETIC_MODEL = '<synthetic>'

/**
 * Set of synthetic message types
 */
export const SYNTHETIC_MESSAGES = new Set([
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  CANCEL_MESSAGE,
  REJECT_MESSAGE,
  NO_RESPONSE_REQUESTED,
])
