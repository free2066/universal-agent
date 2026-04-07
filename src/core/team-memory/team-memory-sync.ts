/**
 * team-memory-sync.ts — I32: TeamMemorySync 只读 MVP
 *
 * Mirrors claude-code src/services/teamMemorySync/index.ts（只读简化版）
 *
 * 功能：从 Anthropic API 拉取团队共享记忆文件，写入本地 ~/.uagent/team-memory/
 *
 * 设计原则：
 *   - 只读（不上传本地更改），防止意外覆盖团队数据
 *   - fail-open：网络/认证失败时静默跳过（不阻止 agent 启动）
 *   - ETag 条件请求（304 Not Modified 跳过文件写入）
 *   - 路径遍历保护（safeWritePath 校验 relPath）
 *   - skip-if-same：文件内容未变时不更新 mtime
 *   - 每次 agent 启动时调用一次，结果注入 system prompt
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve, sep } from 'path';

const UAGENT_DIR = join(process.env['HOME'] ?? '~', '.uagent');
const TEAM_MEM_DIR = join(UAGENT_DIR, 'team-memory');
const STATE_FILE = join(UAGENT_DIR, 'team-memory-state.json');
const TIMEOUT_MS = 30_000;
const MAX_FILE_SIZE = 250_000; // 250KB per file

interface SyncState {
  lastEtag: string | null;
  lastSyncAt: number;
  repoSlug: string | null;
}

function _loadState(): SyncState {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as SyncState; }
  catch { return { lastEtag: null, lastSyncAt: 0, repoSlug: null }; }
}

function _saveState(s: SyncState): void {
  try {
    mkdirSync(UAGENT_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf-8');
  } catch { /* non-fatal */ }
}

async function _getRepoSlug(): Promise<string | null> {
  try {
    const { execSync } = await import('child_process');
    const remote = execSync('git remote get-url origin 2>/dev/null', { encoding: 'utf-8' }).trim();
    const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote)
      ?? /gitlab\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote)
      ?? /gitee\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote);
    return m?.[1] ?? null;
  } catch { return null; }
}

function _safeWritePath(relPath: string): string | null {
  // 路径遍历保护 (Mirrors claude-code validateTeamMemKey)
  const safe = resolve(TEAM_MEM_DIR, relPath);
  const prefix = TEAM_MEM_DIR + sep;
  if (!safe.startsWith(prefix) && safe !== TEAM_MEM_DIR) return null;
  // 只允许 .md 和 .txt 文件
  if (!/\.(md|txt)$/i.test(relPath)) return null;
  return safe;
}

function _getAuthHeaders(): Record<string, string> | null {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (apiKey) return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  const oauthToken = process.env['CLAUDE_AI_OAUTH_TOKEN'];
  if (oauthToken) return { Authorization: `Bearer ${oauthToken}`, 'anthropic-version': '2023-06-01' };
  return null;
}

export interface TeamMemorySyncResult {
  filesWritten: number;
  repoSlug: string | null;
  error?: string;
  skipped?: boolean; // true if 304 Not Modified
}

/**
 * I32: pullTeamMemory — 只读拉取 team memory
 *
 * 从 Anthropic API 拉取当前 git 仓库关联的团队共享记忆文件，
 * 写入 ~/.uagent/team-memory/<relPath>，供 context-loader.ts 注入。
 *
 * Mirrors claude-code teamMemorySync/index.ts pullTeamMemory()（只读部分）
 * 依赖 GET /api/claude_code/team_memory?repo=<owner/repo>
 */
export async function pullTeamMemory(cwd = process.cwd()): Promise<TeamMemorySyncResult> {
  const authHeaders = _getAuthHeaders();
  if (!authHeaders) return { filesWritten: 0, repoSlug: null, error: 'No auth credentials (set ANTHROPIC_API_KEY)' };

  // 获取 git remote slug（用于 API 请求参数）
  const repoSlug = await _getRepoSlug().catch(() => null);
  if (!repoSlug) {
    return { filesWritten: 0, repoSlug: null, error: 'Not a git repo or no remote origin' };
  }

  const state = _loadState();
  const base = process.env['UAGENT_TEAM_MEMORY_URL'] ?? 'https://api.anthropic.com';
  const url = `${base}/api/claude_code/team_memory?repo=${encodeURIComponent(repoSlug)}`;

  const headers: Record<string, string> = { ...authHeaders };
  if (state.lastEtag && state.repoSlug === repoSlug) {
    headers['If-None-Match'] = `"${state.lastEtag}"`;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(url, { headers, signal: controller.signal }).finally(() => clearTimeout(timer));

    if (res.status === 304) {
      return { filesWritten: 0, repoSlug, skipped: true }; // 304 Not Modified
    }
    if (res.status === 404) {
      return { filesWritten: 0, repoSlug }; // no team memory yet for this repo
    }
    if (res.status === 401 || res.status === 403) {
      return { filesWritten: 0, repoSlug, error: `Auth failed (${res.status})` };
    }
    if (!res.ok) {
      return { filesWritten: 0, repoSlug, error: `HTTP ${res.status}` };
    }

    const data = await res.json() as {
      content?: { entries?: Record<string, string> };
      checksum?: string;
    };
    const entries = data.content?.entries ?? {};
    const newEtag = data.checksum ?? res.headers.get('etag')?.replace(/^"|"$/g, '') ?? null;

    mkdirSync(TEAM_MEM_DIR, { recursive: true });
    let written = 0;

    for (const [relPath, content] of Object.entries(entries)) {
      if (typeof content !== 'string') continue;
      if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_SIZE) continue;

      const safePath = _safeWritePath(relPath);
      if (!safePath) continue; // path traversal rejected

      try {
        const parentDir = safePath.substring(0, safePath.lastIndexOf(sep));
        if (parentDir) mkdirSync(parentDir, { recursive: true });

        // skip-if-same — 内容未变时不更新 mtime（避免 context-loader 误判为新文件）
        try {
          const existing = readFileSync(safePath, 'utf-8');
          if (existing === content) continue;
        } catch { /* ENOENT — file doesn't exist, proceed to write */ }

        writeFileSync(safePath, content, 'utf-8');
        written++;
      } catch { /* skip unwritable path */ }
    }

    _saveState({ lastEtag: newEtag, lastSyncAt: Date.now(), repoSlug });
    return { filesWritten: written, repoSlug };
  } catch (e) {
    return {
      filesWritten: 0,
      repoSlug,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * I32: getTeamMemoryDir — 获取 team-memory 目录路径。
 * 供 context-loader.ts 读取团队记忆文件。
 */
export function getTeamMemoryDir(): string {
  return TEAM_MEM_DIR;
}

/**
 * I32: loadTeamMemoryFiles — 读取所有团队记忆文件，格式化为 context 注入字符串。
 * Mirrors claude-code teamMemorySync loadTeamMemoryContent().
 */
export function loadTeamMemoryFiles(): string | null {
  try {
    if (!existsSync(TEAM_MEM_DIR)) return null;
    const files = readdirSync(TEAM_MEM_DIR).filter((f) => f.endsWith('.md') || f.endsWith('.txt'));
    if (files.length === 0) return null;

    const parts: string[] = [];
    for (const file of files) {
      try {
        const content = readFileSync(join(TEAM_MEM_DIR, file), 'utf-8').trim();
        if (content) parts.push(`### ${file}\n${content}`);
      } catch { /* skip unreadable */ }
    }
    if (parts.length === 0) return null;
    return `<team-memory>\n${parts.join('\n\n')}\n</team-memory>`;
  } catch { return null; }
}
