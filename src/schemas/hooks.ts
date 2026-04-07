/**
 * schemas/hooks.ts — Hook configuration schema
 *
 * Mirrors claude-code's schemas/hooks.ts.
 * Provides validation schema for hooks configuration.
 */

import type { HookDefinition, HooksConfig, HookEvent, HookType } from '../core/hooks.js';

// ── Valid values ──────────────────────────────────────────────────────────────

export const VALID_HOOK_EVENTS: HookEvent[] = [
  'pre_prompt',
  'post_response',
  'on_tool_call',
  'on_slash_cmd',
  'on_session_end',
  'on_file_change',
  'pre_compact',
  'post_compact',
  'session_restore',
  'model_switch',
  'tool_permission_request',
  'worktree_create',
  'worktree_remove',
  'memory_ingest',
  'subagent_start',
  'subagent_stop',
  'task_create',
  'task_complete',
  'cwd_change',
  'domain_switch',
  'thinking_change',
  'agent_stop',
  'agent_stop_failure',
  'notification',
  'instructions_loaded',
  'tool_pre_use',
  'tool_post_use',
  'tool_use_failure',
  'user_prompt_submit',
  'permission_request',
  'permission_denied',
  'setup',
  'elicitation',
  'elicitation_result',
  'config_change',
];

export const VALID_HOOK_TYPES: HookType[] = [
  'shell',
  'inject',
  'block',
  'module',
  'http',
  'agent',
];

// ── Validation ────────────────────────────────────────────────────────────────

export interface ValidationError {
  field: string;
  message: string;
}

export function validateHookDefinition(hook: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  if (typeof hook !== 'object' || hook === null) {
    errors.push({ field: 'hook', message: 'Must be an object' });
    return errors;
  }
  const h = hook as Record<string, unknown>;

  if (!h['event'] || !VALID_HOOK_EVENTS.includes(h['event'] as HookEvent)) {
    errors.push({ field: 'event', message: `Must be one of: ${VALID_HOOK_EVENTS.join(', ')}` });
  }

  if (!h['type'] || !VALID_HOOK_TYPES.includes(h['type'] as HookType)) {
    errors.push({ field: 'type', message: `Must be one of: ${VALID_HOOK_TYPES.join(', ')}` });
  }

  if (h['type'] === 'shell' && !h['command_line']) {
    errors.push({ field: 'command_line', message: 'Required for shell hooks' });
  }

  if (h['type'] === 'http' && !h['url']) {
    errors.push({ field: 'url', message: 'Required for http hooks' });
  }

  if (h['type'] === 'agent' && !h['agent_prompt']) {
    errors.push({ field: 'agent_prompt', message: 'Required for agent hooks' });
  }

  return errors;
}

export function validateHooksConfig(config: unknown): { valid: boolean; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  if (typeof config !== 'object' || config === null) {
    return { valid: false, errors: [{ field: 'config', message: 'Must be an object' }] };
  }
  const c = config as Record<string, unknown>;
  if (!Array.isArray(c['hooks'])) {
    return { valid: false, errors: [{ field: 'hooks', message: 'Must be an array' }] };
  }
  for (let i = 0; i < c['hooks'].length; i++) {
    const hookErrors = validateHookDefinition(c['hooks'][i]);
    errors.push(...hookErrors.map(e => ({ ...e, field: `hooks[${i}].${e.field}` })));
  }
  return { valid: errors.length === 0, errors };
}
