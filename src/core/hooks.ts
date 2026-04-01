/**
 * InternalHooks — lightweight event bus for agent lifecycle events
 *
 * Inspired by openclaw's src/hooks/internal-hooks.ts
 *
 * Allows decoupled components to react to agent/tool events without
 * tight coupling. Used for logging, analytics, and extensibility.
 *
 * Usage:
 *   registerHook('tool:before', async (event) => { ... })
 *   registerHook('tool:after', async (event) => { ... })
 *   registerHook('agent:turn', async (event) => { ... })
 *   await triggerHook({ type: 'tool', action: 'before', ... })
 */

import { createLogger } from './logger.js';

const log = createLogger('hooks');

// ── Types ──────────────────────────────────────────────────────────────────────

export type HookEventType = 'agent' | 'tool' | 'session' | 'model';

export interface HookEvent {
  /** Category of event */
  type: HookEventType;
  /** Specific action: 'turn', 'before', 'after', 'error', 'start', 'end' */
  action: string;
  /** ISO timestamp */
  timestamp: string;
  /** Event-specific payload */
  context: Record<string, unknown>;
  /** Accumulated messages hooks want to surface to the user (optional) */
  messages: string[];
}

export type HookHandler = (event: HookEvent) => Promise<void> | void;

// ── Registry ───────────────────────────────────────────────────────────────────

// Use a module-level map (not global singleton) — sufficient for CLI use case
const handlers = new Map<string, HookHandler[]>();

/**
 * Register a handler for an event key.
 * Key can be either "type" (e.g. "tool") or "type:action" (e.g. "tool:before").
 */
export function registerHook(eventKey: string, handler: HookHandler): void {
  if (!handlers.has(eventKey)) handlers.set(eventKey, []);
  handlers.get(eventKey)!.push(handler);
}

/** Remove a specific handler. */
export function unregisterHook(eventKey: string, handler: HookHandler): void {
  const list = handlers.get(eventKey);
  if (!list) return;
  const idx = list.indexOf(handler);
  if (idx !== -1) list.splice(idx, 1);
  if (list.length === 0) handlers.delete(eventKey);
}

/** Clear all hooks (useful in tests). */
export function clearHooks(): void {
  handlers.clear();
}

/** List registered event keys (for debug). */
export function getRegisteredHookKeys(): string[] {
  return [...handlers.keys()];
}

// ── Trigger ────────────────────────────────────────────────────────────────────

/**
 * Fire all handlers registered for `event.type` and `event.type:event.action`.
 * Errors in handlers are caught and logged — never thrown to the caller.
 */
export async function triggerHook(event: HookEvent): Promise<void> {
  const typeHandlers = handlers.get(event.type) ?? [];
  const specificHandlers = handlers.get(`${event.type}:${event.action}`) ?? [];
  const all = [...typeHandlers, ...specificHandlers];
  if (all.length === 0) return;

  for (const handler of all) {
    try {
      await handler(event);
    } catch (err) {
      log.error(`Hook error [${event.type}:${event.action}]: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ── Factory ────────────────────────────────────────────────────────────────────

export function createHookEvent(
  type: HookEventType,
  action: string,
  context: Record<string, unknown> = {},
): HookEvent {
  return {
    type,
    action,
    timestamp: new Date().toISOString(),
    context,
    messages: [],
  };
}

// ── Built-in hooks ─────────────────────────────────────────────────────────────

// Performance timing hook for tool calls
const toolTimings = new Map<string, number>();

registerHook('tool:before', (event) => {
  const callId = event.context.callId as string | undefined;
  if (callId) toolTimings.set(callId, Date.now());
  log.debug(`Tool start: ${event.context.toolName as string}`, {
    args: JSON.stringify(event.context.args).slice(0, 120),
  });
});

registerHook('tool:after', (event) => {
  const callId = event.context.callId as string | undefined;
  const start = callId ? toolTimings.get(callId) : undefined;
  const durationMs = start ? Date.now() - start : undefined;
  if (callId) toolTimings.delete(callId);
  log.debug(`Tool done: ${event.context.toolName as string}`, {
    ...(durationMs !== undefined && { durationMs }),
    success: event.context.success,
  });
});

registerHook('tool:error', (event) => {
  // Clean up timing entry to prevent Map growth on long-running sessions (b6 fix).
  // tool:after is NOT fired when a tool throws, so we must clean here too.
  const callId = event.context.callId as string | undefined;
  if (callId) toolTimings.delete(callId);
  log.warn(`Tool error: ${event.context.toolName as string} — ${event.context.error as string}`);
});

registerHook('agent:turn', (event) => {
  const iter = event.context.iteration as number | undefined;
  log.debug(`Agent turn ${iter ?? '?'}: model=${event.context.model as string}`);
});

registerHook('agent:compact', (event) => {
  log.info(`Auto-compact: ${event.context.compacted} turns → 1 summary`);
});

registerHook('session:start', (event) => {
  log.info(`Session start: domain=${event.context.domain as string}, model=${event.context.model as string}`);
});
