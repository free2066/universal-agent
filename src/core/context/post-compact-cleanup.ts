/**
 * F15: post-compact-cleanup.ts — 压缩后缓存清理
 *
 * 对标 claude-code src/services/compact/postCompactCleanup.ts。
 * 在 autoCompact 完成后，清理各模块缓存，避免压缩前的陈旧状态在下一轮对话中继续使用。
 *
 * querySource: 'main' | 'subagent'
 *   - 'main'：主线程，清理全部缓存（含 user context、classifier approvals）
 *   - 'subagent'：子代理，仅清理安全的 session 级别缓存
 */

export type CompactQuerySource = 'main' | 'subagent';

/**
 * F15: runPostCompactCleanup — 压缩后 N 类缓存清理
 *
 * 清理顺序：
 *   1. Tool selector 缓存（避免 deferred 工具列表过期）
 *   2. [主线程专属] User context 缓存（含 memory files 缓存）
 *   3. Speculative checks 缓存（permission 预执行状态重置）
 *   4. LLM client 响应缓存（如果有）
 */
export async function runPostCompactCleanup(
  querySource: CompactQuerySource = 'main',
): Promise<void> {
  const isMain = querySource === 'main';

  // Helper: 安全调用模块导出的无参函数
  async function tryCall(importPath: string, fnName: string): Promise<void> {
    try {
      const mod = await import(importPath).catch(() => null);
      if (!mod) return;
      const fn = (mod as Record<string, unknown>)[fnName];
      if (typeof fn === 'function') {
        (fn as () => void)();
      }
    } catch { /* non-fatal */ }
  }

  // 1. 清理 tool selector 缓存（避免 deferred 工具列表过期）
  await tryCall('../tool-selector.js', 'clearToolSelectorCache');

  // 2. 主线程专属：清理 user context 缓存（子代理不重置全局状态）
  if (isMain) {
    await tryCall('./context-loader.js', 'clearUserContextCache');
  }

  // 3. 清理 speculative checks 缓存（权限预执行状态重置）
  await tryCall('../agent/permission-manager.js', 'clearSpeculativeChecks');

  // 4. 重置 LLM client 响应缓存（如果有）
  await tryCall('../../models/model-manager.js', 'clearResponseCache');
}
