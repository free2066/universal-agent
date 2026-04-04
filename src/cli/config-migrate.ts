/**
 * config-migrate.ts — One-click migration from CodeFlicker IDE / KwaiPilot settings.
 *
 * Aligns with `npx @ks-codeflicker/migrate@latest` behavior:
 * reads CodeFlicker/KwaiPilot preferences from all known locations and merges them
 * into the uagent global config (~/.codeflicker/config.json).
 *
 * Migration sources (in priority order):
 *   1. ~/.codeflicker/config.json         — flickcli native config (direct copy)
 *   2. ~/.codeflicker/data.json           — IDE runtime data (recentModels)
 *   3. ~/.codeflicker/remote-base-config.json — server-pushed defaults (DEFAULT_MODEL, COMMIT_MODEL)
 *   4. ~/.codeflicker/argv.json           — IDE locale → language
 *   5. ~/.codeflicker/mcp/codeflicker-mcp-settings.json — MCP servers
 *   6. ~/.kwaipilot/mcp/kwaipilot-mcp-settings.json     — KwaiPilot MCP servers
 *   7. VSCode settings.json               — kwaipilot.* / codeflicker.* extension settings
 *
 * All discovered values are shown as a preview before writing.
 * Use --yes / -y to skip confirmation.
 * Use --dry-run to preview only without writing.
 */

import { existsSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import type { UAgentConfig, ThinkingLevelExtended } from './config-store.js';

// ── Source paths ──────────────────────────────────────────────────────────────

const HOME = process.env.HOME ?? '~';

function p(...parts: string[]): string {
  return resolve(HOME, ...parts);
}

const SOURCES = {
  flickcliConfig:     p('.codeflicker', 'config.json'),
  ideData:            p('.codeflicker', 'data.json'),
  remoteBaseConfig:   p('.codeflicker', 'remote-base-config.json'),
  ideArgv:            p('.codeflicker', 'argv.json'),
  cfMcp:              p('.codeflicker', 'mcp', 'codeflicker-mcp-settings.json'),
  kpMcp:              p('.kwaipilot',   'mcp', 'kwaipilot-mcp-settings.json'),
  vscodeSettings:     getVscodeSettingsPath(),
} as const;

function getVscodeSettingsPath(): string {
  if (process.platform === 'darwin') {
    return join(HOME, 'Library', 'Application Support', 'Code', 'User', 'settings.json');
  } else if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? HOME, 'Code', 'User', 'settings.json');
  } else {
    return join(HOME, '.config', 'Code', 'User', 'settings.json');
  }
}

// ── JSON safe read ────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readJson(filePath: string): any {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

// ── Locale → language mapping ────────────────────────────────────────────────

function localeToLanguage(locale: string): string | undefined {
  const map: Record<string, string> = {
    'zh-cn': 'Chinese',
    'zh-tw': 'Chinese (Traditional)',
    'zh':    'Chinese',
    'en':    'English',
    'en-us': 'English',
    'ja':    'Japanese',
    'ko':    'Korean',
    'fr':    'French',
    'de':    'German',
    'es':    'Spanish',
    'ru':    'Russian',
    'pt':    'Portuguese',
    'it':    'Italian',
    'ar':    'Arabic',
  };
  return map[locale.toLowerCase()];
}

// ── KwaiPilot VSCode setting key mappings ─────────────────────────────────────

/**
 * Map VSCode kwaipilot.* / codeflicker.* settings to UAgentConfig fields.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractFromVscodeSettings(settings: Record<string, any>): Partial<UAgentConfig> {
  const result: Partial<UAgentConfig> = {};

  // Approval mode
  // kwaipilot.composer.approvalMode / kwaipilot.settings.approvalMode
  const approvalRaw =
    settings['kwaipilot.composer.approvalMode'] ??
    settings['kwaipilot.settings.approvalMode'] ??
    settings['codeflicker.approvalMode'];
  if (approvalRaw && ['default', 'autoEdit', 'yolo'].includes(approvalRaw)) {
    result.approvalMode = approvalRaw as UAgentConfig['approvalMode'];
  }

  // Thinking level
  const thinkingRaw =
    settings['kwaipilot.composer.thinkingLevel'] ??
    settings['codeflicker.thinkingLevel'];
  const validLevels: ThinkingLevelExtended[] = ['low', 'medium', 'high', 'max', 'xhigh', 'maxOrXhigh'];
  if (thinkingRaw && validLevels.includes(thinkingRaw as ThinkingLevelExtended)) {
    result.thinkingLevel = thinkingRaw as ThinkingLevelExtended;
  }

  // Model
  const modelRaw =
    settings['kwaipilot.model'] ??
    settings['kwaipilot.composer.model'] ??
    settings['codeflicker.model'];
  if (typeof modelRaw === 'string' && modelRaw) {
    result.model = modelRaw;
  }

  // Language
  const langRaw =
    settings['kwaipilot.language'] ??
    settings['codeflicker.language'];
  if (typeof langRaw === 'string' && langRaw) {
    result.language = langRaw;
  }

  // Auto-compact
  const compactRaw =
    settings['kwaipilot.autoCompact'] ??
    settings['codeflicker.autoCompact'];
  if (typeof compactRaw === 'boolean') {
    result.autoCompact = compactRaw;
  }

  // System prompt
  const systemPromptRaw =
    settings['kwaipilot.systemPrompt'] ??
    settings['codeflicker.systemPrompt'];
  if (typeof systemPromptRaw === 'string' && systemPromptRaw) {
    result.systemPrompt = systemPromptRaw;
  }

  // Notification
  const notifRaw =
    settings['kwaipilot.notification'] ??
    settings['codeflicker.notification'];
  if (notifRaw !== undefined) {
    result.notification = notifRaw as boolean | string;
  }

  return result;
}

// ── Discovery result type ─────────────────────────────────────────────────────

export interface MigrationSource {
  /** Human-readable name of the source */
  name: string;
  /** File path that was read */
  path: string;
  /** Config fields discovered from this source */
  discovered: Partial<UAgentConfig>;
}

export interface MigrationPlan {
  sources: MigrationSource[];
  /** Merged config to be written (final resolved state) */
  merged: Partial<UAgentConfig>;
  /** Number of fields that will be changed */
  changedCount: number;
}

// ── Main discovery function ───────────────────────────────────────────────────

/**
 * Scan all known CodeFlicker / KwaiPilot config locations and build a migration plan.
 * Does NOT write anything — just collects what would be migrated.
 */
export function buildMigrationPlan(existingGlobal: UAgentConfig = {}): MigrationPlan {
  const sources: MigrationSource[] = [];
  const merged: Partial<UAgentConfig> = {};

  // ── 1. ~/.codeflicker/config.json (flickcli native — direct copy) ──────────
  {
    const data = readJson(SOURCES.flickcliConfig);
    if (data && typeof data === 'object') {
      const discovered: Partial<UAgentConfig> = {};
      // Direct field mappings (flickcli config uses same field names as UAgentConfig)
      const directFields: Array<keyof UAgentConfig> = [
        'model', 'language', 'systemPrompt', 'approvalMode', 'thinkingLevel',
        'autoCompact', 'autoUpdate', 'notification', 'outputStyle', 'plugins', 'todo',
      ];
      for (const field of directFields) {
        if (data[field] !== undefined) {
          // Skip wanqing/* model names — they are CodeFlicker-internal service-discovery IDs
          // (format: "wanqing/claude-4.6-sonnet"). uagent has its own wanqing endpoint
          // detector that finds the correct ep-* ID at runtime. Copying this value would
          // break uagent's model routing.
          if (field === 'model' && typeof data[field] === 'string' &&
              (data[field] as string).startsWith('wanqing/')) {
            continue;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (discovered as any)[field] = data[field];
        }
      }
      if (data.commit?.language) discovered.commit = { language: data.commit.language };
      if (data.mcpServers && Object.keys(data.mcpServers).length > 0) {
        discovered.mcpServers = data.mcpServers;
      }
      if (Object.keys(discovered).length > 0) {
        sources.push({ name: 'flickcli config (~/.codeflicker/config.json)', path: SOURCES.flickcliConfig, discovered });
        Object.assign(merged, discovered);
      }
    }
  }

  // ── 2. ~/.codeflicker/data.json (IDE runtime — recentModels) ──────────────
  {
    const data = readJson(SOURCES.ideData);
    if (data?.recentModels?.length > 0 && !merged.model) {
      const model = data.recentModels[0] as string;
      // Skip wanqing/* model names — uagent auto-detects the correct ep-* endpoint
      if (typeof model === 'string' && model && !model.startsWith('wanqing/')) {
        const discovered: Partial<UAgentConfig> = { model };
        sources.push({
          name: 'IDE recent models (~/.codeflicker/data.json)',
          path: SOURCES.ideData,
          discovered,
        });
        Object.assign(merged, discovered);
      }
    }
  }

  // ── 3. ~/.codeflicker/remote-base-config.json (server defaults) ───────────
  {
    const data = readJson(SOURCES.remoteBaseConfig);
    if (data && typeof data === 'object') {
      const discovered: Partial<UAgentConfig> = {};
      // Use DEFAULT_MODEL as fallback model if not already set
      // Skip wanqing/* model names — uagent auto-detects the correct ep-* endpoint
      if (!merged.model && typeof data.DEFAULT_MODEL === 'string' && data.DEFAULT_MODEL &&
          !data.DEFAULT_MODEL.startsWith('wanqing/')) {
        discovered.model = data.DEFAULT_MODEL as string;
      }
      // COMMIT_MODEL → commit.language is not directly related, but track it for info
      // (We don't map COMMIT_MODEL to model since it's a specialized sub-model)
      if (Object.keys(discovered).length > 0) {
        sources.push({
          name: 'Remote base config (~/.codeflicker/remote-base-config.json)',
          path: SOURCES.remoteBaseConfig,
          discovered,
        });
        Object.assign(merged, discovered);
      }
    }
  }

  // ── 4. ~/.codeflicker/argv.json (IDE locale) ──────────────────────────────
  {
    const data = readJson(SOURCES.ideArgv);
    if (data?.locale && !merged.language) {
      const language = localeToLanguage(data.locale as string);
      if (language) {
        const discovered: Partial<UAgentConfig> = { language };
        sources.push({
          name: 'IDE locale (~/.codeflicker/argv.json)',
          path: SOURCES.ideArgv,
          discovered,
        });
        Object.assign(merged, discovered);
      }
    }
  }

  // ── 5. CodeFlicker MCP servers ─────────────────────────────────────────────
  {
    const data = readJson(SOURCES.cfMcp);
    if (data?.mcpServers && Object.keys(data.mcpServers).length > 0) {
      const discovered: Partial<UAgentConfig> = {
        mcpServers: { ...(merged.mcpServers ?? {}), ...data.mcpServers },
      };
      sources.push({
        name: 'CodeFlicker MCP (~/.codeflicker/mcp/codeflicker-mcp-settings.json)',
        path: SOURCES.cfMcp,
        discovered,
      });
      Object.assign(merged, discovered);
    }
  }

  // ── 6. KwaiPilot MCP servers ───────────────────────────────────────────────
  {
    const data = readJson(SOURCES.kpMcp);
    if (data?.mcpServers && Object.keys(data.mcpServers).length > 0) {
      const discovered: Partial<UAgentConfig> = {
        mcpServers: { ...(merged.mcpServers ?? {}), ...data.mcpServers },
      };
      sources.push({
        name: 'KwaiPilot MCP (~/.kwaipilot/mcp/kwaipilot-mcp-settings.json)',
        path: SOURCES.kpMcp,
        discovered,
      });
      Object.assign(merged, discovered);
    }
  }

  // ── 7. VSCode extension settings ──────────────────────────────────────────
  {
    const data = readJson(SOURCES.vscodeSettings);
    if (data && typeof data === 'object') {
      const discovered = extractFromVscodeSettings(data as Record<string, unknown>);
      if (Object.keys(discovered).length > 0) {
        sources.push({
          name: 'VSCode extension settings',
          path: SOURCES.vscodeSettings,
          discovered,
        });
        // VSCode settings have lower priority — only fill in what's not already set
        for (const [k, v] of Object.entries(discovered)) {
          if (!(k in merged)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (merged as any)[k] = v;
          }
        }
      }
    }
  }

  // Compute changedCount: fields that differ from existing global config
  let changedCount = 0;
  for (const [k, v] of Object.entries(merged)) {
    const existing = existingGlobal[k as keyof UAgentConfig];
    if (JSON.stringify(existing) !== JSON.stringify(v)) changedCount++;
  }

  return { sources, merged, changedCount };
}

// ── Exported sources info for display ────────────────────────────────────────

/**
 * Return which source files exist on this machine (for status display).
 */
export function detectSources(): Array<{ name: string; path: string; exists: boolean }> {
  return [
    { name: 'flickcli config',            path: SOURCES.flickcliConfig,   exists: existsSync(SOURCES.flickcliConfig) },
    { name: 'IDE data (recentModels)',     path: SOURCES.ideData,          exists: existsSync(SOURCES.ideData) },
    { name: 'Remote base config',         path: SOURCES.remoteBaseConfig,  exists: existsSync(SOURCES.remoteBaseConfig) },
    { name: 'IDE locale (argv.json)',      path: SOURCES.ideArgv,          exists: existsSync(SOURCES.ideArgv) },
    { name: 'CodeFlicker MCP servers',    path: SOURCES.cfMcp,            exists: existsSync(SOURCES.cfMcp) },
    { name: 'KwaiPilot MCP servers',      path: SOURCES.kpMcp,            exists: existsSync(SOURCES.kpMcp) },
    { name: 'VSCode extension settings',  path: SOURCES.vscodeSettings,   exists: existsSync(SOURCES.vscodeSettings) },
  ];
}
