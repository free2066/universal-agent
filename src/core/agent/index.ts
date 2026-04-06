/**
 * agent/index.ts — AgentCore 公共入口
 *
 * AgentCore 类：薄壳，将内部各模块组合起来。
 * 对外保持与原 agent.ts 完全相同的接口（runStream、run、clearHistory 等），
 * 内部实现委托给 agent-loop.ts 和 agent-tools.ts。
 */

import type { LLMClient, Message } from '../../models/types.js';
import { modelManager } from '../../models/model-manager.js';
import { DomainRouter } from '../domain-router.js';
import { ToolRegistry } from '../tool-registry.js';
import { MCPManager } from '../mcp-manager.js';
import { ModelFallbackChain } from '../model-fallback.js';
import { addToHistory } from '../memory/session-history.js';
import { resetSessionMemory } from '../memory/session-memory.js';
import { createLogger } from '../logger.js';

import { registerAllTools } from './agent-tools.js';
import { runStreamLoop } from './agent-loop.js';

export type { AgentEvents, AgentOptions, PendingConfirmation } from './types.js';

const log = createLogger('agent');

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

  private _systemPromptOverride: string | null = null;
  private _appendSystemPrompt: string | null = null;
  private _thinkingLevel: import('../../models/types.js').ThinkingLevel | undefined = undefined;
  private _disabledTools: Record<string, boolean> | undefined = undefined;
  private _outputStyle: string | null = null;  // Batch 3: 'plain' | 'markdown' | 'compact'
  private _approvalMode: 'default' | 'autoEdit' | 'yolo' = 'default';  // Round 5: claude-code parity
  private uncertainItems: string[] = [];

  /** Mutable ref so agent-loop can read/write without holding `this`. */
  private pendingConfirmationRef: {
    value: import('./types.js').PendingConfirmation | null;
  } = { value: null };

  constructor(options: import('./types.js').AgentOptions) {
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
    if (options.approvalMode) this._approvalMode = options.approvalMode;
    if (this.safeMode) process.env.AGENT_SAFE_MODE = '1';

    modelManager.setPointer('main', options.model);

    this.router = new DomainRouter();
    this.registry = new ToolRegistry();
    this.mcpManager = new MCPManager();

    const fallbackModels = (process.env.AGENT_FALLBACK_MODELS ?? '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    this.fallbackChain = fallbackModels.length > 0
      ? new ModelFallbackChain(fallbackModels)
      : null;

    this._disabledTools = options.disabledTools;
    registerAllTools(this.registry, this.router, options.domain, options.disabledTools);

    // C19: Import inherited session grants from parent agent (synchronous path)
    // Allows parent's "Allow for this session" approvals to propagate to subagents.
    // Uses dynamic import with .then() since constructor cannot be async.
    const _inheritedGrants = (options as import('./types.js').AgentOptions).inheritedSessionGrants;
    if (_inheritedGrants?.length) {
      import('./permission-manager.js').then(({ getPermissionManager }) => {
        getPermissionManager(process.cwd()).importSessionGrants(_inheritedGrants);
      }).catch(() => { /* non-fatal */ });
    }
  }

  async initMCP(): Promise<void> {
    const { connected, failed } = await this.mcpManager.connectAll();
    if (connected.length > 0) {
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
    registerAllTools(this.registry, this.router, domain);
  }

  setModel(model: string) {
    modelManager.setPointer('main', model);
    this.llm = null;
  }

  setSystemPrompt(prompt: string): void {
    this._systemPromptOverride = prompt;
  }

  setThinkingLevel(level: import('../../models/types.js').ThinkingLevel | undefined): void {
    this._thinkingLevel = level;
  }

  getMcpInfo(): { servers: import('../mcp-manager.js').MCPServer[]; tools: string[] } {
    const servers = this.mcpManager.listServers();
    const tools = this.registry.list().filter((n) => n.startsWith('mcp_'));
    return { servers, tools };
  }

  private _getLLM(): LLMClient {
    if (!this.llm) this.llm = modelManager.getClient('main');
    return this.llm;
  }

  clearHistory() {
    this.history = [];
    this.uncertainItems = [];
    this.pendingConfirmationRef.value = null;
    resetSessionMemory();
  }

  /**
   * G13: setPlanMode — Plan Mode 开关（claude-code /plan 命令对标）
   * Plan Mode 下 LLM 只输出规划而不调用任何工具。
   * @param enabled  true = 进入 plan mode；false = 退出 plan mode
   */
  setPlanMode(enabled: boolean): void {
    const PLAN_MODE_PROMPT =
      'PLAN MODE ENABLED: You are in planning-only mode. Analyze the request thoroughly and ' +
      'output a detailed step-by-step plan. DO NOT call any tools or make any changes. ' +
      'Only describe what you would do and why. ' +
      'End your plan with: "Ready to execute — type /plan off to proceed."';

    // Plan mode 使用 appendSystemPrompt 注入规划指令
    const existing = (this._appendSystemPrompt ?? '')
      .replace(/\n?PLAN MODE ENABLED:.*?(?=\n[A-Z]|\n?$)/s, '')
      .trim();

    if (enabled) {
      this._appendSystemPrompt = existing
        ? `${existing}\n\n${PLAN_MODE_PROMPT}`
        : PLAN_MODE_PROMPT;
    } else {
      this._appendSystemPrompt = existing || null;
    }
  }

  /**
   * J12: rewindHistory — 回滚对话历史 n 轮。
   * 一轮 = 最多一对 user + assistant 消息（从尾部向前移除）。
   * 对标 claude-code /rewind 命令的历史回退功能。
   * @param turns  要回滚的轮数（默认 1）
   * @returns      实际移除的消息数量
   */
  rewindHistory(turns = 1): number {
    if (turns <= 0 || this.history.length === 0) return 0;
    let removed = 0;
    let turnsLeft = turns;
    // Remove from the tail, treating each user message as the start of a turn
    while (turnsLeft > 0 && this.history.length > 0) {
      // Pop the last message
      this.history.pop();
      removed++;
      // If the new tail is a user message, we've completed one turn boundary
      const tail = this.history[this.history.length - 1];
      if (!tail || tail.role === 'user') {
        turnsLeft--;
      }
    }
    return removed;
  }

  getHistory(): Message[] {
    return [...this.history];
  }

  setHistory(messages: Message[]): void {
    this.history = [...messages];
  }

  async run(prompt: string, filePath?: string): Promise<string> {
    const chunks: string[] = [];
    await this.runStream(prompt, (chunk) => chunks.push(chunk), undefined, filePath);
    return chunks.join('');
  }

  injectContext(text: string): void {
    this.history.push({ role: 'user', content: `[shell output injected]\n${text}` });
    this.history.push({ role: 'assistant', content: '(noted)' });
  }

  /**
   * setOutputStyle — upgrade: load from Markdown file + persist to config.
   *
   * Resolution order (same as claude-code):
   *  1. Look up in getAllOutputStyles() — covers builtin, user, and project styles
   *  2. If found: use config.prompt as the injection directive
   *  3. Persist selected style name to ~/.uagent/config via setConfigValue()
   *     so the style survives process restarts
   *
   * Supports:
   *   setOutputStyle('plain')    — builtin
   *   setOutputStyle('compact')  — builtin
   *   setOutputStyle('my-style') — user/project .uagent/output-styles/my-style.md
   */
  setOutputStyle(style: string): void {
    this._outputStyle = style;

    // Resolve via loader (builtin + user + project Markdown files)
    import('../../core/output-styles/loader.js').then(({ getOutputStyle, buildOutputStylePrompt }) => {
      const config = getOutputStyle(style);

      // Fallback to legacy STYLE_PROMPTS for backward compatibility
      const LEGACY_PROMPTS: Record<string, string> = {
        plain:
          'IMPORTANT: Format ALL your responses as plain text. Do NOT use markdown, ' +
          'code fences, headers, bold, italics, bullet lists, or any other markdown syntax. ' +
          'Write in simple, clean prose.',
        compact:
          'IMPORTANT: Keep all responses concise and minimal. Avoid preamble, lengthy ' +
          'explanations, or redundant headers. Prefer short bullet points over paragraphs. ' +
          'Omit confirmations like "I will…" or "Sure, I can…".',
        markdown: '',
      };

      const directive = config
        ? buildOutputStylePrompt(config)
        : (LEGACY_PROMPTS[style] ?? '');

      // Compose with existing appendSystemPrompt (strip old style directive first)
      const existing = (this._appendSystemPrompt ?? '')
        .replace(/\n?# Output Style:.*?(?=\n#|\n?$)/s, '')
        .replace(/\nIMPORTANT: (?:Format ALL|Keep all responses concise)[^\n]*/g, '')
        .trim();
      this._appendSystemPrompt = directive
        ? (existing ? `${existing}\n${directive}` : directive)
        : (existing || null);

      // Persist selected style name to user config (survives restart)
      import('../../cli/config-store.js').then(({ setConfigValue }) => {
        try { setConfigValue('outputStyle', style); } catch { /* non-fatal */ }
      }).catch(() => { /* non-fatal */ });
    }).catch(() => {
      // Loader unavailable — fallback to legacy behavior
      const STYLE_PROMPTS: Record<string, string> = {
        plain:
          'IMPORTANT: Format ALL your responses as plain text. Do NOT use markdown, ' +
          'code fences, headers, bold, italics, bullet lists, or any other markdown syntax. ' +
          'Write in simple, clean prose.',
        compact:
          'IMPORTANT: Keep all responses concise and minimal. Avoid preamble, lengthy ' +
          'explanations, or redundant headers. Prefer short bullet points over paragraphs. ' +
          'Omit confirmations like "I will…" or "Sure, I can…".',
        markdown: '',
      };
      const directive = STYLE_PROMPTS[style] ?? '';
      const existing = (this._appendSystemPrompt ?? '')
        .replace(/\nIMPORTANT: (?:Format ALL|Keep all responses concise)[^\n]*/g, '')
        .trim();
      this._appendSystemPrompt = directive
        ? (existing ? `${existing}\n${directive}` : directive)
        : (existing || null);
    });
  }

  getOutputStyle(): string {
    return this._outputStyle ?? 'markdown';
  }

  injectImagePrompt(
    text: string,
    imageBlock: import('../../models/types.js').ImageBlock | import('../../models/types.js').ImageUrlBlock,
  ): void {
    const contentBlocks: import('../../models/types.js').ContentBlock[] = [text, imageBlock];
    this.history.push({ role: 'user', content: contentBlocks });
  }

  async runStream(
    prompt: string,
    onChunk: (chunk: string) => void,
    events?: import('./types.js').AgentEvents,
    filePath?: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    // Persist prompt to history file (~/.uagent/history.jsonl)
    addToHistory(prompt);

    await runStreamLoop({
      prompt,
      onChunk,
      events,
      filePath,
      abortSignal,
      history: this.history,
      pendingConfirmationRef: this.pendingConfirmationRef,
      uncertainItems: this.uncertainItems,
      systemPromptOverride: this._systemPromptOverride,
      appendSystemPrompt: this._appendSystemPrompt,
      thinkingLevel: this._thinkingLevel,
      approvalMode: this._approvalMode,  // Round 5: pass through to agent-loop (claude-code parity)
      currentDomain: this.currentDomain,
      verbose: this.verbose,
      registry: this.registry,
      router: this.router,
      getLLM: () => this._getLLM(),
      fallbackChain: this.fallbackChain,
    });
  }
}
