/**
 * state/onChangeAppState.ts — State change reactor
 *
 * Mirrors claude-code's state/onChangeAppState.ts.
 * Provides subscription to application state changes.
 */

import { onStateChange } from './AppStateStore.js';

// Re-export onStateChange for external use
export { onStateChange };

// ── Specific field change subscriptions ───────────────────────────────────────

type FieldChangeListener<T> = (newValue: T) => void;

/**
 * Subscribe to changes in a specific state field.
 * Returns an unsubscribe function.
 */
export function onFieldChange<T>(
  field: string,
  listener: FieldChangeListener<T>,
): () => void {
  return onStateChange((changedField, value) => {
    if (changedField === field) {
      listener(value as T);
    }
  });
}

/**
 * Subscribe to model changes.
 */
export function onModelChange(listener: FieldChangeListener<string | undefined>): () => void {
  return onFieldChange<string | undefined>('activeModelId', listener);
}

/**
 * Subscribe to domain changes.
 */
export function onDomainChange(listener: FieldChangeListener<string | undefined>): () => void {
  return onFieldChange<string | undefined>('activeDomain', listener);
}

/**
 * Subscribe to cwd changes.
 */
export function onCwdChange(listener: FieldChangeListener<string>): () => void {
  return onFieldChange<string>('cwd', listener);
}
