/**
 * migrations/migrateModelSettings.ts — Model settings migration
 *
 * Mirrors claude-code's model migration pattern.
 * Handles migration of legacy model names to current identifiers.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

/** Model name migration map */
const MODEL_MIGRATIONS: Record<string, string> = {
  // Anthropic legacy names
  'claude-3-opus-20240229': 'claude-opus-4-5',
  'claude-3-sonnet-20240229': 'claude-sonnet-4-5',
  'claude-3-haiku-20240307': 'claude-haiku-4-5',
  'claude-3-5-sonnet-20241022': 'claude-sonnet-4-5',
  'claude-3-5-haiku-20241022': 'claude-haiku-4-5',
  // OpenAI legacy names
  'gpt-4-turbo-preview': 'gpt-4-turbo',
  'gpt-3.5-turbo': 'gpt-4o-mini',
};

function migrateModelName(model: string): string {
  return MODEL_MIGRATIONS[model] ?? model;
}

function migrateConfigFile(filePath: string): boolean {
  if (!existsSync(filePath)) return false;

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const config = JSON.parse(raw);
    let changed = false;

    if (config.model && MODEL_MIGRATIONS[config.model]) {
      config.model = MODEL_MIGRATIONS[config.model];
      changed = true;
    }

    if (changed) {
      writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    }

    return changed;
  } catch {
    return false;
  }
}

/**
 * Migrate model names in global config.
 */
export async function migrateModelSettings(): Promise<boolean> {
  const home = homedir();
  const globalConfig = resolve(home, '.codeflicker', 'config.json');
  return migrateConfigFile(globalConfig);
}

/**
 * Migrate model names in project config.
 */
export async function migrateProjectModelSettings(cwd = process.cwd()): Promise<boolean> {
  const projectConfig = resolve(cwd, '.codeflicker', 'config.json');
  const projectLocalConfig = resolve(cwd, '.codeflicker', 'config.local.json');

  const a = migrateConfigFile(projectConfig);
  const b = migrateConfigFile(projectLocalConfig);
  return a || b;
}
