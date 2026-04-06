/**
 * cron-tools.ts — ScheduleCronTool 工具注册
 *
 * E23: 对标 claude-code src/tools/ScheduleCronTool/
 *
 * 提供三个工具让 LLM 管理定时任务：
 *   - cron_create: 创建 cron 任务（验证表达式、检查 MAX_JOBS=50）
 *   - cron_delete: 删除任务（by ID）
 *   - cron_list:   列出所有任务（含 next-fire 时间计算）
 *
 * cron 表达式采用 5字段格式：分 时 日 月 周（与 claude-code 对齐）
 * feature 门控：AGENT_TRIGGERS 环境变量（兼容 claude-code）
 */

import type { ToolRegistration } from '../../../models/types.js';
import {
  addCronTask,
  removeCronTask,
  listCronTasks,
  MAX_CRON_JOBS,
} from '../../cron/cron-tasks.js';
import {
  validateCronExpression,
  getNextFireTime,
  startCronScheduler,
  isCronSchedulerRunning,
} from '../../cron/cron-scheduler.js';

// ── feature 门控 ──────────────────────────────────────────────────────────────

/** E23: AGENT_TRIGGERS 门控（对标 claude-code feature('AGENT_TRIGGERS')） */
function isAgentTriggersEnabled(): boolean {
  const envVal = process.env['AGENT_TRIGGERS'];
  if (envVal === 'false' || envVal === '0') return false;
  return true; // 默认开启（claude-code 对标）
}

// ── cron_create ───────────────────────────────────────────────────────────────

export const cronCreateTool: ToolRegistration = {
  definition: {
    name: 'cron_create',
    description:
      'Create a scheduled cron task that automatically triggers with a prompt. ' +
      'Uses standard 5-field cron expression format: "minute hour day month weekday". ' +
      `Maximum ${MAX_CRON_JOBS} tasks total. ` +
      'Examples: "0 9 * * 1-5" (9am Mon-Fri), "*/30 * * * *" (every 30 min), ' +
      '"0 0 * * 0" (midnight Sunday). ' +
      'Set durable=true to persist across restarts; recurring=false for one-shot tasks.',
    parameters: {
      type: 'object',
      properties: {
        cron: {
          type: 'string',
          description: '5-field cron expression: "minute hour day month weekday". Example: "0 9 * * 1-5"',
        },
        prompt: {
          type: 'string',
          description: 'The prompt to send to the agent when the task fires',
        },
        recurring: {
          type: 'boolean',
          description: 'true=repeat on schedule, false=one-shot (fires once then deletes). Default: true',
        },
        durable: {
          type: 'boolean',
          description: 'true=persist to disk (survives restarts), false=session-only. Default: false',
        },
        permanent: {
          type: 'boolean',
          description: 'true=task survives process exit even when durable=true. Default: false',
        },
        agentId: {
          type: 'string',
          description: 'Optional: route this task to a specific agent ID. Omit for current agent.',
        },
      },
      required: ['cron', 'prompt'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    if (!isAgentTriggersEnabled()) {
      return '[CronCreate] Scheduled tasks are disabled. Set AGENT_TRIGGERS=true to enable.';
    }

    const cron = String(args['cron'] ?? '').trim();
    const prompt = String(args['prompt'] ?? '').trim();
    const recurring = args['recurring'] !== false; // default true
    const durable = Boolean(args['durable'] ?? false);
    const permanent = Boolean(args['permanent'] ?? false);
    const agentId = args['agentId'] ? String(args['agentId']) : undefined;

    if (!cron) return '[CronCreate] cron expression is required';
    if (!prompt) return '[CronCreate] prompt is required';

    // 验证 cron 表达式
    const valid = validateCronExpression(cron);
    if (valid !== true) return `[CronCreate] ${valid}`;

    try {
      const task = addCronTask({ cron, prompt, recurring, permanent, durable, agentId });

      // 自动启动调度器（若未启动）
      if (!isCronSchedulerRunning()) {
        startCronScheduler(async (taskId, taskPrompt, _agentId) => {
          process.stderr.write(`[cron] Task "${taskId}" fired: ${taskPrompt.slice(0, 80)}\n`);
          // 实际触发由 AgentCore 的 onCronFire 回调处理（已在 agent-loop.ts 注册）
        });
      }

      const nextFire = getNextFireTime(cron);
      const nextFireStr = nextFire
        ? nextFire.toISOString()
        : 'unable to determine next fire time';

      return JSON.stringify({
        taskId: task.id,
        cron: task.cron,
        prompt: task.prompt.slice(0, 100),
        recurring: task.recurring,
        durable: task.durable,
        permanent: task.permanent,
        agentId: task.agentId ?? null,
        createdAt: new Date(task.createdAt).toISOString(),
        nextFireTime: nextFireStr,
        status: 'created',
      });
    } catch (err) {
      return `[CronCreate] ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

// ── cron_delete ───────────────────────────────────────────────────────────────

export const cronDeleteTool: ToolRegistration = {
  definition: {
    name: 'cron_delete',
    description:
      'Delete a scheduled cron task by its ID. ' +
      'Use cron_list to see all task IDs.',
    parameters: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'The task ID to delete (from cron_list or cron_create output)',
        },
      },
      required: ['taskId'],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    if (!isAgentTriggersEnabled()) {
      return '[CronDelete] Scheduled tasks are disabled.';
    }

    const taskId = String(args['taskId'] ?? '').trim();
    if (!taskId) return '[CronDelete] taskId is required';

    const deleted = removeCronTask(taskId);
    if (!deleted) {
      return JSON.stringify({ taskId, status: 'not_found', message: `No task found with ID "${taskId}"` });
    }
    return JSON.stringify({ taskId, status: 'deleted' });
  },
};

// ── cron_list ─────────────────────────────────────────────────────────────────

export const cronListTool: ToolRegistration = {
  definition: {
    name: 'cron_list',
    description:
      'List all scheduled cron tasks, including their next fire time. ' +
      'Shows task ID, cron expression, prompt preview, recurring status, and durable status.',
    parameters: {
      type: 'object',
      properties: {
        includeInactive: {
          type: 'boolean',
          description: 'If true, also show one-shot tasks that have already fired (lastFiredAt set but deleted). Default: false',
        },
      },
      required: [],
    },
  },
  handler: async (): Promise<string> => {
    if (!isAgentTriggersEnabled()) {
      return '[CronList] Scheduled tasks are disabled.';
    }

    const tasks = listCronTasks();
    if (tasks.length === 0) {
      return JSON.stringify({ tasks: [], count: 0, maxJobs: MAX_CRON_JOBS });
    }

    const now = new Date();
    const formatted = tasks.map((t) => {
      const nextFire = getNextFireTime(t.cron, now);
      return {
        taskId: t.id,
        cron: t.cron,
        prompt: t.prompt.length > 80 ? t.prompt.slice(0, 80) + '...' : t.prompt,
        recurring: t.recurring,
        durable: t.durable,
        permanent: t.permanent,
        agentId: t.agentId ?? null,
        createdAt: new Date(t.createdAt).toISOString(),
        lastFiredAt: t.lastFiredAt ? new Date(t.lastFiredAt).toISOString() : null,
        nextFireTime: nextFire ? nextFire.toISOString() : null,
      };
    });

    return JSON.stringify({
      tasks: formatted,
      count: tasks.length,
      maxJobs: MAX_CRON_JOBS,
      schedulerRunning: isCronSchedulerRunning(),
    });
  },
};
