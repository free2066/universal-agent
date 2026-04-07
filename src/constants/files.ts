/**
 * constants/files.ts — File and path constants
 *
 * Mirrors claude-code's constants/files.ts.
 */

import { resolve } from 'path';
import { homedir } from 'os';

// ── Config filenames ──────────────────────────────────────────────────────────

export const CONFIG_FILENAME = 'config.json';
export const CONFIG_LOCAL_FILENAME = 'config.local.json';
export const SETTINGS_FILENAME = 'settings.json';
export const SETTINGS_LOCAL_FILENAME = 'settings.local.json';
export const MCP_CONFIG_FILENAME = '.mcp.json';
export const HOOKS_CONFIG_FILENAME = 'hooks.json';

// ── Memory / session files ────────────────────────────────────────────────────

export const SESSION_DIR = 'sessions';
export const MEMORY_DIR = 'memory';
export const METRICS_DIR = 'metrics';
export const LOGS_DIR = 'logs';
export const SKILLS_DIR = 'skills';
export const OUTPUT_STYLES_DIR = 'output-styles';

// ── Memory file names ─────────────────────────────────────────────────────────

export const MEMORY_FILE = 'MEMORY.md';
export const PROJECT_MEMORY_FILE = 'MEMORY.md';
export const TEAM_MEMORY_FILE = 'TEAM_MEMORY.md';

// ── Instruction files ─────────────────────────────────────────────────────────

export const CLAUDE_MD = 'CLAUDE.md';
export const AGENTS_MD = 'AGENTS.md';
export const SYSTEM_PROMPT_FILE = '.system-prompt';

// ── Path helpers ──────────────────────────────────────────────────────────────

export function getGlobalConfigDir(): string {
  return resolve(homedir(), '.codeflicker');
}

export function getProjectConfigDir(cwd = process.cwd()): string {
  return resolve(cwd, '.codeflicker');
}

export function getMemoryPath(cwd = process.cwd()): string {
  return resolve(cwd, '.codeflicker', MEMORY_DIR);
}

export function getSessionPath(cwd = process.cwd()): string {
  return resolve(cwd, '.codeflicker', SESSION_DIR);
}
