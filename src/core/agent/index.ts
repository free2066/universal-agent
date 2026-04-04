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
      currentDomain: this.currentDomain,
      verbose: this.verbose,
      registry: this.registry,
      router: this.router,
      getLLM: () => this._getLLM(),
      fallbackChain: this.fallbackChain,
    });
  }
}
