/**
 * D16: mcp-headers-helper.ts — MCP Server 动态 Header 注入
 *
 * 对标 claude-code/src/services/mcp/headersHelper.ts
 *
 * 功能：MCP Server 配置中可指定 `headersHelper: "<shell cmd>"` 字段。
 * 运行时执行该 shell 命令，解析其 stdout 中的 `KEY: value` 格式行（类 git credential-helper 风格），
 * 动态 headers 与静态 headers 合并后返回，动态 headers 优先级更高。
 *
 * 安全性：
 * - 10s 超时，超时时回退到静态 headers（非致命）
 * - 向子进程注入 UAGENT_MCP_SERVER_NAME 环境变量
 * - 仅允许来自已确认的 project/local 配置文件（运行前应有 trust 对话）
 */

const HEADERS_HELPER_TIMEOUT_MS = 10_000;

export interface HeadersHelperConfig {
  /** shell 命令字符串，执行后从 stdout 读取 `KEY: value` 格式的动态 headers */
  headersHelper?: string;
  /** 静态 headers（会被动态 headers 覆盖） */
  headers?: Record<string, string>;
}

/**
 * D16: getMcpServerHeaders — 合并静态 headers 和动态 headersHelper 输出
 *
 * @param serverName  MCP 服务器名称（注入 UAGENT_MCP_SERVER_NAME 环境变量）
 * @param config      包含 headers 和 headersHelper 的配置对象
 * @returns           合并后的 headers 对象（动态优先）
 */
export async function getMcpServerHeaders(
  serverName: string,
  config: HeadersHelperConfig,
): Promise<Record<string, string>> {
  const staticHeaders = config.headers ?? {};

  if (!config.headersHelper) return staticHeaders;

  try {
    const dynamicHeaders = await runHeadersHelper(serverName, config.headersHelper);
    return { ...staticHeaders, ...dynamicHeaders };
  } catch (err) {
    // headersHelper 失败时回退到静态 headers（非致命 — 避免阻塞 MCP 连接）
    process.stderr.write(
      `[MCP:${serverName}] headersHelper failed (falling back to static headers): ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return staticHeaders;
  }
}

/**
 * D16: runHeadersHelper — 执行 headersHelper shell 命令并解析输出
 *
 * 输出格式（类 git credential-helper）：
 * ```
 * Authorization: Bearer token123
 * X-Custom-Header: value
 * ```
 */
async function runHeadersHelper(
  serverName: string,
  helperCmd: string,
): Promise<Record<string, string>> {
  const { execFile } = await import('child_process');

  return new Promise<Record<string, string>>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      reject(new Error(`headersHelper timed out after ${HEADERS_HELPER_TIMEOUT_MS}ms`));
    }, HEADERS_HELPER_TIMEOUT_MS);

    execFile(
      'sh',
      ['-c', helperCmd],
      {
        timeout: HEADERS_HELPER_TIMEOUT_MS,
        env: {
          ...process.env,
          UAGENT_MCP_SERVER_NAME: serverName,
        },
      },
      (err, stdout, _stderr) => {
        clearTimeout(timeoutHandle);
        if (err) {
          reject(err);
          return;
        }
        // 解析 "KEY: value" 格式行
        const headers: Record<string, string> = {};
        for (const line of stdout.split('\n')) {
          const colonIdx = line.indexOf(':');
          if (colonIdx === -1) continue;
          const key = line.slice(0, colonIdx).trim();
          const value = line.slice(colonIdx + 1).trim();
          if (key && value) {
            headers[key] = value;
          }
        }
        resolve(headers);
      },
    );
  });
}
