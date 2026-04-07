/**
 * types/hooks.ts — Hook system types
 *
 * Mirrors claude-code's types/hooks.ts.
 * Re-exports hook types from core/hooks for convenient access.
 */

export type {
  HookEvent,
  HookType,
  HookDefinition,
  HooksConfig,
  HookContext,
} from '../core/hooks.js';

// ── Hook callback types ───────────────────────────────────────────────────────

import type { PermissionDecision } from '../core/agent/permission-manager.js';

/** Hook action result */
export interface HookActionResult {
  action: 'continue' | 'block' | 'stop' | 'inject';
  message?: string;
  injectedContent?: string;
  permissionDecision?: PermissionDecision;
}

/** Hook callback matcher (registered via SDK or native plugin) */
export interface HookCallbackMatcher {
  event: import('../core/hooks.js').HookEvent;
  matcher?: string;
  callback: (context: import('../core/hooks.js').HookContext) => Promise<HookActionResult> | HookActionResult;
}
