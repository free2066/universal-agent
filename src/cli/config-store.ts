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
 *
 * E13: Zod-like schema validation (手工实现，无外部依赖) + migrationVersion 版本迁移系统
 *   - validateConfig() — 校验配置对象，返回清洗后的合法字段
 *   - runConfigMigrations() — 按版本号顺序执行迁移
 *   - migrationVersion 字段跟踪已执行的最高迁移版本
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
  /** E13: 版本迁移字段 — 跟踪已执行的最高迁移版本（claude-code migrationVersion 对标） */
  migrationVersion?: number;
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
  /**
   * Per-tool enable/disable flags. Aligns with CodeFlicker CLI's `tools` config field.
   * Keys are tool names (e.g. "write", "bash", "mcp__xxx__yyy").
   * A value of `false` disables that tool; `true` or omitted means enabled (default).
   *
   * Example: { "bash": false, "write": false }  — read-only mode
   * Priority: CLI --tools > project config > global config
   */
  tools?: Record<string, boolean>;
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

// ── E13: Config Schema Validation (claude-code SettingsSchema 对标) ───────────
//
// 手工实现轻量级 schema 校验，无需 zod 依赖。
// 校验逻辑：过滤未知字段 + 校验已知字段的类型，非致命（返回校验结果，不抛异常）。

/** E13: 校验结果类型 */
export interface ConfigValidationResult {
  valid: boolean;
  issues: string[];
  /** 清洗后的合法配置（unknown keys 已移除，类型错误字段已跳过） */
  cleaned: UAgentConfig;
}

/** E13: 已知的合法 config key 集合（用于过滤 unknown keys） */
const KNOWN_CONFIG_KEYS: Set<string> = new Set([
  'migrationVersion', 'approvalMode', 'autoCompact', 'autoUpdate',
  'commit', 'language', 'mcpServers', 'model', 'notification',
  'outputStyle', 'plugins', 'systemPrompt', 'thinkingLevel', 'todo', 'tools',
]);

/**
 * E13: validateConfig — 校验配置对象
 * 过滤未知字段，校验已知字段的基本类型，返回清洗后的合法配置。
 * 非致命：不抛异常，返回 issues 列表。
 */
export function validateConfig(raw: Record<string, unknown>): ConfigValidationResult {
  const issues: string[] = [];
  const cleaned: UAgentConfig = {};

  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) {
      issues.push(`Unknown config key: "${key}" (ignored)`);
      continue;
    }

    // Type checks for known fields
    switch (key) {
      case 'migrationVersion':
        if (typeof value === 'number') (cleaned as Record<string, unknown>)[key] = value;
        else issues.push(`"${key}" must be a number, got ${typeof value}`);
        break;
      case 'approvalMode':
        if (['default', 'autoEdit', 'yolo'].includes(value as string)) {
          cleaned.approvalMode = value as UAgentConfig['approvalMode'];
        } else {
          issues.push(`"approvalMode" must be one of: default, autoEdit, yolo`);
        }
        break;
      case 'autoCompact':
      case 'autoUpdate':
      case 'notification':
      case 'todo':
        if (typeof value === 'boolean' || typeof value === 'string') {
          (cleaned as Record<string, unknown>)[key] = value;
        } else {
          issues.push(`"${key}" must be a boolean or string, got ${typeof value}`);
        }
        break;
      case 'model':
      case 'language':
      case 'systemPrompt':
      case 'outputStyle':
        if (typeof value === 'string') {
          (cleaned as Record<string, unknown>)[key] = value;
        } else {
          issues.push(`"${key}" must be a string, got ${typeof value}`);
        }
        break;
      case 'thinkingLevel':
        if (['low', 'medium', 'high', 'max', 'xhigh', 'maxOrXhigh'].includes(value as string)) {
          cleaned.thinkingLevel = value as UAgentConfig['thinkingLevel'];
        } else {
          issues.push(`"thinkingLevel" must be one of: low, medium, high, max, xhigh, maxOrXhigh`);
        }
        break;
      case 'plugins':
        if (Array.isArray(value)) {
          cleaned.plugins = value.filter((v) => typeof v === 'string') as string[];
        } else {
          issues.push(`"plugins" must be an array`);
        }
        break;
      case 'commit':
      case 'mcpServers':
      case 'tools':
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          (cleaned as Record<string, unknown>)[key] = value;
        } else {
          issues.push(`"${key}" must be an object`);
        }
        break;
      default:
        // fallback: copy as-is
        (cleaned as Record<string, unknown>)[key] = value;
    }
  }

  return { valid: issues.length === 0, issues, cleaned };
}

// ── E13: Config Migration System (claude-code runMigrations 对标) ─────────────
//
// 按版本号顺序执行迁移，每个版本只执行一次（通过 migrationVersion 字段追踪）。
// claude-code 有 11 个迁移版本；我们从 v1 开始。

const CURRENT_MIGRATION_VERSION = 1;

interface Migration {
  version: number;
  description: string;
  migrate: (cfg: Record<string, unknown>) => Record<string, unknown>;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Normalize legacy field names',
    migrate: (cfg) => {
      // v0→v1: 重命名历史遗留字段（如有）
      if ('approval_mode' in cfg) {
        cfg['approvalMode'] = cfg['approval_mode'];
        delete cfg['approval_mode'];
      }
      if ('auto_compact' in cfg) {
        cfg['autoCompact'] = cfg['auto_compact'];
        delete cfg['auto_compact'];
      }
      return cfg;
    },
  },
];

/**
 * E13: runConfigMigrations — 按版本执行迁移，写回 global config
 * 对标 claude-code 的 runMigrations() 函数。
 * 每次启动时调用一次（幂等操作）。
 */
export function runConfigMigrations(cwd = process.cwd()): void {
  const filePath = globalConfigPath();
  let cfg = readJsonSafe(filePath) as Record<string, unknown>;
  const currentVersion = (cfg['migrationVersion'] as number | undefined) ?? 0;
  if (currentVersion >= CURRENT_MIGRATION_VERSION) return; // 已是最新版本

  let updated = { ...cfg };
  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      try {
        updated = migration.migrate(updated);
      } catch {
        // 迁移失败不阻塞启动
      }
    }
  }
  updated['migrationVersion'] = CURRENT_MIGRATION_VERSION;
  void cwd; // 暂时只迁移 global config
  writeJson(filePath, updated as UAgentConfig);
}
