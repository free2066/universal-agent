/**
 * mcp-auth-tool.ts — McpAuthTool 未认证 MCP 服务器伪工具
 *
 * A22: 对标 claude-code src/tools/McpAuthTool/McpAuthTool.ts
 *
 * 当 MCP 服务器配置了 OAuth 但尚未认证时，动态注入一个同名"伪工具"：
 *   mcp__<serverName>__authenticate
 *
 * 当 LLM 调用该伪工具时，触发 OAuth 授权流程（打开浏览器），
 * 认证完成后返回成功消息。这允许 LLM 主动发起 MCP OAuth 认证，
 * 实现零配置 OAuth 接入体验（无需用户手动触发认证流程）。
 *
 * 设计原则：
 *   - 非侵入式：伪工具仅在服务器未认证时出现
 *   - 幂等：多次调用安全（重复授权检查）
 *   - 清晰错误：授权失败返回结构化错误消息
 */

import type { ToolRegistration } from '../../models/types.js';

// ── McpAuthTool 工具名前缀 ───────────────────────────────────────────────────
const MCP_AUTH_TOOL_PREFIX = 'mcp__';
const MCP_AUTH_TOOL_SUFFIX = '__authenticate';

/**
 * A22: createMcpAuthTool — 为未认证的 MCP 服务器创建伪工具
 *
 * 对标 claude-code McpAuthTool.ts:
 *   - 工具名格式: mcp__<serverName>__authenticate
 *   - 描述: 告知 LLM 此服务器需要 OAuth 认证，调用工具触发授权
 *   - 执行: 调用 auth.authorize() 打开浏览器完成 OAuth 流程
 *   - 成功后: 返回成功消息（正常 MCP 工具自动可用）
 *   - 失败: 返回结构化错误消息（不抛出，保持 LLM 对话稳定）
 *
 * @param serverName  MCP 服务器名称
 * @param authorizeCallback  触发 OAuth 授权的回调函数
 * @returns ToolRegistration 可注册到工具注册表的伪工具
 */
/**
 * A22 + C27: createMcpAuthTool — 为未认证的 MCP 服务器创建伪工具
 *
 * 对标 claude-code McpAuthTool.ts:
 *   - 工具名格式: mcp__<serverName>__authenticate
 *   - 描述: 告知 LLM 此服务器需要 OAuth 认证，调用工具触发授权
 *   - 执行: 调用 auth.authorize() 打开浏览器完成 OAuth 流程
 *   - 成功后: 返回成功消息（正常 MCP 工具自动可用）
 *   - 失败: 返回结构化错误消息（不抛出，保持 LLM 对话稳定）
 *
 * C27: skipBrowserOpen 模式 — 对标 claude-code McpAuthTool.ts L126-132
 *   - headless/CI 环境（!process.stdout.isTTY）自动启用
 *   - skipBrowserOpen=true 时返回 auth URL 而非打开浏览器
 *   - 后台等待 OAuth 完成后通知 reconnect
 *
 * @param serverName  MCP 服务器名称
 * @param authorizeCallback  触发 OAuth 授权的回调函数
 * @param options    C27: 可选配置项
 * @returns ToolRegistration 可注册到工具注册表的伪工具
 */
export function createMcpAuthTool(
  serverName: string,
  authorizeCallback: () => Promise<void>,
  options?: {
    /** C27: skipBrowserOpen — return auth URL instead of opening browser (for headless/SDK use) */
    getAuthUrl?: () => Promise<string | null>;
    /** C27: onReconnect — called after OAuth completes to reconnect the MCP server */
    onReconnect?: () => Promise<void>;
  },
): ToolRegistration {
  const toolName = `${MCP_AUTH_TOOL_PREFIX}${serverName}${MCP_AUTH_TOOL_SUFFIX}`;

  // C27: auto-detect headless environment
  const isHeadless = !process.stdout.isTTY || process.env.CI === '1';

  return {
    definition: {
      name: toolName,
      description:
        `This MCP server (${serverName}) requires OAuth authentication before its tools can be used. ` +
        `Call this tool to ${isHeadless ? 'get the authorization URL to complete authentication' : 'open the browser and complete the authorization flow'}. ` +
        `After authentication succeeds, the server's actual tools will become available. ` +
        `Only call this tool once — it will wait for the OAuth flow to complete.`,
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    handler: async (): Promise<string> => {
      // C27: headless/SDK mode — return URL instead of opening browser
      // Mirrors claude-code McpAuthTool.ts L126-132: skipBrowserOpen + Promise.race
      if (isHeadless && options?.getAuthUrl) {
        try {
          const authUrl = await options.getAuthUrl();
          if (authUrl) {
            // C27: Background wait for OAuth completion + auto-reconnect
            // Mirrors McpAuthTool.ts L137-173: background reconnect after oauth completes
            (async () => {
              try {
                await authorizeCallback();
                if (options?.onReconnect) {
                  await options.onReconnect();
                }
              } catch { /* non-fatal background reconnect failure */ }
            })().catch(() => {});

            return (
              `🔗 OAuth authentication required for MCP server "${serverName}".\n\n` +
              `Visit this URL to authenticate:\n${authUrl}\n\n` +
              `After completing authentication in your browser, the server's tools will become available automatically.`
            );
          }
        } catch { /* fallthrough to browser mode */ }
      }

      // Default: open browser (interactive TTY mode)
      try {
        await authorizeCallback();
        // C27: trigger reconnect after successful auth
        if (options?.onReconnect) {
          await options.onReconnect().catch(() => {});
        }
        return (
          `✅ OAuth authentication for MCP server "${serverName}" completed successfully. ` +
          `The server's tools are now available — you can use them directly in your next tool call.`
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return (
          `❌ OAuth authentication for MCP server "${serverName}" failed: ${errMsg}\n\n` +
          `You can try again by calling this tool once more, or ask the user to ` +
          `check the server configuration.`
        );
      }
    },
  };
}

/**
 * A22: isMcpAuthToolName — 检测工具名是否为 McpAuthTool 伪工具
 */
export function isMcpAuthToolName(toolName: string): boolean {
  return toolName.startsWith(MCP_AUTH_TOOL_PREFIX) && toolName.endsWith(MCP_AUTH_TOOL_SUFFIX);
}

/**
 * A22: extractServerNameFromAuthTool — 从伪工具名提取 MCP 服务器名称
 */
export function extractServerNameFromAuthTool(toolName: string): string | null {
  if (!isMcpAuthToolName(toolName)) return null;
  return toolName.slice(MCP_AUTH_TOOL_PREFIX.length, -MCP_AUTH_TOOL_SUFFIX.length);
}
