/**
 * FileReadTool/FileReadTool.ts — Read file contents with optional pagination
 *
 * Mirrors claude-code's FileReadTool.ts.
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { resolve, extname } from 'path';
import type { ToolRegistration } from '../../models/types.js';
import { truncateOutput, TRUNCATE_MAX_LINES } from '../shared/fsHelpers.js';

export const readFileTool: ToolRegistration = {
  definition: {
    name: 'Read',
    description:
      'Read the contents of a file with optional pagination. Returns file content with line numbers. ' +
      'Use offset+limit for large files to avoid context overflow.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute or relative path to the file' },
        start_line: { type: 'number', description: 'Start line number (1-indexed, optional). Alias for offset.' },
        end_line: { type: 'number', description: 'End line number (1-indexed, optional). If omitted reads to file end or limit.' },
        offset: { type: 'number', description: 'First line to read (1-indexed). Takes priority over start_line if both provided.' },
        limit: { type: 'number', description: `Max number of lines to return (default: ${TRUNCATE_MAX_LINES}). Use with offset for pagination.` },
      },
      required: ['file_path'],
    },
  },
  // F19: Expand relative file_path to absolute before hooks/permissions see it
  backfillObservableInput(input) {
    if (typeof input['file_path'] === 'string' && !input['file_path'].startsWith('/')) {
      input['file_path'] = resolve(process.cwd(), input['file_path']);
    }
  },
  handler: async (args) => {
    const filePath = resolve(args.file_path as string);
    if (!existsSync(filePath)) return `Error: File not found: ${filePath}`;
    try {
      const st = statSync(filePath);
      if (st.isDirectory()) {
        return `Error: Path is a directory, not a file: ${filePath}\nUse the LS tool to list directory contents.`;
      }

      // C32: Image file support
      const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico']);
      const ext = extname(filePath).toLowerCase();
      if (IMAGE_EXTS.has(ext)) {
        const MIME_MAP: Record<string, string> = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
          '.ico': 'image/x-icon',
        };
        const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
        if (st.size > MAX_IMAGE_BYTES) {
          return `Error: Image file too large (${(st.size / 1024 / 1024).toFixed(1)}MB). Maximum is 5MB.`;
        }
        const { readFileSync: readBin } = await import('fs');
        const imgData = readBin(filePath);
        const base64 = imgData.toString('base64');
        const mimeType = MIME_MAP[ext] ?? 'image/png';
        return JSON.stringify({
          type: 'image',
          source: { type: 'base64', media_type: mimeType, data: base64 },
          _filePath: filePath,
          _size: st.size,
        });
      }

      const offsetArg = (args.offset as number | undefined) ?? (args.start_line as number | undefined);
      const offset = offsetArg !== undefined ? Math.max(1, offsetArg) : 1;
      const limitArg = args.limit as number | undefined;
      const endLineArg = args.end_line as number | undefined;

      const content = readFileSync(filePath, 'utf-8');
      const allLines = content.split('\n');
      const totalLines = allLines.length;

      const start = offset - 1;
      let end: number;
      if (endLineArg !== undefined) {
        end = Math.min(totalLines, endLineArg);
      } else if (limitArg !== undefined) {
        end = Math.min(totalLines, start + limitArg);
      } else {
        end = Math.min(totalLines, start + TRUNCATE_MAX_LINES);
      }

      const slice = allLines.slice(start, end);
      const result = slice.map((line, i) => `${String(start + i + 1).padStart(6)}│ ${line}`).join('\n');

      const hasMore = end < totalLines;
      if (hasMore) {
        const nextOffset = end + 1;
        return (
          result +
          `\n\n(Showing lines ${offset}-${end} of ${totalLines}. ` +
          `Use offset=${nextOffset} to continue reading.)`
        );
      }

      const { content: final, truncated, removedLines } = truncateOutput(result);
      if (truncated) {
        return final + `\n(${removedLines} additional lines hidden — use offset/limit to paginate)`;
      }
      return result + `\n\n(End of file — ${totalLines} lines total)`;
    } catch (err) {
      return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
