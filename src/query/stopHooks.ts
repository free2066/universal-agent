/**
 * query/stopHooks.ts — Stop hook evaluation for agent loop
 *
 * Mirrors claude-code's query/stopHooks.ts.
 * Provides utilities for evaluating hooks that can stop the agent loop.
 */

export {
  HookEvent,
  HookType,
  HookDefinition,
  HooksConfig,
  HookContext,
  HookRunner,
  getHookRunner,
  reloadHooks,
  emitHook,
  createHookEvent,
  triggerHook,
} from '../core/hooks.js';
