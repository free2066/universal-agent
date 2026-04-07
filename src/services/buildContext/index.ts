/**
 * services/buildContext/index.ts — Context building service
 *
 * Mirrors claude-code's services/buildContext/index.ts.
 * Orchestrates assembling the full LLM system prompt and context.
 */

export {
  AgentsContext,
  loadProjectContext,
  loadRules,
  buildSystemPromptWithContext,
  initAgentsMd,
} from '../../core/context/context-loader.js';

export {
  AUTO_COMPACT_DISABLED,
  CompactDecision,
  TokenWarningState,
  CompactionResult,
  CompactProgressEventType,
  CompactProgressEventCallback,
  estimateMessageTokens,
  estimateHistoryTokens,
  calculateTokenWarningState,
  shouldCompact,
  autoCompact,
  reactiveCompact,
  resetCompactCircuitBreaker,
  snipCompactIfNeeded,
  getMessagesAfterCompactBoundary,
  isCompactBoundaryMessage,
} from '../../core/context/context-compressor.js';
