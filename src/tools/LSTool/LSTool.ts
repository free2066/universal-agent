/**
 * LSTool/LSTool.ts — List files and directories
 *
 * Mirrors claude-code's LSTool.ts.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { resolve, relative, join } from 'path';
import type { ToolRegistration } from '../../models/types.js';

export const listFilesTool: ToolRegistration = {
  definition: {
    name: 'LS',
    description: 'List files and directories at a path. Shows file sizes and types.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list (default: current directory)' },
        recursive: { type: 'boolean', description: 'List recursively (default: false)' },
      },
    },
  },
  handler: async (args) => {
    const dirPath = resolve(process.cwd(), (args.path as string) || '.');
    if (!existsSync(dirPath)) return `Error: Path not found: ${dirPath}`;

    const recursive = args.recursive as boolean | undefined;

    function listDir(dir: string, depth: number = 0): string[] {
      const lines: string[] = [];
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return [`${' '.repeat(depth * 2)}(unreadable)`];
      }

      for (const entry of entries) {
        if (entry === 'node_modules' || entry === '.git') continue;
        const full = join(dir, entry);
        try {
          const stat = statSync(full);
          const indent = '  '.repeat(depth);
          const relPath = relative(dirPath, full);
          if (stat.isDirectory()) {
            lines.push(`${indent}📁 ${relPath}/`);
            if (recursive && depth < 3) lines.push(...listDir(full, depth + 1));
          } else {
            const size = stat.size < 1024 ? `${stat.size}B` : `${(stat.size / 1024).toFixed(1)}KB`;
            lines.push(`${indent}📄 ${relPath} (${size})`);
          }
        } catch {
          // Skip unreadable entries (e.g. broken symlinks)
        }
      }
      return lines;
    }

    const lines = listDir(dirPath);
    return lines.join('\n') || '(empty directory)';
  },
};
