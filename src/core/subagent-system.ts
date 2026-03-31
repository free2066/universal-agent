import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { parse as parseYaml } from 'yaml';
import { modelManager } from '../models/model-manager.js';
import type { ToolRegistration } from '../models/types.js';

export interface SubagentDef {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt?: string;
}

export class SubagentSystem {
  private agents: Map<string, SubagentDef> = new Map();

  constructor() {
    this.loadBuiltinAgents();
    this.discoverAgents();
  }

  private loadBuiltinAgents() {
    const builtins: SubagentDef[] = [
      {
        name: 'reviewer',
        description: 'Review code for correctness, security, and simplicity. Be strict, point out bugs and risky changes.',
        tools: ['Read', 'Grep', 'LS'],
        model: 'inherit',
        systemPrompt: 'You are a strict code reviewer. Point out bugs, security issues, and risky changes. Prefer small, targeted fixes.',
      },
      {
        name: 'architect',
        description: 'Design system architecture and technical solutions. Think in abstractions, components, and data flows.',
        tools: ['Read', 'LS', 'Grep'],
        model: 'inherit',
        systemPrompt: 'You are a senior software architect. Design clean, scalable systems. Think about trade-offs, patterns, and long-term maintainability.',
      },
      {
        name: 'test-writer',
        description: 'Create comprehensive unit and integration tests.',
        tools: ['Read', 'Write', 'Grep', 'Bash'],
        model: 'inherit',
        systemPrompt: 'You are a testing expert. Write comprehensive, well-structured tests. Cover edge cases, error paths, and happy paths.',
      },
      {
        name: 'data-analyst',
        description: 'Analyze data, generate EDA reports, and create SQL queries.',
        tools: ['Read', 'Bash', 'analyze_csv', 'generate_eda_report'],
        model: 'inherit',
        systemPrompt: 'You are an expert data analyst. Analyze datasets thoroughly, identify patterns, and provide actionable insights.',
      },
      {
        name: 'security-auditor',
        description: 'Audit code for security vulnerabilities and OWASP issues.',
        tools: ['Read', 'Grep', 'LS'],
        model: 'inherit',
        systemPrompt: 'You are a security expert. Find vulnerabilities including SQL injection, XSS, CSRF, insecure auth, and other OWASP issues.',
      },
      {
        name: 'doc-writer',
        description: 'Write and maintain technical documentation.',
        tools: ['Read', 'Write', 'LS', 'Grep'],
        model: 'inherit',
        systemPrompt: 'You are a technical writer. Write clear, concise, and comprehensive documentation. Use examples and code snippets.',
      },
    ];
    for (const agent of builtins) this.agents.set(agent.name, agent);
  }

  private discoverAgents() {
    const searchPaths = [
      resolve(process.cwd(), '.uagent', 'agents'),
      resolve(process.cwd(), '.kode', 'agents'),
      resolve(process.env.HOME || '~', '.uagent', 'agents'),
    ];
    for (const dir of searchPaths) {
      if (!existsSync(dir)) continue;
      try {
        const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
        for (const file of files) {
          const content = readFileSync(join(dir, file), 'utf-8');
          const agent = parseAgentMarkdown(content, file.replace('.md', ''));
          if (agent) this.agents.set(agent.name, agent);
        }
      } catch { /* ignore */ }
    }
  }

  getAgent(name: string): SubagentDef | undefined { return this.agents.get(name); }
  listAgents(): SubagentDef[] { return Array.from(this.agents.values()); }

  async runAgent(agentName: string, task: string, parentModel?: string): Promise<string> {
    const def = this.agents.get(agentName);
    if (!def) {
      return `Error: Subagent "${agentName}" not found. Available: ${Array.from(this.agents.keys()).join(', ')}`;
    }

    const model = def.model === 'inherit' || !def.model
      ? (parentModel || modelManager.getCurrentModel('task'))
      : def.model;

    // Lazy import to break the circular dependency: subagent-system ↔ agent
    const { AgentCore } = await import('./agent.js');
    const agent = new AgentCore({ domain: 'auto', model, stream: false, verbose: false });

    const prompt = def.systemPrompt
      ? `[System: ${def.systemPrompt}]\n\n${task}`
      : task;

    return agent.run(prompt);
  }

  saveAgent(def: SubagentDef, scope: 'user' | 'project' = 'project') {
    const dir = scope === 'project'
      ? resolve(process.cwd(), '.uagent', 'agents')
      : resolve(process.env.HOME || '~', '.uagent', 'agents');
    mkdirSync(dir, { recursive: true });
    const content = [
      '---',
      `name: ${def.name}`,
      `description: "${def.description}"`,
      `tools: [${(def.tools || []).map((t) => `"${t}"`).join(', ')}]`,
      `model: ${def.model || 'inherit'}`,
      '---',
      '',
      def.systemPrompt || '',
    ].join('\n');
    writeFileSync(join(dir, `${def.name}.md`), content);
    this.agents.set(def.name, def);
  }
}

function parseAgentMarkdown(content: string, fallbackName: string): SubagentDef | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)/);
  if (!match) return null;
  try {
    const frontmatter = parseYaml(match[1]) as Record<string, unknown>;
    const body = match[2]?.trim();
    return {
      name: (frontmatter.name as string) || fallbackName,
      description: (frontmatter.description as string) || '',
      tools: (frontmatter.tools as string[]) || [],
      model: (frontmatter.model as string) || 'inherit',
      systemPrompt: body || undefined,
    };
  } catch { return null; }
}

// ── Task Tool ────────────────────────────────────────────
export function createTaskTool(sys: SubagentSystem): ToolRegistration {
  return {
    definition: {
      name: 'Task',
      description: `Delegate a task to a specialized subagent. Available: ${sys.listAgents().map((a) => a.name).join(', ')}`,
      parameters: {
        type: 'object',
        properties: {
          subagent_type: { type: 'string', description: 'Subagent name to run' },
          task: { type: 'string', description: 'Task to delegate' },
          model: { type: 'string', description: 'Optional: override model for this run' },
        },
        required: ['subagent_type', 'task'],
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const { subagent_type, task, model } = args as { subagent_type: string; task: string; model?: string };
      return sys.runAgent(subagent_type, task, model);
    },
  };
}

// ── AskExpertModel Tool ──────────────────────────────────
export const askExpertModelTool: ToolRegistration = {
  definition: {
    name: 'AskExpertModel',
    description: 'Consult a specific expert AI model. Use @ask-<model-name> syntax.',
    parameters: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model to consult (e.g., claude-3-5-sonnet, gpt-4o, ollama:llama3)' },
        question: { type: 'string', description: 'Question or analysis request' },
        context: { type: 'string', description: 'Optional: code or context to analyze' },
      },
      required: ['model', 'question'],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const { model, question, context } = args as { model: string; question: string; context?: string };
    const { createLLMClient } = await import('../models/llm-client.js');
    const client = createLLMClient(model);
    const prompt = context ? `${question}\n\nContext:\n${context}` : question;
    try {
      const response = await client.chat({
        systemPrompt: 'You are an expert AI assistant. Provide concise, accurate, and insightful analysis.',
        messages: [{ role: 'user', content: prompt }],
      });
      return `[Expert: ${model}]\n${response.content}`;
    } catch (err) {
      return `Error consulting ${model}: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const subagentSystem = new SubagentSystem();
