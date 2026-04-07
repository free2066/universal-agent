/**
 * GlobTool/GlobTool.ts — GlobTool: file pattern matching search
 *
 * Mirrors claude-code's GlobTool.ts design.
 *
 * Finds files matching a glob pattern within a directory.
 * - Input: { pattern: string, path?: string }
 * - Output: list of matching file paths relative to cwd
 * - Maximum 100 results (matching claude-code limit)
 * - Uses Node.js built-ins only (no external glob dependency)
 *
 * Safety:
 * - Skips UNC paths (\\... or //...) to prevent NTLM credential leaks
 * - Validates path is an existing directory
 *
 * Round 6: claude-code GlobTool parity
 */

import { existsSync, statSync, readdirSync } from 'fs';
import { resolve, relative, isAbsolute, join, sep } from 'path';
import type { ToolRegistration } from '../../models/types.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_GLOB_RESULTS = 100;

// ── Glob pattern → RegExp conversion ─────────────────────────────────────────

/**
 * Convert a glob pattern to a RegExp.
 *
 * Supported syntax:
 *   **   → match any path segment (including /)
 *   *    → match any character except /
 *   ?    → match any single character except /
 *   [..] → character class
 *
 * All other regex special characters are escaped.
 */
function globToRegex(pattern: string): RegExp {
  // Normalize path separators
  const normalized = pattern.replace(/\\/g, '/');

  let regexStr = '';
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i]!;

    if (ch === '*' && normalized[i + 1] === '*') {
      // **/ at start or after /
      if (normalized[i + 2] === '/') {
        // **/ → match zero or more path segments
        regexStr += '(?:.+/)?';
        i += 3;
      } else if (i === normalized.length - 2) {
        // trailing ** → match everything
        regexStr += '.*';
        i += 2;
      } else {
        regexStr += '.*';
        i += 2;
      }
    } else if (ch === '*') {
      // single * → match any character except /
      regexStr += '[^/]*';
      i++;
    } else if (ch === '?') {
      // ? → match any single character except /
      regexStr += '[^/]';
      i++;
    } else if (ch === '[') {
      // character class — pass through as-is until matching ]
      const end = normalized.indexOf(']', i + 1);
      if (end < 0) {
        regexStr += '\\[';
        i++;
      } else {
        regexStr += normalized.slice(i, end + 1);
        i = end + 1;
      }
    } else if ('.+^${}()|\\'.includes(ch)) {
      // Escape regex special characters
      regexStr += `\\${ch}`;
      i++;
    } else {
      regexStr += ch;
      i++;
    }
  }

  return new RegExp(`^${regexStr}$`);
}

// ── Recursive directory traversal ─────────────────────────────────────────────

function collectFiles(
  dir: string,
  baseDir: string,
  pattern: RegExp,
  results: string[],
  limit: number,
): void {
  if (results.length >= limit) return;

  let entries: import('fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as import('fs').Dirent[];
  } catch { return; /* permission denied or inaccessible — skip silently */ }

  for (const entry of entries) {
    if (results.length >= limit) return;

    // Skip hidden directories (like .git, node_modules when traversing deeply)
    if (entry.name.startsWith('.') && entry.isDirectory()) continue;
    // Skip node_modules
    if (entry.name === 'node_modules') continue;

    const fullPath = join(dir, entry.name);
    const relPath = relative(baseDir, fullPath).replace(/\\/g, '/');

    if (pattern.test(relPath)) {
      results.push(relPath);
    }

    if (entry.isDirectory()) {
      collectFiles(fullPath, baseDir, pattern, results, limit);
    }
  }
}

// ── Tool registration ─────────────────────────────────────────────────────────

export const globTool: ToolRegistration = {
  definition: {
    name: 'Glob',
    description: [
      'Find files matching a glob pattern.',
      '',
      'Use this tool to quickly locate files by name pattern.',
      'Examples:',
      '  **/*.ts        — all TypeScript files in any subdirectory',
      '  src/**/*.test.ts — all test files under src/',
      '  *.json         — JSON files in the root',
      '',
      'Results are capped at 100 files. Use a more specific path to narrow results.',
      'Returns file paths relative to the current working directory.',
    ].join('\n'),
    parameters: {
      type: 'object' as const,
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern to match files (e.g. "**/*.ts", "src/**/*.json")',
        },
        path: {
          type: 'string',
          description: 'Absolute or relative directory path to search within (defaults to cwd)',
        },
      },
      required: ['pattern'],
    },
  },

  async handler(args: unknown): Promise<string> {
    const input = args as { pattern?: string; path?: string };
    const pattern = (input.pattern ?? '').trim();
    const pathArg = input.path?.trim();

    if (!pattern) {
      return '[Glob] Error: pattern is required';
    }

    // Resolve search directory
    const cwd = process.cwd();
    let searchDir: string;

    if (pathArg) {
      searchDir = isAbsolute(pathArg) ? pathArg : resolve(cwd, pathArg);
    } else {
      searchDir = cwd;
    }

    // Safety: skip UNC paths (\\... or //...) to prevent NTLM credential leaks
    if (searchDir.startsWith('\\\\') || searchDir.startsWith('//')) {
      return '[Glob] Error: UNC paths are not supported';
    }

    // Validate directory exists
    if (!existsSync(searchDir)) {
      return `[Glob] Error: directory not found: ${searchDir}`;
    }
    try {
      const st = statSync(searchDir);
      if (!st.isDirectory()) {
        return `[Glob] Error: path is not a directory: ${searchDir}`;
      }
    } catch (e) {
      return `[Glob] Error: cannot access path: ${e instanceof Error ? e.message : String(e)}`;
    }

    const startMs = Date.now();

    // Build regex from pattern
    // Normalize separators to forward slash for consistent matching
    const normalizedPattern = pattern.replace(/\\/g, '/');
    let patternRegex: RegExp;
    try {
      patternRegex = globToRegex(normalizedPattern);
    } catch (e) {
      return `[Glob] Error: invalid pattern: ${e instanceof Error ? e.message : String(e)}`;
    }

    // Collect matching files (collect up to MAX+1 to detect truncation)
    const rawResults: string[] = [];
    collectFiles(searchDir, searchDir, patternRegex, rawResults, MAX_GLOB_RESULTS + 1);

    // Sort for deterministic output
    rawResults.sort();

    let truncated = false;
    let filenames: string[];
    if (rawResults.length > MAX_GLOB_RESULTS) {
      truncated = true;
      filenames = rawResults.slice(0, MAX_GLOB_RESULTS);
    } else {
      filenames = rawResults;
    }

    // Relativize to cwd (saves tokens when searchDir != cwd)
    const relativeFilenames = filenames.map((f) => {
      const abs = resolve(searchDir, f);
      const rel = relative(cwd, abs);
      // Normalize path separators to forward slash
      return rel.replace(/\\/g, '/');
    });

    const durationMs = Date.now() - startMs;
    const numFiles = relativeFilenames.length;

    if (numFiles === 0) {
      return `[Glob] No files found matching "${pattern}"${pathArg ? ` in ${searchDir}` : ''}.`;
    }

    const header = `${numFiles} file${numFiles !== 1 ? 's' : ''} found (${durationMs}ms)${truncated ? ` [truncated at ${MAX_GLOB_RESULTS}]` : ''}:`;
    return [header, ...relativeFilenames].join('\n');
  },
};

// Add 'Glob' to PARALLELIZABLE_TOOLS in types.ts is handled automatically
// since this tool only reads the filesystem (no writes).
void sep; // use import to avoid unused warning
