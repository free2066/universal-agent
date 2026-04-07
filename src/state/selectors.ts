/**
 * state/selectors.ts — State selectors
 *
 * Mirrors claude-code's state/selectors.ts.
 * Provides derived state computations from the application state.
 */

import { getFullState } from '../bootstrap/state.js';

// ── Selectors ─────────────────────────────────────────────────────────────────

export function selectIsInteractive(): boolean {
  return getFullState().isInteractive;
}

export function selectActiveModel(): string | undefined {
  return getFullState().activeModelId;
}

export function selectActiveDomain(): string | undefined {
  return getFullState().activeDomain;
}

export function selectTotalCost(): number {
  return getFullState().totalCostUSD;
}

export function selectSessionUptime(): number {
  return Date.now() - getFullState().startTime;
}

export function selectCwd(): string {
  return getFullState().cwd;
}

export function selectProjectRoot(): string {
  return getFullState().projectRoot;
}
