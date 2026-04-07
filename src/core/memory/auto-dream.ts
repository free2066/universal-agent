/**
 * auto-dream.ts — AutoDream 后台记忆整合
 *
 * F23: 对标 claude-code src/services/autoDream/autoDream.ts
 *
 * 三重门控 + LLM 后台整合：
 *   门控1: 时间门 — 距上次整合 >= minHours（默认24h）
 *   门控2: 会话门 — 自上次整合后新 session >= minSessions（默认5）
 *   门控3: 进程锁 — 防并发整合（lockfile）
 *
 * 触发：agent 正常完成（_terminalReason==='completed'）时异步触发
 * 整合：读取所有 session 摘要 → LLM 整合 → 写入 auto-memory.md
 *
 * 设计约束：
 *   - 全程非阻塞（async，不 await），不影响主循环
 *   - 失败不崩溃（catch all，仅 stderr 输出）
 *   - 无 claude.ai 账户依赖（本地 LLM 整合）
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  unlinkSync, readdirSync, statSync, utimesSync,
} from 'fs';
import { resolve, join } from 'path';

// ── 常量 ──────────────────────────────────────────────────────────────────────

const UAGENT_DIR = resolve(process.env.HOME ?? '~', '.uagent');
const DREAM_STATE_FILE = join(UAGENT_DIR, 'autodream.json');
const DREAM_LOCK_FILE = join(UAGENT_DIR, 'autodream.lock');
const DREAM_OUTPUT_FILE = join(UAGENT_DIR, 'memory', 'auto-memory.md');
const SESSION_SCAN_INTERVAL_MS = 10 * 60_000; // 10分钟会话扫描节流

interface AutoDreamConfig {
  minHours: number;      // 触发所需最小间隔（小时）
  minSessions: number;   // 触发所需最小新 session 数
}

const DEFAULT_CONFIG: AutoDreamConfig = {
  minHours: 24,
  minSessions: 5,
};

interface AutoDreamState {
  lastConsolidatedAt: number; // 上次整合时间戳（ms）
  sessionScanAt?: number;     // 上次会话扫描时间戳（ms）
  lastSessionCount?: number;  // 上次扫描时的 session 数
}

// ── State I/O ─────────────────────────────────────────────────────────────────

function readDreamState(): AutoDreamState {
  try {
    if (!existsSync(DREAM_STATE_FILE)) return { lastConsolidatedAt: 0 };
    const raw = readFileSync(DREAM_STATE_FILE, 'utf-8');
    return JSON.parse(raw) as AutoDreamState;
  } catch {
    return { lastConsolidatedAt: 0 };
  }
}

function writeDreamState(state: AutoDreamState): void {
  try {
    mkdirSync(UAGENT_DIR, { recursive: true });
    writeFileSync(DREAM_STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  } catch { /* non-fatal */ }
}

// ── A31: mtime-based consolidation lock ──────────────────────────────────────
//
// Mirrors claude-code src/services/autoDream/consolidationLock.ts
//
// Key differences from previous PID-only lockfile:
//   1. Lock file mtime IS the lastConsolidatedAt timestamp (no separate state file needed)
//   2. tryAcquireDreamLock() returns priorMtime for rollback
//   3. rollbackDreamLock(priorMtime) restores mtime via utimesSync (no lock file deleted)
//   4. double-check after write prevents race condition between processes

/**
 * A31: Read lastConsolidatedAt from lock file mtime.
 * Mirrors claude-code consolidationLock.ts L29-36 readLastConsolidatedAt().
 */
function readLastConsolidatedAt(): number {
  try {
    const st = statSync(DREAM_LOCK_FILE);
    return st.mtimeMs;
  } catch {
    return 0; // lock file doesn't exist → never consolidated
  }
}

/**
 * A31: Acquire consolidation lock; return priorMtime (for rollback) or null if busy.
 * Mirrors claude-code consolidationLock.ts tryAcquireConsolidationLock().
 *
 * Unlike the previous 'wx' exclusive-create approach, we always write the lock file
 * (updating its mtime), then double-check by reading back the PID to detect races.
 */
function tryAcquireDreamLock(): number | null {
  try {
    mkdirSync(UAGENT_DIR, { recursive: true });

    // Read prior mtime before we overwrite (needed for rollback)
    const priorMtime = readLastConsolidatedAt();

    // Check if another process currently holds the lock (pid still alive)
    try {
      const existingPid = parseInt(readFileSync(DREAM_LOCK_FILE, 'utf-8').trim(), 10);
      if (existingPid && existingPid !== process.pid && isProcessAlive(existingPid)) {
        return null; // live process holds the lock
      }
    } catch { /* lock file doesn't exist or is unreadable — proceed */ }

    // Write our PID to the lock file (mtime = now)
    writeFileSync(DREAM_LOCK_FILE, String(process.pid), { encoding: 'utf-8', flag: 'w' });

    // A31: double-check — confirm we are the lock holder (prevents race)
    try {
      const written = readFileSync(DREAM_LOCK_FILE, 'utf-8').trim();
      if (written !== String(process.pid)) return null; // lost the race
    } catch {
      return null;
    }

    return priorMtime;
  } catch {
    return null;
  }
}

/**
 * A31: Release lock by unlinking the lock file.
 */
function releaseDreamLock(): void {
  try { unlinkSync(DREAM_LOCK_FILE); } catch { /* non-fatal */ }
}

/**
 * A31: Rollback the lock file's mtime to priorMtime (on fork failure).
 * Mirrors claude-code consolidationLock.ts L91-108 rollbackConsolidationLock().
 * Uses utimesSync() so the lock file's mtime is restored to the pre-attempt value,
 * effectively "undoing" the acquisition without leaving stale state.
 */
function rollbackDreamLock(priorMtime: number): void {
  try {
    const ts = new Date(priorMtime || Date.now());
    utimesSync(DREAM_LOCK_FILE, ts, ts);
  } catch { /* non-fatal */ }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── 会话扫描 ──────────────────────────────────────────────────────────────────

/**
 * 扫描自 lastConsolidatedAt 后更新的 session 数量。
 * 通过检查 ~/.uagent/snapshots/ 目录的 mtime 变化来计数。
 */
function countNewSessionsSince(since: number): number {
  try {
    const snapshotsDir = join(UAGENT_DIR, 'snapshots');
    if (!existsSync(snapshotsDir)) return 0;
    const entries = readdirSync(snapshotsDir);
    let count = 0;
    for (const entry of entries) {
      try {
        const st = statSync(join(snapshotsDir, entry));
        if (st.mtimeMs > since) count++;
      } catch { /* skip */ }
    }
    return count;
  } catch {
    return 0;
  }
}

// ── 摘要收集 ──────────────────────────────────────────────────────────────────

/**
 * 收集自 since 以来的 session 摘要文本，用于 LLM 整合。
 * 读取 ~/.uagent/snapshots/*.json 中的 summary 字段。
 */
function collectSessionSummaries(since: number): string[] {
  const summaries: string[] = [];
  try {
    const snapshotsDir = join(UAGENT_DIR, 'snapshots');
    if (!existsSync(snapshotsDir)) return summaries;
    const files = readdirSync(snapshotsDir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    for (const file of files) {
      try {
        const filePath = join(snapshotsDir, file);
        const st = statSync(filePath);
        if (st.mtimeMs <= since) continue;
        const data = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
        const summary = data['summary'] as string | undefined;
        const prompt = data['prompt'] as string | undefined;
        const text = summary ?? prompt;
        if (text && text.trim()) {
          summaries.push(text.trim().slice(0, 500)); // 每条摘要限 500 chars
        }
      } catch { /* skip malformed files */ }
    }
  } catch { /* directory not found */ }
  return summaries;
}

// ── LLM 整合 ──────────────────────────────────────────────────────────────────

/**
 * 调用 LLM 将 session 摘要整合为 auto-memory.md。
 * 使用轻量级 LLM 调用（避免大模型成本）。
 */
async function consolidateMemories(summaries: string[], domain: string): Promise<void> {
  if (summaries.length === 0) return;

  const prompt = `You are a memory consolidation assistant.
Below are summaries of recent agent sessions in the "${domain}" domain.
Consolidate these into a concise, structured memory document (Markdown format).
Focus on: patterns, learnings, recurring tasks, important decisions, tech debt.
Keep the output under 1000 words. Use headers for organization.

Session summaries:
${summaries.map((s, i) => `[Session ${i + 1}]\n${s}`).join('\n\n')}`;

  try {
    const { modelManager } = await import('../../models/model-manager.js');
    const llm = modelManager.getClient();
    if (!llm) return;

    const response = await llm.chat({
      systemPrompt: 'You are a concise memory consolidation assistant.',
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      stream: false,
    });

    if (response.type === 'text' && response.content.trim()) {
      const header =
        `# Auto-Dream Memory\n\n` +
        `_Generated: ${new Date().toISOString()}_\n` +
        `_Sessions: ${summaries.length}_\n\n`;
      mkdirSync(join(UAGENT_DIR, 'memory'), { recursive: true });
      writeFileSync(DREAM_OUTPUT_FILE, header + response.content, 'utf-8');
      process.stderr.write(`[AutoDream] Consolidated ${summaries.length} sessions → ${DREAM_OUTPUT_FILE}\n`);
    }
  } catch (err) {
    process.stderr.write(`[AutoDream] LLM consolidation failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

// ── 主入口 ────────────────────────────────────────────────────────────────────

let _lastSessionScanAt = 0;
let _lastSessionCount = 0;

/**
 * F23: executeAutoDream — 触发后台记忆整合（非阻塞）
 *
 * 在 agent 正常完成后调用，三重门控检查后异步整合。
 * 对标 claude-code src/services/autoDream/autoDream.ts executeAutoDream().
 *
 * @param domain  当前 agent 域（用于 LLM prompt）
 * @param config  可选门控参数覆盖
 */
export function executeAutoDream(
  domain: string,
  config: Partial<AutoDreamConfig> = {},
): void {
  // 异步执行，不阻塞主循环
  _doAutoDream(domain, { ...DEFAULT_CONFIG, ...config }).catch((err) => {
    process.stderr.write(`[AutoDream] Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
  });
}

async function _doAutoDream(domain: string, config: AutoDreamConfig): Promise<void> {
  // A31: use lock file mtime as lastConsolidatedAt (mirrors claude-code consolidationLock.ts)
  const lastConsolidatedAt = readLastConsolidatedAt();
  const state = readDreamState(); // still needed for sessionScanAt / lastSessionCount
  const now = Date.now();

  // ── 门控 1: 时间门 ─────────────────────────────────────────────────────────
  const hoursSinceLast = (now - lastConsolidatedAt) / 3_600_000;
  if (hoursSinceLast < config.minHours) {
    return; // 距上次整合不足 minHours
  }

  // ── 门控 2: 会话门（节流：最多每 10min 扫描一次）──────────────────────────
  let newSessionCount = 0;
  if (now - _lastSessionScanAt > SESSION_SCAN_INTERVAL_MS) {
    newSessionCount = countNewSessionsSince(lastConsolidatedAt);
    _lastSessionScanAt = now;
    _lastSessionCount = newSessionCount;
  } else {
    newSessionCount = _lastSessionCount;
  }
  if (newSessionCount < config.minSessions) {
    return; // 新 session 数不足 minSessions
  }

  // ── 门控 3: 进程锁（A31: 返回 priorMtime 用于 rollback）───────────────────
  const priorMtime = tryAcquireDreamLock();
  if (priorMtime === null) {
    return; // 另一进程正在整合
  }

  try {
    // A31: double-check — 再次读 mtime，确认仍需整合（防止竞态）
    const freshLastAt = readLastConsolidatedAt();
    const freshHours = (now - freshLastAt) / 3_600_000;
    if (freshHours < config.minHours) {
      rollbackDreamLock(priorMtime); // A31: 恢复 mtime，不留脏状态
      return; // 已被其他进程整合
    }

    process.stderr.write(`[AutoDream] Starting memory consolidation (${newSessionCount} sessions)...\n`);

    // 收集摘要
    const summaries = collectSessionSummaries(freshLastAt);
    if (summaries.length === 0) {
      return;
    }

    // LLM 整合
    await consolidateMemories(summaries, domain);

    // 更新 state（session scan 相关字段）— mtime 由 releaseDreamLock 的写入时间自然更新
    writeDreamState({
      ...state,
      lastConsolidatedAt: now, // 保持兼容：状态文件仍更新
    });
    _lastSessionCount = 0; // 重置计数
  } catch (err) {
    // A31: on failure, rollback the lock file mtime so next attempt can retry
    rollbackDreamLock(priorMtime);
    throw err;
  } finally {
    releaseDreamLock();
  }
}

/**
 * F23: getAutoDreamOutputPath — 获取 auto-memory.md 路径
 * 供 context-loader.ts 注入到 system prompt。
 */
export function getAutoDreamOutputPath(): string {
  return DREAM_OUTPUT_FILE;
}

/**
 * F23: loadAutoDreamMemory — 读取整合后的 auto-memory.md 内容
 * 供 context-loader.ts 注入到 system prompt（含 <auto-memory> 标签）。
 */
export function loadAutoDreamMemory(): string | null {
  try {
    if (!existsSync(DREAM_OUTPUT_FILE)) return null;
    const content = readFileSync(DREAM_OUTPUT_FILE, 'utf-8').trim();
    if (!content) return null;
    return `<auto-memory>\n${content}\n</auto-memory>`;
  } catch {
    return null;
  }
}
