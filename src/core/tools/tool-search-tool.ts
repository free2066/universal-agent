/**
 * I15: ToolSearchTool — 工具关键词搜索 + isDeferredTool 懒加载体系
 *
 * 对标 claude-code ToolSearchTool.ts + isDeferredTool 机制。
 *
 * 功能：
 * 1. 当工具总数 > DEFER_THRESHOLD=50 时，MCP 工具默认从 prompt 中移除（deferred）
 * 2. LLM 通过 ToolSearch 工具按关键词搜索可用工具列表
 * 3. 支持 select:<name> 精确选择单个或多个工具
 * 4. 加权评分：工具名精确匹配+10、包含+5、描述包含+2
 */

import type { ToolRegistration } from '../../models/types.js';

/** I15: ToolSearch 工具本体（alwaysLoad，不参与 deferred） */
export const toolSearchToolRegistration: ToolRegistration & {
  alwaysLoad: boolean;
} = {
  alwaysLoad: true,  // ToolSearch 自身永远展开，不 defer
  definition: {
    name: 'ToolSearch',
    description: [
      'Search for available tools by keyword.',
      'When you need a specific capability but are unsure which tool to use,',
      'call this tool with relevant keywords to find the best match.',
      'Use "select:<tool_name>" to expand the schema of a specific tool.',
      'Use "select:A,B,C" to expand multiple tools at once.',
    ].join(' '),
    parameters: {
      type: 'object' as const,
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: [
            'Keyword(s) to search for available tools.',
            'Examples: "file read", "bash execute", "web search".',
            'Or use "select:<tool_name>" to get details of a specific tool.',
          ].join(' '),
        },
      },
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
    if (!query) return 'Error: query is required';

    // 通过全局进程级别缓存获取当前注册表（由 agent-loop 初始化时注入）
    // 若无法获取，返回友好提示
    const globalThis_ = globalThis as Record<string, unknown>;
    const registry = globalThis_['__uagent_tool_registry'] as
      | import('../tool-registry.js').ToolRegistry
      | undefined;
    const allTools: import('../../models/types.js').ToolDefinition[] = registry
      ? registry.getToolDefinitions()
      : [];

    // ── select: 精确选择模式 ───────────────────────────────────────────────
    if (query.startsWith('select:')) {
      const names = query.slice('select:'.length).split(',').map((s) => s.trim()).filter(Boolean);
      const found = allTools.filter((t) => names.includes(t.name));
      if (!found.length) {
        return (
          `No tools found matching: ${names.join(', ')}\n` +
          `Available tools (sample): ${allTools.slice(0, 10).map((t) => t.name).join(', ')}`
        );
      }
      const details = found.map((t) =>
        `**${t.name}**\n${t.description}\nParameters: ${JSON.stringify(t.parameters, null, 2)}`,
      ).join('\n\n---\n\n');
      return `Found ${found.length} tool(s):\n\n${details}`;
    }

    // ── 关键词搜索（加权评分）────────────────────────────────────────────────
    const q = query.toLowerCase();
    const scored = allTools.map((t) => {
      let score = 0;
      const name = t.name.toLowerCase();
      const desc = (t.description ?? '').toLowerCase();

      // 工具名评分
      if (name === q) score += 10;          // 精确匹配
      else if (name.includes(q)) score += 5; // 包含
      else if (q.split(/\s+/).some((w) => name.includes(w))) score += 3; // 词组拆解

      // 描述评分
      if (desc.includes(q)) score += 2;
      else if (q.split(/\s+/).some((w) => w.length > 2 && desc.includes(w))) score += 1;

      return { t, score };
    })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    if (!scored.length) {
      return (
        `No tools matched "${query}".\n` +
        `Try broader keywords, or list all tools with: select:*\n` +
        `Available tools (sample): ${allTools.slice(0, 15).map((t) => t.name).join(', ')}`
      );
    }

    const results = scored.map(({ t }) =>
      `- **${t.name}**: ${t.description?.slice(0, 120) ?? '(no description)'}`,
    ).join('\n');

    return (
      `Top ${scored.length} tool(s) matching "${query}":\n\n${results}\n\n` +
      `Use select:<tool_name> to get full schema details.`
    );
  },
};
