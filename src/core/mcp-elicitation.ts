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
 *   - url:  打开浏览器完成认证/授权流程，等待 ElicitationCompleteNotification 服务器确认
 *
 * A21: 本版本新增：
 *   1. ElicitationCompleteNotificationSchema 处理（URL 模式等待服务器确认）
 *   2. runElicitationHooks() 外部程序化响应（hook 拦截 elicitation）
 *   3. waitingState / _pendingElicitations 状态机（Promise-based 等待）
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
  /** A21: requestId for URL-mode waiting state correlation */
  requestId?: string;
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

// ── A21: waitingState — URL-mode Promise waiting map ──────────────────────
//
// Mirrors claude-code elicitationHandler.ts ElicitationWaitingState + pending queue.
// When URL mode elicitation is opened, we create a Promise and store its resolve
// function here, keyed by requestId. When ElicitationCompleteNotification arrives
// (or timeout fires), the Promise resolves and the handler returns the result.
//
// This replaces the previous immediate-return behavior (return accept right after
// opening browser) with proper async waiting for server confirmation.

interface PendingElicitation {
  resolve: (result: MCPElicitationResult) => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

/** Module-level pending elicitation map (requestId → pending Promise state) */
const _pendingElicitations = new Map<string, PendingElicitation>();

/** URL-mode elicitation timeout (30 seconds, mirrors claude-code default) */
const ELICITATION_URL_TIMEOUT_MS = 30_000;

// ── Core Handler ───────────────────────────────────────────────────────────

/**
 * D14: handleElicitation — MCP Elicitation 处理器
 *
 * 终端模式实现（无 React UI）：
 *   - URL 模式：调用系统浏览器打开 URL，等待 ElicitationCompleteNotification（或 30s 超时）
 *   - Form 模式：用 readline 逐字段收集用户输入
 *   - 无 schema：仅提示用户确认
 *
 * A21: 在展示 UI 之前先运行 elicitation hooks（程序化拦截）。
 *
 * @param request  Elicitation 请求（来自 MCP 服务器）
 * @param onMessage 用于输出提示信息的回调（通常写到 stderr 或 onChunk）
 */
export async function handleElicitation(
  request: MCPElicitationRequest,
  onMessage: (msg: string) => void,
): Promise<MCPElicitationResult> {
  const { message, requestedSchema, mode, url, requestId } = request;

  // ── A21-2: runElicitationHooks — 程序化拦截（claude-code elicitationHandler.ts L88-107）──
  // 在展示 UI 之前先执行 elicitation hook；若 hook 返回 elicitResult，跳过人工交互
  try {
    const { getHookRunner } = await import('./hooks.js');
    const runner = getHookRunner(process.cwd());
    if (runner.hasHooksFor('elicitation')) {
      const hookResult = await runner.run({
        event: 'elicitation',
        elicitationPrompt: message,
        cwd: process.cwd(),
      });
      // Hook 程序化响应 — 若 hook 返回有效的 elicitation 结果，跳过人工交互
      const _hookElicitResult = (hookResult as unknown as Record<string, unknown>)['elicitResult'];
      if (_hookElicitResult && typeof _hookElicitResult === 'object') {
        const _r = _hookElicitResult as MCPElicitationResult;
        if (_r.action === 'accept' || _r.action === 'decline' || _r.action === 'cancel') {
          onMessage(`[MCP Elicitation] Hook provided programmatic response: ${_r.action}\n`);
          return _r;
        }
      }
    }
  } catch { /* elicitation hook failure is non-fatal — continue to human interaction */ }

  // ── URL 模式：打开浏览器，A21-3: 等待 ElicitationCompleteNotification ─────────
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
      onMessage('[MCP Elicitation] Browser opened. Waiting for server confirmation...\n');
    } catch {
      onMessage('[MCP Elicitation] Could not open browser automatically. Please visit the URL manually.\n');
    }

    // A21-3: waitingState — 创建 Promise 等待 ElicitationCompleteNotification
    // 若有 requestId，注册到 _pendingElicitations；否则 fallback 到立即 accept
    if (requestId) {
      const waitResult = await new Promise<MCPElicitationResult>((resolve, reject) => {
        const timeoutHandle = setTimeout(() => {
          _pendingElicitations.delete(requestId);
          // 超时 fallback：接受（URL 已打开，用户可能已完成但服务器未发通知）
          resolve({ action: 'accept', content: { url_opened: true, url, timed_out: true } });
        }, ELICITATION_URL_TIMEOUT_MS);
        // Allow Node.js to exit even if waiting (unref the timer)
        if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();
        _pendingElicitations.set(requestId, { resolve, reject, timeoutHandle });
      });
      onMessage(`[MCP Elicitation] Server confirmation received: ${waitResult.action}\n`);
      return waitResult;
    }

    // No requestId — fallback to immediate accept (pre-A21 behavior)
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

    // A21-2: runElicitationResultHooks — 用户响应后 hook 可修改最终结果
    // Mirrors claude-code elicitationHandler.ts runElicitationResultHooks() L264-313
    let userResult: MCPElicitationResult = { action: 'accept', content: result };
    try {
      const { getHookRunner } = await import('./hooks.js');
      const runner = getHookRunner(process.cwd());
      if (runner.hasHooksFor('elicitation_result')) {
        const resultHookResult = await runner.run({
          event: 'elicitation_result',
          elicitationPrompt: message,
          cwd: process.cwd(),
        });
        // Hook 可覆盖用户结果
        const _hookOverride = (resultHookResult as unknown as Record<string, unknown>)['elicitResult'];
        if (_hookOverride && typeof _hookOverride === 'object') {
          const _r = _hookOverride as MCPElicitationResult;
          if (_r.action === 'accept' || _r.action === 'decline' || _r.action === 'cancel') {
            userResult = _r;
          }
        }
      }
    } catch { /* elicitation_result hook failure is non-fatal */ }

    onMessage('[MCP Elicitation] Input collected. Proceeding.\n\n');
    return userResult;
  } catch {
    onMessage('[MCP Elicitation] Input collection failed. Cancelling.\n\n');
    return { action: 'cancel' };
  }
}

// ── A21-1: handleElicitationCompleteNotification ──────────────────────────
//
// Mirrors claude-code elicitationHandler.ts L175-207.
// Called by registerElicitationHandler() when the MCP client receives
// an ElicitationCompleteNotification from the server (URL mode confirmation).

/**
 * A21: Resolve a pending URL-mode elicitation by requestId.
 * Called when ElicitationCompleteNotification is received from MCP server.
 *
 * @param requestId  The request ID from the notification
 * @param content    Optional content from the server
 */
export function resolveElicitationComplete(
  requestId: string,
  content: Record<string, unknown> = {},
): boolean {
  const pending = _pendingElicitations.get(requestId);
  if (!pending) return false;

  clearTimeout(pending.timeoutHandle);
  _pendingElicitations.delete(requestId);
  pending.resolve({ action: 'accept', content });
  return true;
}

// ── Elicitation Registration Helper ───────────────────────────────────────

/**
 * D14: registerElicitationHandler — 向 MCP SDK client 注册 elicitation 处理器
 *
 * A21: 同时注册 ElicitationCompleteNotificationSchema 处理器（URL 模式确认）。
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
          // A21: extract requestId from _meta for URL-mode waiting
          requestId: ((params._meta as Record<string, unknown> | undefined)?.requestId as string | undefined),
        };
        const result = await handleElicitation(req, onMessage);
        return result;
      });

      // ── A21-1: ElicitationCompleteNotification handler ────────────────────
      // Mirrors claude-code elicitationHandler.ts L175-207.
      // Registered separately — resolves pending URL-mode elicitations when
      // server sends confirmation after user completes authorization flow.
      const ElicitationCompleteNotificationSchema = types['ElicitationCompleteNotificationSchema'];
      if (ElicitationCompleteNotificationSchema && typeof client.setNotificationHandler === 'function') {
        client.setNotificationHandler(
          ElicitationCompleteNotificationSchema,
          async (notification: Record<string, unknown>) => {
            const _meta = notification.params as Record<string, unknown> | undefined;
            const _requestId = (_meta?.requestId ?? (_meta?._meta as Record<string, unknown>)?.requestId) as string | undefined;
            const _content = (_meta?.content ?? {}) as Record<string, unknown>;

            if (_requestId) {
              const resolved = resolveElicitationComplete(_requestId, _content);
              if (resolved) {
                onMessage(`[MCP Elicitation] ElicitationCompleteNotification received for requestId=${_requestId}\n`);
              }
            }

            // A21: trigger notification hook (elicitation_complete)
            try {
              const { executeNotificationHooks } = await import('./hooks.js');
              await executeNotificationHooks({
                notificationType: 'elicitation_complete',
                message: `MCP elicitation completed for requestId=${_requestId ?? 'unknown'}`,
                title: 'MCP Elicitation Complete',
              });
            } catch { /* non-fatal */ }
          },
        );
      }
    }).catch(() => { /* SDK version doesn't support elicitation — ignore */ });
  } catch {
    // Non-fatal: elicitation is a progressive enhancement
  }
}
