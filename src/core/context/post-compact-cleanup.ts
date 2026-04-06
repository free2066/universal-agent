/**
 * E16 + F15 + E25: post-compact-cleanup.ts — 压缩后缓存清理（完整版）
 *
 * 对标 claude-code/src/services/compact/postCompactCleanup.ts
 *
 * Round 15 (F15): 实现了 4 项清理
 * Round 16 (E16): 扩展到 7 项清理，对标 claude-code 的 10 项（外部可复现的 7 项）
 * Round 25 (E25): querySource 扩展，接受完整 QuerySource 枚举
 *
 * querySource: 'main' | 'repl_main_thread' (foreground) | 'subagent' | 'agent' (background)
 *   - foreground ('main'/'repl_main_thread')：主线程，清理全部缓存（含 user context）
 *   - background ('subagent'/'agent')：子代理，仅清理安全的 session 级别缓存
 */

export type CompactQuerySource = 'main' | 'subagent';

// E25: FOREGROUND_COMPACT_SOURCES -- sources that trigger full cache cleanup
const FOREGROUND_COMPACT_SOURCES = new Set([
  'main', 'repl_main_thread', 'repl_main_thread:compact', 'agent_main', 'compact',
]);

/**
 * E16: runPostCompactCleanup — 压缩后 7 类缓存清理
 *
 * 清理顺序（对标 claude-code postCompactCleanup.ts）：
 *   1. microcompact 状态重置（避免压缩后立即再次触发 time-based microcompact）
 *   2. tool selector 缓存（避免 deferred 工具列表过期）
 *   3. [主线程] user context 缓存（含 memory files 缓存）
 *   4. systemPromptSections 缓存（压缩后重新注入系统提示词 sections）
 *   5. 权限分类器审批记录（压缩后规则可能变化）
 *   6. speculative checks 缓存（权限预执行状态重置）
 *   7. LLM client 响应缓存（如果有）
 */
export async function runPostCompactCleanup(
  querySource: import('../agent/types.js').QuerySource | CompactQuerySource = 'main',
): Promise<void> {
  // E25: support full QuerySource enumeration for foreground detection
  const isMain = FOREGROUND_COMPACT_SOURCES.has(querySource as string);

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

  // 1. microcompact 状态重置（E16 新增）
  // 避免压缩后立即再次触发 time-based microcompact（需要重置 _lastTimeBasedMicrocompactAt）
  await tryCall('./context-compressor.js', '_resetTimeBasedMicrocompact');

  // 2. 清理 tool selector 缓存（F15 已有）
  await tryCall('../tool-selector.js', 'clearToolSelectorCache');

  // 3. 主线程专属：清理 user context 缓存（F15 已有，子代理不重置全局状态）
  if (isMain) {
    await tryCall('./context-loader.js', 'clearUserContextCache');
  }

  // 4. systemPromptSections 缓存（E16 新增）
  // 压缩后重新注入系统提示词 sections（如 MCP 工具列表、memory 等）
  await tryCall('./system-prompt-builder.js', 'clearSystemPromptSections');

  // 5. 权限分类器审批记录（E16 新增）
  // 压缩后规则可能变化，清理审批缓存防止旧判断影响新对话
  await tryCall('../agent/permission-manager.js', 'clearClassifierApprovals');

  // 6. 清理 speculative checks 缓存（F15 已有）
  await tryCall('../agent/permission-manager.js', 'clearSpeculativeChecks');

  // 7. 重置 LLM client 响应缓存（F15 已有）
  await tryCall('../../models/model-manager.js', 'clearResponseCache');
}
