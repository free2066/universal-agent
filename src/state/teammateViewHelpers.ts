/**
 * state/teammateViewHelpers.ts — Teammate view state helpers
 *
 * Mirrors claude-code's state/teammateViewHelpers.ts.
 * Provides view-layer helper functions for the teammate/swarm system.
 */

import type { InboxMessage } from '../core/teammate-manager.js';

// ── Teammate status display ───────────────────────────────────────────────────

export type TeammateDisplayStatus =
  | 'idle'
  | 'working'
  | 'waiting_approval'
  | 'error'
  | 'offline';

export interface TeammateViewState {
  name: string;
  role: string;
  status: TeammateDisplayStatus;
  lastActivity?: string;
  pendingMessages: number;
}

/**
 * Format a teammate status for display.
 */
export function formatTeammateStatus(status: TeammateDisplayStatus): string {
  switch (status) {
    case 'idle': return '⏸ Idle';
    case 'working': return '⚡ Working';
    case 'waiting_approval': return '🔔 Waiting';
    case 'error': return '❌ Error';
    case 'offline': return '○ Offline';
  }
}

/**
 * Format a teammate inbox message for display.
 */
export function formatInboxMessage(msg: InboxMessage): string {
  const time = new Date(msg.timestamp).toLocaleTimeString();
  return `[${time}] ${msg.from}: ${msg.content.slice(0, 80)}`;
}

/**
 * Get a short label for a message type.
 */
export function getMessageTypeLabel(type: string): string {
  switch (type) {
    case 'message': return 'MSG';
    case 'broadcast': return 'BCAST';
    case 'shutdown_request': return 'SHUTDOWN';
    case 'plan_approval_response': return 'PLAN';
    default: return type.toUpperCase().slice(0, 6);
  }
}
