import type { LLMClient, Message } from '../models/types.js';
import { modelManager } from '../models/model-manager.js';
import { DomainRouter } from './domain-router.js';
import { ToolRegistry } from './tool-registry.js';
import { buildSystemPromptWithContext } from './context/context-loader.js';
import { subagentSystem, createTaskTool, askExpertModelTool } from './subagent-system.js';
import { readFileTool, writeFileTool, editFileTool, bashTool, listFilesTool, grepTool } from './tools/fs/fs-tools.js';
import { webFetchTool, webSearchTool } from './tools/web/web-tools.js';
import { codeInspectorTool } from './tools/code/code-inspector.js';
import { selfHealTool } from './tools/code/self-heal.js';
import { spawnAgentTool, spawnParallelTool } from './tools/agents/spawn-agent.js';
import { coordinatorRunTool } from './tools/agents/coordinator-tool.js';
import { businessDefectDetectorTool } from './tools/code/business-defect-detector.js';
import { reverseAnalyzeTool } from './tools/code/reverse-analyze.js';
import { loadSkillTool, runSkillTool } from './tools/productivity/skill-tool.js';
import { readDocTool, docSearchTool, fetchDocTool } from './tools/productivity/docs-tool.js';
import { scriptSaveTool, scriptRunTool, scriptListTool } from './tools/productivity/script-tools.js';
import { testRunnerTool } from './tools/productivity/test-runner.js';
import { envProbeTool } from './tools/productivity/env-probe.js';
import {
  wsServerStartTool, wsServerStopTool, wsServerStatusTool,
  wsBroadcastTool, wsInboxTool, wsMockInjectTool,
} from './tools/productivity/ws-mcp-server.js';
import {
  proxyStartTool, proxyStopTool, proxyStatusTool,
  proxyCapturesTool, proxyMockTool, proxyMockListTool, proxyMockClearTool, proxyClearTool,
} from './tools/productivity/proxy-tools.js';
import { curlExecuteTool } from './tools/productivity/curl-tool.js';
import {
  githubCreatePRTool,
  githubListPRsTool,
  githubMergePRTool,
} from './tools/productivity/github-pr-tool.js';
import { autopilotRunTool } from './tools/agents/autopilot-tool.js';
import {
  terminalSendTool,
  terminalReadTool,
  terminalExecTool,
  terminalListTool,
} from './tools/productivity/terminal-ipc-tool.js';
import { redisProbeTool } from './tools/productivity/redis-probe.js';
import { databaseQueryTool } from './tools/productivity/database-query.js';
import { taskCreateTool, taskUpdateTool, taskListTool, taskGetTool } from './task-board.js';
import { backgroundRunTool, checkBackgroundTool, killBashTool } from './tools/productivity/background-tools.js';
import { backgroundManager } from './background-manager.js';
import { todoWriteTool, todoManager } from './tools/productivity/todo-tool.js';
import {
  spawnTeammateTool,
  listTeammatesTool,
  sendMessageTool,
  readInboxTool,
  broadcastTool,
  shutdownRequestTool,
  planApprovalTool,
  claimTaskFromBoardTool,
  getTeammateManager,
} from './teammate-manager.js';
import {
  worktreeCreateTool,
  worktreeListTool,
  worktreeStatusTool,
  worktreeRunTool,
  worktreeRemoveTool,
  worktreeKeepTool,
  worktreeEventsTool,
  taskBindWorktreeTool,
} from './tools/agents/worktree-tools.js';
import { MCPManager } from './mcp-manager.js';
import { autoCompact, reactiveCompact } from './context/context-compressor.js';
import {
  updateSessionMemory,
  trySessionMemoryCompaction,
  resetSessionMemory,
} from './memory/session-memory.js';
import { addToHistory } from './memory/session-history.js';
import { getMemoryStore } from './memory/memory-store.js';
import { createLogger } from './logger.js';
import { triggerHook, createHookEvent } from './hooks.js';
import { withToolRetry, withApiRateLimitRetry } from './tool-retry.js';
import { ModelFallbackChain } from './model-fallback.js';
import { editContextIfNeeded } from './context/context-editor.js';
import { selectTools } from './tool-selector.js';

const log = createLogger('agent');

// ─── Agent Loop Constants ────────────────────────────────────────────────────

/**
 * Tools that are safe to run in parallel (read-only / idempotent).
 * Declared at module level so it is allocated once, not on every LLM response.
 */
const PARALLELIZABLE_TOOLS = new Set([
  // File system — read
  'Read', 'read_file', 'readFile',
  'LS', 'ls', 'list_files',
  'Grep', 'grep_search',
  // Web
  'WebFetch', 'WebSearch', 'web_search', 'web_fetch',
  // Analysis / inspection
  'InspectCode', 'inspect_code',
  'DatabaseQuery', 'database_query',
  'EnvProbe', 'env_probe',
  // Worktree read operations
  'worktree_list', 'worktree_status', 'worktree_events',
]);


/** Default maximum LLM iterations per runStream() call.
 * Raised from 15 → 50: complex tasks (code review, multi-file refactor) easily need
 * 30-80 tool calls. Users can override via AGENT_MAX_ITERATIONS env var.
 */
const DEFAULT_MAX_ITERATIONS = 50;
/** Default maximum unattended-retry rounds (CI mode) */
const DEFAULT_MAX_UNATTENDED_RETRIES = 2;
/** Default wait between unattended retries (ms) */
const DEFAULT_UNATTENDED_RETRY_DELAY_MS = 30_000;
/** Hard ceiling for unattended retry wait to prevent indefinite blocking */
const MAX_UNATTENDED_RETRY_DELAY_MS = 5 * 60 * 1000;
/** TodoWrite nag reminder fires after this many rounds without a TodoWrite call */
const TODO_NAG_ROUNDS = 3;

/**
 * AgentEvents — CLI 层感知工具调用生命周期的回调接口
 *
 * 由 runStream() 第三参数传入，CLI 侧（index.ts）用来驱动 CliSpinner 的
 * 工具调用行追踪，替代原来只在 verbose=true 时打印 onChunk 的方式。
 */
export interface AgentEvents {
  /** 工具调用开始时触发 */
  onToolStart?: (name: string, args: Record<string, unknown>) => void;
  /** 工具调用完成时触发（success=false 表示抛异常）*/
  onToolEnd?: (name: string, success: boolean, durationMs: number) => void;
  /** LLM 开始输出文本（首个 text chunk 到来）时触发 */
  onResponseStart?: () => void;
}

export interface AgentOptions {
  domain: string;
  model: string;
  stream: boolean;
  verbose: boolean;
  safeMode?: boolean;
  /** Override system prompt entirely */
  systemPromptOverride?: string;
  /** Append extra text to the system prompt */
  appendSystemPrompt?: string;
  /** Claude extended-thinking level: 'low' | 'medium' | 'high' | 'max' | 'xhigh' | 'maxOrXhigh' */
  thinkingLevel?: import('../models/types.js').ThinkingLevel;
  /** Approval mode: 'default' | 'autoEdit' | 'yolo' */
  approvalMode?: 'default' | 'autoEdit' | 'yolo';
  /**
   * Per-tool enable/disable overrides. Keys are tool names (e.g. "write", "bash",
   * "mcp__filesystem__write_file"). A value of `false` disables that tool.
   * CLI --tools flag and config.tools field are both resolved before construction
   * and merged here. Priority: CLI --tools > project config > global config.
   */
  disabledTools?: Record<string, boolean>;
}

export class AgentCore {
  /** Lazily initialised on first use to avoid API-key checks at construction time. */
  private llm: LLMClient | null = null;
  private router: DomainRouter;
  private registry: ToolRegistry;
  private history: Message[] = [];
  private currentDomain: string;
  private verbose: boolean;
  private safeMode: boolean;
  private mcpManager: MCPManager;
  private fallbackChain: ModelFallbackChain | null;
  /**
   * Optional system prompt override injected by a parent agent (kstack article #15343).
   * When set via setSystemPrompt(), runStream() uses this instead of calling
   * buildSystemPromptWithContext() — avoids redundant AGENTS.md / git-status
   * loading in parallel sub-agents that share the same context.
   */
  private _systemPromptOverride: string | null = null;
  /** Appended text for --append-system-prompt option */
  private _appendSystemPrompt: string | null = null;
  /** Extended-thinking level for Claude models */
  private _thinkingLevel: import('../models/types.js').ThinkingLevel | undefined = undefined;
  /** Per-tool disable map (populated from AgentOptions.disabledTools, used in initMCP) */
  private _disabledTools: Record<string, boolean> | undefined = undefined;
  /** Accumulated [UNCERTAIN] items across the session (kstack article #15310 confidence mechanism) */
  private uncertainItems: string[] = [];
  /**
   * Pending dangerous command waiting for user confirmation (kstack article #15313).
   * When bashTool returns __CONFIRM_REQUIRED__:<label>\n<command>, the agent loop pauses
   * and stores the command here. The next user turn is checked: if it's a confirmation
   * ('yes'/'y'/'confirm'/etc.) the command is executed; otherwise it is cancelled.
   */
  private pendingConfirmation: {
    command: string;
    cwd: string;
    label: string;
    /** Index in this.history where the synthetic [SYSTEM] message was injected.
     *  Stored so we can splice it out after the user confirms or cancels (b5 fix). */
    injectedAt?: number;
  } | null = null;

  constructor(options: AgentOptions) {
    // Validate domain early so AgentCore never starts in an unknown state.
    // 'auto' is always valid; other values must be in the known list.
    const VALID_DOMAINS = new Set(['auto', 'data', 'dev', 'service']);
    if (!VALID_DOMAINS.has(options.domain)) {
      throw new Error(
        `Invalid domain: "${options.domain}". Valid values: ${[...VALID_DOMAINS].join(', ')}`
      );
    }

    this.currentDomain = options.domain;
    this.verbose = options.verbose;
    this.safeMode = options.safeMode ?? false;
    if (options.systemPromptOverride) this._systemPromptOverride = options.systemPromptOverride;
    if (options.appendSystemPrompt) this._appendSystemPrompt = options.appendSystemPrompt;
    if (options.thinkingLevel) this._thinkingLevel = options.thinkingLevel;
    if (options.thinkingLevel) this._thinkingLevel = options.thinkingLevel;
    if (this.safeMode) process.env.AGENT_SAFE_MODE = '1';

    // Set model on manager.
    // NOTE: we only call setPointer here, NOT getClient().
    // getClient() triggers OpenAI SDK construction which validates API keys immediately.
    // Deferring to the first actual LLM call gives the user a chance to see
    // the REPL prompt before crashing with a missing-key error (fix f1).
    modelManager.setPointer('main', options.model);
    // this.llm is initialised lazily in _getLLM() below.

    this.router = new DomainRouter();
    this.registry = new ToolRegistry();
    this.mcpManager = new MCPManager();

    // Set up model fallback chain from env (AGENT_FALLBACK_MODELS=model1,model2)
    const fallbackModels = (process.env.AGENT_FALLBACK_MODELS ?? '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    this.fallbackChain = fallbackModels.length > 0
      ? new ModelFallbackChain(fallbackModels)
      : null;

    this._disabledTools = options.disabledTools;
    this.registerAllTools(options.domain, options.disabledTools);
  }

  private registerAllTools(domain: string, disabledTools?: Record<string, boolean>) {
    // Build a name-based filter. The disabled map comes from:
    //   1. CLI --tools flag          (highest priority)
    //   2. config.tools (project)    (via AgentOptions.disabledTools)
    //   3. config.tools (global)     (already merged by loadConfig() in index.ts)
    // We also apply the legacy config.todo=false shorthand here.
    const isDisabled = (toolName: string): boolean => {
      if (disabledTools && disabledTools[toolName] === false) return true;
      // also accept lower-cased version for convenience
      const lower = toolName.toLowerCase();
      if (disabledTools && disabledTools[lower] === false) return true;
      return false;
    };
    // Convenience wrapper: register only if not disabled
    const reg = (tool: import('../models/types.js').ToolRegistration) => {
      if (!isDisabled(tool.definition.name)) this.registry.register(tool);
    };
    const regMany = (tools: import('../models/types.js').ToolRegistration[]) => {
      for (const t of tools) reg(t);
    };

    // Core FS tools (always registered — these are the foundation)
    regMany([
      readFileTool,
      writeFileTool,
      editFileTool,
      bashTool,
      listFilesTool,
      grepTool,
    ]);

    // Web tools
    regMany([webFetchTool, webSearchTool]);

    // Code quality & self-healing tools (always available)
    reg(codeInspectorTool);
    reg(selfHealTool);

    // Subagent tools
    reg(createTaskTool(subagentSystem));
    reg(askExpertModelTool);
    reg(spawnAgentTool);
    reg(spawnParallelTool);
    reg(coordinatorRunTool);
    reg(businessDefectDetectorTool);
    reg(reverseAnalyzeTool);
    // s03 — in-session todo tracking with nag reminder
    // Legacy config.todo=false shorthand is still respected via isDisabled('todoWrite')
    {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      let todoEnabled = true;
      try {
        const cs = require('../cli/config-store.js') as typeof import('../cli/config-store.js');
        todoEnabled = cs.loadConfig().todo !== false;
      } catch { /* config unavailable → default ON */ }
      if (todoEnabled) reg(todoWriteTool);
    }

    // s05 — on-demand skill loading
    reg(loadSkillTool);
    reg(runSkillTool);

    // Docs tools
    regMany([readDocTool, docSearchTool, fetchDocTool]);

    // Script tools
    regMany([scriptSaveTool, scriptRunTool, scriptListTool]);

    // TDD tools
    reg(testRunnerTool);

    // EnvProbe
    reg(envProbeTool);

    // WebSocket MCP Server
    regMany([
      wsServerStartTool, wsServerStopTool, wsServerStatusTool,
      wsBroadcastTool, wsInboxTool, wsMockInjectTool,
    ]);

    // HTTP Proxy / Traffic Capture
    regMany([
      proxyStartTool, proxyStopTool, proxyStatusTool,
      proxyCapturesTool, proxyMockTool, proxyMockListTool, proxyMockClearTool, proxyClearTool,
    ]);

    // 邪修 TDD tools
    reg(curlExecuteTool);
    reg(redisProbeTool);
    reg(databaseQueryTool);

    // Terminal IPC tools
    regMany([
      terminalListTool,
      terminalSendTool,
      terminalReadTool,
      terminalExecTool,
    ]);

    // GitHub PR tools
    regMany([
      githubCreatePRTool,
      githubListPRsTool,
      githubMergePRTool,
    ]);

    // AutopilotRun
    reg(autopilotRunTool);

    // s07 — persistent task board (+ s11 claim)
    regMany([taskCreateTool, taskUpdateTool, taskListTool, taskGetTool]);
    reg(claimTaskFromBoardTool);

    // s08 — background command execution
    regMany([backgroundRunTool, checkBackgroundTool, killBashTool]);

    // s09/s10/s11 — teammate system
    regMany([
      spawnTeammateTool,
      listTeammatesTool,
      sendMessageTool,
      readInboxTool,
      broadcastTool,
      shutdownRequestTool,
      planApprovalTool,
    ]);

    // s12 — worktree isolation tools
    regMany([
      worktreeCreateTool,
      worktreeListTool,
      worktreeStatusTool,
      worktreeRunTool,
      worktreeRemoveTool,
      worktreeKeepTool,
      worktreeEventsTool,
      taskBindWorktreeTool,
    ]);

    // Domain-specific tools
    this.router.registerTools(this.registry, domain);
  }

  async initMCP(): Promise<void> {
    const { connected, failed } = await this.mcpManager.connectAll();
    if (connected.length > 0) {
      // Apply disabled-tools filter to MCP tools as well
      const allMcpTools = this.mcpManager.getTools();
      const filteredMcpTools = this._disabledTools
        ? allMcpTools.filter((t) => this._disabledTools![t.definition.name] !== false)
        : allMcpTools;
      this.registry.registerMany(filteredMcpTools);
      log.info(`MCP: Connected to ${connected.join(', ')}`);
    }
    if (failed.length > 0) {
      log.warn(`MCP: Failed to connect: ${failed.join(', ')}`);
    }
  }

  setDomain(domain: string) {
    const VALID_DOMAINS = new Set(['auto', 'data', 'dev', 'service']);
    if (!VALID_DOMAINS.has(domain)) {
      throw new Error(`Invalid domain: "${domain}". Valid values: ${[...VALID_DOMAINS].join(', ')}`);
    }
    this.currentDomain = domain;
    this.registry.clear();
    this.registerAllTools(domain);
  }

  setModel(model: string) {
    modelManager.setPointer('main', model);
    this.llm = null; // reset lazy cache so next _getLLM() picks up the new model
  }

  /**
   * Inject a pre-built system prompt (shared prompt cache — kstack article #15343).
   *
   * When SpawnParallel launches N sub-agents concurrently, each one normally
   * calls buildSystemPromptWithContext() independently, re-reading AGENTS.md,
   * rules files, and running execSync('git status') N times.  The parent agent
   * can call this method ONCE and pass the result down, so all sub-agents share
   * the identical system prompt string — maximising LLM provider KV-cache hits.
   */
  setSystemPrompt(prompt: string): void {
    this._systemPromptOverride = prompt;
  }

  /**
   * Set or clear the thinking level at runtime (used by Ctrl+T in REPL).
   */
  setThinkingLevel(level: import('../models/types.js').ThinkingLevel | undefined): void {
    this._thinkingLevel = level;
  }

  /**
   * Return MCP server configuration and connected tools for /mcp slash command.
   * Servers come from MCPManager (config file), tools come from the live registry
   * filtered to those whose names start with 'mcp_'.
   */
  getMcpInfo(): { servers: import('./mcp-manager.js').MCPServer[]; tools: string[] } {
    const servers = this.mcpManager.listServers();
    // registry.list() returns tool names (string[])
    const tools = this.registry.list().filter((n) => n.startsWith('mcp_'));
    return { servers, tools };
  }

  /** Return the current LLM client, initialising it on first use (lazy init). */
  private _getLLM(): LLMClient {
    if (!this.llm) this.llm = modelManager.getClient('main');
    return this.llm;
  }

  clearHistory() {
    this.history = [];
    this.uncertainItems = [];
    this.pendingConfirmation = null;
    // Reset session memory when conversation is cleared
    resetSessionMemory();
  }

  getHistory(): Message[] {
    return [...this.history];
  }

  /** Restore a saved session — replaces current (empty) history with saved messages. */
  setHistory(messages: Message[]): void {
    this.history = [...messages];
  }

  async run(prompt: string, filePath?: string): Promise<string> {
    const chunks: string[] = [];
    await this.runStream(prompt, (chunk) => chunks.push(chunk), undefined, filePath);
    return chunks.join('');
  }

  async runStream(
    prompt: string,
    onChunk: (chunk: string) => void,
    events?: AgentEvents,
    filePath?: string
  ): Promise<void> {
    // Persist prompt to history file (~/.uagent/history.jsonl)
    addToHistory(prompt);

    // ── Pending confirmation check (kstack article #15313 dry-run + confirm flow) ──
    // If there's a dangerous command waiting for approval, the next user turn decides.
    if (this.pendingConfirmation) {
      const { command, cwd, label, injectedAt } = this.pendingConfirmation;
      this.pendingConfirmation = null;

      const isConfirmed = /^\s*(yes|y|confirm|ok|go|proceed|execute|run it|do it)\s*$/i.test(prompt.trim());
      if (isConfirmed) {
        // Remove the synthetic [SYSTEM] message injected at the end of the previous turn
        // so it doesn't pollute the permanent conversation history (fix b5).
        if (injectedAt !== undefined && this.history.length > injectedAt) {
          this.history.splice(injectedAt);
        }
        onChunk(`\n✅ Confirmed. Executing: \`${command}\`\n\n`);
        try {
          const { execSync } = await import('child_process');
          const output = execSync(command, {
            cwd,
            encoding: 'utf-8',
            timeout: 30000,
            maxBuffer: 10 * 1024 * 1024,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          onChunk(output.trim() || '(no output)');
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; message?: string };
          const parts: string[] = [];
          if (e.stdout?.trim()) parts.push(e.stdout.trim());
          if (e.stderr?.trim()) parts.push(e.stderr.trim());
          if (!e.stderr && e.message) parts.push(e.message);
          onChunk(`\n❌ Command failed:\n${parts.join('\n') || 'Unknown error'}`);
        }
        onChunk('\n');
        return;
      } else {
        // Cancelled — also clean up the injected synthetic message
        if (injectedAt !== undefined && this.history.length > injectedAt) {
          this.history.splice(injectedAt);
        }
        onChunk(`\n🚫 Cancelled. The following command was NOT executed:\n  \`${command}\`\n  (${label})\n`);
        return;
      }
    }

    // Auto-detect domain
    const domain = this.currentDomain === 'auto'
      ? this.router.detectDomain(prompt)
      : this.currentDomain;

    // Expand @run-agent-xxx and @ask-xxx mentions before sending
    const expandedPrompt = this.expandMentions(prompt);

    // Build system prompt with project context (AGENTS.md).
    // If a parent agent injected a pre-built prompt via setSystemPrompt(), use that
    // directly so all parallel sub-agents share the SAME prompt string and can hit
    // the LLM provider's KV-cache (kstack article #15343 shared prompt cache insight).
    const baseSystemPrompt = this.router.getSystemPrompt(domain);
    let systemPrompt = this._systemPromptOverride ?? buildSystemPromptWithContext(baseSystemPrompt);
    if (this._appendSystemPrompt) systemPrompt += `\n\n${this._appendSystemPrompt}`;

    // ── Memory recall: inject relevant long-term memories into system prompt ──
    // Following mem9's design: pinned memories are always included;
    // insight/fact are ranked by relevance to the current prompt.
    // Inspired by Cowork Forge's 4-layer memory: also inject recent iteration snapshots
    // ("迭代知识记忆") so the agent has context from previous sessions.
    try {
      const store = getMemoryStore(process.cwd());
      const memories = await store.recall(prompt);
      if (memories.length > 0) {
        // Separate iteration snapshots for dedicated section
        const iterations = memories.filter((m) => m.type === 'iteration');
        const others = memories.filter((m) => m.type !== 'iteration');

        if (others.length > 0) {
          // Format timestamps as relative time (kstack #15375: relative time is more natural for LLMs
          // than ISO strings — "3 days ago" beats "2026-03-31T08:12:44Z" for context understanding)
          const relativeTime = (ms: number): string => {
            const diffSec = Math.floor((Date.now() - ms) / 1000);
            if (diffSec < 60) return `${diffSec}s ago`;
            if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
            if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
            const days = Math.floor(diffSec / 86400);
            if (days === 1) return 'yesterday';
            if (days < 30) return `${days} days ago`;
            if (days < 365) return `${Math.floor(days / 30)} months ago`;
            return `${Math.floor(days / 365)} years ago`;
          };
          const memLines = others.map((m) => {
            const tag = m.type === 'pinned' ? '📌' : m.type === 'insight' ? '💡' : '📝';
            return `${tag} [${relativeTime(m.createdAt)}] ${m.content}`;
          }).join('\n');
          systemPrompt += `\n\n## Relevant Memories (from previous sessions)\n${memLines}`;
        }

        // Inject recent iteration snapshots as a separate block
        // Cowork Forge pattern: "迭代知识记忆" — cross-session project knowledge
        if (iterations.length > 0) {
          const iterLines = iterations.map((m) => {
            const d = new Date(m.createdAt).toISOString().slice(0, 10);
            return `### [${d}]\n${m.content}`;
          }).join('\n\n');
          systemPrompt += `\n\n## Recent Iteration History (from past sessions)\n` +
            `> These are auto-captured snapshots of what was done in previous sessions.\n` +
            `> Use them to maintain continuity and avoid repeating past mistakes.\n\n${iterLines}`;
        }
      }
    } catch {
      // Memory recall failure is non-fatal
    }

    const userMessage: Message = {
      role: 'user',
      content: filePath ? `${expandedPrompt}\n\n[File context: ${filePath}]` : expandedPrompt,
    };

    this.history.push(userMessage);

    // ── Layer 4: Session Memory Update (non-blocking, <10ms) ───────────────
    // Update the rolling 10-chapter summary incrementally.
    // Done BEFORE compaction so the summary is fresh for Layer 4 compaction.
    updateSessionMemory(this.history);

    // ── Compaction cascade: Layer 4 → Layer 5 ──────────────────────────────
    // Try cheap Session Memory compaction first (no LLM call).
    // Only fall back to expensive AutoCompact (LLM) if Layer 4 is not enough.
    // Inspired by Claude Code's 4-layer compaction hierarchy (kstack #15375).
    const smCompacted = trySessionMemoryCompaction(this.history, onChunk);
    if (smCompacted) {
      await triggerHook(createHookEvent('agent', 'compact', { compacted: -1, layer: 4 }));
    }

    // Auto-compact history if approaching context limit (Layer 5)
    const compacted = await autoCompact(this.history, onChunk);
    if (compacted > 0) {
      await triggerHook(createHookEvent('agent', 'compact', { compacted }));
    }

    // session:start fires only on the first turn of a new conversation
    if (this.history.length === 1) {
      await triggerHook(createHookEvent('session', 'start', {
        domain,
        model: modelManager.getCurrentModel('main'),
      }));
    }

    let iteration = 0;
    // Tracks the timestamp of the last LLM call — used by the min-round-interval
    // throttle to ensure at least AGENT_MIN_ROUND_INTERVAL_MS between LLM calls.
    let lastLLMCallAt = 0;
    // Allow override via AGENT_MAX_ITERATIONS env var for power users
    // who need more turns for complex multi-step tasks (default: 15).
    const MAX_ITERATIONS = parseInt(process.env.AGENT_MAX_ITERATIONS ?? String(DEFAULT_MAX_ITERATIONS), 10);

    // ── AGENT_UNATTENDED_RETRY (kstack article #15375: Claude Code 无人值守重试模式) ──
    // When AGENT_UNATTENDED_RETRY=1 (e.g. in CI/batch mode), the agent may retry
    // after hitting the iteration limit instead of stopping.
    // Safety: max 5 minutes between retry attempts to avoid infinite loops.
    const unattendedRetry = process.env.AGENT_UNATTENDED_RETRY === '1';
    let unattendedRetryCount = 0;
    const MAX_UNATTENDED_RETRIES = parseInt(
      process.env.AGENT_MAX_UNATTENDED_RETRIES ?? String(DEFAULT_MAX_UNATTENDED_RETRIES), 10);
    const UNATTENDED_RETRY_DELAY_MS = Math.min(
      parseInt(process.env.AGENT_UNATTENDED_RETRY_DELAY_MS ?? String(DEFAULT_UNATTENDED_RETRY_DELAY_MS), 10),
      MAX_UNATTENDED_RETRY_DELAY_MS,
    );

    // s03: track rounds since last TodoWrite call; inject nag reminder after 3 rounds
    let roundsWithoutTodo = 0;

    // s09: get the teammate manager for inbox drain before each LLM call
    const teamMgr = getTeammateManager(process.cwd());

    // Outer unattended-retry loop — wraps the inner while.
    // In non-unattended mode this executes exactly once.
    let _unattendedDone = false;
    while (!_unattendedDone) {
    _unattendedDone = true; // default: don't retry unless explicitly set below

    while (iteration < MAX_ITERATIONS) {
      iteration++;

      // ── Min-round-interval throttle ─────────────────────────────────────────
      // Prevent rapid consecutive LLM calls (e.g. many quick tool results in a row).
      // Default: 500ms. Set AGENT_MIN_ROUND_INTERVAL_MS=0 to disable.
      // Effective on free-tier models (wanqing, Gemini free) to avoid 429s.
      const _minInterval = parseInt(process.env.AGENT_MIN_ROUND_INTERVAL_MS ?? '500', 10);
      if (_minInterval > 0 && lastLLMCallAt > 0) {
        const _elapsed = Date.now() - lastLLMCallAt;
        if (_elapsed < _minInterval) {
          await new Promise((resolve) => setTimeout(resolve, _minInterval - _elapsed));
        }
      }

      // s08 — drain background task notifications and inject before LLM call
      const bgNotifs = backgroundManager.drainNotifications();
      if (bgNotifs.length > 0) {
        const notifText = bgNotifs
          .map((n) => `[bg:${n.taskId}] ${n.status}: ${n.result}`)
          .join('\n');
        this.history.push({
          role: 'user',
          content: `<background-results>\n${notifText}\n</background-results>`,
        });
      }

      // s09 — drain lead inbox (messages from teammates) and inject before LLM call
      const inboxMsgs = teamMgr.bus.readInbox('lead');
      if (inboxMsgs.length > 0) {
        this.history.push({
          role: 'user',
          content: `<inbox>\n${JSON.stringify(inboxMsgs)}\n</inbox>`,  // compact: no indent needed for LLM parsing
        });
      }

      // Context editing: selectively clear old tool results before hitting LLM
      const cleared = editContextIfNeeded(this.history);
      if (cleared > 0) {
        onChunk(`\n✂️  Cleared ${cleared} old tool result(s) to free context space\n`);
      }

      await triggerHook(createHookEvent('agent', 'turn', {
        iteration,
        model: modelManager.getCurrentModel('main'),
      }));

      // Refresh tool list every iteration to pick up any conditionally-activated tools.
      // This replaces the previous approach of mutating a shared allTools array
      // (which had a race condition if runStream were called concurrently).
      const currentTools = this.registry.getToolDefinitions();

      // Tool selection: filter to relevant tools when count > threshold
      const lastUserMsg = [...this.history].reverse().find((m) => m.role === 'user')?.content ?? prompt;
      const tools = await selectTools(currentTools, lastUserMsg, this.history);

      let response;
      try {
        const chatOpts = {
          systemPrompt,
          messages: this.history,
          tools,
          stream: false,
          thinkingLevel: this._thinkingLevel,
        };
        // ── API Rate-limit Retry (kstack #15375: AGENT_UNATTENDED_RETRY) ──────────
        // Wrap LLM calls with 429/529 rate-limit back-pressure retry.
        // In unattended mode (AGENT_UNATTENDED_RETRY=1): retry every 30s up to 6h.
        // In normal mode: fail fast (let outer error handling deal with it).
        response = this.fallbackChain
          ? await withApiRateLimitRetry(
              () => this.fallbackChain?.call(this._getLLM(), chatOpts) ?? this._getLLM().chat(chatOpts),
              (elapsed) => onChunk(`\n⏳ Rate-limited — waiting 30s… (${Math.round(elapsed / 60000)}min elapsed)\n`),
            )
          : await withApiRateLimitRetry(
              () => this._getLLM().chat(chatOpts),
              (elapsed) => onChunk(`\n⏳ Rate-limited — waiting 30s… (${Math.round(elapsed / 60000)}min elapsed)\n`),
            );
        lastLLMCallAt = Date.now();
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // ── Layer 7: Reactive Compact — 413 / context-overflow emergency recovery ──
        // Triggered when the LLM rejects the request because the context is too large.
        // Strategy: first try microcompact (zero LLM cost), then emergency LLM compact.
        // If recovery succeeds, retry this iteration immediately instead of breaking.
        // Inspired by Claude Code's Layer 7 Reactive Compact (kstack #15375).
        const isContextOverflow = /413|context.{0,30}(overflow|limit|length|window)|too.{0,10}(long|large|many.{0,10}token)|maximum.{0,20}(context|length)/i.test(errMsg);
        if (isContextOverflow) {
          onChunk(`\n⚠️  Context overflow detected (${errMsg.slice(0, 80)}) — attempting reactive compact…\n`);
          const recovered = await reactiveCompact(this.history, onChunk);
          if (recovered) {
            onChunk('  ↩️  Retrying with compacted context…\n');
            continue; // retry this iteration with smaller history
          }
        }
        onChunk(`\n❌ LLM error: ${errMsg}\n`);
        break;
      }

      // Track token usage if available
      if ((response as unknown as Record<string, unknown>).usage) {
        const usage = (response as unknown as Record<string, unknown>).usage as { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
        const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
        const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
        modelManager.recordUsage(inputTokens, outputTokens, modelManager.getCurrentModel('main'));
      }

      if (response.type === 'text') {
        const content = response.content;

        // Confidence mechanism (kstack article #15310):
        // Collect lines tagged with [UNCERTAIN] or ⚠️ so we can surface them
        // as a "pending confirmation" list at the end of the response.
        const uncertainPattern = /\[UNCERTAIN\]|⚠️\s*\[UNCERTAIN\]/gi;
        const lines = content.split('\n');
        for (const line of lines) {
          if (uncertainPattern.test(line)) {
            this.uncertainItems.push(line.trim().replace(/^[\-*>]+\s*/, ''));
          }
        }

        onChunk(content);

        // Surface uncertain items as a confirmation checklist
        if (this.uncertainItems.length > 0) {
          const checklist = this.uncertainItems
            .map((item, i) => `  ${i + 1}. ${item}`)
            .join('\n');
          onChunk(`\n\n---\n⚠️  **Pending Confirmations** (items marked [UNCERTAIN]):  \n${checklist}\n---\n`);
          // Reset for next turn so items aren't repeated
          this.uncertainItems = [];
        }

        this.history.push({ role: 'assistant', content });
        break;
      }

      if (response.type === 'tool_calls') {
        // 工具调用开始 — 通知 CLI 层切换到 tool-use 模式
        // （events 回调由 index.ts 的 CliSpinner 消费，verbose 模式下仍输出原始文本）
        if (this.verbose) {
          onChunk(`\n🔧 Tools: ${response.toolCalls.map((t) => t.name).join(', ')}\n`);
        }

        this.history.push({
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls,
        });

        const toolResults: Message[] = [];

        // ── Parallel tool execution ─────────────────────────────────────────────
        // Read-only tools (Read, LS, Grep, WebFetch, etc.) are safe to run in
        // parallel: they have no shared state or file-system side effects.
        // Write tools (Write, Edit, Bash, worktree_*) MUST remain sequential.
        //
        // Parallelizing read tools reduces round-trip time for multi-file scans
        // (e.g. a code-review that calls Read on 6 files in one turn: 6×500ms
        // serial → ~600ms parallel) and lowers the total number of LLM rounds,
        // which directly reduces QPS pressure on free-tier models.
        //
        // Safety invariant: we never mix parallel + sequential in the same batch;
        // if ANY call in the batch is a write tool, the entire batch runs serially.

        // NOTE: PARALLELIZABLE_TOOLS and MAX_PARALLEL_TOOLS are declared at module
        // level (see top of file) to avoid repeated allocation on every LLM response.
        const MAX_PARALLEL_TOOLS = 5; // safety cap

        const allParallelizable =
          response.toolCalls.every((c) => PARALLELIZABLE_TOOLS.has(c.name));

        const canParallelize =
          allParallelizable && response.toolCalls.length > 1;

        if (canParallelize) {
          // Execute all read-only calls in parallel (capped at MAX_PARALLEL_TOOLS)
          const batch = response.toolCalls.slice(0, MAX_PARALLEL_TOOLS);
          const overflow = response.toolCalls.slice(MAX_PARALLEL_TOOLS);

          const runCall = async (call: (typeof response.toolCalls)[0]) => {
            events?.onToolStart?.(call.name, call.arguments as Record<string, unknown>);
            const callId = `${call.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const toolStartMs = Date.now();
            await triggerHook(createHookEvent('tool', 'before', { callId, toolName: call.name, args: call.arguments }));
            try {
              const result = await withToolRetry(
                () => this.registry.execute(call.name, call.arguments),
                call.name,
              );
              const durationMs = Date.now() - toolStartMs;
              const newlyActivated = this.registry.evaluateConditionals(call.name, result);
              if (newlyActivated.length > 0) onChunk(`\n🔓 Unlocked tools: ${newlyActivated.join(', ')}\n`);
              await triggerHook(createHookEvent('tool', 'after', { callId, toolName: call.name, success: true }));
              events?.onToolEnd?.(call.name, true, durationMs);
              // compact JSON for tool results — LLM does not need pretty-print indentation;
              // removing null,2 reduces token consumption with no semantic loss.
              const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
              return { role: 'tool' as const, toolCallId: call.id, content: resultStr };
            } catch (err) {
              const durationMs = Date.now() - toolStartMs;
              await triggerHook(createHookEvent('tool', 'error', { callId, toolName: call.name, error: err instanceof Error ? err.message : String(err), success: false }));
              events?.onToolEnd?.(call.name, false, durationMs);
              return { role: 'tool' as const, toolCallId: call.id, content: `Error: ${err instanceof Error ? err.message : String(err)}` };
            }
          };

          if (this.verbose) {
            onChunk(`\n🔧 Tools (parallel): ${batch.map((t) => t.name).join(', ')}\n`);
          }

          const parallelResults = await Promise.all(batch.map(runCall));
          toolResults.push(...parallelResults);

          // Any overflow calls run serially after the parallel batch
          for (const call of overflow) {
            const r = await runCall(call);
            toolResults.push(r);
          }
        } else {
          // Sequential branch — write tools or single call
          for (const call of response.toolCalls) {
            if (this.verbose) {
              const TOOL_ARGS_PREVIEW_CHARS = 120;
              const argsStr = JSON.stringify(call.arguments).slice(0, TOOL_ARGS_PREVIEW_CHARS);
              onChunk(`  → ${call.name}(${argsStr}${argsStr.length >= 120 ? '...' : ''})\n`);
            }

            // 通知 CLI：工具调用即将开始
            events?.onToolStart?.(call.name, call.arguments as Record<string, unknown>);

            const callId = `${call.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const toolStartMs = Date.now();
            await triggerHook(createHookEvent('tool', 'before', {
              callId,
              toolName: call.name,
              args: call.arguments,
            }));
            try {
              const result = await withToolRetry(
                () => this.registry.execute(call.name, call.arguments),
                call.name,
              );

              const toolDurationMs = Date.now() - toolStartMs;

              // Conditional lazy tool loading (Harness Engineering — kstack #15309):
              // After each tool execution, evaluate whether new tools should be unlocked.
              const newlyActivated = this.registry.evaluateConditionals(call.name, result);
              if (newlyActivated.length > 0) {
                onChunk(`\n🔓 Unlocked tools: ${newlyActivated.join(', ')}\n`);
                // No need to explicitly refresh — currentTools is re-fetched at the top
                // of each while iteration, so newly activated tools appear next turn.
              }

              await triggerHook(createHookEvent('tool', 'after', {
                callId,
                toolName: call.name,
                success: true,
              }));

              // 通知 CLI：工具调用成功完成
              events?.onToolEnd?.(call.name, true, toolDurationMs);

              if (this.verbose) {
                const TOOL_RESULT_PREVIEW_CHARS = 300;
                const preview = JSON.stringify(result).slice(0, TOOL_RESULT_PREVIEW_CHARS);
                onChunk(`  ✓ ${preview}${preview.length === 300 ? '...' : ''}\n`);
              }
              // ── Dry-run confirmation gate (kstack article #15313) ────────────────
              // bashTool returns __CONFIRM_REQUIRED__:<label>\n<command> for dangerous
              // commands instead of executing them. Pause the agent loop and surface
              // a clear confirmation prompt to the user.
              // compact JSON for tool results (no null,2 — saves tokens in LLM context)
              const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
              if (resultStr.startsWith('__CONFIRM_REQUIRED__:')) {
                const firstNewline = resultStr.indexOf('\n');
                const header = resultStr.slice('__CONFIRM_REQUIRED__:'.length, firstNewline > -1 ? firstNewline : undefined);
                const dangerousCommand = firstNewline > -1 ? resultStr.slice(firstNewline + 1).trim() : '';
                const cmdCwd = (call.arguments.cwd as string | undefined)
                  ? String(call.arguments.cwd)
                  : process.cwd();

                this.pendingConfirmation = {
                  command: dangerousCommand,
                  cwd: cmdCwd,
                  label: header,
                  // Record history length BEFORE we inject the synthetic [SYSTEM] message
                  // so we can splice it out after the user confirms or cancels (fix b5).
                  injectedAt: this.history.length + toolResults.length,
                };

                // Push a synthetic tool result so history stays valid
                toolResults.push({
                  role: 'tool',
                  toolCallId: call.id,
                  content: `[Paused for confirmation] Dangerous command detected: ${header}`,
                });

                // Flush history so far and break — let agent produce a final text response
                this.history.push(...toolResults);

                // Inject a system-level instruction so the LLM asks for confirmation
                this.history.push({
                  role: 'user',
                  content:
                    `[SYSTEM] The Bash tool wants to execute a potentially destructive command.\n` +
                    `Risk: ${header}\n` +
                    `Command:\n\`\`\`\n${dangerousCommand}\n\`\`\`\n\n` +
                    `Please show the user this information and ask them to reply **yes** to execute or **no** to cancel.`,
                });

                // Run one more LLM turn so the agent surfaces the confirmation prompt
                const confirmOpts = { systemPrompt, messages: this.history, tools: [], stream: false };
                try {
                  const confirmResp = this.fallbackChain
                    ? await this.fallbackChain.call(this._getLLM(), confirmOpts)
                    : await this._getLLM().chat(confirmOpts);
                  if (confirmResp.type === 'text') {
                    onChunk(confirmResp.content);
                    this.history.push({ role: 'assistant', content: confirmResp.content });
                  }
                } catch { /* ignore — user will still see the raw prompt */ }

                return; // Pause agent loop; resume when user replies
              }

              toolResults.push({
                role: 'tool',
                toolCallId: call.id,
                content: resultStr,
              });
            } catch (err) {
              const toolDurationMsErr = Date.now() - toolStartMs;
              await triggerHook(createHookEvent('tool', 'error', {
                callId,
                toolName: call.name,
                error: err instanceof Error ? err.message : String(err),
                success: false,
              }));
              // 通知 CLI：工具调用失败
              events?.onToolEnd?.(call.name, false, toolDurationMsErr);
              toolResults.push({
                role: 'tool',
                toolCallId: call.id,
                content: `Error: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
          } // end sequential for loop
        } // end sequential branch

        this.history.push(...toolResults);

        // s03: track TodoWrite usage; inject nag reminder if not used for ≥3 rounds
        const usedTodo = response.toolCalls.some((tc) => tc.name === 'TodoWrite');
        roundsWithoutTodo = usedTodo ? 0 : roundsWithoutTodo + 1;
        if (todoManager.hasOpenItems() && roundsWithoutTodo >= TODO_NAG_ROUNDS) {
          this.history.push({ role: 'user', content: '<reminder>Update your TodoWrite list.</reminder>' });
          roundsWithoutTodo = 0;
        }
      }
    }

    if (iteration >= MAX_ITERATIONS) {
      onChunk(
        `\n⚠️  Reached iteration limit (${MAX_ITERATIONS} rounds).\n` +
        `   Type /continue (or just press Enter after typing your next message)\n` +
        `   to keep going from where the agent left off.\n` +
        `   To raise the limit: AGENT_MAX_ITERATIONS=100 uagent\n`,
      );
      // Ensure history always ends with an assistant message so the next turn
      // produces a valid alternating user/assistant sequence for all LLM APIs.
      const last = this.history[this.history.length - 1];
      if (last?.role === 'tool') {
        this.history.push({ role: 'assistant', content: '[Iteration limit reached]' });
      }

      // ── AGENT_UNATTENDED_RETRY (kstack article #15375) ─────────────────────
      // In unattended/CI mode, instead of stopping, wait and retry.
      // Safety: hard cap of 5 minutes between retries and MAX_UNATTENDED_RETRIES total.
      if (unattendedRetry && unattendedRetryCount < MAX_UNATTENDED_RETRIES) {
        unattendedRetryCount++;
        onChunk(
          `\n♻️  Unattended retry ${unattendedRetryCount}/${MAX_UNATTENDED_RETRIES} ` +
          `— waiting ${UNATTENDED_RETRY_DELAY_MS / 1000}s before continuing…\n`,
        );
        await new Promise((res) => setTimeout(res, UNATTENDED_RETRY_DELAY_MS));
        // Reset iteration counter and re-enter via the outer _unattendedDone loop.
        // We CANNOT use `continue` here because this block is outside the inner
        // `while (iteration < MAX_ITERATIONS)` loop (TS1107 error).
        // Instead, we reset iteration and flip _unattendedDone so the outer while
        // loops back, which re-enters the inner while naturally.
        iteration = 0;
        _unattendedDone = false; // Outer loop will restart
        this.history.push({
          role: 'user',
          content: `[SYSTEM] Unattended retry ${unattendedRetryCount}: please continue from where you left off. Max iterations reset.`,
        });
        // (no snapshot — continuing)
      } else {
        // No more retries — _unattendedDone stays true, outer loop exits
      }
    } else {
      // ── Iteration Snapshot (Cowork Forge "迭代知识记忆" pattern) ────────────
      // On successful completion (NOT on iteration limit), auto-save a snapshot
      // of what was accomplished in this session to the iteration memory store.
      // This enables cross-session continuity and tech debt tracking.
      // Non-blocking: snapshot failures never surface to the user.
      this._captureIterationSnapshot(prompt).catch(() => { /* non-fatal */ });
    }
    } // end while (!_unattendedDone)
  }

  /**
   * Auto-capture an iteration snapshot at the end of a successful session turn.
   *
   * Inspired by Cowork Forge's "迭代知识记忆":
   *   "每次迭代完成后自动生成快照 — 记录做了什么、遇到了什么问题、留下了什么 tech debt"
   *
   * The snapshot is generated by asking the LLM to summarize the conversation
   * using a retrospective prompt. It is stored as type='iteration' in MemoryStore.
   * GC keeps the last 50 iteration snapshots per project (90-day TTL).
   */
  private async _captureIterationSnapshot(originalPrompt: string): Promise<void> {
    if (this.history.length < 4) return; // too short to be worth snapshotting

    try {
      const store = getMemoryStore(process.cwd());

      // Build a compact conversation summary (last 20 turns)
      const recentTurns = this.history.slice(-20);
      const convText = recentTurns
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => `[${m.role.toUpperCase()}]: ${String(m.content).slice(0, 400)}`)
        .join('\n');

      const snapshotPrompt = `You are creating a brief retrospective snapshot of an AI coding session.

## Original Request
${originalPrompt.slice(0, 300)}

## Session Summary (recent turns)
${convText}

## Your Task
Write a concise retrospective in 3-5 bullet points covering:
1. What was accomplished (files created/modified, features added)
2. Key decisions made or patterns established
3. Any problems encountered and how they were resolved
4. Tech debt or follow-up items left for future sessions

Rules:
- Be specific (name actual files, functions, patterns)
- Keep each bullet to 1-2 sentences
- Start each bullet with • 
- Do NOT include meta-commentary about this being a snapshot
- Write from first-person perspective ("We refactored...", "Added support for...")`;

      const client = modelManager.getClient('compact');
      const response = await client.chat({
        systemPrompt: 'You are a retrospective assistant. Write concise, specific session summaries.',
        messages: [{ role: 'user', content: snapshotPrompt }],
      });

      const content = response.content.trim();
      if (content && content.length > 20) {
        store.add({
          type: 'iteration',
          content,
          tags: ['session', 'retrospective', 'auto-snapshot'],
          source: 'agent',
        });
      }
    } catch {
      // Snapshot failure is completely non-fatal — never surfaces to user
    }
  }

  /**
   * Expand @run-agent-<name> and @ask-<model> mentions into tool calls
   * by injecting them into the prompt as instructions
   */
  private expandMentions(prompt: string): string {
    const hints: string[] = [];

    // @run-agent-<name> → Task tool hint
    const agentMentions = prompt.match(/@run-agent-([\w-]+)/g) || [];
    for (const mention of agentMentions) {
      const agentName = mention.replace('@run-agent-', '');
      if (subagentSystem.getAgent(agentName)) {
        hints.push(`delegate to subagent "${agentName}" using the Task tool`);
      }
    }

    // @ask-<model> → AskExpertModel hint
    const modelMentions = prompt.match(/@ask-([\w-.:]+)/g) || [];
    for (const mention of modelMentions) {
      const modelName = mention.replace('@ask-', '');
      hints.push(`consult expert model "${modelName}" using the AskExpertModel tool`);
    }

    if (hints.length === 0) return prompt;
    return `${prompt}\n\n[Hints: ${hints.join('; ')}]`;
  }
}
