import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { parse as parseYaml } from 'yaml';
import { modelManager } from '../models/model-manager.js';
import type { ToolRegistration } from '../models/types.js';
import { createLogger } from './logger.js';

const log = createLogger('subagent');

export interface SubagentDef {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt?: string;
}

// ── Usage tracking (for entropy-reduction / zombie detection) ─────────────────
// In-memory cache that batches disk writes: recordUsage() only flushes to disk
// when the dirty flag is set AND at least USAGE_FLUSH_INTERVAL_MS have elapsed
// since the last flush. This avoids a readFileSync+writeFileSync pair on every
// single subagent call in high-frequency SpawnParallel scenarios.
interface UsageRecord {
  lastUsed: number; // epoch ms
  callCount: number;
}

const usageFile = resolve(process.env.HOME || '~', '.uagent', 'agent-usage.json');
const USAGE_FLUSH_INTERVAL_MS = 30_000; // flush at most once per 30 s

let _usageCache: Record<string, UsageRecord> | null = null;
let _usageDirty = false;
let _usageLastFlush = 0;

function loadUsage(): Record<string, UsageRecord> {
  if (_usageCache) return _usageCache;
  try {
    if (existsSync(usageFile)) {
      _usageCache = JSON.parse(readFileSync(usageFile, 'utf-8')) as Record<string, UsageRecord>;
      return _usageCache;
    }
  } catch { /* ignore */ }
  _usageCache = {};
  return _usageCache;
}

function saveUsage(usage: Record<string, UsageRecord>) {
  try {
    const dir = resolve(process.env.HOME || '~', '.uagent');
    mkdirSync(dir, { recursive: true });
    writeFileSync(usageFile, JSON.stringify(usage, null, 2));
    _usageLastFlush = Date.now();
    _usageDirty = false;
  } catch { /* ignore */ }
}

function recordUsage(agentName: string) {
  const usage = loadUsage();
  const existing = usage[agentName] ?? { lastUsed: 0, callCount: 0 };
  usage[agentName] = { lastUsed: Date.now(), callCount: existing.callCount + 1 };
  _usageDirty = true;
  // Only flush if enough time has elapsed (batching writes for high-frequency calls)
  if (Date.now() - _usageLastFlush >= USAGE_FLUSH_INTERVAL_MS) {
    saveUsage(usage);
  }
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

    recordUsage(agentName);

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

  /**
   * Fan-out: run multiple subagents in parallel, return combined results.
   * Inspired by kstack article #15309 Fan-out parallel Agent pattern.
   *
   * Each entry in `tasks` specifies which subagent to run and what task to give it.
   * All agents run concurrently via Promise.all — the main agent gets a combined report.
   */
  async runParallel(
    tasks: Array<{ agentName: string; task: string }>,
    parentModel?: string,
  ): Promise<string> {
    log.info(`Fan-out: running ${tasks.length} subagents in parallel`);
    const results = await Promise.all(
      tasks.map(async ({ agentName, task }) => {
        const result = await this.runAgent(agentName, task, parentModel);
        return `### [${agentName}]\n${result}`;
      }),
    );
    return results.join('\n\n---\n\n');
  }

  /**
   * Entropy reduction: find subagents that haven't been used in `staleDays`.
   * Returns a list of "zombie" subagents for cleanup.
   *
   * Built-in agents (defined in loadBuiltinAgents) are excluded —
   * they ship with the system and should never appear as "stale".
   * Only user-defined agents (loaded from .uagent/agents/ or .kode/agents/) are checked.
   */
  findZombieAgents(staleDays = 30): Array<{ name: string; lastUsed: Date | null; callCount: number }> {
    const usage = loadUsage();
    const staleMs = staleDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const zombies: Array<{ name: string; lastUsed: Date | null; callCount: number }> = [];

    for (const agent of this.agents.values()) {
      // Skip built-in agents — they are always present and should not be flagged
      if (this.isBuiltinAgent(agent.name)) continue;

      const rec = usage[agent.name];
      if (!rec) {
        // User-defined agent never used
        zombies.push({ name: agent.name, lastUsed: null, callCount: 0 });
      } else if (now - rec.lastUsed > staleMs) {
        zombies.push({ name: agent.name, lastUsed: new Date(rec.lastUsed), callCount: rec.callCount });
      }
    }
    return zombies;
  }

  /** Names of built-in agents (loaded by loadBuiltinAgents) */
  private static readonly BUILTIN_AGENT_NAMES = new Set([
    'reviewer', 'architect', 'test-writer', 'data-analyst', 'security-auditor', 'doc-writer',
  ]);

  private isBuiltinAgent(name: string): boolean {
    return SubagentSystem.BUILTIN_AGENT_NAMES.has(name);
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
//
// Supports both single-agent and Fan-out parallel execution.
// Fan-out is triggered when `parallel_tasks` array is provided.
//
// Example — parallel Fan-out (kstack article #15309):
//   Task({
//     parallel_tasks: [
//       { subagent_type: "reviewer", task: "Review auth module" },
//       { subagent_type: "security-auditor", task: "Audit auth module" }
//     ]
//   })
export function createTaskTool(sys: SubagentSystem): ToolRegistration {
  return {
    definition: {
      name: 'Task',
      description: [
        `Delegate a task to a specialized subagent, or fan-out to multiple subagents in parallel.`,
        `Available subagents: ${sys.listAgents().map((a) => a.name).join(', ')}.`,
        `For single delegation: use subagent_type + task.`,
        `For parallel fan-out: use parallel_tasks array with [{subagent_type, task}] entries.`,
        `Parallel fan-out runs all agents concurrently and merges results — use it for independent subtasks.`,
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          subagent_type: { type: 'string', description: 'Subagent name for single delegation' },
          task: { type: 'string', description: 'Task description for single delegation' },
          model: { type: 'string', description: 'Optional: override model for this run' },
          parallel_tasks: {
            type: 'array',
            description: 'Fan-out: array of {subagent_type, task} objects to run in parallel',
            items: {
              type: 'object',
              description: 'Each entry: { subagent_type: string, task: string }',
            },
          },
        },
        required: [],
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const { subagent_type, task, model, parallel_tasks } = args as {
        subagent_type?: string;
        task?: string;
        model?: string;
        parallel_tasks?: Array<{ subagent_type: string; task: string }>;
      };

      // Fan-out parallel mode
      if (Array.isArray(parallel_tasks) && parallel_tasks.length > 0) {
        return sys.runParallel(
          parallel_tasks.map((pt) => ({ agentName: pt.subagent_type, task: pt.task })),
          model,
        );
      }

      // Single agent mode
      if (!subagent_type || !task) {
        return 'Error: Task tool requires either (subagent_type + task) or parallel_tasks array';
      }
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
    // Re-use modelManager's cached LLMClient so we don't allocate a new HTTP
    // client object on every AskExpertModel call.  We temporarily point 'task'
    // at the requested model, grab the (now-cached) client, then restore the
    // previous pointer so we don't leave a persistent side-effect.
    const prevTaskModel = modelManager.getCurrentModel('task');
    let client;
    try {
      modelManager.setPointer('task', model);
      client = modelManager.getClient('task');
    } catch {
      // Unknown model not in profiles — fall back to direct instantiation
      const { createLLMClient } = await import('../models/llm-client.js');
      client = createLLMClient(model);
    } finally {
      // Restore original task pointer to avoid persistent side-effect
      if (prevTaskModel && prevTaskModel !== model) {
        try { modelManager.setPointer('task', prevTaskModel); } catch { /* ignore */ }
      }
    }
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
