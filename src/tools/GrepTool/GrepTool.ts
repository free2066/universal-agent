/**
 * GrepTool/GrepTool.ts — Search for patterns in files using regex
 *
 * Mirrors claude-code's GrepTool.ts.
 */

import { execSync } from 'child_process';
import { statSync as fsStat } from 'fs';
import { resolve } from 'path';
import type { ToolRegistration } from '../../models/types.js';
import { mmrRerankGrepResults } from '../../core/memory/mmr.js';

export const grepTool: ToolRegistration = {
  definition: {
    name: 'Grep',
    description: 'Search for a pattern in files using regex. Returns matching lines with file:line context.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'Directory or file to search in (default: current directory)' },
        file_pattern: { type: 'string', description: 'File glob pattern like *.ts, *.py (optional)' },
        case_sensitive: { type: 'boolean', description: 'Case sensitive search (default: true)' },
      },
      required: ['pattern'],
    },
  },
  handler: async (args) => {
    const searchPath = resolve(process.cwd(), (args.path as string) || '.');
    const pattern = args.pattern as string;
    const filePattern = args.file_pattern as string | undefined;
    const caseFlag = args.case_sensitive === false ? '-i' : '';
    const escapedFilePattern = filePattern ? filePattern.replace(/'/g, "'\"'\"'") : '';
    const includeFlag = escapedFilePattern ? `--include='${escapedFilePattern}'` : '';
    const escapedSearchPath = searchPath.replace(/'/g, "'\"'\"'");

    if (pattern.length > 500) {
      return `Error: Pattern too long (${pattern.length} chars, max 500). Simplify your regex.`;
    }
    if (filePattern && filePattern.length > 200) {
      return `Error: File pattern too long (${filePattern.length} chars, max 200).`;
    }
    if (/^\.[*+]$/.test(pattern)) {
      return `Error: Pattern "${pattern}" is too broad and would match everything.`;
    }

    try {
      new RegExp(pattern);
    } catch (regexErr) {
      return `Error: Invalid regular expression pattern: ${regexErr instanceof Error ? regexErr.message : String(regexErr)}\n  Pattern: ${pattern}`;
    }

    const MAX_GREP_RESULTS = 100;
    const MAX_GREP_LINE_LENGTH = 2000;
    const GREP_TIMEOUT_MS = 15000;

    try {
      const escapedPattern = pattern.replace(/'/g, "'\"'\"'");
      const cmd = [
        'grep', '-rn', caseFlag, includeFlag,
        '--exclude-dir=node_modules', '--exclude-dir=.git',
        '--exclude-dir=dist', '--exclude-dir=.next', '--exclude-dir=.cache',
        '-E', `'${escapedPattern}'`,
        `'${escapedSearchPath}'`,
        '2>/dev/null',
      ].filter(Boolean).join(' ');

      const raw = execSync(cmd, { encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024, timeout: GREP_TIMEOUT_MS }).trim();
      if (!raw) return `No matches found for pattern: ${pattern}`;

      interface GrepMatch { file: string; line: number; content: string; mtime: number; }
      const rawLines = raw.split('\n');
      const allMatches: GrepMatch[] = [];
      for (const ln of rawLines) {
        if (!ln) continue;
        const m = ln.match(/^(.+?):(\d+):(.*)/);
        if (!m) continue;
        let mtime = 0;
        try { mtime = fsStat(m[1]).mtimeMs; } catch { /* ignore */ }
        allMatches.push({ file: m[1], line: parseInt(m[2], 10), content: m[3], mtime });
      }

      const totalMatches = allMatches.length;
      const mmrEnabled = process.env.AGENT_MMR !== '0';
      const grepResults = allMatches.map((r) => ({ file: r.file, line: r.line, content: r.content }));
      const reranked = mmrRerankGrepResults(grepResults, { enabled: mmrEnabled, lambda: 0.7 });

      const withMtime = reranked.map((r) => {
        const orig = allMatches.find((m) => m.file === r.file && m.line === r.line);
        return { ...r, mtime: orig?.mtime ?? 0 };
      });
      withMtime.sort((a, b) => b.mtime - a.mtime);

      const truncated = withMtime.length > MAX_GREP_RESULTS;
      const finalMatches = truncated ? withMtime.slice(0, MAX_GREP_RESULTS) : withMtime;

      const outputLines: string[] = [
        `Found ${totalMatches} match${totalMatches === 1 ? '' : 'es'}` +
        (truncated ? ` (showing first ${MAX_GREP_RESULTS})` : ''),
      ];
      let currentFile = '';
      for (const r of finalMatches) {
        if (r.file !== currentFile) {
          if (currentFile) outputLines.push('');
          currentFile = r.file;
          outputLines.push(`${r.file}:`);
        }
        const lineText = r.content.length > MAX_GREP_LINE_LENGTH
          ? r.content.substring(0, MAX_GREP_LINE_LENGTH) + '...'
          : r.content;
        outputLines.push(`  Line ${r.line}: ${lineText}`);
      }
      if (truncated) {
        outputLines.push('');
        outputLines.push(`(Results truncated: ${totalMatches - MAX_GREP_RESULTS} hidden. Use a more specific pattern or path.)`);
      }
      return outputLines.join('\n');
    } catch {
      return `No matches found for pattern: ${pattern}`;
    }
  },
};
