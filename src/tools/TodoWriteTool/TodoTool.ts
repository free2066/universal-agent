/**
 * s03 TodoWrite — in-session task tracking with nag reminder.
 *
 * Mirrors learn-claude-code s03's TodoManager:
 * - Model calls TodoWrite to maintain a checklist during multi-step tasks
 * - Agent loop tracks rounds_without_todo; injects a reminder when >= 3
 * - Only one task can be in_progress at a time
 * - max 20 items
 *
 * Key insight: "The agent can track its own progress — and I can see it."
 */

import type { ToolRegistration } from '../../models/types.js';

// ─── TodoItem ──────────────────────────────────────────────────────────────────

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  /** Short active form (verb phrase) describing what is being done */
  activeForm: string;
}

// ─── TodoManager ──────────────────────────────────────────────────────────────

export class TodoManager {
  private items: TodoItem[] = [];

  update(items: TodoItem[]): string {
    if (items.length > 20) throw new Error('Max 20 todos allowed');

    const validated: TodoItem[] = [];
    let inProgressCount = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const content = String(item.content ?? '').trim();
      const status = String(item.status ?? 'pending').toLowerCase() as TodoItem['status'];
      const activeForm = String(item.activeForm ?? '').trim();

      if (!content) throw new Error(`Item ${i}: content required`);
      if (!['pending', 'in_progress', 'completed'].includes(status)) {
        throw new Error(`Item ${i}: invalid status '${status}'`);
      }
      if (!activeForm) throw new Error(`Item ${i}: activeForm required`);
      if (status === 'in_progress') inProgressCount++;

      validated.push({ content, status, activeForm });
    }

    if (inProgressCount > 1) throw new Error('Only one in_progress allowed');
    this.items = validated;
    return this.render();
  }

  render(): string {
    if (this.items.length === 0) return 'No todos.';
    const markers: Record<string, string> = {
      completed: '[x]',
      in_progress: '[>]',
      pending: '[ ]',
    };
    const lines = this.items.map((item) => {
      const m = markers[item.status] ?? '[?]';
      const suffix = item.status === 'in_progress' ? ` <- ${item.activeForm}` : '';
      return `${m} ${item.content}${suffix}`;
    });
    const done = this.items.filter((t) => t.status === 'completed').length;
    lines.push(`\n(${done}/${this.items.length} completed)`);
    return lines.join('\n');
  }

  hasOpenItems(): boolean {
    return this.items.some((item) => item.status !== 'completed');
  }

  getItems(): TodoItem[] {
    return this.items;
  }
}

// ─── Singleton per process ─────────────────────────────────────────────────

export const todoManager = new TodoManager();

// ─── Tool registration ─────────────────────────────────────────────────────

export const todoWriteTool: ToolRegistration = {
  definition: {
    name: 'TodoWrite',
    description: [
      'Update the in-session task tracking checklist.',
      'Use this to plan multi-step tasks: list all steps upfront, then mark',
      'in_progress before starting each one and completed when done.',
      'Only one item can be in_progress at a time. Max 20 items.',
      'Keep using this tool throughout your work — the harness will remind you if you forget.',
    ].join(' '),
    parameters: {
      type: 'object' as const,
      properties: {
        items: {
          type: 'array',
          description: 'Full list of todos (replaces existing list).',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Task description.' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: 'Task status.',
              },
              activeForm: {
                type: 'string',
                description: 'Verb phrase for in_progress items, e.g. "Reading file".',
              },
            },
            required: ['content', 'status', 'activeForm'],
          },
        },
      },
      required: ['items'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    return todoManager.update(args.items as TodoItem[]);
  },
};

/**
 * E15: TodoReadTool — 纯读语义（无副作用）
 * 对标 claude-code TodoReadTool，LLM 可独立读取当前 todo 状态，无需发起写操作。
 * alwaysLoad: true — 不参与 deferred 懒加载（工具数超阈值时也保持可见）
 */
export const todoReadTool: ToolRegistration & { alwaysLoad?: boolean } = {
  alwaysLoad: true,
  definition: {
    name: 'TodoRead',
    description: [
      'Read the current in-session task tracking checklist.',
      'Use this to check task status before making updates.',
      'Returns all todos with their current status.',
    ].join(' '),
    parameters: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  handler: async (_args: Record<string, unknown>): Promise<string> => {
    const items = todoManager.getItems();
    if (items.length === 0) return '(No todos yet — use TodoWrite to create tasks)';
    return todoManager.render();
  },
};
