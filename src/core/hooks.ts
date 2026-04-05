/**
 * Hooks System — inspired by Codeflicker CLI's hooks feature
 *
 * Allows users to customize Agent behavior via .uagent/hooks.json
 * configuration file. Hooks intercept key lifecycle events:
 *
 *   pre_prompt      — transform/augment the user's input before sending to LLM
 *   post_response   — process/log/transform the LLM's response
 *   on_tool_call    — observe or block tool calls (e.g. audit logs, custom guards)
 *   on_slash_cmd    — define custom /slash commands in the REPL
 *   on_session_end  — cleanup or reporting when session exits
 *   on_file_change  — trigger when a file is written (for watch-mode integrations)
 *
 * Hook types:
 *   shell   — run a shell command, pipe input/output via stdin/stdout or env vars
 *   module  — require() a local JS/TS module that exports a handler function
 *   inject  — simple text injection (no execution needed)
 *   block   — block the event and return a custom message
 *   http    — POST JSON payload to an HTTP/HTTPS URL (Round 3: claude-code parity)
 *   agent   — use LLM multi-turn dialog to validate/gate the event (Round 3: claude-code parity)
 *
 * Config example (.uagent/hooks.json):
 * {
 *   "hooks": [
 *     { "event": "pre_prompt", "type": "inject", "content": "Always reply in Chinese." },
 *     { "event": "on_tool_call", "tool": "Bash", "type": "http",
 *       "url": "http://localhost:8080/audit", "timeout_ms": 5000 },
 *     { "event": "on_tool_call", "tool": "Write", "type": "agent",
 *       "agent_prompt": "Check the file being written doesn't contain hardcoded secrets: $ARGUMENTS" }
 *   ]
 * }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ── SSRF protection helper ─────────────────────────────────────────────────────
//
// Mirrors claude-code execHttpHook.ts's private IP detection.
// Blocks 10.x, 172.16-31.x, 192.168.x private ranges.
// Allows loopback: 127.x, ::1 (needed for local webhook development servers).

function isPrivateIp(hostname: string): boolean {
  // IPv6 loopback — allow
  if (hostname === '::1' || hostname === '[::1]') return false;
  // Named hosts (non-IP) — allow (DNS resolution is out-of-scope for SSRF here)
  const ipv4 = hostname.replace(/^\[|\]$/g, '');
  const parts = ipv4.split('.');
  if (parts.length !== 4) return false;
  const [a, b] = parts.map(Number);
  // 127.x.x.x — loopback, allow
  if (a === 127) return false;
  // 10.x.x.x — private, block
  if (a === 10) return true;
  // 172.16.x.x – 172.31.x.x — private, block
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.x.x — private, block
  if (a === 192 && b === 168) return true;
  // 169.254.x.x — link-local, block
  if (a === 169 && b === 254) return true;
  // 0.x.x.x — block
  if (a === 0) return true;
  return false;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const SHELL_HOOK_DEFAULT_TIMEOUT_MS = 5000;
/** Timeout for tool-related hooks — allows for slower scripts (10 min, claude-code parity) */
const TOOL_HOOK_TIMEOUT_MS = 10 * 60 * 1000;
/** Timeout for session-end hooks — must be quick to not delay exit (claude-code parity) */
const SESSION_END_HOOK_TIMEOUT_MS = 1500;

// ── Permission Decision Merging (claude-code parity) ─────────────────────────
//
// When multiple hooks fire for the same event, each may return a permissionDecision.
// Claude-code's merging rule: deny > ask > allow > passthrough
// This is a strict priority order — any 'deny' from any hook blocks the operation,
// regardless of other hooks returning 'allow'.

type PermissionDecision = 'allow' | 'ask' | 'deny' | 'passthrough';

/**
 * Merge multiple permission decisions using claude-code's priority order:
 *   deny > ask > allow > passthrough
 *
 * Returns 'passthrough' when the input array is empty.
 */
export function mergePermissionDecisions(decisions: PermissionDecision[]): PermissionDecision {
  if (decisions.length === 0) return 'passthrough';
  if (decisions.includes('deny')) return 'deny';
  if (decisions.includes('ask')) return 'ask';
  if (decisions.includes('allow')) return 'allow';
  return 'passthrough';
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type HookEvent =
  // ── Original 6 events ────────────────────────────────────────────────────
  | 'pre_prompt'           // Transform/augment user input before LLM
  | 'post_response'        // Process/log LLM response
  | 'on_tool_call'         // Observe or block tool calls
  | 'on_slash_cmd'         // Custom /slash commands
  | 'on_session_end'       // Cleanup when session exits
  | 'on_file_change'       // File write trigger (watch mode)
  // ── Extended events (Batch 2 — Claude Code parity) ───────────────────────
  | 'pre_compact'          // Before context compression (can block)
  | 'post_compact'         // After context compression completes
  | 'session_restore'      // After /resume or /rewind restores a session
  | 'model_switch'         // After /model switches to a new model
  | 'tool_permission_request'  // Dangerous command awaiting user confirmation
  | 'worktree_create'      // After git worktree is created
  | 'worktree_remove'      // After git worktree is removed
  | 'memory_ingest'        // After Dream Mode stores insights
  | 'subagent_start'       // Before a sub-agent begins execution
  | 'subagent_stop'        // After a sub-agent finishes (success or error)
  | 'task_create'          // After a task is created on the task board
  | 'task_complete'        // After a task is marked completed
  | 'cwd_change'           // After working directory changes
  | 'domain_switch'        // After /domain switches active domain
  | 'thinking_change';     // After thinking level changes (none/low/medium/high)

export type HookType = 'shell' | 'inject' | 'block' | 'module' | 'http' | 'agent';

export interface HookDefinition {
  /** Which lifecycle event this hook fires on */
  event: HookEvent;
  /** Hook implementation type */
  type: HookType;
  /** Human-readable description */
  description?: string;
  /** Enabled/disabled (default: true) */
  enabled?: boolean;

  // ── inject/block specific ──
  /** Text to inject (for type=inject) or block message (for type=block) */
  content?: string;

  // ── shell specific ──
  /** Shell command to execute (for type=shell). May reference env vars. */
  command_line?: string;
  /** Timeout in ms for shell hooks (default: 5000) */
  timeout_ms?: number;

  // ── module specific ──
  /** Relative path to a local JS module exporting a default handler */
  module_path?: string;

  // ── http specific (Round 3: claude-code HttpHook parity) ──
  /** POST target URL (for type=http). Must be http:// or https:// */
  url?: string;
  /**
   * Request headers (for type=http). Values support $VAR_NAME interpolation.
   * Only env vars listed in allowed_env_vars will be interpolated.
   */
  headers?: Record<string, string>;
  /**
   * Allowlist of environment variable names that can be interpolated into headers.
   * Prevents accidental secret leakage via header injection.
   */
  allowed_env_vars?: string[];

  // ── agent specific (Round 3: claude-code AgentHook parity) ──
  /**
   * Prompt for the LLM to evaluate (for type=agent).
   * Supports $ARGUMENTS placeholder which is replaced with the hook input JSON.
   */
  agent_prompt?: string;
  /** LLM model to use for agent hooks (default: compact model) */
  agent_model?: string;

  // ── event-specific filters ──
  /** For on_slash_cmd: the /command string to match (e.g. "/standup") */
  command?: string;
  /** For on_tool_call: tool name to match (or "*" for all) */
  tool?: string;
  /** For on_file_change: glob pattern for files to watch */
  file_pattern?: string;
}

export interface HooksConfig {
  hooks: HookDefinition[];
}

export interface HookContext {
  event: HookEvent;
  /** For pre_prompt: the user's raw input */
  prompt?: string;
  /** For post_response: the LLM's response text */
  response?: string;
  /** For on_tool_call / tool_permission_request: tool name and args */
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  /** For on_slash_cmd: the full slash command input */
  slashCmd?: string;
  /** For on_file_change: the changed file path */
  filePath?: string;
  /** For model_switch / domain_switch: new value */
  newValue?: string;
  /** For model_switch / domain_switch: previous value */
  prevValue?: string;
  /** For worktree_create/remove: worktree info */
  worktreeName?: string;
  worktreePath?: string;
  /** For task_create/complete: task info */
  taskId?: number;
  taskSubject?: string;
  /** For subagent_start/stop: agent name and result */
  agentName?: string;
  agentResult?: string;
  /** For pre_compact/post_compact: token counts */
  tokensBefore?: number;
  tokensAfter?: number;
  /** For memory_ingest: how many insights were added */
  memoriesAdded?: number;
  /** Current working directory */
  cwd?: string;
}

export interface HookResult {
  /** Whether to continue normal processing */
  proceed: boolean;
  /** Modified value (e.g. augmented prompt, transformed response) */
  value?: string;
  /** Extra text appended to prompt (for inject hooks) */
  injection?: string;
  /** Error message if hook failed */
  error?: string;
  /**
   * For PreToolUse shell hooks: modified tool input to use instead of original.
   * Set via JSON stdout: { "hookSpecificOutput": { "updatedInput": {...} } }
   */
  updatedInput?: Record<string, unknown>;
  /**
   * Whether the hook requests blocking the tool/operation.
   * Set via exit code 2 from shell hooks, or { "proceed": false } from module hooks.
   */
  blocked?: boolean;
  /** Human-readable reason for blocking (displayed to user) */
  blockReason?: string;
  /**
   * Four-level permission decision (claude-code parity).
   * Used to merge decisions from multiple hooks with clear priority:
   *   deny > ask > allow > passthrough
   *
   * Set via JSON stdout: { "hookSpecificOutput": { "permissionDecision": "deny" } }
   */
  permissionDecision?: 'allow' | 'ask' | 'deny' | 'passthrough';
}

// ── HookRunner ────────────────────────────────────────────────────────────────

const CONFIG_FILE = '.uagent/hooks.json';
const EXAMPLE_CONFIG: HooksConfig = {
  hooks: [
    {
      event: 'pre_prompt',
      type: 'inject',
      content: '<!-- Example: inject project context before every prompt -->',
      description: 'Example: inject text before every prompt (disabled)',
      enabled: false,
    },
    {
      event: 'on_slash_cmd',
      command: '/standup',
      type: 'inject',
      content: 'Please generate a daily standup summary based on our conversation so far.',
      description: 'Custom /standup command — summarize progress',
      enabled: true,
    },
    {
      event: 'on_tool_call',
      tool: 'Bash',
      type: 'shell',
      command_line: 'echo "[$(date +%H:%M:%S)] Bash: $TOOL_ARGS_CMD" >> .uagent/bash-audit.log',
      description: 'Audit log: record all bash commands (disabled by default)',
      enabled: false,
    },
  ],
};

export class HookRunner {
  private config: HooksConfig;
  private configPath: string;
  private cwd: string;
  /** mtime of the last successfully loaded config file (ms). 0 = not loaded yet. */
  private _configMtimeMs = 0;

  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
    this.configPath = resolve(cwd, CONFIG_FILE);
    this.config = this.loadConfig();
  }

  // ── Config management ──────────────────────────────────────────────────────

  private loadConfig(): HooksConfig {
    if (!existsSync(this.configPath)) {
      return { hooks: [] };
    }
    // mtime cache: skip disk read when file hasn't changed since last load.
    // Checked via statSync (syscall only, no file read) before the heavier
    // readFileSync + JSON.parse. Saves I/O on every tool call where reload()
    // is invoked proactively.
    try {
      const mtimeMs = statSync(this.configPath).mtimeMs;
      if (this._configMtimeMs !== 0 && mtimeMs === this._configMtimeMs) {
        return this.config; // file unchanged — return cached result
      }
      this._configMtimeMs = mtimeMs;
    } catch { /* statSync failure is non-fatal; fall through to readFileSync */ }
    try {
      const raw = JSON.parse(readFileSync(this.configPath, 'utf-8'));
      // Defensive check: hooks must be an array; reject malformed config silently
      if (typeof raw !== 'object' || raw === null || !Array.isArray(raw.hooks)) {
        return { hooks: [] };
      }
      return raw as HooksConfig;
    } catch (err) {
      // Hooks config exists but failed to parse — warn loudly so the user knows
      // their hooks are NOT running (silent fallback to [] would be invisible).
      console.warn(`[hooks] Failed to parse hooks config at ${this.configPath}, running without hooks. Error: ${String(err)}`);
      return { hooks: [] };
    }
  }

  reload(): void {
    this.config = this.loadConfig();
  }

  static init(cwd: string): string {
    const dir = resolve(cwd, '.uagent');
    mkdirSync(dir, { recursive: true });
    const configPath = resolve(cwd, CONFIG_FILE);
    if (existsSync(configPath)) {
      return `Hooks config already exists: ${CONFIG_FILE}`;
    }
    writeFileSync(configPath, JSON.stringify(EXAMPLE_CONFIG, null, 2) + '\n', 'utf-8');
    return `✓ Created ${CONFIG_FILE} with example hooks.`;
  }

  listHooks(): HookDefinition[] {
    return this.config.hooks;
  }

  hasHooksFor(event: HookEvent): boolean {
    return this.config.hooks.some(
      (h) => h.event === event && h.enabled !== false,
    );
  }

  // ── Hook execution ─────────────────────────────────────────────────────────

  async run(ctx: HookContext): Promise<HookResult> {
    const hooks = this.config.hooks.filter(
      (h) => h.event === ctx.event && h.enabled !== false,
    );

    if (hooks.length === 0) return { proceed: true };

    // Apply event-specific pre-filters to narrow matching hooks
    const matchingHooks = hooks.filter((hook) => {
      if (ctx.event === 'on_slash_cmd' && hook.command) {
        return (ctx.slashCmd ?? '').startsWith(hook.command);
      }
      if (ctx.event === 'on_tool_call' && hook.tool && hook.tool !== '*') {
        return ctx.toolName === hook.tool;
      }
      return true;
    });

    if (matchingHooks.length === 0) return { proceed: true };

    let currentValue = ctx.prompt ?? ctx.response ?? '';
    const injections: string[] = [];
    let updatedInput: Record<string, unknown> | undefined;
    // ── Four-level permission decision collection (claude-code parity) ────────
    const permissionDecisions: Array<'allow' | 'ask' | 'deny' | 'passthrough'> = [];

    // ── Concurrent execution (inspired by claude-code's all() generator) ──────
    // Run all hooks concurrently via Promise.allSettled for maximum throughput.
    // Results are processed in declaration order (not completion order) to ensure
    // deterministic precedence: first block wins, last updatedInput wins.
    //
    // Exception: if any hook has type='block', we short-circuit immediately.
    // (Serial fallback would be simpler but 3× slower for 3 concurrent hooks.)
    const results = await Promise.allSettled(
      matchingHooks.map((hook) => this.runSingleHook(hook, ctx, currentValue)),
    );

    for (const settled of results) {
      if (settled.status === 'rejected') {
        process.stderr.write(`[hooks] Unhandled hook error: ${String(settled.reason)}\n`);
        continue;
      }
      const result = settled.value;
      if (!result.proceed || result.blocked) {
        // Block: a hook vetoed the operation — return immediately
        return { proceed: false, blocked: true, blockReason: result.blockReason };
      }
      if (result.value !== undefined) {
        currentValue = result.value;
      }
      if (result.injection) {
        injections.push(result.injection);
      }
      // Last updatedInput wins (most recently declared hook takes precedence)
      if (result.updatedInput) {
        updatedInput = result.updatedInput;
      }
      // Collect permission decisions for later merging
      if (result.permissionDecision) {
        permissionDecisions.push(result.permissionDecision);
      }
      if (result.error) {
        // Log hook errors but continue
        process.stderr.write(`[hooks] Warning: hook "${matchingHooks[results.indexOf(settled)]?.description ?? 'unknown'}" failed: ${result.error}\n`);
      }
    }

    // ── Merge permission decisions: deny > ask > allow > passthrough ──────────
    // Mirrors claude-code's mergePermissionDecisions() priority order.
    // If no permission decisions were set, the field is omitted.
    const mergedPermission = mergePermissionDecisions(permissionDecisions);

    return {
      proceed: true,
      value: currentValue,
      injection: injections.length > 0 ? injections.join('\n') : undefined,
      updatedInput,
      ...(mergedPermission !== 'passthrough' ? { permissionDecision: mergedPermission } : {}),
    };
  }

  private async runSingleHook(
    hook: HookDefinition,
    ctx: HookContext,
    currentValue: string,
  ): Promise<HookResult> {
    try {
      switch (hook.type) {
        case 'inject':
          return {
            proceed: true,
            injection: hook.content ?? '',
          };

        case 'block':
          return {
            proceed: false,
            value: hook.content ?? '(blocked by hook)',
          };

        case 'shell':
          return await this.runShellHook(hook, ctx, currentValue);

        case 'module':
          return await this.runModuleHook(hook, ctx, currentValue);

        case 'http':
          return await this.runHttpHook(hook, ctx, currentValue);

        case 'agent':
          return await this.runAgentHook(hook, ctx, currentValue);

        default:
          return { proceed: true };
      }
    } catch (err) {
      return {
        proceed: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async runShellHook(
    hook: HookDefinition,
    ctx: HookContext,
    currentValue: string,
  ): Promise<HookResult> {
    if (!hook.command_line) return { proceed: true };

    // ── Fine-grained timeout (claude-code parity) ──────────────────────────
    // Tool hooks: 10 min (heavy scripts like formatters, linters)
    // Session-end hooks: 1.5 sec (must not delay process exit)
    // Other hooks: user-configured or 5 sec default
    let defaultTimeout: number;
    if (ctx.event === 'on_session_end') {
      defaultTimeout = SESSION_END_HOOK_TIMEOUT_MS;
    } else if (ctx.event === 'on_tool_call' || ctx.event === 'tool_permission_request') {
      defaultTimeout = TOOL_HOOK_TIMEOUT_MS;
    } else {
      defaultTimeout = SHELL_HOOK_DEFAULT_TIMEOUT_MS;
    }
    const timeout = hook.timeout_ms ?? defaultTimeout;

    // #19 Shell injection mitigation: shell-escape env vars that may contain
    // user-controlled content before they are passed into `sh -c command_line`.
    // If hook.command_line references $TOOL_ARGS_CMD and tool args contain
    // shell meta-chars (;, |, &, $, `...), the shell would execute them.
    // Single-quote wrapping + escaping embedded single-quotes neutralises this.
    function shellEscape(value: string): string {
      // Replace every ' with '"'"' (end quote, literal single quote, start quote)
      // then wrap the whole thing in single quotes.
      return "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
    }

    const rawCmd = String(ctx.toolArgs?.command ?? ctx.toolArgs?.cmd ?? '');
    // #19 Security: All user-controlled env values are shell-escaped to prevent
    // indirect command injection when hook scripts use $HOOK_PROMPT etc.
    // in sh -c context (e.g., `echo $HOOK_PROMPT` with malicious prompt input).
    // shellEscape wraps values in single-quotes and escapes embedded single-quotes,
    // neutralising ;, |, &, $(...), `...`, and newline injection.
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOOK_EVENT: ctx.event,
      HOOK_CWD: this.cwd,
      HOOK_PROMPT: shellEscape(ctx.prompt ?? ''),
      HOOK_RESPONSE: shellEscape(ctx.response ?? ''),
      HOOK_TOOL_NAME: ctx.toolName ?? '',
      HOOK_TOOL_ARGS: shellEscape(ctx.toolArgs ? JSON.stringify(ctx.toolArgs) : ''),
      TOOL_NAME: ctx.toolName ?? '',
      TOOL_ARGS: shellEscape(ctx.toolArgs ? JSON.stringify(ctx.toolArgs) : ''),
      // Shell-escaped so that $TOOL_ARGS_CMD in hook scripts cannot inject commands
      TOOL_ARGS_CMD: shellEscape(rawCmd),
      HOOK_SLASH_CMD: shellEscape(ctx.slashCmd ?? ''),
      HOOK_FILE_PATH: shellEscape(ctx.filePath ?? ''),
      HOOK_CURRENT_VALUE: shellEscape(currentValue),
    };

    try {
      // Use execFileAsync (async) with 'sh' to avoid blocking the event loop.
      // stdin input is passed via HOOK_CURRENT_VALUE env var (stdin pipe not
      // supported by execFile directly; use spawn if stdin piping is required).
      const { stdout } = await execFileAsync('sh', ['-c', hook.command_line], {
        cwd: this.cwd,
        encoding: 'utf-8' as BufferEncoding,
        timeout,
        env,
      });
      const output = stdout.trim();

      // ── JSON stdout protocol (inspired by claude-code hooks) ───────────────
      // If the hook outputs a JSON object, parse it for structured control:
      //   { "hookSpecificOutput": { "updatedInput": {...} } }  → modify tool input
      //   { "proceed": false, "message": "..." }               → block operation
      //   { "injection": "..." }                               → inject text
      //
      // Plain text stdout (non-JSON) falls through to legacy injection behavior.
      if (output.startsWith('{')) {
        try {
          const json = JSON.parse(output) as Record<string, unknown>;
          // Block signal: { "proceed": false } or { "block": true }
          if (json['proceed'] === false || json['block'] === true) {
            const reason = (json['message'] ?? json['reason'] ?? 'Blocked by hook') as string;
            return { proceed: false, blocked: true, blockReason: reason };
          }
          // updatedInput + permissionDecision: PreToolUse hook-specific fields
          const hookSpecific = json['hookSpecificOutput'] as Record<string, unknown> | undefined;

          // ── Permission decision (claude-code parity) ───────────────────────
          // JSON: { "hookSpecificOutput": { "permissionDecision": "deny" } }
          // Priority: deny > ask > allow > passthrough
          const rawDecision = hookSpecific?.['permissionDecision'] as string | undefined
            ?? json['permissionDecision'] as string | undefined;
          const permissionDecision = (['allow', 'ask', 'deny', 'passthrough'].includes(rawDecision ?? ''))
            ? (rawDecision as 'allow' | 'ask' | 'deny' | 'passthrough')
            : undefined;

          if (hookSpecific?.['updatedInput']) {
            return {
              proceed: true,
              updatedInput: hookSpecific['updatedInput'] as Record<string, unknown>,
              injection: hookSpecific['additionalContext'] as string | undefined,
              permissionDecision,
            };
          }
          // injection: { "injection": "text to append" }
          if (json['injection']) {
            return { proceed: true, injection: String(json['injection']), permissionDecision };
          }
          // Permission-only response (no other action)
          if (permissionDecision && permissionDecision !== 'passthrough') {
            return { proceed: true, permissionDecision };
          }
          // Plain JSON with no recognized fields → treat as injection
          return { proceed: true, injection: output };
        } catch { /* not valid JSON — fall through to text handling */ }
      }

      // Legacy plain-text handling
      if (output) {
        // For pre_prompt: output is injected as context
        // For post_response: output replaces response (if non-empty)
        if (ctx.event === 'pre_prompt') {
          return { proceed: true, injection: output };
        } else if (ctx.event === 'post_response') {
          return { proceed: true, value: output };
        }
        return { proceed: true, injection: output };
      }
      return { proceed: true };
    } catch (err: unknown) {
      const e = err as { code?: number; stderr?: string; message?: string };
      // ── exit code 2 = blocking error (same as claude-code convention) ──────
      // exit 0: success, exit 1: non-blocking error, exit 2: BLOCK operation
      if (e.code === 2) {
        const reason = (e.stderr?.trim() || 'Operation blocked by hook (exit code 2)').slice(0, 300);
        return { proceed: false, blocked: true, blockReason: reason };
      }
      const msg = (e.stderr ?? e.message ?? String(err)).trim().slice(0, 200);
      return { proceed: true, error: msg };
    }
  }

  private async runModuleHook(
    hook: HookDefinition,
    ctx: HookContext,
    currentValue: string,
  ): Promise<HookResult> {
    if (!hook.module_path) return { proceed: true };
    const cwdResolved = resolve(this.cwd);
    const absPath = resolve(cwdResolved, hook.module_path);
    // CWE-22: reject module_path that escapes the project cwd.
    // Without this guard, a hooks.json entry like module_path: '../../evil.js'
    // could load and execute arbitrary code outside the project directory.
    if (!absPath.startsWith(cwdResolved + '/') && absPath !== cwdResolved) {
      return { proceed: true, error: `Module path traversal rejected: "${hook.module_path}" escapes project directory` };
    }
    if (!existsSync(absPath)) {
      return { proceed: true, error: `Module not found: ${absPath}` };
    }
    try {
      // Dynamic import — module should export a default async function(ctx, value) => HookResult
      const mod = await import(absPath);
      const handler = mod.default ?? mod.handler;
      if (typeof handler !== 'function') {
        return { proceed: true, error: `Module has no default export function: ${absPath}` };
      }
      const result = await handler(ctx, currentValue);
      return result as HookResult;
    } catch (err) {
      return { proceed: true, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── HTTP Hook (Round 3: claude-code HttpHook / execHttpHook parity) ─────────

  /**
   * POST hook context as JSON to a remote URL.
   *
   * Key design decisions (mirroring claude-code's execHttpHook.ts):
   *  1. SSRF protection: block private IP ranges (10.x, 172.16-31.x, 192.168.x)
   *     while allowing loopback (127.x / ::1) for local webhook servers.
   *  2. Env var interpolation in headers is restricted to allowed_env_vars whitelist.
   *  3. No redirects (redirect:'error') prevents SSRF bypass via redirect chains.
   *  4. 2xx = success, 4xx/5xx = non-blocking error (hook failure does not block).
   *  5. Response JSON: { proceed: false, message: "..." } → block; else continue.
   */
  private async runHttpHook(
    hook: HookDefinition,
    ctx: HookContext,
    currentValue: string,
  ): Promise<HookResult> {
    if (!hook.url) return { proceed: true };

    // ── SSRF protection ──────────────────────────────────────────────────────
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(hook.url);
    } catch {
      return { proceed: true, error: `HTTP hook: invalid URL "${hook.url}"` };
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return { proceed: true, error: `HTTP hook: unsupported protocol "${parsedUrl.protocol}"` };
    }
    const hostname = parsedUrl.hostname;
    if (isPrivateIp(hostname)) {
      return {
        proceed: true,
        error: `HTTP hook: SSRF protection — "${hostname}" is in a private IP range. Only loopback (127.x/::1) is allowed.`,
      };
    }

    // ── Build headers with env var interpolation (allowlist-controlled) ──────
    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'universal-agent-hook/1.0',
    };
    if (hook.headers) {
      const allowedVars = new Set(hook.allowed_env_vars ?? []);
      for (const [key, val] of Object.entries(hook.headers)) {
        const interpolated = val.replace(/\$([A-Z_][A-Z0-9_]*)/g, (match, varName) => {
          if (allowedVars.has(varName)) return process.env[varName] ?? match;
          return match;
        });
        requestHeaders[key] = interpolated;
      }
    }

    // ── Payload ──────────────────────────────────────────────────────────────
    const payload = JSON.stringify({
      event: ctx.event,
      toolName: ctx.toolName,
      toolArgs: ctx.toolArgs,
      prompt: ctx.prompt,
      response: ctx.response,
      slashCmd: ctx.slashCmd,
      filePath: ctx.filePath,
      cwd: ctx.cwd ?? this.cwd,
      currentValue,
    });

    // ── Fine-grained timeout ─────────────────────────────────────────────────
    let defaultTimeout: number;
    if (ctx.event === 'on_session_end') {
      defaultTimeout = SESSION_END_HOOK_TIMEOUT_MS;
    } else if (ctx.event === 'on_tool_call' || ctx.event === 'tool_permission_request') {
      defaultTimeout = TOOL_HOOK_TIMEOUT_MS;
    } else {
      defaultTimeout = SHELL_HOOK_DEFAULT_TIMEOUT_MS;
    }
    const timeout = hook.timeout_ms ?? defaultTimeout;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(hook.url, {
        method: 'POST',
        headers: requestHeaders,
        body: payload,
        signal: controller.signal,
        redirect: 'error',
      });
      clearTimeout(timer);

      const bodyText = await res.text().catch(() => '');
      if (!res.ok) {
        return { proceed: true, error: `HTTP hook: server returned ${res.status}` };
      }

      // ── Parse response for structured decisions ───────────────────────────
      if (bodyText.startsWith('{')) {
        try {
          const json = JSON.parse(bodyText) as Record<string, unknown>;
          if (json['proceed'] === false || json['block'] === true) {
            const reason = String(json['message'] ?? json['reason'] ?? 'Blocked by HTTP hook');
            return { proceed: false, blocked: true, blockReason: reason };
          }
          const rawDecision = json['permissionDecision'] as string | undefined;
          const permissionDecision = (['allow', 'ask', 'deny', 'passthrough'].includes(rawDecision ?? ''))
            ? (rawDecision as 'allow' | 'ask' | 'deny' | 'passthrough')
            : undefined;
          const hookSpecific = (json['hookSpecificOutput'] as Record<string, unknown>) ?? json;
          if (hookSpecific['updatedInput']) {
            return {
              proceed: true,
              updatedInput: hookSpecific['updatedInput'] as Record<string, unknown>,
              injection: hookSpecific['additionalContext'] as string | undefined,
              permissionDecision,
            };
          }
          if (json['injection']) {
            return { proceed: true, injection: String(json['injection']), permissionDecision };
          }
          if (permissionDecision && permissionDecision !== 'passthrough') {
            return { proceed: true, permissionDecision };
          }
        } catch { /* non-JSON body — not an error */ }
      }
      return { proceed: true };
    } catch (err: unknown) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('aborted') || msg.includes('signal')) {
        return { proceed: true, error: `HTTP hook: timeout after ${timeout}ms` };
      }
      return { proceed: true, error: `HTTP hook: ${msg.slice(0, 200)}` };
    }
  }

  // ── Agent Hook (Round 3: claude-code AgentHook / execAgentHook parity) ──────

  /**
   * Use LLM multi-turn evaluation to gate the operation.
   *
   * Key design decisions (mirroring claude-code's execAgentHook.ts):
   *  1. Isolated context: fresh LLM call with no main agent history contamination.
   *  2. Compact model: fast decisions (< 5 seconds typical).
   *  3. Structured output: forces { ok: boolean, reason?: string } JSON.
   *  4. ok=false → block with reason; ok=true → proceed; failure → fail-open.
   *  5. $ARGUMENTS placeholder in agent_prompt is replaced with hook input JSON.
   */
  private async runAgentHook(
    hook: HookDefinition,
    ctx: HookContext,
    currentValue: string,
  ): Promise<HookResult> {
    if (!hook.agent_prompt) return { proceed: true };

    const timeout = hook.timeout_ms ?? (ctx.event === 'on_session_end' ? SESSION_END_HOOK_TIMEOUT_MS : 30_000);

    const args = JSON.stringify({
      event: ctx.event,
      toolName: ctx.toolName,
      toolArgs: ctx.toolArgs,
      prompt: ctx.prompt?.slice(0, 500),
      filePath: ctx.filePath,
      cwd: ctx.cwd ?? this.cwd,
      currentValue: currentValue.slice(0, 500),
    });

    const evaluationPrompt = hook.agent_prompt.replace(/\$ARGUMENTS/g, args);

    const systemPrompt =
      `You are evaluating a hook condition in an AI agent system.\n` +
      `Your response must be a JSON object matching exactly ONE of these schemas:\n` +
      `1. If the condition is met (OK to proceed): {"ok": true}\n` +
      `2. If the condition is not met (should block): {"ok": false, "reason": "Brief reason why"}\n` +
      `Do not include any other text — only the JSON object.`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const { modelManager } = await import('../models/model-manager.js');
      const client = modelManager.getClient('compact');

      const response = await client.chat({
        systemPrompt,
        messages: [{ role: 'user', content: evaluationPrompt }],
      });
      clearTimeout(timer);

      const rawContent = (response.content ?? '').trim();
      const jsonMatch = rawContent.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) {
        return { proceed: true, error: 'Agent hook: no JSON response from LLM' };
      }

      const result = JSON.parse(jsonMatch[0]) as { ok: boolean; reason?: string };
      if (!result.ok) {
        const reason = String(result.reason ?? 'Condition not met by agent hook');
        return { proceed: false, blocked: true, blockReason: `[Agent hook] ${reason}` };
      }
      return { proceed: true };
    } catch (err: unknown) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      // Agent hook failures are always non-blocking (fail-open)
      return { proceed: true, error: `Agent hook: ${msg.slice(0, 200)}` };
    }
  }

  // ── Slash command hooks ────────────────────────────────────────────────────
  listSlashCommands(): Array<{ command: string; description: string }> {
    return this.config.hooks
      .filter((h) => h.event === 'on_slash_cmd' && h.command && h.enabled !== false)
      .map((h) => ({
        command: h.command!,
        description: h.description ?? '(custom hook)',
      }));
  }

  /**
   * Check if a slash command matches any hook, and return the result.
   * Returns null if no matching hook.
   */
  async handleSlashCmd(input: string): Promise<{ handled: boolean; output: string }> {
    const matchingHooks = this.config.hooks.filter(
      (h) => h.event === 'on_slash_cmd'
        && h.command
        && h.enabled !== false
        && input.startsWith(h.command),
    );

    if (matchingHooks.length === 0) return { handled: false, output: '' };

    const ctx: HookContext = {
      event: 'on_slash_cmd',
      slashCmd: input,
      cwd: this.cwd,
    };

    const outputs: string[] = [];
    for (const hook of matchingHooks) {
      const result = await this.runSingleHook(hook, ctx, input);
      if (!result.proceed && result.value) {
        return { handled: true, output: result.value };
      }
      if (result.injection) outputs.push(result.injection);
      if (result.value) outputs.push(result.value);
    }

    return {
      handled: outputs.length > 0 || matchingHooks.length > 0,
      output: outputs.join('\n'),
    };
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _runner: HookRunner | null = null;

// ── agent.ts compatibility: internal hook events ──────────────────────────────
// agent.ts uses triggerHook/createHookEvent for its own internal lifecycle events
// (session:start, agent:turn, tool:before/after/error, agent:compact).
// These are internal framework events, not user-configurable hooks.
// We re-export compatible stubs here so agent.ts continues to compile.

export type InternalHookDomain = 'session' | 'agent' | 'tool';
export type InternalHookAction = 'start' | 'turn' | 'compact' | 'before' | 'after' | 'error';

export interface InternalHookEvent {
  domain: InternalHookDomain;
  action: InternalHookAction;
  data?: Record<string, unknown>;
}

/**
 * Create an internal hook event object.
 * Used by agent.ts to signal lifecycle transitions (session start, tool calls, etc.)
 */
export function createHookEvent(
  domain: InternalHookDomain,
  action: InternalHookAction,
  data?: Record<string, unknown>,
): InternalHookEvent {
  return { domain, action, data };
}

/**
 * Fire an internal hook event, routing to HookRunner for user-observable events.
 *
 * Extended events (Batch 2) now route through the HookRunner so users can
 * configure shell/inject hooks for pre_compact, model_switch, worktree_create,
 * task_create, subagent_start, etc.
 */
export async function triggerHook(event: InternalHookEvent): Promise<void> {
  // Map internal domain:action → public HookEvent where applicable
  const runner = _runner;
  if (!runner) return;

  // Only route events that have a corresponding public HookEvent
  const mapping: Partial<Record<string, HookEvent>> = {
    'agent:compact': 'pre_compact',
    'session:start': 'on_slash_cmd', // Not mapped — session:start is internal only
  };
  const key = `${event.domain}:${event.action}`;
  const publicEvent = mapping[key];
  if (!publicEvent) return;

  if (!runner.hasHooksFor(publicEvent)) return;
  await runner.run({
    event: publicEvent,
    cwd: process.cwd(),
    ...((event.data ?? {}) as Partial<HookContext>),
  });
}

export function getHookRunner(cwd?: string): HookRunner {
  if (!_runner || (cwd && _runner['cwd'] !== cwd)) {
    _runner = new HookRunner(cwd ?? process.cwd());
  }
  return _runner;
}

export function reloadHooks(): void {
  _runner?.reload();
}

/**
 * Emit a public HookEvent directly (Batch 2 extended events).
 * Non-blocking: errors are swallowed so hooks never crash agent flow.
 */
export function emitHook(event: HookEvent, ctx: Partial<HookContext> = {}): void {
  const runner = _runner;
  if (!runner) return;
  if (!runner.hasHooksFor(event)) return;
  // Fire-and-forget; errors are non-fatal
  runner.run({ event, cwd: process.cwd(), ...ctx }).catch(() => { /* non-fatal */ });
}
