/**
 * services/agentSpawn/index.ts — Agent spawning service
 *
 * Mirrors claude-code's services/agentSpawn/index.ts.
 * Manages subagent lifecycle, task delegation, and spawning.
 */

export {
  SubagentDef,
  SubagentSystem,
  createTaskTool,
  askExpertModelTool,
  subagentSystem,
} from '../../core/subagent-system.js';
