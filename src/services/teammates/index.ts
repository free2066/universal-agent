/**
 * services/teammates/index.ts — Teammate (swarm) management service
 *
 * Mirrors claude-code's services/teammates/index.ts.
 * Manages spawning, messaging, and lifecycle of teammate agents.
 */

export {
  VALID_MSG_TYPES,
  InboxMessage,
  MessageBus,
  TeammateConfig,
  TeammateManager,
  getTeammateManager,
  spawnTeammateTool,
  listTeammatesTool,
  sendMessageTool,
  readInboxTool,
  broadcastTool,
  shutdownRequestTool,
  planApprovalTool,
  claimTaskFromBoardTool,
} from '../../core/teammate-manager.js';
