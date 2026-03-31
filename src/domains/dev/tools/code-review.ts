import type { ToolRegistration } from '../../../models/types.js';

export const codeReviewTool: ToolRegistration = {
  definition: {
    name: 'review_code',
    description: 'Review code for bugs, security issues, performance problems, and style improvements',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The code to review' },
        language: {
          type: 'string',
          description: 'Programming language (python, javascript, typescript, java, go, rust, etc.)',
        },
        focus: {
          type: 'string',
          description: 'Focus area: bugs | security | performance | style | all',
          enum: ['bugs', 'security', 'performance', 'style', 'all'],
        },
      },
      required: ['code'],
    },
  },
  handler: async (args) => {
    const { code, language = 'unknown', focus = 'all' } = args as {
      code: string;
      language: string;
      focus: string;
    };

    const lines = code.split('\n').length;
    const chars = code.length;

    // Return context for LLM to analyze
    return {
      code_stats: {
        lines,
        characters: chars,
        language,
        focus_area: focus,
      },
      checklist: getReviewChecklist(focus),
      instruction: `Review this ${language} code focusing on: ${focus}\n\n\`\`\`${language}\n${code}\n\`\`\``,
    };
  },
};

function getReviewChecklist(focus: string): string[] {
  const checklists: Record<string, string[]> = {
    bugs: [
      'Check for null/undefined dereferences',
      'Check for off-by-one errors',
      'Check for infinite loops',
      'Check for unhandled edge cases',
    ],
    security: [
      'Check for SQL injection vulnerabilities',
      'Check for XSS vulnerabilities',
      'Check for hardcoded secrets',
      'Check for insecure deserialization',
    ],
    performance: [
      'Check for unnecessary loops (O(n²) or worse)',
      'Check for repeated DB queries in loops',
      'Check for memory leaks',
      'Check for blocking I/O in async code',
    ],
    style: [
      'Check naming conventions',
      'Check function length (single responsibility)',
      'Check for code duplication',
      'Check for missing documentation',
    ],
  };

  if (focus === 'all') {
    return Object.values(checklists).flat();
  }
  return checklists[focus] || checklists.bugs;
}
