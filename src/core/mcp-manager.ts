import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { ToolDefinition, ToolRegistration } from '../models/types.js';

/**
 * AbortSignal.timeout() polyfill for Node.js < 17.3.
 * AbortSignal.timeout is only available from Node 17.3+; older runtimes throw
 * TypeError: AbortSignal.timeout is not a function.  This helper falls back to
 * a manual AbortController + setTimeout on older Node versions.
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
}

export interface MCPConfig {
  servers: Record<string, MCPServer>;
}

export class MCPManager {
  private servers: Map<string, MCPServer> = new Map();
  private tools: Map<string, ToolRegistration> = new Map();
  private configPath: string;

  constructor(projectDir?: string) {
    const dir = projectDir || process.cwd();
    this.configPath = existsSync(join(dir, '.mcp.json'))
      ? join(dir, '.mcp.json')
      : join(dir, '.mcprc');
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
    return (data.tools || []).map((t) => this.wrapMCPTool(t, baseUrl, server.name));
  }

  private async connectStdioServer(_server: MCPServer): Promise<ToolRegistration[]> {
    return []; // Full impl needs @modelcontextprotocol/sdk
  }

  private wrapMCPTool(
    mcpTool: { name: string; description: string; inputSchema?: unknown },
    baseUrl: string,
    serverName: string
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

  getTools(): ToolRegistration[] { return Array.from(this.tools.values()); }

  addServer(name: string, server: Omit<MCPServer, 'name'>) {
    this.servers.set(name, { name, ...server });
    this.saveConfig();
  }

  removeServer(name: string) { this.servers.delete(name); this.saveConfig(); }
  listServers(): MCPServer[] { return Array.from(this.servers.values()); }

  private saveConfig() {
    const config: MCPConfig = { servers: {} };
    for (const [name, server] of this.servers.entries()) {
      // Bug fix: don't write `name` twice — it's already used as the key.
      // Strip it from the stored value to keep the config clean.
      const { name: _omit, ...rest } = server;
      config.servers[name] = rest as MCPServer;
    }
    writeFileSync(this.configPath, JSON.stringify(config, null, 2));
  }

  static initConfig(dir: string = process.cwd()): string {
    const configPath = join(dir, '.mcp.json');
    if (existsSync(configPath)) return `Already exists: ${configPath}`;
    // Bug #9: auto-create the directory if it doesn't exist
    try {
      mkdirSync(dir, { recursive: true });
    } catch { /* ignore if dir already exists */ }
    // Note: keys are the server names; do NOT add a `name` field inside each entry
    // (saveConfig() intentionally strips `name` when persisting, to avoid redundancy).
    const template: MCPConfig = {
      servers: { 'example-sse': { type: 'sse', url: 'http://127.0.0.1:3333/sse', enabled: false } as MCPServer },
    };
    writeFileSync(configPath, JSON.stringify(template, null, 2));
    return `✓ Created ${configPath}`;
  }
}
