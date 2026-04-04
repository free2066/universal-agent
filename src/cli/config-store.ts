/**
 * config-store.ts — Layered JSON config system for universal-agent.
 *
 * Aligns with CodeFlicker CLI's `.codeflicker/config.json` spec:
 *   - Global:        ~/.codeflicker/config.json
 *   - Project:       .codeflicker/config.json   (checked into VCS)
 *   - Project local: .codeflicker/config.local.json  (gitignored)
 *
 * Priority (highest → lowest):
 *   project local > project > global
 *
 * CLI commands:
 *   uagent config ls              — list all resolved settings
 *   uagent config get <key>       — print one value
 *   uagent config set <key> <val> — set in project config
 *   uagent config set <key> <val> -g — set in global config
 *   uagent config add <key> <val> — append to array field
 *   uagent config rm  <key> [val] — remove key or array item
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ThinkingLevelExtended =
  | 'low' | 'medium' | 'high'   // all providers
  | 'max' | 'xhigh' | 'maxOrXhigh'; // extended (Claude / advanced)

export interface CommitConfig {
  language?: string;
}

export interface UAgentConfig {
  approvalMode?: 'default' | 'autoEdit' | 'yolo';
  autoCompact?: boolean;
  autoUpdate?: boolean;
  commit?: CommitConfig;
  language?: string;
  mcpServers?: Record<string, unknown>;   // kept for API compat; real MCP still uses .mcp.json
  model?: string;
  notification?: boolean | string;
  outputStyle?: string;
  plugins?: string[];
  systemPrompt?: string;
  thinkingLevel?: ThinkingLevelExtended;
  todo?: boolean;
}

// ── Paths ─────────────────────────────────────────────────────────────────────

export function globalConfigPath(): string {
  return resolve(process.env.HOME ?? '~', '.codeflicker', 'config.json');
}

export function projectConfigPath(cwd = process.cwd()): string {
  return join(cwd, '.codeflicker', 'config.json');
}

export function projectLocalConfigPath(cwd = process.cwd()): string {
  return join(cwd, '.codeflicker', 'config.local.json');
}

// ── Low-level read/write ──────────────────────────────────────────────────────

function readJsonSafe(filePath: string): UAgentConfig {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as UAgentConfig;
  } catch {
    return {};
  }
}

function writeJson(filePath: string, data: UAgentConfig): void {
  const dir = resolve(filePath, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

// ── Deep-merge helper ─────────────────────────────────────────────────────────

function mergeConfig(base: UAgentConfig, override: UAgentConfig): UAgentConfig {
  const result: UAgentConfig = { ...base };
  for (const k of Object.keys(override) as Array<keyof UAgentConfig>) {
    const ov = override[k];
    if (ov !== undefined && ov !== null) {
      if (
        typeof ov === 'object' &&
        !Array.isArray(ov) &&
        typeof base[k] === 'object' &&
        !Array.isArray(base[k])
      ) {
        // Deep merge plain objects (e.g. commit: { language })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (result as any)[k] = mergeConfig(
          (base[k] as UAgentConfig) ?? {},
          ov as UAgentConfig,
        );
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (result as any)[k] = ov;
      }
    }
  }
  return result;
}

// ── Nested key helpers (dot-notation) ────────────────────────────────────────

function setNestedKey(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cur: any = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) {
      cur[parts[i]] = {};
    }
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function getNestedKey(obj: Record<string, unknown>, key: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cur: any = obj;
  for (const part of key.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function deleteNestedKey(obj: Record<string, unknown>, key: string): void {
  const parts = key.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cur: any = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null || typeof cur !== 'object') return;
    cur = cur[parts[i]];
  }
  if (cur != null) delete cur[parts[parts.length - 1]];
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Load and merge all config layers.
 * Result priority: project local > project > global.
 */
export function loadConfig(cwd = process.cwd()): UAgentConfig {
  const globalCfg  = readJsonSafe(globalConfigPath());
  const projectCfg = readJsonSafe(projectConfigPath(cwd));
  const localCfg   = readJsonSafe(projectLocalConfigPath(cwd));
  return mergeConfig(mergeConfig(globalCfg, projectCfg), localCfg);
}

/**
 * Read a single top-level key from the merged config.
 */
export function getConfigValue<K extends keyof UAgentConfig>(
  key: K,
  cwd = process.cwd(),
): UAgentConfig[K] {
  return loadConfig(cwd)[key];
}

/**
 * Write a single key/value to the specified scope.
 * @param key    Dot-notation supported for nested keys: "commit.language"
 * @param value  JSON-parsed value (string, boolean, number, array, object)
 * @param global If true, write to ~/.codeflicker/config.json; otherwise project
 */
export function setConfigValue(
  key: string,
  value: unknown,
  global = false,
  cwd = process.cwd(),
): void {
  const filePath = global ? globalConfigPath() : projectConfigPath(cwd);
  const data = readJsonSafe(filePath);
  setNestedKey(data as unknown as Record<string, unknown>, key, value);
  writeJson(filePath, data);
}

/**
 * Append a value to an array-typed key (creates the array if absent).
 * Only operates on the project config (not global).
 */
export function addConfigValue(key: string, value: unknown, cwd = process.cwd()): void {
  const filePath = projectConfigPath(cwd);
  const data = readJsonSafe(filePath);
  const dataRec = data as unknown as Record<string, unknown>;
  const existing = getNestedKey(dataRec, key);
  if (Array.isArray(existing)) {
    setNestedKey(dataRec, key, [...existing, value]);
  } else {
    setNestedKey(dataRec, key, [value]);
  }
  writeJson(filePath, data);
}

/**
 * Remove a key entirely, or remove one item from an array.
 * If `value` is provided, removes only that item from the array.
 * If `value` is omitted, deletes the entire key.
 */
export function removeConfigValue(
  key: string,
  value?: unknown,
  global = false,
  cwd = process.cwd(),
): void {
  const filePath = global ? globalConfigPath() : projectConfigPath(cwd);
  const data = readJsonSafe(filePath);
  const dataRec = data as unknown as Record<string, unknown>;

  if (value !== undefined) {
    const existing = getNestedKey(dataRec, key);
    if (Array.isArray(existing)) {
      setNestedKey(dataRec, key, existing.filter((item) => item !== value));
    }
  } else {
    deleteNestedKey(dataRec, key);
  }
  writeJson(filePath, data);
}

// ── Config display helper ─────────────────────────────────────────────────────

/**
 * Pretty-print the merged config as a flat key=value list (like `flickcli config ls`).
 */
export function formatConfigList(cwd = process.cwd()): string {
  const cfg = loadConfig(cwd);
  if (Object.keys(cfg).length === 0) return '(no settings configured)';

  const lines: string[] = [];
  function flatten(obj: Record<string, unknown>, prefix = ''): void {
    for (const [k, v] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        flatten(v as Record<string, unknown>, fullKey);
      } else {
        lines.push(`${fullKey}=${JSON.stringify(v)}`);
      }
    }
  }
  flatten(cfg as unknown as Record<string, unknown>);
  return lines.join('\n');
}

/**
 * Parse a CLI string value to a typed JS value.
 * "true"/"false" → boolean, numeric strings → number, JSON objects/arrays → parsed,
 * otherwise returned as-is string.
 */
export function parseCliValue(raw: string): unknown {
  if (raw === 'true')  return true;
  if (raw === 'false') return false;
  if (raw === 'null')  return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  try { return JSON.parse(raw); } catch { /* not JSON */ }
  return raw;
}
