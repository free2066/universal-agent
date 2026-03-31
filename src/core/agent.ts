import type { LLMClient, Message, ToolDefinition } from '../models/types.js';
import { createLLMClient } from '../models/llm-client.js';
import { DomainRouter } from './domain-router.js';
import { ToolRegistry } from './tool-registry.js';

export interface AgentOptions {
  domain: string;
  model: string;
  stream: boolean;
  verbose: boolean;
}

export class AgentCore {
  private llm: LLMClient;
  private router: DomainRouter;
  private registry: ToolRegistry;
  private history: Message[] = [];
  private currentDomain: string;
  private verbose: boolean;

  constructor(options: AgentOptions) {
    this.currentDomain = options.domain;
    this.verbose = options.verbose;
    this.llm = createLLMClient(options.model);
    this.router = new DomainRouter();
    this.registry = new ToolRegistry();

    // Register domain tools
    this.router.registerTools(this.registry, options.domain);
  }

  setDomain(domain: string) {
    this.currentDomain = domain;
    this.registry.clear();
    this.router.registerTools(this.registry, domain);
  }

  clearHistory() {
    this.history = [];
  }

  async run(prompt: string, filePath?: string): Promise<string> {
    const chunks: string[] = [];
    await this.runStream(
      prompt,
      (chunk) => chunks.push(chunk),
      filePath
    );
    return chunks.join('');
  }

  async runStream(
    prompt: string,
    onChunk: (chunk: string) => void,
    filePath?: string
  ): Promise<void> {
    // Auto-detect domain if set to 'auto'
    const domain =
      this.currentDomain === 'auto'
        ? this.router.detectDomain(prompt)
        : this.currentDomain;

    // Build system prompt
    const systemPrompt = this.router.getSystemPrompt(domain);

    // Build user message
    const userMessage: Message = {
      role: 'user',
      content: filePath
        ? `${prompt}\n\n[File context: ${filePath}]`
        : prompt,
    };

    this.history.push(userMessage);

    const tools = this.registry.getToolDefinitions();

    // Agentic loop
    let iteration = 0;
    const MAX_ITERATIONS = 10;

    while (iteration < MAX_ITERATIONS) {
      iteration++;

      const response = await this.llm.chat({
        systemPrompt,
        messages: this.history,
        tools,
        stream: false,
      });

      if (response.type === 'text') {
        onChunk(response.content);
        this.history.push({ role: 'assistant', content: response.content });
        break;
      }

      if (response.type === 'tool_calls') {
        if (this.verbose) {
          onChunk(`\n🔧 Calling tools: ${response.toolCalls.map((t) => t.name).join(', ')}\n`);
        }

        this.history.push({
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls,
        });

        const toolResults: Message[] = [];
        for (const call of response.toolCalls) {
          if (this.verbose) {
            onChunk(`  → ${call.name}(${JSON.stringify(call.arguments)})\n`);
          }

          try {
            const result = await this.registry.execute(call.name, call.arguments);
            if (this.verbose) {
              const preview = JSON.stringify(result).slice(0, 200);
              onChunk(`  ✓ Result: ${preview}${preview.length === 200 ? '...' : ''}\n`);
            }
            toolResults.push({
              role: 'tool',
              toolCallId: call.id,
              content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            });
          } catch (err) {
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
    }
  }
}
