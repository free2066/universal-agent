/**
 * D15: mcp-resource-tools.ts — MCP 资源访问工具
 *
 * 对标 claude-code ListMcpResourcesTool + ReadMcpResourceTool。
 * 允许 LLM 通过工具调用访问 MCP 服务器暴露的资源（Resources）。
 */
import type { ToolRegistration } from '../../../models/types.js';

export const ListMcpResourcesRegistration: ToolRegistration = {
  definition: {
    name: 'ListMcpResources',
    description:
      'List resources available from connected MCP servers. ' +
      'Resources are data/content items exposed by MCP servers (distinct from tools). ' +
      'Optionally filter by server name.',
    parameters: {
      type: 'object',
      properties: {
        server_name: {
          type: 'string',
          description: 'Optional: filter to a specific MCP server name',
        },
      },
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const serverName = typeof args['server_name'] === 'string' ? args['server_name'] : undefined;
    const { MCPManager } = await import('../../mcp-manager.js');
    const mgr = new MCPManager(process.cwd());
    const servers = mgr.listServers().filter(
      (s) => s.enabled && s.type === 'stdio' && (!serverName || s.name === serverName),
    );

    if (!servers.length) {
      return serverName
        ? `No enabled stdio MCP server found: "${serverName}"`
        : 'No enabled stdio MCP servers configured.';
    }

    const lines: string[] = [];
    for (const s of servers) {
      const client = mgr.getStdioClient(s.name);
      if (!client) {
        lines.push(`\n## ${s.name}  (not connected)`);
        continue;
      }
      try {
        const resources = await client.listResources();
        lines.push(`\n## ${s.name}  (${resources.length} resource${resources.length !== 1 ? 's' : ''})`);
        if (!resources.length) {
          lines.push('  (no resources exposed)');
          continue;
        }
        for (const r of resources) {
          const mime = r.mimeType ? `  [${r.mimeType}]` : '';
          const name = r.name ? `  ${r.name}` : '';
          lines.push(`  ${r.uri}${mime}${name}`);
        }
      } catch (e) {
        lines.push(`\n## ${s.name}`);
        lines.push(`  Error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return lines.length ? lines.join('\n') + '\n' : 'No resources found.';
  },
};

export const ReadMcpResourceRegistration: ToolRegistration = {
  definition: {
    name: 'ReadMcpResource',
    description:
      'Read the content of a specific MCP server resource by its URI. ' +
      'Use ListMcpResources first to discover available resource URIs.',
    parameters: {
      type: 'object',
      required: ['uri'],
      properties: {
        uri: {
          type: 'string',
          description: 'The resource URI to read (obtained from ListMcpResources)',
        },
        server_name: {
          type: 'string',
          description: 'Optional: specify which MCP server to read from (for disambiguation)',
        },
      },
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const uri = typeof args['uri'] === 'string' ? args['uri'] : '';
    const serverName = typeof args['server_name'] === 'string' ? args['server_name'] : undefined;
    if (!uri) return 'Error: uri is required';

    const { MCPManager } = await import('../../mcp-manager.js');
    const mgr = new MCPManager(process.cwd());
    const servers = mgr.listServers().filter(
      (s) => s.enabled && s.type === 'stdio' && (!serverName || s.name === serverName),
    );

    for (const s of servers) {
      const client = mgr.getStdioClient(s.name);
      if (!client) continue;
      try {
        const content = await client.readResource(uri);
        if (content !== null) {
          return `[Resource: ${uri} from ${s.name}]\n\n${content}`;
        }
      } catch { continue; }
    }

    return `Resource not found: ${uri}${serverName ? ` (server: ${serverName})` : ''}`;
  },
};
