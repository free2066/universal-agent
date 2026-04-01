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
import { MCPManager } from './mcp-manager.js';
import { autoCompact } from './context-compressor.js';
import { addToHistory } from './session-history.js';
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
  private llm: LLMClient;
  private router: DomainRouter;
  private registry: ToolRegistry;
  private history: Message[] = [];
  private currentDomain: string;
  private verbose: boolean;
  private safeMode: boolean;
  private mcpManager: MCPManager;

  constructor(options: AgentOptions) {
    this.currentDomain = options.domain;
    this.verbose = options.verbose;
    this.safeMode = options.safeMode ?? false;

    if (this.safeMode) process.env.AGENT_SAFE_MODE = '1';

    // Set model on manager
    modelManager.setPointer('main', options.model);
    this.llm = modelManager.getClient('main');

    this.router = new DomainRouter();
    this.registry = new ToolRegistry();
    this.mcpManager = new MCPManager();

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
    this.currentDomain = domain;
    this.registry.clear();
    this.registerAllTools(domain);
  }

  setModel(model: string) {
    modelManager.setPointer('main', model);
    this.llm = modelManager.getClient('main');
  }

  clearHistory() {
    this.history = [];
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

    // Auto-detect domain
    const domain = this.currentDomain === 'auto'
      ? this.router.detectDomain(prompt)
      : this.currentDomain;

    // Expand @run-agent-xxx and @ask-xxx mentions before sending
    const expandedPrompt = this.expandMentions(prompt);

    // Build system prompt with project context (AGENTS.md)
    const baseSystemPrompt = this.router.getSystemPrompt(domain);
    const systemPrompt = buildSystemPromptWithContext(baseSystemPrompt);

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

    // Set up model fallback chain from env (AGENT_FALLBACK_MODELS=model1,model2)
    const fallbackModels = (process.env.AGENT_FALLBACK_MODELS ?? '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    const fallbackChain = fallbackModels.length > 0
      ? new ModelFallbackChain(fallbackModels)
      : null;

    const allTools = this.registry.getToolDefinitions();
    let iteration = 0;
    const MAX_ITERATIONS = 15;

    while (iteration < MAX_ITERATIONS) {
      iteration++;

      // Context editing: selectively clear old tool results before hitting LLM
      const cleared = editContextIfNeeded(this.history);
      if (cleared > 0) {
        onChunk(`\n✂️  Cleared ${cleared} old tool result(s) to free context space\n`);
      }

      await triggerHook(createHookEvent('agent', 'turn', {
        iteration,
        model: modelManager.getCurrentModel('main'),
      }));

      // Tool selection: filter to relevant tools when count > threshold
      const lastUserMsg = [...this.history].reverse().find((m) => m.role === 'user')?.content ?? prompt;
      const tools = await selectTools(allTools, lastUserMsg, this.history);

      let response;
      try {
        const chatOpts = {
          systemPrompt,
          messages: this.history,
          tools,
          stream: false,
        };
        response = fallbackChain
          ? await fallbackChain.call(this.llm, chatOpts)
          : await this.llm.chat(chatOpts);
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
        onChunk(response.content);
        this.history.push({ role: 'assistant', content: response.content });
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

          const callId = `${call.name}-${Date.now()}`;
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
              // Refresh allTools so the next iteration includes newly activated tools
              allTools.length = 0;
              allTools.push(...this.registry.getToolDefinitions());
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
            toolResults.push({
              role: 'tool',
              toolCallId: call.id,
              content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
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
