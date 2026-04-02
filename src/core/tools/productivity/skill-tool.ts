/**
 * Skill Tools — Two paradigm execution (kstack article #15366)
 *
 * Implements "Skill as Prompt" vs "Skill as Program" dual paradigm:
 *
 * 1. load_skill (Prompt Paradigm — original behavior)
 *    Returns the SKILL.md body as text injected into LLM context.
 *    The MODEL decides how to execute — high flexibility, good for reasoning/generation.
 *    Use when: degrees_of_freedom=high|medium, understanding/strategy tasks.
 *
 * 2. run_skill (Program Paradigm — new)
 *    The SYSTEM executes steps in sequence with completion gates.
 *    The MODEL executes each isolated step; system controls progression.
 *    Use when: mode=program, degrees_of_freedom=low, multi-step flows, strict sequences.
 *
 * Core insight (kstack #15366):
 *   "让 Prompt 负责理解世界，让 Program 负责改变世界"
 *   Don't let the model decide when a task is done — the system decides.
 *
 * s05 motto: "Load knowledge when you need it, not upfront"
 */

import type { ToolRegistration } from '../../../models/types.js';
import { getSkillLoader, ProgramSkillRunner, formatProgramSkillResult } from '../../skills/skill-loader.js';

// ─── Tool 1: load_skill (Prompt Paradigm) ────────────────────────────────────

export const loadSkillTool: ToolRegistration = {
  definition: {
    name: 'load_skill',
    description: [
      'Load specialized domain knowledge by skill name (Prompt Paradigm — kstack #15366).',
      'Returns the full skill body as text for the model to interpret and follow.',
      'For "prompt" mode skills: injects instructions into context for model-driven execution.',
      'For "program" mode skills: returns the structured step plan and instructs you to call run_skill instead.',
      'Available skills are listed in the system prompt under "Available Skills".',
      'If a skill shows [PROGRAM] badge, use run_skill() for system-controlled step execution.',
    ].join('\n'),
    parameters: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Skill name to load (e.g. "pdf-processing", "code-review", "page-explorer").',
        },
      },
      required: ['name'],
    },
  },

  handler: async (args: Record<string, unknown>): Promise<string> => {
    const name = args.name as string;
    if (!name || typeof name !== 'string') {
      return 'Error: "name" parameter is required.';
    }
    const loader = getSkillLoader(process.cwd());
    return loader.getContent(name.trim());
  },
};

// ─── Tool 2: run_skill (Program Paradigm) ────────────────────────────────────

export const runSkillTool: ToolRegistration = {
  definition: {
    name: 'run_skill',
    description: [
      'Execute a program-mode skill with system-controlled step execution (kstack #15366).',
      '',
      'Unlike load_skill (which returns text for the MODEL to interpret),',
      'run_skill is the "Skill as Program" execution engine:',
      '  - System code advances through each step in order',
      '  - Each step has a completion_gate — model cannot skip or combine steps',
      '  - Final completion gate checked before reporting success',
      '  - Prevents: early exits, silent skips, fake completion',
      '',
      'Use this tool when:',
      '  - The skill shows [PROGRAM] badge in the available skills list',
      '  - load_skill() tells you to call run_skill() instead',
      '  - The task requires strict sequential execution with no model drift',
      '  - degrees_of_freedom is "low" (strict sequence, no alternative paths)',
      '',
      'Returns: per-step outputs, execution log, and final status.',
    ].join('\n'),
    parameters: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Skill name to execute (must be a program-mode skill).',
        },
        context: {
          type: 'string',
          description: [
            'Optional additional context to inject into all steps.',
            'Use to provide task-specific information beyond the skill body.',
            'Example: target URL, file path, or current task description.',
          ].join('\n'),
        },
        project_root: {
          type: 'string',
          description: 'Project root directory. Defaults to current working directory.',
        },
      },
      required: ['name'],
    },
  },

  handler: async (args: Record<string, unknown>): Promise<string> => {
    const name = args.name as string;
    const context = args.context as string | undefined;
    const projectRoot = (args.project_root as string | undefined) ?? process.cwd();

    if (!name || typeof name !== 'string') {
      return 'Error: "name" parameter is required.';
    }

    const loader = getSkillLoader(projectRoot);
    const skill = loader.getSkill(name.trim());

    if (!skill) {
      const available = loader.listNames().join(', ') || '(none)';
      return `Error: Unknown skill '${name}'. Available skills: ${available}`;
    }

    // Guard: warn if used with a prompt-mode skill
    if (skill.meta.mode !== 'program') {
      const dof = skill.meta.degrees_of_freedom;
      const warning = dof === 'high' || !dof
        ? `⚠️  Skill "${name}" is mode=prompt (degrees_of_freedom=${dof ?? 'unset'}). ` +
          `Consider using load_skill() instead for better model flexibility.\n\n`
        : '';

      // Still run it if it has steps defined (graceful fallback)
      if (!skill.meta.steps || skill.meta.steps.length === 0) {
        return (
          `${warning}Skill "${name}" has no steps defined for program execution. ` +
          `Use load_skill("${name}") to load it as a prompt-mode skill instead.`
        );
      }
    }

    // Check steps exist
    const steps = skill.meta.steps ?? [];
    if (steps.length === 0) {
      return (
        `Error: Skill "${name}" has mode=program but no steps defined in SKILL.md frontmatter.\n\n` +
        `Add steps like:\n` +
        `\`\`\`yaml\n` +
        `steps:\n` +
        `  - id: step1\n` +
        `    prompt: "Do something specific"\n` +
        `    required_output: "result"\n` +
        `\`\`\``
      );
    }

    // Run the program skill
    const runner = new ProgramSkillRunner(skill, projectRoot);
    const result = await runner.run(context);

    return formatProgramSkillResult(name, result);
  },
};
