/**
 * types/permissions.ts — Permission types
 *
 * Mirrors claude-code's types/permissions.ts.
 * Re-exports permission types from permission-manager for convenience.
 */

export type {
  ApprovalMode,
  PermissionDecision,
  PermissionDecisionExtended,
  PermissionSettings,
} from '../core/agent/permission-manager.js';

export { matchesPattern } from '../core/agent/permission-manager.js';

// ── Additional permission types ───────────────────────────────────────────────

/** Result of a permission check */
export interface PermissionResult {
  decision: import('../core/agent/permission-manager.js').PermissionDecision;
  reason?: string;
  /** Whether user was prompted for this decision */
  wasPrompted?: boolean;
}

/** Context for permission evaluation */
export interface PermissionContext {
  toolName: string;
  toolArgs: Record<string, unknown>;
  cwd: string;
  approvalMode: import('../core/agent/permission-manager.js').ApprovalMode;
}
