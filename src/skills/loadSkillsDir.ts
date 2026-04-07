/**
 * skills/loadSkillsDir.ts — Skill directory loader
 *
 * Mirrors claude-code's skills/loadSkillsDir.ts.
 * Re-exports skill loading functionality from core/skills/skill-loader.ts.
 */

export {
  ProgramSkillStep,
  StateMachine,
  SkillMeta,
  Skill,
  SkillLoader,
  ProgramSkillRunner,
  ProgramSkillResult,
  formatProgramSkillResult,
  getSkillLoader,
} from '../core/skills/skill-loader.js';
