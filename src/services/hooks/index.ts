/**
 * services/hooks/index.ts — Hook system service
 *
 * Mirrors claude-code's services/hooks/index.ts.
 * Provides the lifecycle hook execution service.
 */

export {
  HookEvent,
  HookType,
  HookDefinition,
  HooksConfig,
  HookContext,
  HookResult,
  HookRunner,
  InternalHookDomain,
  InternalHookAction,
  InternalHookEvent,
  NotificationHookContext,
  mergePermissionDecisions,
  createHookEvent,
  triggerHook,
  getHookRunner,
  reloadHooks,
  emitHook,
  fireFileChanged,
  maybeFireCwdChanged,
  executeNotificationHooks,
} from '../../core/hooks.js';
