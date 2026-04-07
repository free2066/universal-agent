/**
 * services/sessionMemory/index.ts — Session memory management service
 *
 * Mirrors claude-code's services/sessionMemory/index.ts.
 * Manages per-session conversation memory (10-chapter rolling summaries).
 */

export {
  SM_MINIMUM_TOKENS_TO_INIT,
  SM_MINIMUM_TOKENS_BETWEEN_UPDATE,
  SM_TOOL_CALLS_BETWEEN_UPDATES,
  SessionMemoryState,
  resetSessionMemory,
  getSessionMemoryState,
  buildSessionMemory,
  shouldUpdateSessionMemory,
  updateSessionMemory,
  trySessionMemoryCompaction,
} from '../../core/memory/session-memory.js';
