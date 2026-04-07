/**
 * types/ids.ts — Branded ID types
 *
 * Mirrors claude-code's types/ids.ts.
 * Provides branded types for IDs to prevent accidental misuse.
 */

export type { SessionId } from '../bootstrap/state.js';

/** Agent/subagent instance ID */
export type AgentId = string & { readonly __brand: 'AgentId' };

/** Task ID on the task board */
export type TaskId = number & { readonly __brand: 'TaskId' };

/** MCP server identifier */
export type McpServerId = string & { readonly __brand: 'McpServerId' };

/** Tool registration name */
export type ToolName = string & { readonly __brand: 'ToolName' };

/** Create a new AgentId */
export function newAgentId(): AgentId {
  const { randomUUID } = require('crypto');
  return randomUUID() as AgentId;
}
