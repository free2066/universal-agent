import { execSync } from 'child_process';
import type { ToolRegistration } from '../../../models/types.js';

export const codeExecuteTool: ToolRegistration = {
  definition: {
    name: 'run_code_snippet',
    description: 'Execute a small code snippet and return the output (Python or Node.js)',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Code snippet to execute' },
        language: {
          type: 'string',
          description: 'Language: python | node',
          enum: ['python', 'node'],
        },
      },
      required: ['code', 'language'],
    },
  },
  handler: async (args) => {
    const { code, language } = args as { code: string; language: string };

    // Safety check: block dangerous patterns
    const dangerous = [
      /rm\s+-rf/,
      /os\.system/,
      /subprocess/,
      /exec\s*\(/,
      /eval\s*\(/,
      /require\s*\(\s*['"]child_process/,
      /process\.exit/,
    ];

    for (const pattern of dangerous) {
      if (pattern.test(code)) {
        return { error: 'Blocked: Code contains potentially dangerous patterns' };
      }
    }

    try {
      let output: string;

      if (language === 'python') {
        const escaped = code.replace(/'/g, "'\"'\"'");
        output = execSync(`python3 -c '${escaped}'`, {
          timeout: 10000,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
        });
      } else {
        const escaped = code.replace(/`/g, '\\`');
        output = execSync(`node -e \`${escaped}\``, {
          timeout: 10000,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
        });
      }

      return { output: output.trim(), language };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
        language,
      };
    }
  },
};
