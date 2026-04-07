/**
 * migrations/migrateLegacyConfig.ts — Legacy config format migration
 *
 * Mirrors claude-code's migrations/ pattern.
 * Migrates the .uagent/ config directory to .codeflicker/ format.
 */

import { existsSync, mkdirSync, copyFileSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { homedir } from 'os';

/**
 * Migrate from .uagent/ to .codeflicker/ if needed.
 * Returns true if migration was performed.
 */
export async function migrateLegacyConfig(): Promise<boolean> {
  const home = homedir();
  const oldDir = resolve(home, '.uagent');
  const newDir = resolve(home, '.codeflicker');

  if (!existsSync(oldDir)) {
    return false; // Nothing to migrate
  }

  if (existsSync(newDir)) {
    return false; // Already migrated
  }

  try {
    mkdirSync(newDir, { recursive: true });

    // Copy known config files
    const filesToMigrate = ['config.json', 'settings.json', 'history.jsonl'];
    for (const file of filesToMigrate) {
      const src = join(oldDir, file);
      const dst = join(newDir, file);
      if (existsSync(src)) {
        copyFileSync(src, dst);
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Migrate project-level .uagent/ to .codeflicker/ in a given directory.
 */
export async function migrateLegacyProjectConfig(cwd = process.cwd()): Promise<boolean> {
  const oldDir = resolve(cwd, '.uagent');
  const newDir = resolve(cwd, '.codeflicker');

  if (!existsSync(oldDir)) return false;
  if (existsSync(newDir)) return false;

  try {
    mkdirSync(newDir, { recursive: true });
    const files = readdirSync(oldDir);
    for (const file of files) {
      const src = join(oldDir, file);
      const dst = join(newDir, file);
      if (!existsSync(dst)) {
        try { copyFileSync(src, dst); } catch { /* skip */ }
      }
    }
    return true;
  } catch {
    return false;
  }
}
