import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import type { ToolDefinition, ToolRegistration } from '../models/types.js';

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

export interface MCPServer {
  name: string;
  type: 'stdio' | 'sse' | 'http';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled: boolean;
  description?: string;  // human-readable note stored in config
}

export interface MCPConfig {
  servers: Record<string, MCPServer>;
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
  private server: MCPServer;

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

    this.proc.stdout!.setEncoding('utf-8');
    this.proc.stdout!.on('data', (chunk: string) => this.onData(chunk));

    this.proc.stderr!.on('data', (chunk: Buffer) => {
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
      capabilities: { tools: {} },
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
    if (!this.proc) throw new Error(`MCP server "${this.server.name}" is not running`);
    const res = await this.request('tools/call', { name: toolName, arguments: toolArgs });
    if (res.error) throw new Error(`MCP tool error: ${res.error.message}`);
    const content = (res.result as { content?: Array<{ type: string; text?: string }> })?.content ?? [];
    return content.map((c) => c.text ?? JSON.stringify(c)).join('\n');
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
      this.proc.stdin!.write(line);
    });
  }

  private notify(method: string) {
    if (!this.proc) return;
    const msg = { jsonrpc: '2.0', method };
    this.proc.stdin!.write(JSON.stringify(msg) + '\n');
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        if (typeof msg.id === 'number') {
          const pending = this.pending.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(msg.id);
            pending.resolve(msg);
          }
        }
      } catch { /* ignore non-JSON lines (e.g. server startup messages) */ }
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
    // Also check ~/.uagent/.mcp.json as global fallback
    const localPath = join(dir, '.mcp.json');
    const globalPath = join(process.env.HOME || '~', '.uagent', '.mcp.json');
    this.configPath = existsSync(localPath) ? localPath
      : existsSync(join(dir, '.mcprc')) ? join(dir, '.mcprc')
      : existsSync(globalPath) ? globalPath
      : localPath; // default to local for writes
    this.loadConfig();
  }

  private loadConfig() {
    if (!existsSync(this.configPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.configPath, 'utf-8')) as MCPConfig;
      for (const [name, server] of Object.entries(raw.servers || {})) {
        this.servers.set(name, { ...server, name, enabled: server.enabled ?? true });
      }
    } catch { /* ignore */ }
  }

  async connectAll(): Promise<{ connected: string[]; failed: string[] }> {
    const connected: string[] = [];
    const failed: string[] = [];
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
    return { connected, failed };
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
    const res = await fetch(`${baseUrl}/tools`, {
      signal: timeoutSignal(timeout),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${baseUrl}/tools`);
    const data = await res.json() as { tools?: Array<{ name: string; description: string; inputSchema?: unknown }> };
    return (data.tools || []).map((t) => this.wrapSSETool(t, baseUrl, server.name));
  }

  private wrapSSETool(
    mcpTool: { name: string; description: string; inputSchema?: unknown },
    baseUrl: string,
    serverName: string,
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
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ arguments: args }),
          signal: timeoutSignal(timeout),
        });
        if (!res.ok) throw new Error(`MCP tool error: HTTP ${res.status}`);
        const data = await res.json() as { content?: Array<{ text?: string }> };
        return data.content?.map((c) => c.text).join('\n') || '';
      },
    };
  }

  // ── stdio server (JSON-RPC 2.0) ──────────────────────────────────────────────

  private async connectStdioServer(server: MCPServer): Promise<ToolRegistration[]> {
    const client = new StdioMCPClient(server);
    const toolDefs = await client.start();
    this.stdioClients.set(server.name, client);

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
    writeFileSync(this.configPath, JSON.stringify(config, null, 2));
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
