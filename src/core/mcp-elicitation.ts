/**
 * mcp-elicitation.ts — MCP Elicitation 协议实现
 *
 * D14: MCP 2025-03-26 规范引入了 Elicitation 协议，允许 MCP 工具服务器在执行过程中
 * 向用户请求额外信息（form 表单输入 / URL 回调流程）。
 *
 * 对标 claude-code src/services/mcp/elicitationHandler.ts（314行）。
 *
 * 支持两种模式：
 *   - form: 按 JSON Schema 属性逐字段收集用户输入（readline 交互）
 *   - url:  打开浏览器完成认证/授权流程，返回接受结果
 *
 * 在 mcp-manager.ts 中通过 client.setRequestHandler(ElicitRequestSchema, ...) 注册。
 */

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * MCP Elicitation 请求（对标 ElicitRequestSchema 的 params 部分）
 */
export interface MCPElicitationRequest {
  message: string;
  requestedSchema?: {
    type: 'object';
    properties?: Record<string, {
      type: string;
      title?: string;
      description?: string;
      enum?: unknown[];
      default?: unknown;
    }>;
    required?: string[];
  };
  mode?: 'form' | 'url';
  url?: string;
}

/**
 * MCP Elicitation 结果（对标 ElicitResult）
 *   - accept:  用户提供了数据
 *   - decline: 用户明确拒绝（MCP 服务器可降级）
 *   - cancel:  用户取消（中断流程）
 */
export type MCPElicitationResult =
  | { action: 'accept'; content: Record<string, unknown> }
  | { action: 'decline' }
  | { action: 'cancel' };

// ── Core Handler ───────────────────────────────────────────────────────────

/**
 * D14: handleElicitation — MCP Elicitation 处理器
 *
 * 终端模式实现（无 React UI）：
 *   - URL 模式：调用系统浏览器打开 URL，立即返回 accept
 *   - Form 模式：用 readline 逐字段收集用户输入
 *   - 无 schema：仅提示用户确认
 *
 * @param request  Elicitation 请求（来自 MCP 服务器）
 * @param onMessage 用于输出提示信息的回调（通常写到 stderr 或 onChunk）
 */
export async function handleElicitation(
  request: MCPElicitationRequest,
  onMessage: (msg: string) => void,
): Promise<MCPElicitationResult> {
  const { message, requestedSchema, mode, url } = request;

  // ── URL 模式：打开浏览器，提示用户完成后继续 ──────────────────────────────
  if (mode === 'url' && url) {
    onMessage(`\n[MCP Elicitation] Opening browser for authorization:\n  ${url}\n`);
    try {
      const { execSync } = await import('child_process');
      const openCmd =
        process.platform === 'darwin'
          ? `open "${url}"`
          : process.platform === 'win32'
            ? `start "" "${url}"`
            : `xdg-open "${url}"`;
      execSync(openCmd, { timeout: 3_000, stdio: 'ignore' });
      onMessage('[MCP Elicitation] Browser opened. Returning accept.\n');
    } catch {
      onMessage('[MCP Elicitation] Could not open browser automatically. Please visit the URL manually.\n');
    }
    return { action: 'accept', content: { url_opened: true, url } };
  }

  // ── Form 模式：逐字段收集用户输入 ─────────────────────────────────────────
  onMessage(`\n[MCP Elicitation] ${message}\n`);

  // 无 schema：仅提示消息，自动接受（不阻塞）
  if (!requestedSchema?.properties || Object.keys(requestedSchema.properties).length === 0) {
    onMessage('[MCP Elicitation] No input required. Accepting.\n\n');
    return { action: 'accept', content: {} };
  }

  // 有 schema：用 readline 逐字段收集
  const result: Record<string, unknown> = {};

  try {
    const { createInterface } = await import('readline');
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    const askField = (
      key: string,
      schema: { type: string; title?: string; description?: string; enum?: unknown[]; default?: unknown },
    ): Promise<string> =>
      new Promise((resolve) => {
        const label = schema.title ?? key;
        const descPart = schema.description ? ` (${schema.description})` : '';
        const enumPart = schema.enum ? ` [${schema.enum.join('|')}]` : '';
        const defaultPart = schema.default !== undefined ? ` (default: ${schema.default})` : '';
        const prompt = `  ${label}${descPart}${enumPart}${defaultPart}: `;
        rl.question(prompt, resolve);
      });

    const required = new Set(requestedSchema.required ?? []);

    for (const [key, fieldSchema] of Object.entries(requestedSchema.properties)) {
      const val = await askField(key, fieldSchema as { type: string; title?: string; description?: string; enum?: unknown[]; default?: unknown });
      const trimmed = val.trim();

      if (trimmed.length === 0) {
        // 未填写：使用 default 或跳过（非必填）
        if (fieldSchema.default !== undefined) {
          result[key] = fieldSchema.default;
        } else if (required.has(key)) {
          // 必填但留空 → cancel
          rl.close();
          onMessage('[MCP Elicitation] Required field left empty. Cancelling.\n\n');
          return { action: 'cancel' };
        }
        // 非必填且无 default → 不注入
        continue;
      }

      // 类型转换
      const fType = (fieldSchema as { type: string }).type;
      if (fType === 'number' || fType === 'integer') {
        const num = Number(trimmed);
        result[key] = isNaN(num) ? trimmed : num;
      } else if (fType === 'boolean') {
        result[key] = trimmed.toLowerCase() === 'true' || trimmed === '1' || trimmed.toLowerCase() === 'yes';
      } else {
        result[key] = trimmed;
      }
    }

    rl.close();
    onMessage('[MCP Elicitation] Input collected. Proceeding.\n\n');
    return { action: 'accept', content: result };
  } catch {
    onMessage('[MCP Elicitation] Input collection failed. Cancelling.\n\n');
    return { action: 'cancel' };
  }
}

// ── Elicitation Registration Helper ───────────────────────────────────────

/**
 * D14: registerElicitationHandler — 向 MCP SDK client 注册 elicitation 处理器
 *
 * 用法（在 StdioMCPClient / HTTP client 初始化时调用）：
 * ```typescript
 * if (typeof client.setRequestHandler === 'function') {
 *   registerElicitationHandler(client, onMessage);
 * }
 * ```
 *
 * MCP SDK 2025-03-26+ 在 client 连接期间会将 elicitation 请求路由到这个 handler。
 * 如果 SDK 版本不支持 setRequestHandler，调用会静默失败（try/catch 保护）。
 */
export function registerElicitationHandler(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  onMessage: (msg: string) => void = (m) => process.stderr.write(m),
): void {
  try {
    if (typeof client?.setRequestHandler !== 'function') return;

    // 尝试导入 ElicitRequestSchema（MCP SDK >= 1.9.0）
    // 如果 SDK 版本不支持，gracefully 忽略
    // 使用 Function constructor 规避静态类型检查（SDK 版本不确定）
    const tryImport = new Function('m', 'return import(m)') as (m: string) => Promise<Record<string, unknown>>;
    tryImport('@modelcontextprotocol/sdk/types.js').then((types) => {
      const ElicitRequestSchema = types['ElicitRequestSchema'];
      if (!ElicitRequestSchema) return;

      client.setRequestHandler(ElicitRequestSchema, async (params: Record<string, unknown>) => {
        const req: MCPElicitationRequest = {
          message: (params.message as string | undefined) ?? 'MCP server requires input',
          requestedSchema: params.requestedSchema as MCPElicitationRequest['requestedSchema'],
          mode: params.mode as 'form' | 'url' | undefined,
          url: params.url as string | undefined,
        };
        const result = await handleElicitation(req, onMessage);
        return result;
      });
    }).catch(() => { /* SDK version doesn't support elicitation — ignore */ });
  } catch {
    // Non-fatal: elicitation is a progressive enhancement
  }
}
