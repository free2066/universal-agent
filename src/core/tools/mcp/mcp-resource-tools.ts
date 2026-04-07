/**
 * D15: mcp-resource-tools.ts — MCP 资源访问工具
 *
 * 对标 claude-code ListMcpResourcesTool + ReadMcpResourceTool。
 * 允许 LLM 通过工具调用访问 MCP 服务器暴露的资源（Resources）。
 *
 * G28: 改为单例 MCPManager + TTL 缓存（5分钟），对标
 *      claude-code ListMcpResourcesTool.ts L79-94 fetchResourcesForClient LRU 缓存 +
 *      ensureConnectedClient 重连逻辑。单个 server 失败不影响其他 server 返回。
 *
 * C29: ReadMcpResource 新增 blob 二进制资源持久化，对标
 *      claude-code ReadMcpResourceTool.ts L103-138 persistBinaryContent 机制。
 */
import type { ToolRegistration } from '../../../models/types.js';

// ── C29: MIME type → file extension mapping ────────────────────────────────
// Mirrors ReadMcpResourceTool.ts mimeType handling
function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'application/pdf': 'pdf',
    'application/json': 'json',
    'text/plain': 'txt',
    'text/html': 'html',
    'text/csv': 'csv',
    'text/xml': 'xml',
    'application/xml': 'xml',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'video/mp4': 'mp4',
    'application/zip': 'zip',
    'application/octet-stream': 'bin',
  };
  return map[mime] ?? mime.split('/').pop()?.replace(/[^a-z0-9]/gi, '') ?? 'bin';
}

// ── G28: 模块级单例 MCPManager + TTL 缓存 ─────────────────────────────────────
// Mirrors claude-code ListMcpResourcesTool.ts L79-94:
//   fetchResourcesForClient = memoize(...)  — LRU + server-level isolation

let _mcpManager: import('../../mcp-manager.js').MCPManager | null = null;
let _mcpManagerCwd = '';
const _resourcesCache = new Map<string, { data: string; expiresAt: number }>();
const CACHE_TTL_MS = 300_000; // 5 minutes

async function getMcpManager(cwd: string): Promise<import('../../mcp-manager.js').MCPManager> {
  const { MCPManager } = await import('../../mcp-manager.js');
  // Re-create if cwd changed (project switch)
  if (!_mcpManager || _mcpManagerCwd !== cwd) {
    _mcpManager = new MCPManager(cwd);
    _mcpManagerCwd = cwd;
    _resourcesCache.clear(); // G28: invalidate cache on project change
  }
  return _mcpManager;
}

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

    // G28: use singleton manager
    const mgr = await getMcpManager(process.cwd());
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
      // G28: per-server TTL cache — single server failure does NOT sink others
      const cacheKey = s.name;
      const cached = _resourcesCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        lines.push(cached.data);
        continue;
      }

      const client = mgr.getStdioClient(s.name);
      if (!client) {
        lines.push(`\n## ${s.name}  (not connected)`);
        continue;
      }
      try {
        const resources = await client.listResources();
        const serverLines: string[] = [];
        serverLines.push(`\n## ${s.name}  (${resources.length} resource${resources.length !== 1 ? 's' : ''})`);
        if (!resources.length) {
          serverLines.push('  (no resources exposed)');
        } else {
          for (const r of resources) {
            const mime = r.mimeType ? `  [${r.mimeType}]` : '';
            const name = r.name ? `  ${r.name}` : '';
            serverLines.push(`  ${r.uri}${mime}${name}`);
          }
        }
        const serverOutput = serverLines.join('\n');
        // G28: write to cache
        _resourcesCache.set(cacheKey, { data: serverOutput, expiresAt: Date.now() + CACHE_TTL_MS });
        lines.push(serverOutput);
      } catch (e) {
        // G28: per-server error isolation — continue with other servers
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

    // G28: use singleton manager
    const mgr = await getMcpManager(process.cwd());
    const servers = mgr.listServers().filter(
      (s) => s.enabled && s.type === 'stdio' && (!serverName || s.name === serverName),
    );

    for (const s of servers) {
      const client = mgr.getStdioClient(s.name);
      if (!client) continue;
      try {
        // C29: use readResourceRaw to handle blob binary resources
        // Mirrors ReadMcpResourceTool.ts L103-138 blob persistence logic
        const rawContents = await client.readResourceRaw(uri);
        if (rawContents.length === 0) continue;

        for (const content of rawContents) {
          // C29: blob binary resource — decode base64 → write to disk
          if (content.blob) {
            try {
              const { writeFileSync, mkdirSync, existsSync } = await import('fs');
              const { tmpdir } = await import('os');
              const { join } = await import('path');

              const buf = Buffer.from(content.blob, 'base64');
              const ext = mimeToExt(content.mimeType ?? 'application/octet-stream');
              const dir = join(tmpdir(), 'uagent-mcp-blobs');
              if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
              const filename = `blob-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
              const blobPath = join(dir, filename);
              writeFileSync(blobPath, buf);

              return (
                `[Resource: ${uri} from ${s.name}]\n` +
                `blobSavedTo: ${blobPath}\n` +
                `mimeType: ${content.mimeType ?? 'application/octet-stream'}\n` +
                `size: ${buf.length} bytes`
              );
            } catch (blobErr) {
              // Fallback: return blob as base64 string if disk write fails
              return (
                `[Resource: ${uri} from ${s.name}]\n` +
                `[binary blob, base64]\n` +
                `mimeType: ${content.mimeType ?? 'application/octet-stream'}\n` +
                content.blob.slice(0, 2000) + (content.blob.length > 2000 ? '\n...(truncated)' : '')
              );
            }
          }
          // text resource
          if (content.text) {
            return `[Resource: ${uri} from ${s.name}]\n\n${content.text}`;
          }
        }

        // All contents processed but nothing returned — content exists but empty
        return `[Resource: ${uri} from ${s.name}]\n(empty resource)`;
      } catch { continue; }
    }

    return `Resource not found: ${uri}${serverName ? ` (server: ${serverName})` : ''}`;
  },
};
