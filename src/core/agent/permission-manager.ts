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

import { existsSync, readFileSync, writeFileSync, mkdirSync, watchFile, unwatchFile } from 'fs';
import { resolve, join } from 'path';
import { normalizeCommandForPermissionCheck } from '../../utils/bash-security.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export type ApprovalMode = 'default' | 'autoEdit' | 'yolo';

/** Three-level permission decision (mirrors claude-code's allow/ask/deny) */
export type PermissionDecision = 'allow' | 'ask' | 'deny';

export interface PermissionSettings {
  /** Tools/patterns that are always allowed without prompting */
  alwaysAllow: string[];
  /** Tools/patterns that are always denied */
  alwaysDeny: string[];
  /**
   * Tools/patterns that MUST be confirmed by the user even in yolo mode.
   * Mirrors claude-code's ask[] permission tier.
   * Example: ["Bash(deploy*)", "Bash(prod*)"]
   */
  ask?: string[];
  /**
   * Additional directories (outside CWD) the agent is allowed to read/write.
   * Paths may use ~ expansion. Mirrors claude-code's additionalDirectories.
   * Example: ["/tmp/workspace", "~/repos/shared"]
   */
  additionalDirectories?: string[];
  /**
   * Extra environment variables injected into all tool subprocess executions.
   * Mirrors claude-code's SettingsJson.env field.
   * Example: { "NODE_ENV": "development", "DEBUG": "app:*" }
   */
  env?: Record<string, string>;
  /**
   * Number of days after which old session files are automatically cleaned up.
   * Set to 0 to disable cleanup. Default: 30.
   * Mirrors claude-code's cleanupPeriodDays.
   */
  cleanupPeriodDays?: number;
  /**
   * Language the agent must use when replying.
   * Injected as a system prompt suffix on every turn.
   * Mirrors claude-code's language setting.
   * Example: "zh-CN", "en-US", "Japanese"
   */
  language?: string;
  /**
   * Default shell to use when executing Bash commands.
   * Falls back to process.env.SHELL then auto-detection.
   * Mirrors claude-code's defaultShell setting.
   * Example: "/bin/zsh", "/usr/bin/bash"
   */
  defaultShell?: string;
}

const EMPTY_SETTINGS: PermissionSettings = {
  alwaysAllow: [],
  alwaysDeny: [],
  ask: [],
  additionalDirectories: [],
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
      ask: Array.isArray(raw.ask) ? raw.ask : [],
      additionalDirectories: Array.isArray(raw.additionalDirectories) ? raw.additionalDirectories : [],
      env: raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env) ? raw.env as Record<string, string> : undefined,
      cleanupPeriodDays: typeof raw.cleanupPeriodDays === 'number' ? raw.cleanupPeriodDays : undefined,
      language: typeof raw.language === 'string' ? raw.language : undefined,
      defaultShell: typeof raw.defaultShell === 'string' ? raw.defaultShell : undefined,
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

// ── settings.json watchFile hot-reload (C11: claude-code settingsCache.ts parity) ────────────
//
// Watches each settings file for changes and auto-invalidates the PermissionManager cache.
// This mirrors claude-code's resetSettingsCache() behavior triggered by file watchers.
// Uses polling (watchFile) instead of inotify (fs.watch) for cross-platform reliability.
//
// Auto-unwatches after 30 minutes to prevent memory/fd leaks on long-running sessions.

const _settingsWatchers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Register a watchFile listener for a settings file path.
 * On change: calls manager.invalidate() so the next read re-parses from disk.
 * Idempotent: calling twice for the same path is safe (no duplicate listeners).
 */
function watchSettingsFile(filePath: string, manager: PermissionManager): void {
  if (_settingsWatchers.has(filePath)) return;

  // Use polling interval of 2s — less responsive than inotify but works on
  // network filesystems, Docker volumes, and macOS where fs.watch is flaky.
  watchFile(filePath, { interval: 2000, persistent: false }, () => {
    manager.invalidate();
  });

  // Auto-unwatch after 30 minutes to prevent fd/memory leaks.
  // PermissionManager is typically re-created each agent session anyway.
  const timer = setTimeout(() => {
    unwatchFile(filePath);
    _settingsWatchers.delete(filePath);
  }, 30 * 60 * 1000);
  // Allow the timer to be garbage-collected when the process is about to exit
  if (typeof timer === 'object' && timer.unref) timer.unref();

  _settingsWatchers.set(filePath, timer);
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
      // C11: hot-reload — watch for changes and auto-invalidate cache
      watchSettingsFile(USER_SETTINGS_FILE, this);
    }
    return this._userSettings;
  }

  private get projectSettings(): PermissionSettings {
    if (!this._projectSettings) {
      const path = resolve(this.cwd, SETTINGS_FILE);
      this._projectSettings = loadSettingsFile(path);
      // C11: hot-reload — watch project settings file
      watchSettingsFile(path, this);
    }
    return this._projectSettings;
  }

  private get localSettings(): PermissionSettings {
    if (!this._localSettings) {
      const path = resolve(this.cwd, LOCAL_SETTINGS_FILE);
      this._localSettings = loadSettingsFile(path);
      // C11: hot-reload — watch local settings file (may not exist yet, watchFile tolerates this)
      watchSettingsFile(path, this);
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

  /**
   * Merged ask[] rules — force user confirmation even in yolo mode.
   * Mirrors claude-code's ask[] permission tier.
   */
  get allAsk(): string[] {
    return [
      ...(this.userSettings.ask ?? []),
      ...(this.projectSettings.ask ?? []),
      ...(this.localSettings.ask ?? []),
    ];
  }

  /**
   * Merged additionalDirectories list (~ expanded to HOME).
   * Returns resolved absolute paths.
   */
  get allAdditionalDirectories(): string[] {
    const home = process.env.HOME ?? '';
    const expand = (p: string) => p.startsWith('~') ? p.replace(/^~/, home) : p;
    return [
      ...(this.userSettings.additionalDirectories ?? []),
      ...(this.projectSettings.additionalDirectories ?? []),
      ...(this.localSettings.additionalDirectories ?? []),
    ].map(expand);
  }

  /**
   * Check whether a given file path is accessible.
   * A path is allowed if it falls under CWD or any additionalDirectories entry.
   */
  isPathAllowed(filePath: string): boolean {
    const abs = resolve(filePath);
    if (abs.startsWith(resolve(this.cwd))) return true;
    for (const dir of this.allAdditionalDirectories) {
      if (abs.startsWith(resolve(dir))) return true;
    }
    return false;
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
   * Priority (claude-code parity, B9 updated):
   *   1. alwaysDeny  → deny  (any source can deny, highest priority)
   *   2. ask[]       → ask   (force confirmation even in yolo mode)
   *   3. alwaysAllow → allow
   *   4. approvalMode-dependent fallback:
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

    // B16: 对 Bash 工具执行命令规范化（剖离前置 env var + wrapper）
    // 防止 `LD_PRELOAD=/x.so denied_cmd` 或 `timeout 30 denied_cmd` 绕过 deny 规则
    let normalizedArgs = args;
    if (toolName === 'Bash' && typeof args['command'] === 'string') {
      let binaryHijackDetected = false;
      const normalized = normalizeCommandForPermissionCheck(
        args['command'] as string,
        () => { binaryHijackDetected = true; },
      );
      if (binaryHijackDetected || normalized !== args['command']) {
        normalizedArgs = { ...args, command: normalized, _originalCommand: args['command'] };
      }
    }

    // 1. Check deny rules (highest priority — any deny wins)
    for (const pattern of this.allAlwaysDeny) {
      if (matchesPattern(pattern, toolName, normalizedArgs)) return 'deny';
    }

    // 2. Check ask[] rules (force confirmation even in yolo mode)
    for (const pattern of this.allAsk) {
      if (matchesPattern(pattern, toolName, normalizedArgs)) return 'ask';
    }

    // 3. Check allow rules
    for (const pattern of this.allAlwaysAllow) {
      if (matchesPattern(pattern, toolName, normalizedArgs)) return 'allow';
    }

    // 4. ApprovalMode fallback
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
   * @param type  'allow' | 'ask' | 'deny'
   * @param pattern  Tool pattern (e.g. "Bash(npm test)", "Write(src/**)")
   * @param scope  'project' | 'local' | 'user'
   */
  addRule(
    type: 'allow' | 'ask' | 'deny',
    pattern: string,
    scope: 'project' | 'local' | 'user' = 'project',
  ): void {
    const settingsPath = scope === 'user'
      ? USER_SETTINGS_FILE
      : scope === 'local'
        ? resolve(this.cwd, LOCAL_SETTINGS_FILE)
        : resolve(this.cwd, SETTINGS_FILE);

    const settings = loadSettingsFile(settingsPath);
    const key = type === 'allow' ? 'alwaysAllow' : type === 'ask' ? 'ask' : 'alwaysDeny';
    const list = ((settings[key as keyof PermissionSettings] ?? []) as string[]);

    if (!list.includes(pattern)) {
      list.push(pattern);
      (settings as unknown as Record<string, unknown>)[key] = list;
      saveSettingsFile(settingsPath, settings);
      this.invalidate();
    }
  }

  /**
   * Add a directory to the additionalDirectories list.
   * @param dir  Absolute path or ~ path
   * @param scope  'project' | 'local' | 'user'
   */
  addDirectory(dir: string, scope: 'project' | 'local' | 'user' = 'project'): void {
    const settingsPath = scope === 'user'
      ? USER_SETTINGS_FILE
      : scope === 'local'
        ? resolve(this.cwd, LOCAL_SETTINGS_FILE)
        : resolve(this.cwd, SETTINGS_FILE);

    const settings = loadSettingsFile(settingsPath);
    const dirs = settings.additionalDirectories ?? [];
    if (!dirs.includes(dir)) {
      dirs.push(dir);
      settings.additionalDirectories = dirs;
      saveSettingsFile(settingsPath, settings);
      this.invalidate();
    }
  }

  /**
   * Remove a rule from all settings files.
   */
  removeRule(type: 'allow' | 'ask' | 'deny', pattern: string): boolean {
    let removed = false;
    const paths = [
      USER_SETTINGS_FILE,
      resolve(this.cwd, SETTINGS_FILE),
      resolve(this.cwd, LOCAL_SETTINGS_FILE),
    ];
    const key = type === 'allow' ? 'alwaysAllow' : type === 'ask' ? 'ask' : 'alwaysDeny';

    for (const settingsPath of paths) {
      if (!existsSync(settingsPath)) continue;
      const settings = loadSettingsFile(settingsPath);
      const list = ((settings[key as keyof PermissionSettings] ?? []) as string[]);
      const idx = list.indexOf(pattern);
      if (idx !== -1) {
        list.splice(idx, 1);
        (settings as unknown as Record<string, unknown>)[key] = list;
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
  listRules(): Array<{ type: 'allow' | 'ask' | 'deny'; pattern: string; source: string }> {
    const results: Array<{ type: 'allow' | 'ask' | 'deny'; pattern: string; source: string }> = [];

    const sources: Array<[PermissionSettings, string]> = [
      [this.userSettings, 'user'],
      [this.projectSettings, 'project'],
      [this.localSettings, 'local'],
    ];

    for (const [settings, source] of sources) {
      for (const pattern of settings.alwaysAllow) {
        results.push({ type: 'allow', pattern, source });
      }
      for (const pattern of (settings.ask ?? [])) {
        results.push({ type: 'ask', pattern, source });
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
    const dirs = this.allAdditionalDirectories;
    const hasRules = rules.length > 0;
    const hasDirs = dirs.length > 0;

    if (!hasRules && !hasDirs) {
      return 'No permission rules configured.\n\nUse /permissions allow <pattern> or /permissions deny <pattern> to add rules.';
    }

    const byType: Record<string, string[]> = { allow: [], ask: [], deny: [] };
    for (const r of rules) {
      byType[r.type].push(`  ${r.pattern} (${r.source})`);
    }

    const lines: string[] = ['Permission Rules:', ''];
    if (byType.allow.length > 0) {
      lines.push('Always Allow:');
      lines.push(...byType.allow);
      lines.push('');
    }
    if (byType.ask.length > 0) {
      lines.push('Always Ask (even in yolo mode):');
      lines.push(...byType.ask);
      lines.push('');
    }
    if (byType.deny.length > 0) {
      lines.push('Always Deny:');
      lines.push(...byType.deny);
      lines.push('');
    }
    if (hasDirs) {
      lines.push('Additional Directories:');
      for (const d of dirs) lines.push(`  ${d}`);
      lines.push('');
    }
    lines.push('Patterns: "ToolName", "ToolName(*)", "ToolName(glob)", "*"');
    return lines.join('\n');
  }

  /**
   * E16: clearClassifierApprovals — 清理 yolo classifier 的审批记录缓存
   * 对标 claude-code clearClassifierApprovals()，在 postCompactCleanup 中被调用。
   * 压缩后需要重置审批缓存，避免旧的 allow 判断影响新对话。
   */
  clearClassifierApprovals(): void {
    // yolo-classifier 的判断缓存存储在 yolo-classifier.ts 模块内部
    // 这里调用 module-level 的 clearClassifierApprovals 进行清理
    clearYoloClassifierCache();
  }
}

// ── E16: Module-level classifier cache clear ──────────────────────────────────

/**
 * E16: clearSpeculativeChecks — 模块级 speculative check 缓存清理
 * 导出供 post-compact-cleanup.ts 的 tryCall 调用
 */
export function clearSpeculativeChecks(): void {
  // PermissionManager 不持有 speculative 状态，此函数为兼容性导出
  // 实际的 speculative 状态在 streaming-tool-executor.ts 中（无持久缓存）
}

/**
 * E16: clearClassifierApprovals — 模块级 classifier 审批缓存清理
 * 导出供 post-compact-cleanup.ts 的 tryCall 调用
 */
export function clearClassifierApprovals(): void {
  clearYoloClassifierCache();
}

/** 调用 yolo-classifier 的缓存清理（懒加载，避免循环依赖） */
function clearYoloClassifierCache(): void {
  // 通过动态 import 调用 yolo-classifier 的清理函数（避免循环依赖）
  // 使用异步但 fire-and-forget 模式（清理失败不阻塞主流程）
  import('./yolo-classifier.js').then((mod) => {
    const fn = (mod as Record<string, unknown>)['clearClassifierCache'];
    if (typeof fn === 'function') (fn as () => void)();
  }).catch(() => { /* yolo-classifier 未加载时忽略 */ });
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

// ── getUserSetting() helper (B10: claude-code parity) ─────────────────────────
//
// Merges settings from all three layers (user < project < local) for a single key.
// The local layer wins over project, project wins over user.
// Returns undefined if the key is not set in any layer.

type SettingsKey = keyof PermissionSettings;

/**
 * Get a single setting value, merged across all layers (local > project > user).
 * Generic helper to avoid repeating the 3-layer merge for every setting.
 */
export function getUserSetting<K extends SettingsKey>(key: K, cwd?: string): PermissionSettings[K] | undefined {
  const pm = getPermissionManager(cwd);
  // Access private fields via the lazy-loading getters
  const local = (pm as unknown as { localSettings: PermissionSettings }).localSettings;
  const project = (pm as unknown as { projectSettings: PermissionSettings }).projectSettings;
  const user = (pm as unknown as { userSettings: PermissionSettings }).userSettings;

  // For array fields, merge (handled by PermissionManager getters directly)
  // For scalar fields: local wins, then project, then user
  if (local[key] !== undefined) return local[key];
  if (project[key] !== undefined) return project[key];
  if (user[key] !== undefined) return user[key];
  return undefined;
}

/**
 * Get merged env variables from all settings layers.
 * All layers are merged, with local > project > user priority.
 */
export function getMergedEnv(cwd?: string): Record<string, string> {
  const pm = getPermissionManager(cwd);
  const local = (pm as unknown as { localSettings: PermissionSettings }).localSettings;
  const project = (pm as unknown as { projectSettings: PermissionSettings }).projectSettings;
  const user = (pm as unknown as { userSettings: PermissionSettings }).userSettings;
  return {
    ...(user.env ?? {}),
    ...(project.env ?? {}),
    ...(local.env ?? {}),
  };
}

/**
 * Get the effective cleanup period in days (default 30).
 * Returns 0 if cleanup is disabled.
 */
export function getCleanupPeriodDays(cwd?: string): number {
  const val = getUserSetting('cleanupPeriodDays', cwd);
  return val ?? 30;
}
