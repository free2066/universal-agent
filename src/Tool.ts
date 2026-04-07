/**
 * src/Tool.ts — Base tool type definition
 *
 * Mirrors claude-code's Tool.ts.
 * Defines the canonical shape of a tool registration that the agent can use.
 *
 * All tool implementations must conform to this interface.
 */

// ── Re-export canonical ToolRegistration from the models layer ─────────────────

export type { ToolRegistration, ToolDefinition } from './models/types.js';

// ── Tool result helpers ────────────────────────────────────────────────────────

/**
 * Create a tool result string indicating success.
 */
export function toolSuccess(message: string): string {
  return message;
}

/**
 * Create a tool result string indicating failure.
 */
export function toolError(message: string): string {
  return `Error: ${message}`;
}

/**
 * Check if a tool result indicates an error.
 */
export function isToolError(result: string): boolean {
  return result.startsWith('Error:') || result.startsWith('ERROR:');
}

/**
 * Truncate a tool result to a maximum length.
 */
export function truncateToolResult(result: string, maxChars = 100_000): string {
  if (result.length <= maxChars) return result;
  const half = Math.floor(maxChars / 2);
  return result.slice(0, half) + `\n\n[... ${result.length - maxChars} chars truncated ...]\n\n` + result.slice(-half);
}
