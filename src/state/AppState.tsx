/**
 * state/AppState.tsx — Global application state context
 *
 * Mirrors claude-code's state/AppState.tsx.
 * Provides the app-level state (session info, model, domain, etc.)
 * exposed via context to all components.
 */

import { getFullState } from '../bootstrap/state.js';
import type { SessionId } from '../bootstrap/state.js';

// ── AppState interface ────────────────────────────────────────────────────────

export interface AppStateData {
  sessionId: SessionId;
  cwd: string;
  projectRoot: string;
  isInteractive: boolean;
  isRemoteMode: boolean;
  totalCostUSD: number;
  activeModelId: string | undefined;
  activeDomain: string | undefined;
  startTime: number;
  lastInteractionTime: number;
}

// ── AppState accessor ─────────────────────────────────────────────────────────

export class AppState {
  static get(): AppStateData {
    const s = getFullState();
    return {
      sessionId: s.sessionId,
      cwd: s.cwd,
      projectRoot: s.projectRoot,
      isInteractive: s.isInteractive,
      isRemoteMode: s.isRemoteMode,
      totalCostUSD: s.totalCostUSD,
      activeModelId: s.activeModelId,
      activeDomain: s.activeDomain,
      startTime: s.startTime,
      lastInteractionTime: s.lastInteractionTime,
    };
  }
}
