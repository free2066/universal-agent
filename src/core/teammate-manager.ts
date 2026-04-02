/**
 * s09/s10/s11 Teammate System
 *
 * Persistent named agents with file-based JSONL inboxes.
 * Each teammate runs its own agent loop in a separate child_process (Worker).
 *
 * Architecture mirrors learn-claude-code s09 + s11:
 *
 *   Subagent (s04):  spawn → execute → return summary → destroyed
 *   Teammate (s09):  spawn → work → idle → work → ... → shutdown
 *
 *   .uagent/team/config.json          .uagent/team/inbox/
 *   +----------------------------+    +------------------+
 *   | { team_name: "default",    |    | alice.jsonl      |
 *   |   members: [               |    | bob.jsonl        |
 *   |     { name:"alice",        |    | lead.jsonl       |
 *   |       role:"coder",        |    +------------------+
 *   |       status:"idle" }      |
 *   |   ]                        |
 *   | }                          |
 *   +----------------------------+
 *
 * 5 message types (s10):
 *   message              - Normal text
 *   broadcast            - Sent to all teammates
 *   shutdown_request     - Request graceful shutdown
 *   shutdown_response    - Approve/reject shutdown
 *   plan_approval_response - Approve/reject plan
 *
 * s11 idle cycle: teammates poll for unclaimed tasks every POLL_INTERVAL ms.
 *
 * Key insights:
 *   - "Teammates that can talk to each other." (s09)
 *   - "Teammates scan the board and claim tasks themselves." (s11)
 *   - "Teammates need shared communication rules." (s10)
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
} from 'fs';
import { join, resolve } from 'path';
import { createLogger } from '../core/logger.js';
import type { ToolRegistration } from '../models/types.js';

const log = createLogger('teammate');

// ─── Constants ─────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5_000;
const IDLE_TIMEOUT_ROUNDS = 12; // 12 × 5s = 60s max idle

export const VALID_MSG_TYPES = new Set([
  'message',
  'broadcast',
  'shutdown_request',
  'shutdown_response',
  'plan_approval_response',
]);

// ─── Message Bus ───────────────────────────────────────────────────────────

export interface InboxMessage {
  type: string;
  from: string;
  content: string;
  timestamp: number;
  request_id?: string;
  approve?: boolean;
  feedback?: string;
}

export class MessageBus {
  private readonly inboxDir: string;

  constructor(inboxDir: string) {
    this.inboxDir = inboxDir;
    mkdirSync(this.inboxDir, { recursive: true });
  }

  send(
    sender: string,
    to: string,
    content: string,
    msgType = 'message',
    extra?: Record<string, unknown>,
  ): string {
    if (!VALID_MSG_TYPES.has(msgType)) {
      return `Error: Invalid type '${msgType}'. Valid: ${[...VALID_MSG_TYPES].join(', ')}`;
    }
    const msg: InboxMessage = {
      type: msgType,
      from: sender,
      content,
      timestamp: Date.now(),
      ...extra,
    };
    const path = join(this.inboxDir, `${to}.jsonl`);
    appendFileSync(path, JSON.stringify(msg) + '\n', 'utf-8');
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name: string): InboxMessage[] {
    const path = join(this.inboxDir, `${name}.jsonl`);
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean);
    const msgs = lines.map((l) => {
      try { return JSON.parse(l) as InboxMessage; } catch { return null; }
    }).filter(Boolean) as InboxMessage[];
    // Drain: clear inbox after reading
    writeFileSync(path, '', 'utf-8');
    return msgs;
  }

  broadcast(sender: string, content: string, teammates: string[]): string {
    let count = 0;
    for (const name of teammates) {
      if (name !== sender) {
        this.send(sender, name, content, 'broadcast');
        count++;
      }
    }
    return `Broadcast to ${count} teammates`;
  }
}

// ─── Teammate Config ────────────────────────────────────────────────────────

export interface TeammateConfig {
  name: string;
  role: string;
  status: 'working' | 'idle' | 'shutdown';
}

interface TeamConfig {
  team_name: string;
  members: TeammateConfig[];
}

// ─── TeammateManager ────────────────────────────────────────────────────────

export class TeammateManager {
  private readonly teamDir: string;
  private readonly configPath: string;
  private readonly inboxDir: string;
  private readonly tasksDir: string;
  private config: TeamConfig;
  public readonly bus: MessageBus;

  constructor(projectRoot: string) {
    this.teamDir = join(projectRoot, '.uagent', 'team');
    this.configPath = join(this.teamDir, 'config.json');
    this.inboxDir = join(this.teamDir, 'inbox');
    this.tasksDir = join(projectRoot, '.uagent', 'tasks');
    mkdirSync(this.teamDir, { recursive: true });
    this.bus = new MessageBus(this.inboxDir);
    this.config = this.loadConfig();
  }

  private loadConfig(): TeamConfig {
    if (existsSync(this.configPath)) {
      try { return JSON.parse(readFileSync(this.configPath, 'utf-8')); } catch { /* fallthrough */ }
    }
    return { team_name: 'default', members: [] };
  }

  private saveConfig(): void {
    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
  }

  private findMember(name: string): TeammateConfig | undefined {
    return this.config.members.find((m) => m.name === name);
  }

  private setStatus(name: string, status: TeammateConfig['status']): void {
    const m = this.findMember(name);
    if (m) {
      m.status = status;
      this.saveConfig();
    }
  }

  /**
   * Spawn a teammate that runs its own LLM loop in a background Node thread.
   * NOTE: Teammate loops require an LLM client. We use `spawnAgentTool` pattern
   * here (runs as a detached async task, not blocking the main loop).
   */
  spawn(name: string, role: string, prompt: string): string {
    const existing = this.findMember(name);
    if (existing) {
      if (!['idle', 'shutdown'].includes(existing.status)) {
        return `Error: '${name}' is currently ${existing.status}`;
      }
      existing.status = 'working';
      existing.role = role;
    } else {
      this.config.members.push({ name, role, status: 'working' });
    }
    this.saveConfig();

    // Run the teammate loop asynchronously
    this.runTeammateLoop(name, role, prompt).catch((err) => {
      log.warn(`Teammate '${name}' loop error: ${err}`);
      this.setStatus(name, 'shutdown');
    });

    return `Spawned '${name}' (role: ${role})`;
  }

  /**
   * s09/s10/s11 teammate loop:
   * WORK PHASE: execute up to 50 LLM iterations
   * IDLE PHASE: poll for new messages or unclaimed tasks
   */
  private async runTeammateLoop(name: string, role: string, initialPrompt: string): Promise<void> {
    const { AgentCore } = await import('./agent.js');
    const { modelManager } = await import('../models/model-manager.js');

    const agent = new AgentCore({
      domain: 'auto',
      model: modelManager.getCurrentModel('main'),
      stream: false,
      verbose: false,
    });

    const teamName = this.config.team_name;
    const sysHint = `You are '${name}', role: ${role}, team: ${teamName}. ` +
      `Use send_message to communicate with teammates. ` +
      `Call idle when you have finished your current work. ` +
      `You may auto-claim unclaimed tasks from the task board.`;
    agent.setSystemPrompt(sysHint);

    let workPrompt = initialPrompt;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // ── WORK PHASE ──────────────────────────────────────────────────────
      // Drain inbox and prepend to prompt
      const inbox = this.bus.readInbox(name);
      for (const msg of inbox) {
        if (msg.type === 'shutdown_request') {
          log.info(`Teammate '${name}' received shutdown_request`);
          this.setStatus(name, 'shutdown');
          return;
        }
        workPrompt += `\n[inbox] ${JSON.stringify(msg)}`;
      }

      try {
        await agent.run(workPrompt);
      } catch (err) {
        log.warn(`Teammate '${name}' LLM error: ${err}`);
        this.setStatus(name, 'shutdown');
        return;
      }

      // ── IDLE PHASE ──────────────────────────────────────────────────────
      this.setStatus(name, 'idle');

      let resumed = false;
      for (let poll = 0; poll < IDLE_TIMEOUT_ROUNDS; poll++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

        // Check inbox
        const idleInbox = this.bus.readInbox(name);
        if (idleInbox.length > 0) {
          for (const msg of idleInbox) {
            if (msg.type === 'shutdown_request') {
              this.setStatus(name, 'shutdown');
              return;
            }
            workPrompt = `[inbox] ${JSON.stringify(msg)}`;
          }
          resumed = true;
          break;
        }

        // s11: Auto-claim unclaimed task
        const unclaimed = this.getUnclaimedTask();
        if (unclaimed) {
          this.claimTask(unclaimed.id, name);
          workPrompt = `Task #${unclaimed.id}: ${unclaimed.subject}\n${unclaimed.description ?? ''}`;
          log.info(`Teammate '${name}' auto-claimed task #${unclaimed.id}`);
          resumed = true;
          break;
        }
      }

      if (!resumed) {
        log.info(`Teammate '${name}' idle timeout, shutting down`);
        this.setStatus(name, 'shutdown');
        return;
      }

      this.setStatus(name, 'working');
      agent.clearHistory();
    }
  }

  private getUnclaimedTask(): { id: number; subject: string; description?: string } | null {
    if (!existsSync(this.tasksDir)) return null;
    const files = readdirSync(this.tasksDir)
      .filter((f) => /^task_\d+\.json$/.test(f))
      .sort((a, b) => {
        const na = parseInt(a.replace('task_', '').replace('.json', ''), 10);
        const nb = parseInt(b.replace('task_', '').replace('.json', ''), 10);
        return na - nb;
      });
    for (const f of files) {
      try {
        const t = JSON.parse(readFileSync(join(this.tasksDir, f), 'utf-8'));
        if (t.status === 'pending' && !t.owner && (!t.blockedBy || t.blockedBy.length === 0)) {
          return t;
        }
      } catch { /* skip */ }
    }
    return null;
  }

  private claimTask(id: number, owner: string): void {
    const path = join(this.tasksDir, `task_${id}.json`);
    if (!existsSync(path)) return;
    const task = JSON.parse(readFileSync(path, 'utf-8'));
    task.owner = owner;
    task.status = 'in_progress';
    task.updatedAt = Date.now();
    writeFileSync(path, JSON.stringify(task, null, 2), 'utf-8');
  }

  listAll(): string {
    if (this.config.members.length === 0) return 'No teammates.';
    const lines = [`Team: ${this.config.team_name}`];
    for (const m of this.config.members) {
      lines.push(`  ${m.name} (${m.role}): ${m.status}`);
    }
    return lines.join('\n');
  }

  memberNames(): string[] {
    return this.config.members.map((m) => m.name);
  }
}

// ─── Singleton per project root ─────────────────────────────────────────────

const managerCache = new Map<string, TeammateManager>();

export function getTeammateManager(projectRoot?: string): TeammateManager {
  const root = resolve(projectRoot ?? process.cwd());
  let mgr = managerCache.get(root);
  if (!mgr) {
    mgr = new TeammateManager(root);
    managerCache.set(root, mgr);
  }
  return mgr;
}

// ─── Tool registrations ────────────────────────────────────────────────────

export const spawnTeammateTool: ToolRegistration = {
  definition: {
    name: 'spawn_teammate',
    description: [
      'Spawn a persistent autonomous teammate that runs its own LLM loop.',
      'Teammates run in background, can accept new tasks via send_message,',
      'and auto-claim unclaimed tasks from the task board when idle (s11).',
      'Use list_teammates to see status. Use send_message to communicate.',
    ].join(' '),
    parameters: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Teammate identifier (e.g. "alice").' },
        role: { type: 'string', description: 'Role description (e.g. "TypeScript coder").' },
        prompt: { type: 'string', description: 'Initial task prompt.' },
      },
      required: ['name', 'role', 'prompt'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    return getTeammateManager().spawn(
      args.name as string,
      args.role as string,
      args.prompt as string,
    );
  },
};

export const listTeammatesTool: ToolRegistration = {
  definition: {
    name: 'list_teammates',
    description: 'List all teammates with name, role, and current status.',
    parameters: { type: 'object' as const, properties: {} },
  },
  handler: async (): Promise<string> => {
    return getTeammateManager().listAll();
  },
};

export const sendMessageTool: ToolRegistration = {
  definition: {
    name: 'send_message',
    description: [
      'Send a message to a teammate\'s inbox.',
      'msg_type: message (default), broadcast, shutdown_request,',
      'shutdown_response, plan_approval_response.',
    ].join(' '),
    parameters: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Recipient teammate name.' },
        content: { type: 'string', description: 'Message content.' },
        msg_type: {
          type: 'string',
          enum: [...VALID_MSG_TYPES],
          description: 'Message type (default: message).',
        },
      },
      required: ['to', 'content'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const mgr = getTeammateManager();
    return mgr.bus.send(
      'lead',
      args.to as string,
      args.content as string,
      (args.msg_type as string | undefined) ?? 'message',
    );
  },
};

export const readInboxTool: ToolRegistration = {
  definition: {
    name: 'read_inbox',
    description: 'Read and drain the lead\'s inbox. Returns all pending messages.',
    parameters: { type: 'object' as const, properties: {} },
  },
  handler: async (): Promise<string> => {
    const mgr = getTeammateManager();
    const msgs = mgr.bus.readInbox('lead');
    if (msgs.length === 0) return 'No messages.';
    return JSON.stringify(msgs, null, 2);
  },
};

export const broadcastTool: ToolRegistration = {
  definition: {
    name: 'broadcast',
    description: 'Send a message to all teammates.',
    parameters: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'Message to broadcast.' },
      },
      required: ['content'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const mgr = getTeammateManager();
    return mgr.bus.broadcast('lead', args.content as string, mgr.memberNames());
  },
};

// ─── s10 shutdown + plan approval ─────────────────────────────────────────

const pendingPlanRequests = new Map<string, { from: string; plan: string }>();

export const shutdownRequestTool: ToolRegistration = {
  definition: {
    name: 'shutdown_request',
    description: 'Request a teammate to gracefully shut down.',
    parameters: {
      type: 'object' as const,
      properties: {
        teammate: { type: 'string', description: 'Teammate name to shut down.' },
      },
      required: ['teammate'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const mgr = getTeammateManager();
    const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    mgr.bus.send('lead', args.teammate as string, 'Please shut down.', 'shutdown_request', { request_id: reqId });
    return `Shutdown request ${reqId} sent to '${args.teammate}'`;
  },
};

export const planApprovalTool: ToolRegistration = {
  definition: {
    name: 'plan_approval',
    description: 'Approve or reject a teammate plan request.',
    parameters: {
      type: 'object' as const,
      properties: {
        request_id: { type: 'string', description: 'Plan request ID.' },
        approve: { type: 'boolean', description: 'true to approve, false to reject.' },
        feedback: { type: 'string', description: 'Optional feedback message.' },
      },
      required: ['request_id', 'approve'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const reqId = args.request_id as string;
    const req = pendingPlanRequests.get(reqId);
    if (!req) return `Error: Unknown plan request_id '${reqId}'`;
    const status = args.approve ? 'approved' : 'rejected';
    const mgr = getTeammateManager();
    mgr.bus.send('lead', req.from, (args.feedback as string | undefined) ?? '', 'plan_approval_response', {
      request_id: reqId,
      approve: args.approve,
      feedback: args.feedback ?? '',
    });
    pendingPlanRequests.delete(reqId);
    return `Plan ${status} for '${req.from}'`;
  },
};

export const claimTaskFromBoardTool: ToolRegistration = {
  definition: {
    name: 'claim_task',
    description: 'Claim a pending unclaimed task from the board by ID.',
    parameters: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'number', description: 'Task ID to claim.' },
      },
      required: ['task_id'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const { getTaskBoard } = await import('./task-board.js');
    const board = getTaskBoard(process.cwd());
    return board.claim(args.task_id as number, 'lead');
  },
};
