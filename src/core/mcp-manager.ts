import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join, resolve } from 'path';
import { spawn } from 'child_process';
import type { ToolDefinition, ToolRegistration } from '../models/types.js';
import { registerElicitationHandler } from './mcp-elicitation.js';

/**
 * AbortSignal.timeout() polyfill for Node.js < 17.3.
 */
function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(new DOMException('TimeoutError', 'TimeoutError')), ms);
  return ctrl.signal;
}

// ── F14: MCPScope — 配置来源层级（claude-code ConfigScopeSchema 对标）──────────
//
// 优先级：local > project > user > global
// local:   仅本机，来自 .mcp.local.json（gitignore 管理，不进 VCS）
// project: 团队共享，来自 .mcp.json（进 VCS）
// user:    用户全局，来自 ~/.uagent/mcp.json
// global:  平台/企业下发（通常通过环境变量或系统配置）

export type MCPScope = 'local' | 'project' | 'user' | 'global';

export interface MCPServer {
  name: string;
  type: 'stdio' | 'sse' | 'http' | 'ws';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled: boolean;
  description?: string;  // human-readable note stored in config
  /**
   * F14: scope — 配置来源层级（local/project/user/global）
   * 由 loadMCPConfig() 自动填充，手动配置文件无需指定。
   */
  scope?: MCPScope;
  /** OAuth config for servers that require authentication (Batch 3) */
  oauth?: {
    authorizationUrl: string;
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    scopes?: string[];
  };
  /**
   * D16: headersHelper — shell 命令字符串，运行时动态获取 HTTP headers
   * 类似 git credential-helper 风格，输出 `KEY: value` 格式的 header
   * 只适用于 SSE/HTTP 类型的 MCP Server（stdio 类型运行时不需要 HTTP header）
   */
  headersHelper?: string;
  /** D16: 静态 headers（会被 headersHelper 的动态 headers 覆盖） */
  headers?: Record<string, string>;
}

export interface MCPConfig {
  servers: Record<string, MCPServer>;
}

// ── E14: MCP Session 过期检测（claude-code McpSessionExpiredError -32001 对标）──

/** MCP JSON-RPC error code for session expiry */
const MCP_SESSION_EXPIRED_CODE = -32001;

/**
 * E14: 判断是否是 MCP session 过期错误（-32001 或 message pattern）
 */
function isMcpSessionExpiredError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  if (e.code === MCP_SESSION_EXPIRED_CODE) return true;
  const msg = String(e.message ?? '');
  return /session.{0,20}(expired|invalid|not\s+found)|-32001/i.test(msg);
}

/**
 * F14: loadMCPConfig — 按 scope 分层读取并合并 MCP 配置
 *
 * 读取顺序（低优先 → 高优先）：global → user → project → local
 * 后读取的 scope 覆盖前面的同名服务器配置。
 */
export function loadMCPConfig(cwd = process.cwd()): Record<string, MCPServer> {
  const configs: Array<{ data: Record<string, Omit<MCPServer, 'name'>>; scope: MCPScope }> = [];

  const readJson = (p: string): Record<string, Omit<MCPServer, 'name'>> => {
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as { servers?: Record<string, Omit<MCPServer, 'name'>> };
      return raw.servers ?? {};
    } catch { return {}; }
  };

  // User-global (~/.uagent/mcp.json)
  const userPath = resolve(process.env.HOME ?? '~', '.uagent', 'mcp.json');
  if (existsSync(userPath)) configs.push({ data: readJson(userPath), scope: 'user' });

  // Project-level (.mcp.json — goes into VCS)
  const projectPath = join(cwd, '.mcp.json');
  if (existsSync(projectPath)) configs.push({ data: readJson(projectPath), scope: 'project' });

  // Local-level (.mcp.local.json — gitignored)
  const localPath = join(cwd, '.mcp.local.json');
  if (existsSync(localPath)) configs.push({ data: readJson(localPath), scope: 'local' });

  // Merge (lower scope first, higher scope overwrites)
  const merged: Record<string, MCPServer> = {};
  for (const { data, scope } of configs) {
    for (const [name, cfg] of Object.entries(data)) {
      merged[name] = { ...(merged[name] ?? {}), ...cfg, name, enabled: (cfg.enabled ?? true), scope };
    }
  }
  return merged;
}

// ── JSON-RPC 2.0 types for MCP stdio protocol ─────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface MCPToolDef {
  name: string;
  description?: string;
  inputSchema?: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

// ── A15: MCP 重连状态机常量（claude-code useManageMCPConnections 对标）───────────
const MAX_RECONNECT_ATTEMPTS = 5;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Communicate with a stdio MCP server using JSON-RPC 2.0.
 * Spawns the process, sends initialize + tools/list, returns tool definitions.
 * Then keeps the process running for tool calls.
 */
class StdioMCPClient {
  private proc: ReturnType<typeof spawn> | null = null;
  private reqId = 1;
  private pending = new Map<number, {
    resolve: (v: JsonRpcResponse) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private buffer = '';
  readonly server: MCPServer;

  // A15: 重连状态追踪
  private _reconnectAttempt = 0;
  private _reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private _reconnectCancelled = false;

  // G15: 热更新通知回调
  private _toolsChangedCallback?: () => void;
  private _promptsChangedCallback?: () => void;

  constructor(server: MCPServer) {
    this.server = server;
  }

  async start(): Promise<MCPToolDef[]> {
    const { command, args = [], env = {} } = this.server;
    if (!command) throw new Error(`stdio server "${this.server.name}" missing command`);

    // Merge environment: inherit current process env + server-specific overrides
    const childEnv: Record<string, string> = { ...process.env as Record<string, string>, ...env };

    this.proc = spawn(command, args, {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout?.setEncoding('utf-8');
    this.proc.stdout?.on('data', (chunk: string) => this.onData(chunk));

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      // Forward stderr to our stderr for debugging (suppressed unless AGENT_VERBOSE)
      if (process.env.AGENT_VERBOSE === '1') {
        process.stderr.write(`[MCP:${this.server.name}] ${chunk}`);
      }
    });

    this.proc.on('error', (err) => {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });

    this.proc.on('exit', (code) => {
      const err = new Error(`MCP server "${this.server.name}" exited with code ${code}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.proc = null;
    });

    // Step 1: initialize handshake
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
        resources: {},  // D15: 说明 resources 能力
        roots: {},       // C16: 说明 roots 能力（MCP Server 可查询工作区根目录）
        elicitation: {}, // C14: Elicitation 协议
      },
      clientInfo: { name: 'universal-agent', version: '1.0.0' },
    });

    // Step 2: send initialized notification (no response expected)
    this.notify('notifications/initialized');

    // Step 3: list available tools
    const listRes = await this.request('tools/list', {});
    const tools = (listRes.result as { tools?: MCPToolDef[] })?.tools ?? [];
    return tools;
  }

  async callTool(toolName: string, toolArgs: Record<string, unknown>): Promise<string> {
    try {
      return await this._callToolInternal(toolName, toolArgs);
    } catch (err) {
      // E14: Session 过期重连 — 检测 -32001 错误，自动调用指数退避重连后重试一次
      if (isMcpSessionExpiredError(err)) {
        process.stderr.write(`[MCP:${this.server.name}] Session expired, reconnecting…\n`);
        await this.reconnectWithBackoff();
        return await this._callToolInternal(toolName, toolArgs);
      }
      throw err;
    }
  }

  private async _callToolInternal(toolName: string, toolArgs: Record<string, unknown>): Promise<string> {
    if (!this.proc) throw new Error(`MCP server "${this.server.name}" is not running`);
    const res = await this.request('tools/call', { name: toolName, arguments: toolArgs });
    if (res.error) throw new Error(`MCP tool error: ${res.error.message}`);
    const content = (res.result as { content?: Array<{ type: string; text?: string }> })?.content ?? [];
    return content.map((c) => c.text ?? JSON.stringify(c)).join('\n');
  }

  /**
   * A15: 指数退避重连（claude-code useManageMCPConnections MAX_RECONNECT_ATTEMPTS 对标）
   * - stdio 进程意外退出不重连（直接标记失败）
   * - SSE/HTTP 类型才进行指数退避重连
   * - 最多 5 次，退避 1s→2s→4s→8s→16s（上限 30s）
   */
  async reconnectWithBackoff(): Promise<void> {
    // stdio 进程退出不应自动重连（进程意外终止通常是配置问题）
    if (this.server.type === 'stdio') {
      process.stderr.write(`[MCP:${this.server.name}] stdio process exited — not auto-reconnecting\n`);
      return;
    }
    if (this._reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      process.stderr.write(
        `[MCP:${this.server.name}] max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached — giving up\n`,
      );
      return;
    }
    this._reconnectCancelled = false;
    this._reconnectAttempt++;
    const backoffMs = Math.min(
      INITIAL_BACKOFF_MS * Math.pow(2, this._reconnectAttempt - 1),
      MAX_BACKOFF_MS,
    );
    process.stderr.write(
      `[MCP:${this.server.name}] reconnect attempt ${this._reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS} in ${backoffMs}ms…\n`,
    );
    await new Promise<void>((res) => {
      this._reconnectTimer = setTimeout(res, backoffMs);
    });
    if (this._reconnectCancelled) return;
    this.stop();
    try {
      await this.start();
      this._reconnectAttempt = 0; // 成功后重置计数
    } catch (err) {
      process.stderr.write(`[MCP:${this.server.name}] reconnect failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  /** A15: 取消正在进行的重连等待 */
  cancelReconnect(): void {
    this._reconnectCancelled = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
  }

  /** G15: 注册工具列表变更回调（ToolListChanged 热更新） */
  onToolsChanged(cb: () => void): void { this._toolsChangedCallback = cb; }
  /** G15: 注册提示列表变更回调（PromptListChanged 热更新） */
  onPromptsChanged(cb: () => void): void { this._promptsChangedCallback = cb; }

  // D15: MCP 资源访问（resources/list + resources/read）
  async listResources(): Promise<Array<{ uri: string; name?: string; mimeType?: string }>> {
    if (!this.proc) return [];
    try {
      const res = await this.request('resources/list', {});
      if (res.error) return [];
      return (res.result as { resources?: Array<{ uri: string; name?: string; mimeType?: string }> })?.resources ?? [];
    } catch { return []; }
  }

  async readResource(uri: string): Promise<string | null> {
    if (!this.proc) return null;
    try {
      const res = await this.request('resources/read', { uri });
      if (res.error) return null;
      const contents = (res.result as { contents?: Array<{ text?: string; blob?: string; mimeType?: string }> })?.contents ?? [];
      return contents.map((c) => c.text ?? (c.blob ? `[binary:${c.mimeType ?? 'data'}]` : '')).join('\n') || null;
    } catch { return null; }
  }

  /** E14/A15: 旧接口保留（仅用于 session 过期场景的兼容调用） */
  async reconnect(): Promise<void> {
    this.stop();
    await new Promise((res) => setTimeout(res, 500));
    await this.start();
  }

  stop() {
    try { this.proc?.kill(); } catch { /* ignore */ }
    this.proc = null;
  }

  private request(method: string, params: unknown): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      if (!this.proc) { reject(new Error('Process not started')); return; }
      const id = this.reqId++;
      const timeoutMs = parseInt(process.env.MCP_TOOL_TIMEOUT || '30000');

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      const line = JSON.stringify(msg) + '\n';
      this.proc.stdin?.write(line);
    });
  }

  private notify(method: string) {
    if (!this.proc) return;
    const msg = { jsonrpc: '2.0', method };
    this.proc.stdin?.write(JSON.stringify(msg) + '\n');
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse & { method?: string; params?: unknown };
        if (typeof msg.id === 'number' && msg.method) {
          // C16: Inbound request (has both id + method) — MCP Server 请求我们响应
          this._handleInboundRequest(msg.id, msg.method, msg.params);
        } else if (typeof msg.id === 'number') {
          // Response to our pending request
          const pending = this.pending.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(msg.id);
            pending.resolve(msg);
          }
        } else if (msg.method) {
          // G15: 处理 MCP 服务器推送的通知消息（无 id）
          this._handleNotification(msg.method);
        }
      } catch { /* ignore non-JSON lines (e.g. server startup messages) */ }
    }
  }

  /**
   * C16: 处理 MCP Server 发来的 inbound requests（Server → Client 方向）
   * 目前实现 roots/list — Server 询问客户端的工作区根目录。
   */
  private _handleInboundRequest(id: number, method: string, _params: unknown): void {
    if (method === 'roots/list') {
      // 返回当前工作区根目录（对标 claude-code client.ts:985-1018）
      const response = {
        jsonrpc: '2.0' as const,
        id,
        result: {
          roots: [{ uri: `file://${process.cwd()}`, name: 'workspace' }],
        },
      };
      this.proc?.stdin?.write(JSON.stringify(response) + '\n');
    } else if (method === 'sampling/createMessage') {
      // 暂不支持 sampling 协议 — 返回 method not found 错误
      const errorResponse = {
        jsonrpc: '2.0' as const,
        id,
        error: { code: -32601, message: 'Method not found: sampling/createMessage is not supported' },
      };
      this.proc?.stdin?.write(JSON.stringify(errorResponse) + '\n');
    } else {
      // 未知 inbound request — 返回通用错误
      const errorResponse = {
        jsonrpc: '2.0' as const,
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
      this.proc?.stdin?.write(JSON.stringify(errorResponse) + '\n');
    }
  }

  /** G15: 处理 MCP 通知（tools/list_changed, prompts/list_changed） */
  private _handleNotification(method: string): void {
    if (method === 'notifications/tools/list_changed') {
      process.stderr.write(`[MCP:${this.server.name}] tools list changed — refreshing…\n`);
      this._toolsChangedCallback?.();
    } else if (method === 'notifications/prompts/list_changed') {
      process.stderr.write(`[MCP:${this.server.name}] prompts list changed\n`);
      this._promptsChangedCallback?.();
    }
  }
}

// ── MCPManager ────────────────────────────────────────────────────────────────

export class MCPManager {
  private servers: Map<string, MCPServer> = new Map();
  private tools: Map<string, ToolRegistration> = new Map();
  private stdioClients: Map<string, StdioMCPClient> = new Map();
  private configPath: string;

  constructor(projectDir?: string) {
    const dir = projectDir || process.cwd();
    // F14: 使用分层 loadMCPConfig 读取所有 scope 的配置
    const scoped = loadMCPConfig(dir);
    for (const [name, server] of Object.entries(scoped)) {
      this.servers.set(name, server);
    }
    // 主配置写入路径：优先 .mcp.local.json，其次 .mcp.json
    const localPath = join(dir, '.mcp.local.json');
    const projectPath = join(dir, '.mcp.json');
    const globalPath = resolve(process.env.HOME ?? '~', '.uagent', 'mcp.json');
    this.configPath = existsSync(localPath) ? localPath
      : existsSync(join(dir, '.mcprc')) ? join(dir, '.mcprc')
      : existsSync(globalPath) ? globalPath
      : projectPath; // default write target
  }

  private loadConfig() {
    // F14: loadConfig 已由构造函数中的 loadMCPConfig() 替代，此方法保留兼容性
    if (!existsSync(this.configPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.configPath, 'utf-8'));
      if (typeof raw !== 'object' || raw === null || typeof raw.servers !== 'object' || Array.isArray(raw.servers)) return;
      const typed = raw as MCPConfig;
      for (const [name, server] of Object.entries(typed.servers || {})) {
        if (!this.servers.has(name)) {
          this.servers.set(name, { ...server, name, enabled: server.enabled ?? true });
        }
      }
    } catch { /* ignore */ }
  }

  async connectAll(): Promise<{ connected: string[]; failed: string[] }> {
    const connected: string[] = [];
    const failed: string[] = [];

    // ── UAGENT_MCP_INLINE: one-shot servers from --mcp-config CLI flag ────────
    // Parsed by index.ts and injected via env var to avoid writing to disk.
    const inlineRaw = process.env.UAGENT_MCP_INLINE;
    if (inlineRaw) {
      try {
        const inlineServers = JSON.parse(inlineRaw) as Record<string, Omit<MCPServer, 'name'>>;
        for (const [name, cfg] of Object.entries(inlineServers)) {
          if (!this.servers.has(name)) {
            this.servers.set(name, { ...cfg, name, enabled: true });
          }
        }
      } catch { /* ignore malformed inline config */ }
    }

    // ── UAGENT_BROWSER_MODE: auto-activate playwright if it exists ────────────
    if (process.env.UAGENT_BROWSER_MODE === '1') {
      const pw = this.servers.get('playwright');
      if (pw && !pw.enabled) {
        pw.enabled = true; // enable for this session only (not saved)
      }
    }

    for (const [name, server] of this.servers.entries()) {
      if (!server.enabled) continue;
      try {
        const tools = await this.connectServer(server);
        for (const tool of tools) this.tools.set(tool.definition.name, tool);
        connected.push(name);
      } catch (err) {
        failed.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── Content-hash dedup (Round 5: claude-code dedupPluginMcpServers parity) ──
    // When multiple servers expose tools with identical names AND identical
    // parameter schemas (content signature), suppress duplicates to prevent
    // LLM confusion from seeing the same tool twice with different prefixes.
    this._deduplicateTools();

    return { connected, failed };
  }

  /**
   * Content-hash dedup: remove duplicate tool registrations.
   *
   * Two tools are considered duplicates if they have the same name AND
   * their parameter schemas produce the same JSON string (content signature).
   *
   * The first occurrence (by registration order) wins; subsequent duplicates
   * are logged and removed.
   *
   * Round 5: claude-code dedupPluginMcpServers parity
   */
  private _deduplicateTools(): void {
    const seen = new Map<string, string>(); // tool name → content hash
    const toRemove: string[] = [];

    for (const [toolName, tool] of this.tools.entries()) {
      const contentSig = JSON.stringify({
        description: tool.definition.description,
        parameters: tool.definition.parameters,
      });

      const existing = seen.get(toolName);
      if (existing !== undefined) {
        if (existing === contentSig) {
          // Exact duplicate — remove
          toRemove.push(toolName);
        }
        // Different content but same name — keep both (name collision, not content dup)
      } else {
        seen.set(toolName, contentSig);
      }
    }

    for (const name of toRemove) {
      this.tools.delete(name);
    }
  }

  private async connectServer(server: MCPServer): Promise<ToolRegistration[]> {
    if (server.type === 'sse' || server.type === 'http') return this.connectSSEServer(server);
    if (server.type === 'stdio') return this.connectStdioServer(server);
    return [];
  }

  // ── SSE / HTTP server ────────────────────────────────────────────────────────

  private async connectSSEServer(server: MCPServer): Promise<ToolRegistration[]> {
    if (!server.url) throw new Error(`SSE server "${server.name}" missing URL`);
    const baseUrl = server.url.replace(/\/sse$/, '');
    const timeout = parseInt(process.env.MCP_CONNECTION_TIMEOUT_MS || '5000');

    // Build auth headers — OAuth Bearer token if configured (Batch 3)
    // D16: 合并静态 headers + headersHelper 动态 headers + OAuth token
    const { getMcpServerHeaders } = await import('./mcp-headers-helper.js').catch(() => ({ getMcpServerHeaders: async () => ({}) }));
    const serverHeaders = await getMcpServerHeaders(server.name, {
      headersHelper: server.headersHelper,
      headers: server.headers,
    });
    const authHeaders: Record<string, string> = { Accept: 'application/json', ...serverHeaders };
    if (server.oauth) {
      try {
        const { getMcpAuth } = await import('./mcp-auth.js');
        const auth = getMcpAuth(server.name);
        const token = await auth.getToken(server.oauth);
        authHeaders['Authorization'] = `Bearer ${token.access_token}`;
      } catch (err) {
        process.stderr.write(`[MCP OAuth] ${server.name}: auth failed — ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    const res = await fetch(`${baseUrl}/tools`, {
      signal: timeoutSignal(timeout),
      headers: authHeaders,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${baseUrl}/tools`);
    const data = await res.json() as { tools?: Array<{ name: string; description: string; inputSchema?: unknown }> };
    return (data.tools || []).map((t) => this.wrapSSETool(t, baseUrl, server.name, authHeaders));
  }

  private wrapSSETool(
    mcpTool: { name: string; description: string; inputSchema?: unknown },
    baseUrl: string,
    serverName: string,
    authHeaders: Record<string, string> = {},
  ): ToolRegistration {
    const toolDef: ToolDefinition = {
      name: `mcp_${serverName}_${mcpTool.name}`,
      description: `[MCP:${serverName}] ${mcpTool.description}`,
      parameters: (mcpTool.inputSchema as ToolDefinition['parameters']) || { type: 'object', properties: {} },
    };
    return {
      definition: toolDef,
      handler: async (args: Record<string, unknown>): Promise<string> => {
        const timeout = parseInt(process.env.MCP_TOOL_TIMEOUT || '30000');
        const res = await fetch(`${baseUrl}/tools/${mcpTool.name}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({ arguments: args }),
          signal: timeoutSignal(timeout),
        });
        if (!res.ok) throw new Error(`MCP tool error: HTTP ${res.status}`);
        const data = await res.json() as { content?: Array<{ text?: string }> };
        return data.content?.map((c) => c.text).join('\n') || '';
      },
    };
  }

  // ── WebSocket server (Batch 3) — JSON-RPC 2.0 over WebSocket ─────────────────

  private async connectWSServer(server: MCPServer): Promise<ToolRegistration[]> {
    if (!server.url) throw new Error(`WS server "${server.name}" missing URL`);
    const timeout = parseInt(process.env.MCP_CONNECTION_TIMEOUT_MS || '10000');

    // Build optional auth header for ws upgrade
    let authToken: string | undefined;
    if (server.oauth) {
      try {
        const { getMcpAuth } = await import('./mcp-auth.js');
        const auth = getMcpAuth(server.name);
        const token = await auth.getToken(server.oauth);
        authToken = token.access_token;
      } catch (err) {
        process.stderr.write(`[MCP OAuth] ${server.name}: auth failed — ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    // Use the ws package if available, otherwise fall back to a simple HTTP-based
    // mock so we don't add a hard dependency. In production, users install 'ws'.
    let ws: import('ws').WebSocket;
    try {
      const WS = (await import('ws')).default;
      const headers: Record<string, string> = {};
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      ws = new WS(server.url, { headers });
    } catch {
      throw new Error(
        `WS transport requires the 'ws' package: npm install ws. ` +
        `Server "${server.name}" (${server.url}) could not connect.`,
      );
    }

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`WS connection timeout for "${server.name}"`));
      }, timeout);
      ws.once('open', () => { clearTimeout(timer); resolve(); });
      ws.once('error', (err: Error) => { clearTimeout(timer); reject(err); });
    });

    // JSON-RPC helper
    let _reqId = 1;
    const pending = new Map<number, (r: { result?: unknown; error?: { message: string } }) => void>();
    ws.on('message', (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8')) as {
          id?: number; result?: unknown; error?: { message: string };
        };
        if (msg.id !== undefined) {
          pending.get(msg.id)?.(msg);
          pending.delete(msg.id);
        }
      } catch { /* ignore parse errors */ }
    });

    const rpc = (method: string, params: unknown): Promise<unknown> => {
      const id = _reqId++;
      const toolTimeout = parseInt(process.env.MCP_TOOL_TIMEOUT || '30000');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`WS RPC timeout: ${method}`));
        }, toolTimeout);
        pending.set(id, (r) => {
          clearTimeout(timer);
          if (r.error) reject(new Error(r.error.message));
          else resolve(r.result);
        });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      });
    };

    // Initialize
    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'universal-agent', version: '1.0' },
    });

    // Discover tools
    const toolsResult = await rpc('tools/list', {}) as { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> };
    const toolDefs = toolsResult.tools ?? [];

    // Store WS in stdioClients map (abuse of field — it's just for cleanup)
    // We register a synthetic client that stops the WS
    this.stdioClients.set(server.name, {
      stop: () => { try { ws.close(); } catch { /* ignore */ } },
    } as unknown as StdioMCPClient);

    return toolDefs.map((t) => {
      const toolDef: ToolDefinition = {
        name: `mcp_${server.name}_${t.name}`,
        description: `[MCP:${server.name}] ${t.description ?? t.name}`,
        parameters: (t.inputSchema as ToolDefinition['parameters']) ?? { type: 'object', properties: {} },
      };
      return {
        definition: toolDef,
        handler: async (args: Record<string, unknown>): Promise<string> => {
          const result = await rpc('tools/call', { name: t.name, arguments: args });
          const r = result as { content?: Array<{ type?: string; text?: string }> } | string;
          if (typeof r === 'string') return r;
          return (r.content ?? []).map((c) => c.text ?? '').join('\n');
        },
      };
    });
  }

  private async connectStdioServer(server: MCPServer): Promise<ToolRegistration[]> {
    const client = new StdioMCPClient(server);
    const toolDefs = await client.start();
    this.stdioClients.set(server.name, client);

    // D14: 注册 Elicitation handler（MCP SDK 2025-03-26+ 支持）
    // 如果 SDK 不支持，registerElicitationHandler 内部会静默忽略
    registerElicitationHandler(client, (msg) => process.stderr.write(msg));

    // G15: 注册热更新通知回调
    client.onToolsChanged(async () => {
      try {
        // 重新拉取工具列表并更新 tools Map
        const freshDefs = await client.start().catch(() => toolDefs); // fallback to last known
        for (const t of freshDefs) {
          const toolDef: ToolDefinition = {
            name: `mcp_${server.name}_${t.name}`,
            description: `[MCP:${server.name}] ${t.description ?? t.name}`,
            parameters: (t.inputSchema as ToolDefinition['parameters']) ?? { type: 'object', properties: {} },
          };
          this.tools.set(toolDef.name, {
            definition: toolDef,
            handler: async (args: Record<string, unknown>): Promise<string> => client.callTool(t.name, args),
          });
        }
        process.stderr.write(`[MCP:${server.name}] tool pool refreshed (${freshDefs.length} tools)\n`);
      } catch { /* non-fatal */ }
    });

    return toolDefs.map((t) => {
      const toolDef: ToolDefinition = {
        name: `mcp_${server.name}_${t.name}`,
        description: `[MCP:${server.name}] ${t.description ?? t.name}`,
        parameters: (t.inputSchema as ToolDefinition['parameters']) ?? { type: 'object', properties: {} },
      };
      return {
        definition: toolDef,
        handler: async (args: Record<string, unknown>): Promise<string> => {
          return client.callTool(t.name, args);
        },
      };
    });
  }

  /** Gracefully stop all stdio MCP processes (call on agent shutdown) */
  stopAll() {
    for (const client of this.stdioClients.values()) client.stop();
    this.stdioClients.clear();
  }

  // ── Config management ────────────────────────────────────────────────────────

  getTools(): ToolRegistration[] { return Array.from(this.tools.values()); }
  listServers(): MCPServer[] { return Array.from(this.servers.values()); }

  /** D15: 获取指定服务器的 StdioMCPClient（用于资源访问） */
  getStdioClient(serverName: string): StdioMCPClient | undefined {
    return this.stdioClients.get(serverName);
  }

  addServer(name: string, server: Omit<MCPServer, 'name'>) {
    this.servers.set(name, { name, ...server });
    this.saveConfig();
  }

  removeServer(name: string): boolean {
    const existed = this.servers.has(name);
    this.servers.delete(name);
    if (existed) this.saveConfig();
    return existed;
  }

  enableServer(name: string, enabled: boolean): boolean {
    const s = this.servers.get(name);
    if (!s) return false;
    s.enabled = enabled;
    this.saveConfig();
    return true;
  }

  private saveConfig() {
    const config: MCPConfig = { servers: {} };
    for (const [name, server] of this.servers.entries()) {
      const { name: _omit, ...rest } = server;
      config.servers[name] = rest as MCPServer;
    }
    // Ensure directory exists
    try { mkdirSync(join(this.configPath, '..'), { recursive: true }); } catch { /* ignore */ }
    // A15: 原子写文件（先写 .tmp 再 rename），防止写入过程中进程崩溃导致文件损坏
    const tmpPath = this.configPath + '.tmp';
    try {
      writeFileSync(tmpPath, JSON.stringify(config, null, 2));
      renameSync(tmpPath, this.configPath);
    } catch {
      // fallback：直接写入
      writeFileSync(this.configPath, JSON.stringify(config, null, 2));
    }
  }

  /** Test a server: spawn it (stdio) or HTTP-ping it (SSE), return status string */
  async testServer(name: string): Promise<string> {
    const server = this.servers.get(name);
    if (!server) return `Error: Server "${name}" not found`;

    if (server.type === 'stdio') {
      try {
        const client = new StdioMCPClient(server);
        const tools = await client.start();
        client.stop();
        return `✅ ${name} (stdio): connected — ${tools.length} tool(s) available\n  Tools: ${tools.map((t) => t.name).join(', ')}`;
      } catch (err) {
        return `❌ ${name} (stdio): ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if (server.type === 'sse' || server.type === 'http') {
      try {
        const baseUrl = (server.url ?? '').replace(/\/sse$/, '');
        const res = await fetch(`${baseUrl}/tools`, {
          signal: timeoutSignal(5000),
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) return `❌ ${name} (sse): HTTP ${res.status}`;
        const data = await res.json() as { tools?: unknown[] };
        return `✅ ${name} (sse): connected — ${data.tools?.length ?? 0} tool(s) available`;
      } catch (err) {
        return `❌ ${name} (sse): ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    return `❌ Unknown server type: ${server.type}`;
  }

  // ── Config templates ─────────────────────────────────────────────────────────

  static readonly TEMPLATES: Record<string, Omit<MCPServer, 'name' | 'enabled'> & { description: string; setupHint: string }> = {
    figma: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'figma-developer-mcp', '--stdio'],
      env: { FIGMA_API_KEY: process.env.FIGMA_API_KEY || 'YOUR_FIGMA_API_KEY' },
      description: 'Figma MCP — read design files, inspect layers, download assets',
      setupHint: 'Get your Figma API key at https://www.figma.com/settings → Personal access tokens',
    },
    github: {
      type: 'stdio',
      command: 'docker',
      args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PERSONAL_ACCESS_TOKEN || 'YOUR_GITHUB_TOKEN' },
      description: 'GitHub MCP — search repos, read files, create issues/PRs',
      setupHint: 'Create a PAT at https://github.com/settings/tokens (requires Docker)',
    },
    filesystem: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', process.cwd()],
      description: 'Filesystem MCP — read/write files in allowed directories',
      setupHint: 'Add more allowed paths by appending them to args, e.g. ["/path/to/dir"]',
    },
    playwright: {
      type: 'stdio',
      command: 'npx',
      args: ['@playwright/mcp@latest', '--headless'],
      description: 'Playwright MCP — browser automation: navigate, click, screenshot',
      setupHint: 'Remove --headless to use headed mode; requires @playwright/mcp to be installed',
    },
    postgres: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/mydb'],
      description: 'PostgreSQL MCP — query and inspect your database',
      setupHint: 'Replace the connection string with your actual database URL',
    },
    sqlite: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sqlite', '--db-path', './data.db'],
      description: 'SQLite MCP — query a local SQLite database',
      setupHint: 'Replace ./data.db with the path to your SQLite file',
    },
  };

  static initConfig(dir: string = process.cwd(), withTemplates = false): string {
    const configPath = join(dir, '.mcp.json');
    if (existsSync(configPath) && !withTemplates) return `Already exists: ${configPath}`;
    try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }

    const config: MCPConfig & { _comment?: string } = {
      _comment: 'MCP server configuration for universal-agent. Run: uagent mcp add --help',
      servers: {
        'example-sse': {
          type: 'sse',
          url: 'http://127.0.0.1:3333/sse',
          enabled: false,
        } as MCPServer,
      },
    };

    if (withTemplates) {
      // Add all templates as disabled examples
      for (const [name, tmpl] of Object.entries(MCPManager.TEMPLATES)) {
        const { setupHint: _hint, ...serverConfig } = tmpl;
        config.servers[name] = { ...serverConfig, enabled: false } as MCPServer;
      }
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2));
    return existsSync(configPath) ? `✓ Updated ${configPath}` : `✓ Created ${configPath}`;
  }
}
