/**
 * services/permissions/index.ts — Permission management service
 *
 * Mirrors claude-code's services/permissions/index.ts.
 * Centralizes tool approval, rule matching, and approval mode enforcement.
 */

export {
  ApprovalMode,
  PermissionDecision,
  PermissionDecisionExtended,
  PermissionSettings,
  matchesPattern,
  PermissionManager,
  clearSpeculativeChecks,
  clearClassifierApprovals,
  READ_TOOLS,
  getPermissionManager,
  getUserSetting,
  getMergedEnv,
  getCleanupPeriodDays,
} from '../../core/agent/permission-manager.js';
