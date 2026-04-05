/**
 * SyntheticOutputTool — structured JSON output generation
 *
 * Allows the agent to emit a validated, structured response that callers
 * can parse reliably (e.g. CI pipelines, automation scripts, sub-agents).
 *
 * Usage: agent calls `synthetic_output` with { schema, data } where:
 *   - schema  (optional): JSON Schema string describing expected shape
 *   - data    : the actual structured payload (object or array)
 *   - label   (optional): a human-readable label for the output
 *
 * The tool writes the output to:
 *   1. stdout as a fenced JSON block (visible in REPL)
 *   2. .uagent/output/latest.json (last output file)
 *   3. .uagent/output/<timestamp>-<label>.json (timestamped archive)
 *
 * Inspired by claude-code's SyntheticOutputTool for structured agent output.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import type { ToolRegistration } from '../../../models/types.js';

const OUTPUT_DIR_NAME = join('.uagent', 'output');

function getOutputDir(cwd: string): string {
  return resolve(cwd, OUTPUT_DIR_NAME);
}

function sanitizeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
}

export const syntheticOutputTool: ToolRegistration = {
  definition: {
    name: 'synthetic_output',
    description:
      'Emit a structured JSON output that can be consumed by external programs, ' +
      'automation scripts, or parent agents. The output is written to ' +
      '.uagent/output/latest.json and archived with a timestamp. ' +
      'Use this when the task requires a machine-readable result (e.g. a list of issues, ' +
      'a summary object, analysis results) rather than free-form text.',
    parameters: {
      type: 'object',
      properties: {
        data: {
          type: 'object' as const,
          description: 'The structured payload to output (object or array). Must be JSON-serializable.',
        },
        label: {
          type: 'string',
          description: 'Short label for the output (used in filename). Default: "output".',
        },
        schema: {
          type: 'string',
          description:
            'Optional JSON Schema string describing the expected shape of data. ' +
            'Used for documentation; the tool does not enforce the schema at runtime.',
        },
      },
      required: ['data'],
    },
  },

  handler: async (args: Record<string, unknown>): Promise<string> => {
    const data = args.data;
    const label = typeof args.label === 'string' && args.label.trim()
      ? sanitizeLabel(args.label.trim())
      : 'output';
    const schema = typeof args.schema === 'string' ? args.schema : undefined;

    if (data === undefined || data === null) {
      return 'Error: data is required and must be a JSON-serializable value.';
    }

    let jsonStr: string;
    try {
      jsonStr = JSON.stringify(data, null, 2);
    } catch (err) {
      return `Error: data is not JSON-serializable: ${err instanceof Error ? err.message : String(err)}`;
    }

    // ── Persist to disk ────────────────────────────────────────────────────────
    const cwd = process.cwd();
    const outputDir = getOutputDir(cwd);
    try {
      mkdirSync(outputDir, { recursive: true, mode: 0o700 });

      // latest.json — always overwrite
      writeFileSync(join(outputDir, 'latest.json'), jsonStr + '\n', { encoding: 'utf-8', mode: 0o600 });

      // timestamped archive
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      writeFileSync(join(outputDir, `${ts}-${label}.json`), jsonStr + '\n', { encoding: 'utf-8', mode: 0o600 });
    } catch (err) {
      // Disk write failure should not prevent returning the data
      console.error(`[synthetic_output] Warning: failed to write output file: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── Format human-readable response ────────────────────────────────────────
    const lines: string[] = [];
    lines.push(`Structured output (${label}):`);
    lines.push('');
    lines.push('```json');
    lines.push(jsonStr);
    lines.push('```');
    lines.push('');
    lines.push(`Saved to: ${join(OUTPUT_DIR_NAME, 'latest.json')}`);
    if (schema) {
      lines.push('');
      lines.push('Schema:');
      lines.push('```json');
      lines.push(schema);
      lines.push('```');
    }

    return lines.join('\n');
  },
};
