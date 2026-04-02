/**
 * load_skill — s05-style on-demand knowledge injection.
 *
 * Layer 1 is handled by context-loader.ts (skill descriptions injected into system prompt).
 * Layer 2 is this tool: when the agent calls load_skill(name), the full SKILL.md body
 * is returned in the tool_result — it is NOT in the system prompt upfront.
 *
 * Motto: "Load knowledge when you need it, not upfront"
 */

import type { ToolRegistration } from '../../models/types.js';
import { getSkillLoader } from '../skill-loader.js';

export const loadSkillTool: ToolRegistration = {
  definition: {
    name: 'load_skill',
    description: [
      'Load specialized domain knowledge by skill name.',
      'Use this tool BEFORE tackling unfamiliar topics, frameworks, or workflows.',
      'Available skills are listed in the system prompt under "Available Skills".',
      'Returns the full skill guide as structured instructions.',
    ].join(' '),
    parameters: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Skill name to load (e.g. "pdf-processing", "code-review").',
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
