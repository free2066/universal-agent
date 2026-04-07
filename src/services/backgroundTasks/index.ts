/**
 * services/backgroundTasks/index.ts — Background task execution service
 *
 * Mirrors claude-code's services/backgroundTasks/index.ts.
 * Provides non-blocking command execution with notification queue.
 */

export {
  BgTaskStatus,
  BgTask,
  BgNotification,
  BackgroundManager,
  backgroundManager,
} from '../../core/background-manager.js';
