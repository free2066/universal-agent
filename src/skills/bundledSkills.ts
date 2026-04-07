/**
 * skills/bundledSkills.ts — Built-in skill definitions
 *
 * Mirrors claude-code's skills/bundledSkills.ts.
 * Registers built-in skills that ship with universal-agent.
 */

export interface BundledSkill {
  name: string;
  description: string;
  /** Skill content (inline, not loaded from file) */
  content: string;
  tags?: string[];
}

export const BUNDLED_SKILLS: BundledSkill[] = [
  {
    name: 'code-inspector',
    description: 'Analyze and inspect code structure, dependencies, and quality metrics.',
    tags: ['code', 'analysis', 'inspection'],
    content: `# Code Inspector Skill
Analyze code structure, identify patterns, and provide quality assessments.
Use InspectCode tool for deep structural analysis.`,
  },
  {
    name: 'prd-split',
    description: 'Split a PRD (Product Requirements Document) into actionable development tasks.',
    tags: ['product', 'planning', 'tasks'],
    content: `# PRD Split Skill
Break down product requirements into actionable development tasks.
1. Identify core features and components
2. Estimate complexity for each component
3. Create task list with dependencies`,
  },
  {
    name: 'self-purify',
    description: 'Analyze and fix code quality issues, remove dead code, and improve structure.',
    tags: ['code', 'cleanup', 'quality'],
    content: `# Self-Purify Skill
Systematically improve code quality by:
1. Identifying and removing dead code
2. Fixing linting errors
3. Improving naming and structure
4. Removing unused imports`,
  },
];

/**
 * Get a bundled skill by name.
 */
export function getBundledSkill(name: string): BundledSkill | undefined {
  return BUNDLED_SKILLS.find(s => s.name === name);
}
