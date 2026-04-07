/**
 * services/gitHistory/index.ts — Session history service
 *
 * Mirrors claude-code's services/gitHistory/index.ts.
 * Manages session conversation history storage and retrieval.
 */

export {
  HistoryEntry,
  getSessionId,
  addToHistory,
  removeLastFromHistory,
  getProjectHistory,
  getRecentHistory,
  clearHistory,
} from '../../core/memory/session-history.js';

export {
  SessionSnapshot,
  getProjectSessionsDir,
  saveSnapshot,
  loadSnapshot,
  listAllSnapshots,
  loadLastSnapshot,
  setCustomTitle,
  setAiGeneratedTitle,
  generateSessionTitle,
  maybeCleanOldSessions,
  SearchResult,
  searchSnapshots,
} from '../../core/memory/session-snapshot.js';
