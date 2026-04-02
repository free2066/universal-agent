import type { LLMClient, Message } from '../models/types.js';
import { modelManager } from '../models/model-manager.js';
import { DomainRouter } from './domain-router.js';
import { ToolRegistry } from './tool-registry.js';
import { buildSystemPromptWithContext } from './context-loader.js';
import { subagentSystem, createTaskTool, askExpertModelTool } from './subagent-system.js';
import { readFileTool, writeFileTool, editFileTool, bashTool, listFilesTool, grepTool } from './tools/fs-tools.js';
import { webFetchTool, webSearchTool } from './tools/web-tools.js';
import { codeInspectorTool } from './tools/code-inspector.js';
import { selfHealTool } from './tools/self-heal.js';
import { spawnAgentTool, spawnParallelTool } from './tools/spawn-agent.js';
import { coordinatorRunTool } from './tools/coordinator-tool.js';
import { businessDefectDetectorTool } from './tools/business-defect-detector.js';
import { reverseAnalyzeTool } from './tools/reverse-analyze.js';
import { loadSkillTool, runSkillTool } from './tools/skill-tool.js';
import { taskCreateTool, taskUpdateTool, taskListTool, taskGetTool } from './task-board.js';
import { backgroundRunTool, checkBackgroundTool } from './tools/background-tools.js';
import { backgroundManager } from './background-manager.js';
import { todoWriteTool, todoManager } from './tools/todo-tool.js';
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
} from './tools/worktree-tools.js';
import { MCPManager } from './mcp-manager.js';
import { autoCompact } from './context-compressor.js';
import { addToHistory } from './session-history.js';
import { getMemoryStore } from './memory-store.js';
import { createLogger } from './logger.js';
import { triggerHook, createHookEvent } from './hooks.js';
import { withToolRetry } from './tool-retry.js';
import { ModelFallbackChain } from './model-fallback.js';
import { editContextIfNeeded } from './context-editor.js';
import { selectTools } from './tool-selector.js';

const log = createLogger('agent');

export interface AgentOptions {
  domain: string;
  model: string;
  stream: boolean;
  verbose: boolean;
  safeMode?: boolean;
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

    this.registerAllTools(options.domain);
  }

  private registerAllTools(domain: string) {
    // Core FS tools (always registered — these are the foundation)
    this.registry.registerMany([
      readFileTool,
      writeFileTool,
      editFileTool,
      bashTool,
      listFilesTool,
      grepTool,
    ]);

    // Web tools
    this.registry.registerMany([webFetchTool, webSearchTool]);

    // Code quality & self-healing tools (always available)
    this.registry.register(codeInspectorTool);
    this.registry.register(selfHealTool);

    // Subagent tools
    this.registry.register(createTaskTool(subagentSystem));
    this.registry.register(askExpertModelTool);
    this.registry.register(spawnAgentTool);
    this.registry.register(spawnParallelTool);
    this.registry.register(coordinatorRunTool);
    this.registry.register(businessDefectDetectorTool);
    this.registry.register(reverseAnalyzeTool);
    // s03 — in-session todo tracking with nag reminder
    this.registry.register(todoWriteTool);

    // s05 — on-demand skill loading (Prompt + Program paradigm, kstack #15366)
    this.registry.register(loadSkillTool);
    this.registry.register(runSkillTool);

    // s07 — persistent task board (+ s11 claim)
    this.registry.registerMany([taskCreateTool, taskUpdateTool, taskListTool, taskGetTool]);
    this.registry.register(claimTaskFromBoardTool);

    // s08 — background command execution
    this.registry.registerMany([backgroundRunTool, checkBackgroundTool]);

    // s09/s10/s11 — teammate system
    this.registry.registerMany([
      spawnTeammateTool,
      listTeammatesTool,
      sendMessageTool,
      readInboxTool,
      broadcastTool,
      shutdownRequestTool,
      planApprovalTool,
    ]);

    // s12 — worktree isolation tools
    this.registry.registerMany([
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
      this.registry.registerMany(this.mcpManager.getTools());
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

  /** Return the current LLM client, initialising it on first use (lazy init). */
  private _getLLM(): LLMClient {
    if (!this.llm) this.llm = modelManager.getClient('main');
    return this.llm;
  }

  clearHistory() {
    this.history = [];
    this.uncertainItems = [];
    this.pendingConfirmation = null;
  }

  getHistory(): Message[] {
    return [...this.history];
  }

  async run(prompt: string, filePath?: string): Promise<string> {
    const chunks: string[] = [];
    await this.runStream(prompt, (chunk) => chunks.push(chunk), filePath);
    return chunks.join('');
  }

  async runStream(
    prompt: string,
    onChunk: (chunk: string) => void,
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

    // ── Memory recall: inject relevant long-term memories into system prompt ──
    // Following mem9's design: pinned memories are always included;
    // insight/fact are ranked by relevance to the current prompt.
    // Inspired by Cowork Forge's 4-layer memory: also inject recent iteration snapshots
    // ("迭代知识记忆") so the agent has context from previous sessions.
    try {
      const store = getMemoryStore(process.cwd());
      const memories = store.recall(prompt);
      if (memories.length > 0) {
        // Separate iteration snapshots for dedicated section
        const iterations = memories.filter((m) => m.type === 'iteration');
        const others = memories.filter((m) => m.type !== 'iteration');

        if (others.length > 0) {
          const memLines = others.map((m) => {
            const tag = m.type === 'pinned' ? '📌' : m.type === 'insight' ? '💡' : '📝';
            return `${tag} ${m.content}`;
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

    // Auto-compact history if approaching context limit
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
    // Allow override via AGENT_MAX_ITERATIONS env var for power users
    // who need more turns for complex multi-step tasks (default: 15).
    const MAX_ITERATIONS = parseInt(process.env.AGENT_MAX_ITERATIONS ?? '15', 10);

    // s03: track rounds since last TodoWrite call; inject nag reminder after 3 rounds
    let roundsWithoutTodo = 0;

    // s09: get the teammate manager for inbox drain before each LLM call
    const teamMgr = getTeammateManager(process.cwd());

    while (iteration < MAX_ITERATIONS) {
      iteration++;

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
          content: `<inbox>\n${JSON.stringify(inboxMsgs, null, 2)}\n</inbox>`,
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
        };
        response = this.fallbackChain
          ? await this.fallbackChain.call(this._getLLM(), chatOpts)
          : await this._getLLM().chat(chatOpts);
      } catch (err) {
        onChunk(`\n❌ LLM error: ${err instanceof Error ? err.message : String(err)}\n`);
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
        if (this.verbose) {
          onChunk(`\n🔧 Tools: ${response.toolCalls.map((t) => t.name).join(', ')}\n`);
        }

        this.history.push({
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls,
        });

        const toolResults: Message[] = [];
        for (const call of response.toolCalls) {
          if (this.verbose) {
            const argsStr = JSON.stringify(call.arguments).slice(0, 120);
            onChunk(`  → ${call.name}(${argsStr}${argsStr.length >= 120 ? '...' : ''})\n`);
          }

          const callId = `${call.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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
            if (this.verbose) {
              const preview = JSON.stringify(result).slice(0, 300);
              onChunk(`  ✓ ${preview}${preview.length === 300 ? '...' : ''}\n`);
            }
            // ── Dry-run confirmation gate (kstack article #15313) ────────────────
            // bashTool returns __CONFIRM_REQUIRED__:<label>\n<command> for dangerous
            // commands instead of executing them. Pause the agent loop and surface
            // a clear confirmation prompt to the user.
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
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
            await triggerHook(createHookEvent('tool', 'error', {
              callId,
              toolName: call.name,
              error: err instanceof Error ? err.message : String(err),
              success: false,
            }));
            toolResults.push({
              role: 'tool',
              toolCallId: call.id,
              content: `Error: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }

        this.history.push(...toolResults);

        // s03: track TodoWrite usage; inject nag reminder if not used for ≥3 rounds
        const usedTodo = response.toolCalls.some((tc) => tc.name === 'TodoWrite');
        roundsWithoutTodo = usedTodo ? 0 : roundsWithoutTodo + 1;
        if (todoManager.hasOpenItems() && roundsWithoutTodo >= 3) {
          this.history.push({ role: 'user', content: '<reminder>Update your TodoWrite list.</reminder>' });
          roundsWithoutTodo = 0;
        }
      }
    }

    if (iteration >= MAX_ITERATIONS) {
      onChunk('\n⚠️ Reached maximum iteration limit.\n');
      // Ensure history always ends with an assistant message so the next turn
      // produces a valid alternating user/assistant sequence for all LLM APIs.
      const last = this.history[this.history.length - 1];
      if (last?.role === 'tool') {
        this.history.push({ role: 'assistant', content: '[Iteration limit reached]' });
      }
    } else {
      // ── Iteration Snapshot (Cowork Forge "迭代知识记忆" pattern) ────────────
      // On successful completion (NOT on iteration limit), auto-save a snapshot
      // of what was accomplished in this session to the iteration memory store.
      // This enables cross-session continuity and tech debt tracking.
      // Non-blocking: snapshot failures never surface to the user.
      this._captureIterationSnapshot(prompt).catch(() => { /* non-fatal */ });
    }
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
