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
 *
 * Config example (.uagent/hooks.json):
 * {
 *   "hooks": [
 *     {
 *       "event": "pre_prompt",
 *       "type": "inject",
 *       "content": "Always reply in Chinese.",
 *       "description": "Force Chinese responses"
 *     },
 *     {
 *       "event": "on_slash_cmd",
 *       "command": "/standup",
 *       "type": "shell",
 *       "command_line": "cat .uagent/standup-template.md",
 *       "description": "Load daily standup template"
 *     },
 *     {
 *       "event": "on_tool_call",
 *       "tool": "Bash",
 *       "type": "shell",
 *       "command_line": "echo \"[AUDIT] Tool: $TOOL_NAME, Args: $TOOL_ARGS\" >> .uagent/audit.log",
 *       "description": "Audit log for bash calls"
 *     },
 *     {
 *       "event": "pre_prompt",
 *       "type": "shell",
 *       "command_line": "cat .uagent/context/project-summary.md",
 *       "description": "Prepend project summary to every prompt"
 *     }
 *   ]
 * }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ── Constants ─────────────────────────────────────────────────────────────────
const SHELL_HOOK_DEFAULT_TIMEOUT_MS = 5000;

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

export type HookType = 'shell' | 'inject' | 'block' | 'module';

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

    let currentValue = ctx.prompt ?? ctx.response ?? '';
    const injections: string[] = [];

    for (const hook of hooks) {
      // Apply event-specific filters
      if (ctx.event === 'on_slash_cmd' && hook.command) {
        const slashCmd = ctx.slashCmd ?? '';
        if (!slashCmd.startsWith(hook.command)) continue;
      }
      if (ctx.event === 'on_tool_call' && hook.tool && hook.tool !== '*') {
        if (ctx.toolName !== hook.tool) continue;
      }

      const result = await this.runSingleHook(hook, ctx, currentValue);
      if (!result.proceed) {
        return result; // Block: stop processing
      }
      if (result.value !== undefined) {
        currentValue = result.value;
      }
      if (result.injection) {
        injections.push(result.injection);
      }
      if (result.error) {
        // Log hook errors but continue
        process.stderr.write(`[hooks] Warning: hook "${hook.description ?? hook.type}" failed: ${result.error}\n`);
      }
    }

    return {
      proceed: true,
      value: currentValue,
      injection: injections.length > 0 ? injections.join('\n') : undefined,
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

    const timeout = hook.timeout_ms ?? SHELL_HOOK_DEFAULT_TIMEOUT_MS;

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

      // If shell hook prints output, treat it as the new/additional value
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
      const e = err as { stderr?: string; message?: string };
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

  // ── Slash command hooks ────────────────────────────────────────────────────

  /**
   * Returns custom slash commands defined by hooks.
   * Used to display them in /help output.
   */
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
