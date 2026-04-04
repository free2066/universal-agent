import { spawnSync } from 'child_process';
import type { ToolRegistration } from '../../../models/types.js';

// CWE-78 fix: use spawnSync with argument arrays instead of execSync + string interpolation.
// Code is passed via stdin (python3 -c / node -e flags omitted in favour of stdin pipe),
// which avoids ALL shell quoting issues entirely.
const CODE_EXECUTE_TIMEOUT_MS = 10_000;
const CODE_EXECUTE_MAX_BUFFER = 1024 * 1024; // 1 MB

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
      let result: ReturnType<typeof spawnSync>;

      if (language === 'python') {
        // Pass code via stdin: echo '<code>' | python3
        // Using spawnSync with input option avoids any shell quoting issues.
        result = spawnSync('python3', [], {
          input: code,
          encoding: 'utf-8',
          timeout: CODE_EXECUTE_TIMEOUT_MS,
          maxBuffer: CODE_EXECUTE_MAX_BUFFER,
        });
      } else {
        // Node.js: pass code via stdin using --input-type=module or default CJS
        result = spawnSync('node', ['--input-type=commonjs'], {
          input: code,
          encoding: 'utf-8',
          timeout: CODE_EXECUTE_TIMEOUT_MS,
          maxBuffer: CODE_EXECUTE_MAX_BUFFER,
        });
      }

      if (result.error) {
        return { error: result.error.message, language };
      }

      if (result.status !== 0) {
        const stderr = (result.stderr as string ?? '').trim();
        return {
          error: stderr || `Process exited with code ${result.status}`,
          language,
        };
      }

      return { output: (result.stdout as string ?? '').trim(), language };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
        language,
      };
    }
  },
};
