/**
 * memdir/paths.ts — Memory directory path helpers
 *
 * Mirrors claude-code's memdir/paths.ts.
 * Centralized path management for all memory storage locations.
 */

import { resolve, join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';

// ── Base directories ──────────────────────────────────────────────────────────

/** Global config/memory root */
export function getGlobalMemDir(): string {
  return resolve(homedir(), '.codeflicker', 'memory');
}

/** Per-project memory directory (hashed path) */
export function getProjectMemDir(projectRoot: string): string {
  const hash = createHash('sha256').update(projectRoot).digest('hex').slice(0, 16);
  return join(getGlobalMemDir(), hash);
}

// ── Memory file paths ─────────────────────────────────────────────────────────

export function getPinnedMemPath(projectRoot: string): string {
  return join(getProjectMemDir(projectRoot), 'pinned.jsonl');
}

export function getInsightMemPath(projectRoot: string): string {
  return join(getProjectMemDir(projectRoot), 'insight.jsonl');
}

export function getFactMemPath(projectRoot: string): string {
  return join(getProjectMemDir(projectRoot), 'fact.jsonl');
}

export function getIterationMemPath(projectRoot: string): string {
  return join(getProjectMemDir(projectRoot), 'iteration.jsonl');
}

// ── Session history paths ─────────────────────────────────────────────────────

export function getSessionsDir(): string {
  return resolve(homedir(), '.codeflicker', 'sessions');
}

// ── Team memory paths ─────────────────────────────────────────────────────────

export function getTeamMemDir(): string {
  return resolve(homedir(), '.codeflicker', 'team-memory');
}

export function getTeamMemStatePath(): string {
  return resolve(homedir(), '.codeflicker', 'team-memory-state.json');
}

// ── Metrics paths ─────────────────────────────────────────────────────────────

export function getMetricsDir(): string {
  return resolve(homedir(), '.codeflicker', 'metrics');
}
