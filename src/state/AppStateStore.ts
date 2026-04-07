/**
 * state/AppStateStore.ts — Application state store
 *
 * Mirrors claude-code's state/AppStateStore.ts.
 * Provides a centralized store for reactive state management.
 */

import {
  getFullState,
  setCwd,
  setActiveModelId,
  setActiveDomain,
  setIsInteractive,
  addToTotalCost,
  updateLastInteractionTime,
  addToAPIDuration,
  addToToolDuration,
  type SessionId,
} from '../bootstrap/state.js';

// ── Change listeners ──────────────────────────────────────────────────────────

type StateChangeListener = (field: string, newValue: unknown) => void;

const listeners: StateChangeListener[] = [];

export function onStateChange(listener: StateChangeListener): () => void {
  listeners.push(listener);
  return () => {
    const idx = listeners.indexOf(listener);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

function notify(field: string, value: unknown): void {
  for (const l of listeners) {
    try { l(field, value); } catch { /* never break state */ }
  }
}

// ── Store methods ─────────────────────────────────────────────────────────────

export const AppStateStore = {
  getCwd(): string {
    return getFullState().cwd;
  },

  setCwd(cwd: string): void {
    setCwd(cwd);
    notify('cwd', cwd);
  },

  getActiveModelId(): string | undefined {
    return getFullState().activeModelId;
  },

  setActiveModelId(model: string | undefined): void {
    setActiveModelId(model);
    notify('activeModelId', model);
  },

  getActiveDomain(): string | undefined {
    return getFullState().activeDomain;
  },

  setActiveDomain(domain: string | undefined): void {
    setActiveDomain(domain);
    notify('activeDomain', domain);
  },

  isInteractive(): boolean {
    return getFullState().isInteractive;
  },

  setInteractive(v: boolean): void {
    setIsInteractive(v);
    notify('isInteractive', v);
  },

  getTotalCostUSD(): number {
    return getFullState().totalCostUSD;
  },

  addCost(usd: number): void {
    addToTotalCost(usd);
    notify('totalCostUSD', getFullState().totalCostUSD);
  },

  addAPIDuration(ms: number): void {
    addToAPIDuration(ms);
  },

  addToolDuration(ms: number): void {
    addToToolDuration(ms);
  },

  touchLastInteraction(): void {
    updateLastInteractionTime();
  },

  getSessionId(): SessionId {
    return getFullState().sessionId;
  },

  getStartTime(): number {
    return getFullState().startTime;
  },
};
