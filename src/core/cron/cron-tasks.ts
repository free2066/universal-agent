/**
 * cron-tasks.ts — CronTask 持久化存储
 *
 * E23: ScheduleCronTool 基础层
 * 对标 claude-code src/utils/cronTasks.ts
 *
 * CronTask 结构：
 *   id          uuid-v4 生成的唯一标识
 *   cron        5字段 cron 表达式（分 时 日 月 周）
 *   prompt      定时触发时发送给 agent 的 prompt
 *   createdAt   创建时间戳（ms）
 *   lastFiredAt 上次触发时间戳（ms），null 表示未触发过
 *   recurring   false=one-shot（触发后删除），true=循环
 *   permanent   true=永不过期（进程退出也保留），跨 session
 *   durable     true=持久化到磁盘；false=仅内存（session 内）
 *   agentId     可选，路由到指定 agent；null=当前 agent
 *
 * 持久化路径：.uagent/scheduled_tasks.json
 * MAX_JOBS = 50（与 claude-code 对齐）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { randomBytes } from 'crypto';

// ── 常量 ──────────────────────────────────────────────────────────────────────

export const MAX_CRON_JOBS = 50;
const TASKS_FILE = '.uagent/scheduled_tasks.json';

// ── CronTask 类型定义 ─────────────────────────────────────────────────────────

export interface CronTask {
  /** 唯一任务 ID (hex-12) */
  id: string;
  /** 5字段标准 cron 表达式（分 时 日 月 周） */
  cron: string;
  /** 触发时发送给 agent 的 prompt */
  prompt: string;
  /** 创建时间戳（ms） */
  createdAt: number;
  /** 上次触发时间戳（ms），首次未触发为 undefined */
  lastFiredAt?: number;
  /** false=one-shot，触发后自动删除；true=循环触发 */
  recurring: boolean;
  /**
   * true=永不过期，进程退出后也保留（仅 durable=true 时有意义）
   * false=进程退出即清理（即使 durable=true 也在启动时检查 permanent 字段）
   */
  permanent: boolean;
  /**
   * true=持久化到磁盘（scheduled_tasks.json），可跨重启
   * false=仅内存存储，session 结束即消失
   */
  durable: boolean;
  /** 路由到指定 agent；undefined=当前 agent */
  agentId?: string;
}

// ── 内存态 cron 任务表 ────────────────────────────────────────────────────────

const _memoryTasks = new Map<string, CronTask>();

// ── 工具函数 ──────────────────────────────────────────────────────────────────

function generateTaskId(): string {
  return randomBytes(6).toString('hex'); // 12-char hex
}

function getTasksFilePath(cwd = process.cwd()): string {
  return resolve(cwd, TASKS_FILE);
}

// ── 持久化 I/O ────────────────────────────────────────────────────────────────

/**
 * 从磁盘加载持久化任务（durable=true 的任务）。
 */
export function loadDurableTasks(cwd = process.cwd()): CronTask[] {
  const filePath = getTasksFilePath(cwd);
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidCronTask);
  } catch {
    return [];
  }
}

/**
 * 将所有 durable=true 的任务写入磁盘。
 */
export function saveDurableTasks(cwd = process.cwd()): void {
  const filePath = getTasksFilePath(cwd);
  const dir = join(filePath, '..');
  mkdirSync(dir, { recursive: true });
  const durableTasks = [..._memoryTasks.values()].filter((t) => t.durable);
  writeFileSync(filePath, JSON.stringify(durableTasks, null, 2) + '\n', 'utf-8');
}

function isValidCronTask(obj: unknown): obj is CronTask {
  if (typeof obj !== 'object' || obj === null) return false;
  const t = obj as Record<string, unknown>;
  return (
    typeof t['id'] === 'string' &&
    typeof t['cron'] === 'string' &&
    typeof t['prompt'] === 'string' &&
    typeof t['createdAt'] === 'number' &&
    typeof t['recurring'] === 'boolean' &&
    typeof t['permanent'] === 'boolean' &&
    typeof t['durable'] === 'boolean'
  );
}

// ── 任务 CRUD ─────────────────────────────────────────────────────────────────

/**
 * E23: 添加 cron 任务（内存 + 可选磁盘持久化）。
 * 返回新任务 ID；如果超过 MAX_CRON_JOBS 则抛出错误。
 */
export function addCronTask(
  params: Omit<CronTask, 'id' | 'createdAt'>,
  cwd = process.cwd(),
): CronTask {
  if (_memoryTasks.size >= MAX_CRON_JOBS) {
    throw new Error(
      `Cannot create more than ${MAX_CRON_JOBS} scheduled tasks. ` +
      `Delete some tasks first with cron_delete.`,
    );
  }
  const task: CronTask = {
    ...params,
    id: generateTaskId(),
    createdAt: Date.now(),
  };
  _memoryTasks.set(task.id, task);
  if (task.durable) saveDurableTasks(cwd);
  return task;
}

/**
 * E23: 删除 cron 任务（by ID）。
 * 返回 true 表示删除成功，false 表示 ID 不存在。
 */
export function removeCronTask(id: string, cwd = process.cwd()): boolean {
  if (!_memoryTasks.has(id)) return false;
  const task = _memoryTasks.get(id)!;
  _memoryTasks.delete(id);
  if (task.durable) saveDurableTasks(cwd);
  return true;
}

/**
 * E23: 获取所有活跃 cron 任务（内存态）。
 */
export function listCronTasks(): CronTask[] {
  return [..._memoryTasks.values()].sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * E23: 按 ID 获取任务。
 */
export function getCronTask(id: string): CronTask | null {
  return _memoryTasks.get(id) ?? null;
}

/**
 * E23: 更新 lastFiredAt 时间戳。
 */
export function updateLastFiredAt(id: string, firedAt: number, cwd = process.cwd()): void {
  const task = _memoryTasks.get(id);
  if (!task) return;
  const updated = { ...task, lastFiredAt: firedAt };
  _memoryTasks.set(id, updated);
  if (task.durable) saveDurableTasks(cwd);
}

/**
 * E23: 初始化 — 从磁盘加载 durable 任务到内存（启动时调用）。
 * non-permanent 任务在加载后若上次触发时间 < 启动时间则提示 missed。
 */
export function initCronTasks(cwd = process.cwd()): { loaded: number; missedIds: string[] } {
  const durable = loadDurableTasks(cwd);
  const missedIds: string[] = [];
  const now = Date.now();
  for (const task of durable) {
    if (!task.permanent) {
      // non-permanent 任务只在进程存活期间有效；若文件中存在则视为上次进程正常保存
      // 检查是否有 missed（lastFiredAt 存在但下次触发时间在 now 之前很久）
    }
    _memoryTasks.set(task.id, task);
    // 简单 missed 检测：lastFiredAt 存在且距 now 超过 1 天且 recurring=true
    if (task.lastFiredAt && (now - task.lastFiredAt) > 86400_000 && task.recurring) {
      missedIds.push(task.id);
    }
  }
  return { loaded: durable.length, missedIds };
}
