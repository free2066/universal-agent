/**
 * permission-manager.ts — Tool Permission Rule Persistence + ApprovalMode Enforcement
 *
 * Mirrors claude-code's permissions.ts and permissionsLoader.ts design.
 *
 * Architecture:
 *
 *   Two settings files (mirroring claude-code's rule source hierarchy):
 *     ~/.uagent/settings.json    — user-level (global)
 *     <project>/.uagent/settings.json — project-level (checked into SCM)
 *     <project>/.uagent/settings.local.json — local override (NOT checked in)
 *
 *   Rule structure:
 *     { alwaysAllow: string[], alwaysDeny: string[] }
 *
 *   Tool name patterns:
 *     "Bash"           — matches the Bash tool exactly
 *     "Bash(*)"        — matches Bash with any arguments
 *     "Write(src/**)"  — matches Write tool on paths matching src/**
 *     "*"              — matches all tools
 *
 *   ApprovalMode behavior (claude-code parity):
 *     default   — current behavior: dangerous commands require __CONFIRM_REQUIRED__ sentinel
 *     autoEdit  — Read tools: always allow; Write/Edit/Bash: check rules, then ask if not in allow list
 *     yolo      — ALL tools: bypass all permission checks (dangerous!)
 *
 * Config example (.uagent/settings.json):
 * {
 *   "alwaysAllow": ["Read", "LS", "Grep", "Write(src/**)", "Bash(npm test)"],
 *   "alwaysDeny":  ["Bash(rm -rf *)", "Bash(curl * | sh)"]
 * }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';

// ── Types ──────────────────────────────────────────────────────────────────────

export type ApprovalMode = 'default' | 'autoEdit' | 'yolo';

/** Three-level permission decision (mirrors claude-code's allow/ask/deny) */
export type PermissionDecision = 'allow' | 'ask' | 'deny';

export interface PermissionSettings {
  /** Tools/patterns that are always allowed without prompting */
  alwaysAllow: string[];
  /** Tools/patterns that are always denied */
  alwaysDeny: string[];
}

const EMPTY_SETTINGS: PermissionSettings = {
  alwaysAllow: [],
  alwaysDeny: [],
};

// ── Pattern matching ──────────────────────────────────────────────────────────

/**
 * Match a tool invocation against a permission rule pattern.
 * Supports:
 *   "ToolName"           — exact tool name match
 *   "ToolName(*)"        — tool name with any args
 *   "ToolName(pattern)"  — tool name + glob-like pattern match against key arg
 *   "*"                  — wildcard, matches all tools
 */
export function matchesPattern(
  pattern: string,
  toolName: string,
  toolArgs?: Record<string, unknown>,
): boolean {
  // Wildcard
  if (pattern === '*') return true;

  const parenIdx = pattern.indexOf('(');

  if (parenIdx === -1) {
    // No arguments pattern — exact tool name match
    return pattern.toLowerCase() === toolName.toLowerCase();
  }

  // Split into tool name and arg pattern
  const patternTool = pattern.slice(0, parenIdx);
  if (patternTool.toLowerCase() !== toolName.toLowerCase()) return false;

  const argPattern = pattern.slice(parenIdx + 1, pattern.endsWith(')') ? pattern.length - 1 : undefined);

  // Wildcard arg pattern
  if (argPattern === '*' || argPattern === '') return true;

  // Match against the most relevant tool argument
  const keyArg = String(
    toolArgs?.['command'] ??
    toolArgs?.['path'] ??
    toolArgs?.['file_path'] ??
    toolArgs?.['query'] ??
    '',
  );

  // Simple glob-like matching: * = any chars, ? = one char
  return globMatch(argPattern, keyArg);
}

/** Simple glob matcher: supports * (any chars) and ? (one char) */
function globMatch(pattern: string, str: string): boolean {
  // Escape regex special chars except * and ?
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`, 'i').test(str);
}

// ── Settings persistence ──────────────────────────────────────────────────────

const SETTINGS_FILE = '.uagent/settings.json';
const LOCAL_SETTINGS_FILE = '.uagent/settings.local.json';
const USER_SETTINGS_FILE = join(
  resolve(process.env.HOME ?? '~', '.uagent'),
  'settings.json',
);

function loadSettingsFile(path: string): PermissionSettings {
  if (!existsSync(path)) return { ...EMPTY_SETTINGS };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    return {
      alwaysAllow: Array.isArray(raw.alwaysAllow) ? raw.alwaysAllow : [],
      alwaysDeny: Array.isArray(raw.alwaysDeny) ? raw.alwaysDeny : [],
    };
  } catch {
    return { ...EMPTY_SETTINGS };
  }
}

function saveSettingsFile(path: string, settings: PermissionSettings): void {
  const dir = resolve(path, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

// ── PermissionManager ─────────────────────────────────────────────────────────

export class PermissionManager {
  private cwd: string;
  private _userSettings: PermissionSettings | null = null;
  private _projectSettings: PermissionSettings | null = null;
  private _localSettings: PermissionSettings | null = null;

  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
  }

  // ── Settings loading ────────────────────────────────────────────────────────

  private get userSettings(): PermissionSettings {
    if (!this._userSettings) {
      this._userSettings = loadSettingsFile(USER_SETTINGS_FILE);
    }
    return this._userSettings;
  }

  private get projectSettings(): PermissionSettings {
    if (!this._projectSettings) {
      const path = resolve(this.cwd, SETTINGS_FILE);
      this._projectSettings = loadSettingsFile(path);
    }
    return this._projectSettings;
  }

  private get localSettings(): PermissionSettings {
    if (!this._localSettings) {
      const path = resolve(this.cwd, LOCAL_SETTINGS_FILE);
      this._localSettings = loadSettingsFile(path);
    }
    return this._localSettings;
  }

  /** Merged alwaysAllow rules (user < project < local, local wins on conflicts) */
  get allAlwaysAllow(): string[] {
    return [
      ...this.userSettings.alwaysAllow,
      ...this.projectSettings.alwaysAllow,
      ...this.localSettings.alwaysAllow,
    ];
  }

  /** Merged alwaysDeny rules (any source can deny) */
  get allAlwaysDeny(): string[] {
    return [
      ...this.userSettings.alwaysDeny,
      ...this.projectSettings.alwaysDeny,
      ...this.localSettings.alwaysDeny,
    ];
  }

  /** Invalidate cache (call after modifying settings) */
  invalidate(): void {
    this._userSettings = null;
    this._projectSettings = null;
    this._localSettings = null;
  }

  // ── Permission decision ─────────────────────────────────────────────────────

  /**
   * Decide whether to allow, ask, or deny a tool invocation.
   *
   * Priority (claude-code parity):
   *   1. alwaysDeny → deny  (any source can deny)
   *   2. alwaysAllow → allow
   *   3. approvalMode-dependent fallback:
   *        yolo      → allow
   *        autoEdit  → allow for read tools, ask for write tools
   *        default   → ask
   */
  decide(
    toolName: string,
    toolArgs: Record<string, unknown> | undefined,
    approvalMode: ApprovalMode,
  ): PermissionDecision {
    const args = toolArgs ?? {};

    // 1. Check deny rules (highest priority — any deny wins)
    for (const pattern of this.allAlwaysDeny) {
      if (matchesPattern(pattern, toolName, args)) return 'deny';
    }

    // 2. Check allow rules
    for (const pattern of this.allAlwaysAllow) {
      if (matchesPattern(pattern, toolName, args)) return 'allow';
    }

    // 3. ApprovalMode fallback
    if (approvalMode === 'yolo') return 'allow';

    if (approvalMode === 'autoEdit') {
      // Read-class tools are automatically allowed in autoEdit mode
      if (READ_TOOLS.has(toolName)) return 'allow';
      return 'ask';
    }

    // default: ask for everything not explicitly allowed
    return 'ask';
  }

  /**
   * Async version of decide() — uses yolo-classifier for autoEdit mode.
   *
   * In autoEdit mode, for non-READ_TOOLS, runs a lightweight LLM classifier
   * to determine if auto-approval is safe (claude-code yoloClassifier parity).
   *
   * Falls back to synchronous decide() if classifier is unavailable or times out.
   *
   * Round 5: claude-code yoloClassifier.ts parity
   */
  async decideAsync(
    toolName: string,
    toolArgs: Record<string, unknown> | undefined,
    approvalMode: ApprovalMode,
    cwd?: string,
  ): Promise<PermissionDecision> {
    // Run synchronous checks first (deny/allow rules + yolo mode)
    const syncDecision = this.decide(toolName, toolArgs, approvalMode);
    if (syncDecision !== 'ask') return syncDecision;

    // In autoEdit mode with 'ask' result → try classifier
    if (approvalMode === 'autoEdit' && cwd) {
      try {
        const { checkAutoEditApproval } = await import('./yolo-classifier.js');
        const classifierResult = await checkAutoEditApproval(
          toolName,
          toolArgs ?? {},
          cwd,
        );
        // Map classifier result to PermissionDecision
        if (classifierResult === 'allow') return 'allow';
        if (classifierResult === 'deny') return 'deny';
        // 'ask' falls through to default ask behavior
        return 'ask';
      } catch {
        // Classifier failure — fall back to ask (fail-open)
        return 'ask';
      }
    }

    return 'ask';
  }

  /**
   * Check whether a tool is "safe to auto-approve" given the current approvalMode.
   * Returns true when agent-loop should skip the user confirmation gate.
   */
  isAutoApproved(
    toolName: string,
    toolArgs: Record<string, unknown> | undefined,
    approvalMode: ApprovalMode,
  ): boolean {
    return this.decide(toolName, toolArgs, approvalMode) === 'allow';
  }

  // ── Rule management ─────────────────────────────────────────────────────────

  /**
   * Add a rule to the project-level settings.
   * @param type  'allow' | 'deny'
   * @param pattern  Tool pattern (e.g. "Bash(npm test)", "Write(src/**)")
   * @param scope  'project' | 'local' | 'user'
   */
  addRule(
    type: 'allow' | 'deny',
    pattern: string,
    scope: 'project' | 'local' | 'user' = 'project',
  ): void {
    const settingsPath = scope === 'user'
      ? USER_SETTINGS_FILE
      : scope === 'local'
        ? resolve(this.cwd, LOCAL_SETTINGS_FILE)
        : resolve(this.cwd, SETTINGS_FILE);

    const settings = loadSettingsFile(settingsPath);
    const key = type === 'allow' ? 'alwaysAllow' : 'alwaysDeny';

    if (!settings[key].includes(pattern)) {
      settings[key].push(pattern);
      saveSettingsFile(settingsPath, settings);
      this.invalidate();
    }
  }

  /**
   * Remove a rule from all settings files.
   */
  removeRule(type: 'allow' | 'deny', pattern: string): boolean {
    let removed = false;
    const paths = [
      USER_SETTINGS_FILE,
      resolve(this.cwd, SETTINGS_FILE),
      resolve(this.cwd, LOCAL_SETTINGS_FILE),
    ];
    const key = type === 'allow' ? 'alwaysAllow' : 'alwaysDeny';

    for (const settingsPath of paths) {
      if (!existsSync(settingsPath)) continue;
      const settings = loadSettingsFile(settingsPath);
      const idx = settings[key].indexOf(pattern);
      if (idx !== -1) {
        settings[key].splice(idx, 1);
        saveSettingsFile(settingsPath, settings);
        removed = true;
      }
    }
    this.invalidate();
    return removed;
  }

  /**
   * List all rules (merged from all sources, with source annotation).
   */
  listRules(): Array<{ type: 'allow' | 'deny'; pattern: string; source: string }> {
    const results: Array<{ type: 'allow' | 'deny'; pattern: string; source: string }> = [];

    const sources: Array<[PermissionSettings, string]> = [
      [this.userSettings, 'user'],
      [this.projectSettings, 'project'],
      [this.localSettings, 'local'],
    ];

    for (const [settings, source] of sources) {
      for (const pattern of settings.alwaysAllow) {
        results.push({ type: 'allow', pattern, source });
      }
      for (const pattern of settings.alwaysDeny) {
        results.push({ type: 'deny', pattern, source });
      }
    }

    return results;
  }

  /**
   * Format rules as a human-readable string for /permissions command output.
   */
  formatRules(): string {
    const rules = this.listRules();
    if (rules.length === 0) {
      return 'No permission rules configured.\n\nUse /permissions allow <pattern> or /permissions deny <pattern> to add rules.';
    }

    const byType: Record<string, string[]> = { allow: [], deny: [] };
    for (const r of rules) {
      byType[r.type].push(`  ${r.pattern} (${r.source})`);
    }

    const lines: string[] = ['Permission Rules:', ''];
    if (byType.allow.length > 0) {
      lines.push('Always Allow:');
      lines.push(...byType.allow);
      lines.push('');
    }
    if (byType.deny.length > 0) {
      lines.push('Always Deny:');
      lines.push(...byType.deny);
      lines.push('');
    }
    lines.push('Patterns: "ToolName", "ToolName(*)", "ToolName(glob)", "*"');
    return lines.join('\n');
  }
}

// ── Read-only tool set (for autoEdit mode) ────────────────────────────────────

/**
 * Tools that are automatically approved in `autoEdit` mode.
 * Matches PARALLELIZABLE_TOOLS plus other non-mutating tools.
 */
export const READ_TOOLS = new Set([
  'Read', 'read_file', 'readFile',
  'LS', 'ls', 'list_files',
  'Grep', 'grep_search',
  'WebFetch', 'WebSearch', 'web_search', 'web_fetch',
  'InspectCode', 'inspect_code',
  'DatabaseQuery', 'database_query',
  'EnvProbe', 'env_probe',
  'worktree_list', 'worktree_status', 'worktree_events',
  // MCP read-class
  'ListMcpResources', 'ReadMcpResource',
]);

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: PermissionManager | null = null;

export function getPermissionManager(cwd?: string): PermissionManager {
  if (!_instance || (cwd && _instance['cwd'] !== cwd)) {
    _instance = new PermissionManager(cwd ?? process.cwd());
  }
  return _instance;
}
