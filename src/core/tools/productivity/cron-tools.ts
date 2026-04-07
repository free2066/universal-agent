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
 *
 * F28: 新增 cronToHuman() 人类可读描述 + DEFAULT_MAX_AGE_DAYS=30 自动过期
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

// ── F28: cronToHuman — 人类可读 cron 描述 ─────────────────────────────────────
// Mirrors claude-code src/utils/cron.ts L218-308
// 手写 7 种 pattern，无外部依赖

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * F28: Convert a 5-field cron expression to a human-readable description.
 * Mirrors claude-code cron.ts cronToHuman() — covers 7 common patterns.
 */
export function cronToHuman(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron; // fallback: return raw

  const [min, hour, day, month, weekday] = parts as [string, string, string, string, string];

  // Every minute
  if (min === '*' && hour === '*' && day === '*' && month === '*' && weekday === '*') {
    return 'Every minute';
  }

  // Every N minutes: */N * * * *
  const everyNMinMatch = /^\*\/(\d+)$/.exec(min);
  if (everyNMinMatch && hour === '*' && day === '*' && month === '*' && weekday === '*') {
    const n = parseInt(everyNMinMatch[1]!, 10);
    return `Every ${n} minute${n !== 1 ? 's' : ''}`;
  }

  // Every N hours: 0 */N * * * or M */N * * *
  const everyNHourMatch = /^\*\/(\d+)$/.exec(hour);
  if (everyNHourMatch && day === '*' && month === '*' && weekday === '*') {
    const n = parseInt(everyNHourMatch[1]!, 10);
    const minNum = parseInt(min, 10);
    if (!isNaN(minNum) && minNum === 0) {
      return `Every ${n} hour${n !== 1 ? 's' : ''}`;
    }
    return `Every ${n} hour${n !== 1 ? 's' : ''} at :${min.padStart(2, '0')}`;
  }

  // Every hour at :MM: M * * * *
  const minNum = parseInt(min, 10);
  if (!isNaN(minNum) && /^\d+$/.test(min) && hour === '*' && day === '*' && month === '*' && weekday === '*') {
    return `Every hour at :${min.padStart(2, '0')}`;
  }

  // Build time string for daily/weekly patterns
  const hNum = parseInt(hour, 10);
  const mNum = parseInt(min, 10);
  const hasFixedTime = !isNaN(hNum) && !isNaN(mNum) && /^\d+$/.test(hour) && /^\d+$/.test(min);
  const timeStr = hasFixedTime
    ? `${String(hNum).padStart(2, '0')}:${String(mNum).padStart(2, '0')}`
    : `${hour}:${min}`;

  // Every specific weekday: M H * * W
  if (day === '*' && month === '*' && /^\d$/.test(weekday)) {
    const wdNum = parseInt(weekday, 10);
    const dayName = DAY_NAMES[wdNum] ?? `weekday ${wdNum}`;
    return `Every ${dayName} at ${timeStr}`;
  }

  // Weekdays (Mon-Fri): M H * * 1-5
  if (day === '*' && month === '*' && weekday === '1-5') {
    return `Every weekday (Mon-Fri) at ${timeStr}`;
  }

  // Daily: M H * * *
  if (day === '*' && month === '*' && weekday === '*' && hasFixedTime) {
    return `Every day at ${timeStr}`;
  }

  // Fallback: return raw cron expression
  return cron;
}

// ── F28: DEFAULT_MAX_AGE_DAYS — 自动过期 ──────────────────────────────────────

/** F28: Default max age for scheduled tasks — 30 days (mirrors claude-code prompt.ts DEFAULT_MAX_AGE_DAYS) */
const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_MAX_AGE_MS = DEFAULT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

// ── cron_create ───────────────────────────────────────────────────────────────

export const cronCreateTool: ToolRegistration = {
  searchHint: 'schedule recurring one-shot task timer prompt automation',
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

    // A29: durable + teammate conflict check — mirrors CronCreateTool.ts L105-114
    // Teammate agents are ephemeral; durable crons survive restart but agentId won't match
    const isTeammate = !!process.env['__UAGENT_PARENT_AGENT_ID'];
    if (durable && isTeammate) {
      return '[CronCreate] durable crons are not allowed for teammate agents ' +
        '(the agentId becomes invalid after restart, causing orphan tasks that cannot be cleaned up)';
    }

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

      // F28: humanSchedule + expiresAt (DEFAULT_MAX_AGE_DAYS=30)
      const humanSchedule = cronToHuman(cron);
      const expiresAt = Date.now() + DEFAULT_MAX_AGE_MS;

      return JSON.stringify({
        taskId: task.id,
        cron: task.cron,
        humanSchedule,
        prompt: task.prompt.slice(0, 100),
        recurring: task.recurring,
        durable: task.durable,
        permanent: task.permanent,
        agentId: task.agentId ?? null,
        createdAt: new Date(task.createdAt).toISOString(),
        nextFireTime: nextFireStr,
        expiresAt: new Date(expiresAt).toISOString(),
        note: `Auto-expires after ${DEFAULT_MAX_AGE_DAYS} days`,
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

    // A29: agentId ownership check — mirrors CronDeleteTool.ts L71-79
    // Teammate agents can only delete their own tasks (防止跨 agent 删除竞态)
    const { getCronTask } = await import('../../cron/cron-tasks.js');
    const task = getCronTask(taskId);
    if (task) {
      const currentAgentId = process.env['AGENT_ID'] ?? process.env['__UAGENT_AGENT_ID'];
      if (task.agentId && currentAgentId && task.agentId !== currentAgentId) {
        return JSON.stringify({
          taskId,
          status: 'forbidden',
          message: `Cannot delete: task "${taskId}" is owned by agent "${task.agentId}"`,
        });
      }
    }

    const deleted = removeCronTask(taskId);
    if (!deleted) {
      return JSON.stringify({ taskId, status: 'not_found', message: `No task found with ID "${taskId}"` });
    }
    return JSON.stringify({ taskId, status: 'deleted' });
  },
};

// ── cron_list ─────────────────────────────────────────────────────────────────

export const cronListTool: ToolRegistration = {
  searchHint: 'list scheduled jobs cron tasks next fire time',
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

    const allTasks = listCronTasks();

    // F28: lazy expiry cleanup — remove tasks older than DEFAULT_MAX_AGE_DAYS
    const now = Date.now();
    const activeTasks = allTasks.filter((t) => {
      const age = now - t.createdAt;
      if (age > DEFAULT_MAX_AGE_MS) {
        removeCronTask(t.id);
        return false;
      }
      return true;
    });

    // A29: teammate filter — mirrors CronListTool.ts L67-69
    // Teammates only see their own tasks; team lead sees all
    const currentAgentId = process.env['AGENT_ID'] ?? process.env['__UAGENT_AGENT_ID'];
    const tasks = currentAgentId
      ? activeTasks.filter((t) => !t.agentId || t.agentId === currentAgentId)
      : activeTasks;

    if (tasks.length === 0) {
      return JSON.stringify({ tasks: [], count: 0, maxJobs: MAX_CRON_JOBS });
    }

    const nowDate = new Date();
    const formatted = tasks.map((t) => {
      const nextFire = getNextFireTime(t.cron, nowDate);
      return {
        taskId: t.id,
        cron: t.cron,
        humanSchedule: cronToHuman(t.cron),  // F28: human-readable schedule
        prompt: t.prompt.length > 80 ? t.prompt.slice(0, 80) + '...' : t.prompt,
        recurring: t.recurring,
        durable: t.durable,
        permanent: t.permanent,
        agentId: t.agentId ?? null,
        createdAt: new Date(t.createdAt).toISOString(),
        lastFiredAt: t.lastFiredAt ? new Date(t.lastFiredAt).toISOString() : null,
        nextFireTime: nextFire ? nextFire.toISOString() : null,
        expiresAt: new Date(t.createdAt + DEFAULT_MAX_AGE_MS).toISOString(),
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
