/**
 * lsp-pool.ts — G33: LSP 持久连接池
 *
 * 解决 lsp-tool.ts 每次请求都 spawn 新进程（500-2000ms）的性能问题。
 * 持久池将首次连接后复用同一个 LSP 进程（50-100ms per request）。
 *
 * 设计原则（Mirrors claude-code LSPServerManager.ts + LSPServerInstance.ts）：
 *   - 状态机: stopped → starting → running → error
 *   - Crash recovery: crashCount <= MAX_RESTARTS，超限熔断
 *   - publishDiagnostics notification 订阅（供 diagnosticTracking 使用）
 *   - openedFiles 幂等（同一 URI 只 didOpen 一次）
 *   - workspace/configuration 反向请求处理（返回空 settings）
 *   - shutdownAll() 供进程退出时清理
 *
 * Mirrors:
 *   claude-code src/services/lsp/LSPServerManager.ts
 *   claude-code src/services/lsp/LSPServerInstance.ts
 *   claude-code src/services/lsp/LSPDiagnosticRegistry.ts
 */

import { spawn, type ChildProcess } from 'child_process';
import { resolve, extname } from 'path';
import { pathToFileURL } from 'url';
import { existsSync, readFileSync } from 'fs';

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_RESTARTS = 3;        // crash recovery limit (熔断阈值)
const INIT_TIMEOUT_MS = 10_000; // initialize 超时
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_DIAGNOSTICS_PER_FILE = 10;   // volume limiting
const MAX_DIAGNOSTIC_FILES_TOTAL = 30; // Mirrors claude-code LSPDiagnosticRegistry

/** Map of extension → LSP server config (mirrors lsp-tool.ts) */
const LSP_SERVERS: Record<string, { command: string; args: string[] }> = {
  '.ts':  { command: 'typescript-language-server', args: ['--stdio'] },
  '.tsx': { command: 'typescript-language-server', args: ['--stdio'] },
  '.js':  { command: 'typescript-language-server', args: ['--stdio'] },
  '.jsx': { command: 'typescript-language-server', args: ['--stdio'] },
  '.py':  { command: 'pylsp', args: [] },
  '.go':  { command: 'gopls', args: [] },
  '.rs':  { command: 'rust-analyzer', args: [] },
};

// ── Types ──────────────────────────────────────────────────────────────────

export interface LspDiagnostic {
  message: string;
  severity: 1 | 2 | 3 | 4; // 1=Error,2=Warn,3=Info,4=Hint
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  source?: string;
  code?: string | number;
}

export interface LspDiagnosticFile {
  uri: string;
  diagnostics: LspDiagnostic[];
}

type ServerState = 'stopped' | 'starting' | 'running' | 'error';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PoolEntry {
  ext: string;
  proc: ChildProcess;
  state: ServerState;
  crashCount: number;
  openedFiles: Set<string>;         // URIs already sent didOpen
  diagnosticBuffer: LspDiagnosticFile[]; // publishDiagnostics buffer (LSPDiagnosticRegistry)
  pendingRequests: Map<number, PendingRequest>;
  buffer: string;                   // stdout parse buffer
  reqId: number;
}

// ── Module-level pool ──────────────────────────────────────────────────────

const pool = new Map<string, PoolEntry>();

// ── JSON-RPC framing helpers ───────────────────────────────────────────────

function _frame(msg: Record<string, unknown>): string {
  const body = JSON.stringify(msg);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

function _parseMessages(entry: PoolEntry, chunk: string): Array<Record<string, unknown>> {
  entry.buffer += chunk;
  const out: Array<Record<string, unknown>> = [];
  while (true) {
    const hEnd = entry.buffer.indexOf('\r\n\r\n');
    if (hEnd < 0) break;
    const header = entry.buffer.slice(0, hEnd);
    const lenMatch = /content-length:\s*(\d+)/i.exec(header);
    if (!lenMatch) { entry.buffer = entry.buffer.slice(hEnd + 4); continue; }
    const len = parseInt(lenMatch[1]!, 10);
    if (entry.buffer.length < hEnd + 4 + len) break; // wait for more data
    const body = entry.buffer.slice(hEnd + 4, hEnd + 4 + len);
    entry.buffer = entry.buffer.slice(hEnd + 4 + len);
    try { out.push(JSON.parse(body) as Record<string, unknown>); } catch { /* malformed */ }
  }
  return out;
}

// ── Server lifecycle ───────────────────────────────────────────────────────

async function _startServer(ext: string, rootPath: string): Promise<PoolEntry | null> {
  const cfg = LSP_SERVERS[ext];
  if (!cfg) return null;

  const prevCrashCount = pool.get(ext)?.crashCount ?? 0;
  if (prevCrashCount >= MAX_RESTARTS) {
    // 熔断：crash 次数超限，不再重启（Mirrors claude-code LSPServerInstance crashRecoveryCount)
    return null;
  }

  const proc = spawn(cfg.command, cfg.args, {
    cwd: rootPath,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const entry: PoolEntry = {
    ext,
    proc,
    state: 'starting',
    crashCount: prevCrashCount,
    openedFiles: new Set(),
    diagnosticBuffer: [],
    pendingRequests: new Map(),
    buffer: '',
    reqId: 1,
  };
  pool.set(ext, entry);

  // Crash handler — increment counter, mark error state
  proc.on('close', () => {
    entry.state = 'error';
    entry.crashCount++;
    // Reject all pending requests
    for (const [, req] of entry.pendingRequests) {
      clearTimeout(req.timer);
      req.reject(new Error('LSP server crashed'));
    }
    entry.pendingRequests.clear();
  });

  // stdout data handler — parse LSP messages
  proc.stdout?.on('data', (chunk: Buffer) => {
    const msgs = _parseMessages(entry, chunk.toString());
    for (const msg of msgs) {
      // Responses to our requests
      if (typeof msg.id === 'number' && msg.id > 0) {
        const pending = entry.pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          entry.pendingRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(JSON.stringify(msg.error)));
          } else {
            pending.resolve(msg.result);
          }
        }
      }
      // Notifications (no id, or id=null)
      if (msg.method === 'textDocument/publishDiagnostics' && msg.params) {
        const params = msg.params as { uri: string; diagnostics: LspDiagnostic[] };
        _handleDiagnostics(entry, params.uri, params.diagnostics);
      }
      // workspace/configuration reverse request — reply with empty settings
      if (msg.method === 'workspace/configuration' && typeof msg.id === 'number') {
        const items = ((msg.params as { items?: unknown[] })?.items ?? []);
        const response = { jsonrpc: '2.0', id: msg.id, result: items.map(() => ({})) };
        proc.stdin?.write(_frame(response));
      }
    }
  });

  // Send initialize
  try {
    const rootUri = pathToFileURL(rootPath).href;
    await _sendRequest(entry, 'initialize', {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          publishDiagnostics: { relatedInformation: false },
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          hover: { dynamicRegistration: false, contentFormat: ['plaintext'] },
          documentSymbol: { dynamicRegistration: false },
        },
        workspace: { configuration: true, workspaceFolders: false },
      },
      workspaceFolders: [{ uri: rootUri, name: 'root' }],
      initializationOptions: {},
    }, INIT_TIMEOUT_MS);

    // Send initialized notification
    proc.stdin?.write(_frame({ jsonrpc: '2.0', method: 'initialized', params: {} }));
    entry.state = 'running';
    return entry;
  } catch (err) {
    entry.state = 'error';
    proc.kill();
    pool.delete(ext);
    return null;
  }
}

function _sendRequest(
  entry: PoolEntry,
  method: string,
  params: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  return new Promise((res, rej) => {
    const id = entry.reqId++;
    const timer = setTimeout(() => {
      entry.pendingRequests.delete(id);
      rej(new Error(`LSP request "${method}" timed out (${timeoutMs}ms)`));
    }, timeoutMs);
    entry.pendingRequests.set(id, { resolve: res, reject: rej, timer });
    entry.proc.stdin?.write(_frame({ jsonrpc: '2.0', id, method, params }));
  });
}

function _handleDiagnostics(entry: PoolEntry, uri: string, diagnostics: LspDiagnostic[]): void {
  // Volume limiting (Mirrors claude-code LSPDiagnosticRegistry)
  const limited = diagnostics.slice(0, MAX_DIAGNOSTICS_PER_FILE);
  const idx = entry.diagnosticBuffer.findIndex((f) => f.uri === uri);
  if (idx >= 0) {
    entry.diagnosticBuffer[idx]!.diagnostics = limited;
  } else {
    if (entry.diagnosticBuffer.length >= MAX_DIAGNOSTIC_FILES_TOTAL) {
      entry.diagnosticBuffer.shift(); // LRU evict oldest
    }
    entry.diagnosticBuffer.push({ uri, diagnostics: limited });
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * G33: ensureServer — 获取或启动指定扩展名的 LSP 服务器实例。
 * fail-open: 如果服务器不可用（熔断或安装缺失），返回 null。
 */
export async function ensureServer(ext: string, rootPath: string): Promise<PoolEntry | null> {
  let entry = pool.get(ext);
  if (entry?.state === 'running') return entry;
  if (entry?.state === 'starting') {
    // Wait briefly for in-progress initialization
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const current = pool.get(ext);
      if (current?.state === 'running') return current;
      if (!current || current.state === 'error') break;
    }
    return null;
  }
  return _startServer(ext, rootPath);
}

/**
 * G33: openFile — 发送 textDocument/didOpen，保证每个 URI 只发一次。
 * Mirrors claude-code LSPServerManager.openFile()
 */
export async function openFile(
  ext: string,
  filePath: string,
  content: string,
  rootPath: string,
): Promise<boolean> {
  const entry = await ensureServer(ext, rootPath);
  if (!entry || entry.state !== 'running') return false;

  const uri = pathToFileURL(resolve(filePath)).href;
  if (entry.openedFiles.has(uri)) return true; // already opened

  try {
    entry.proc.stdin?.write(_frame({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri,
          languageId: _langId(ext),
          version: 1,
          text: content,
        },
      },
    }));
    entry.openedFiles.add(uri);
    return true;
  } catch { return false; }
}

/**
 * G33: changeFile — 发送 textDocument/didChange（触发重新分析）。
 * Mirrors claude-code LSPServerManager.changeFile()
 */
export function changeFile(ext: string, filePath: string, content: string): void {
  const entry = pool.get(ext);
  if (!entry || entry.state !== 'running') return;
  const uri = pathToFileURL(resolve(filePath)).href;
  if (!entry.openedFiles.has(uri)) return; // must open first
  try {
    const version = Date.now() % 100_000; // monotonic-ish
    entry.proc.stdin?.write(_frame({
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      },
    }));
  } catch { /* non-fatal */ }
}

/**
 * G33: sendLspRequest — 发送 LSP 请求到持久服务器，返回结果。
 * Drop-in 替换 lsp-tool.ts 的 makeLspRequest()。
 * Mirrors claude-code LSPServerInstance.sendRequest()
 */
export async function sendLspRequest(
  ext: string,
  rootPath: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  const entry = await ensureServer(ext, rootPath);
  if (!entry || entry.state !== 'running') {
    throw new Error(`LSP server for ${ext} is not available`);
  }
  return _sendRequest(entry, method, params);
}

/**
 * G33: drainDiagnostics — 读取并清空 publishDiagnostics 缓冲区。
 * 供 diagnosticTracking 服务使用（编辑前/后比较）。
 * Mirrors claude-code LSPDiagnosticRegistry drain pattern.
 */
export function drainDiagnostics(ext: string): LspDiagnosticFile[] {
  const entry = pool.get(ext);
  if (!entry) return [];
  const diags = [...entry.diagnosticBuffer];
  entry.diagnosticBuffer.length = 0;
  return diags;
}

/**
 * G33: peekDiagnosticsForFile — 查看指定文件的当前诊断（不清空缓冲区）。
 */
export function peekDiagnosticsForFile(ext: string, filePath: string): LspDiagnosticFile | null {
  const entry = pool.get(ext);
  if (!entry) return null;
  const uri = pathToFileURL(resolve(filePath)).href;
  return entry.diagnosticBuffer.find((f) => f.uri === uri) ?? null;
}

/**
 * G33: getPoolStatus — 获取连接池状态（调试/诊断用）。
 */
export function getPoolStatus(): Array<{ ext: string; state: ServerState; crashCount: number; openedFiles: number }> {
  return [...pool.entries()].map(([ext, e]) => ({
    ext,
    state: e.state,
    crashCount: e.crashCount,
    openedFiles: e.openedFiles.size,
  }));
}

/**
 * G33: shutdownAll — 关闭所有 LSP 服务器（进程退出时调用）。
 * Mirrors claude-code LSPServerManager.destroy()
 */
export async function shutdownAll(): Promise<void> {
  const tasks = [...pool.entries()].map(async ([ext, entry]) => {
    if (entry.state === 'running') {
      try {
        // Graceful shutdown
        await Promise.race([
          _sendRequest(entry, 'shutdown', null, 2000),
          new Promise((r) => setTimeout(r, 2000)),
        ]);
        entry.proc.stdin?.write(_frame({ jsonrpc: '2.0', method: 'exit', params: undefined }));
      } catch { /* ignore */ }
    }
    entry.proc.kill();
    pool.delete(ext);
  });
  await Promise.allSettled(tasks);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _langId(ext: string): string {
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescriptreact',
    '.js': 'javascript', '.jsx': 'javascriptreact',
    '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java',
  };
  return map[ext] ?? ext.slice(1);
}

/**
 * G33: isPoolEnabled — 是否启用 LSP 持久池（通过环境变量控制）。
 * 如果 ENABLE_LSP_POOL=true 且 ENABLE_LSP_TOOL=true，则使用持久池。
 */
export function isPoolEnabled(): boolean {
  return (
    process.env['ENABLE_LSP_TOOL'] === 'true' &&
    process.env['ENABLE_LSP_POOL'] !== 'false'
  );
}

// ── Process exit cleanup ────────────────────────────────────────────────────

// Graceful shutdown on exit (unref so it doesn't prevent exit)
process.on('beforeExit', () => {
  if (pool.size > 0) {
    shutdownAll().catch(() => { /* non-fatal */ });
  }
});
