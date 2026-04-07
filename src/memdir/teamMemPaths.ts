/**
 * memdir/teamMemPaths.ts — Team memory path management
 *
 * Mirrors claude-code's memdir/teamMemPaths.ts.
 * Provides path utilities for team-shared memory storage.
 */

import { resolve, join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = resolve(homedir(), '.codeflicker');
export const TEAM_MEM_DIR = join(CONFIG_DIR, 'team-memory');
export const TEAM_STATE_FILE = join(CONFIG_DIR, 'team-memory-state.json');

/** Max file size for team memory files (250KB) */
export const MAX_TEAM_MEM_FILE_SIZE = 250_000;

/** Allowed file extensions for team memory */
export const ALLOWED_TEAM_MEM_EXTENSIONS = ['.md', '.txt'];

/**
 * Get the path for a specific team memory file.
 */
export function getTeamMemFilePath(relPath: string): string | null {
  const safe = resolve(TEAM_MEM_DIR, relPath);
  const prefix = TEAM_MEM_DIR + require('path').sep;
  if (!safe.startsWith(prefix) && safe !== TEAM_MEM_DIR) return null;

  const ext = require('path').extname(relPath);
  if (!ALLOWED_TEAM_MEM_EXTENSIONS.includes(ext)) return null;

  return safe;
}

/**
 * List all team memory files.
 */
export function listTeamMemFiles(): string[] {
  const { existsSync, readdirSync } = require('fs');
  if (!existsSync(TEAM_MEM_DIR)) return [];
  try {
    return readdirSync(TEAM_MEM_DIR)
      .filter((f: string) => ALLOWED_TEAM_MEM_EXTENSIONS.some(ext => f.endsWith(ext)));
  } catch {
    return [];
  }
}
