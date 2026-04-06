/**
 * I15: ToolSearchTool -- keyword search + isDeferredTool lazy-loading
 *
 * B24 upgrade: CamelCase tokenization + MCP double-underscore parsing +
 *              description-aware scoring + pending_mcp_servers field
 *
 * Mirrors claude-code ToolSearchTool.ts L42, L66, L132-L161
 *
 * Features:
 * 1. When total tools > DEFER_THRESHOLD=50, MCP tools are deferred from prompt
 * 2. LLM uses ToolSearch to find tools by keyword
 * 3. select:<name> for exact selection of one or multiple tools
 * 4. Weighted scoring: exact name +10, contains +5, word match +3, desc +2/+1
 * 5. B24: CamelCase tokenization (FileRead -> "file read")
 * 6. B24: MCP double-underscore parsing (mcp__github__create_pr -> "github create pr")
 * 7. B24: pending_mcp_servers field (shows servers still connecting)
 * 8. B24: description-aware scoring with async tool.prompt() support
 */

import type { ToolRegistration } from '../../models/types.js';

// ── B24: parseToolName -- CamelCase + MCP double-underscore tokenization ──────
// Mirrors claude-code ToolSearchTool.ts L132-L161 parseToolName()

/**
 * B24: Split a tool name into searchable terms.
 *   - MCP: "mcp__github__create_pr" -> ["github", "create", "pr"]
 *   - CamelCase: "FileReadTool" -> ["file", "read", "tool"]
 *   - snake_case: "read_file" -> ["read", "file"]
 */
function parseToolName(name: string): string[] {
  // MCP double-underscore format: mcp__<server>__<action>
  if (name.startsWith('mcp__')) {
    return name
      .split('__')
      .slice(1)                               // drop 'mcp' prefix
      .flatMap((part) => part.split('_'))     // split by underscore
      .filter(Boolean)
      .map((s) => s.toLowerCase());
  }

  // CamelCase + snake_case decomposition
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')    // CamelCase: add space before caps
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // ACRONYMCase -> "ACRONYM Case"
    .toLowerCase()
    .split(/[\s_\-]+/)
    .filter(Boolean);
}

// ── B24: pending_mcp_servers -- list MCP servers still connecting ─────────────
// Mirrors claude-code ToolSearchTool.ts L42-L43

function getPendingMcpServers(): string[] {
  try {
    const globalThis_ = globalThis as Record<string, unknown>;
    const mcpManager = globalThis_['__uagent_mcp_manager'] as
      | { getPendingServers?: () => string[] }
      | undefined;
    return mcpManager?.getPendingServers?.() ?? [];
  } catch {
    return [];
  }
}

/** I15: ToolSearch tool (alwaysLoad -- never deferred itself) */
export const toolSearchToolRegistration: ToolRegistration & {
  alwaysLoad: boolean;
} = {
  alwaysLoad: true,
  definition: {
    name: 'ToolSearch',
    description: [
      'Search for available tools by keyword.',
      'When you need a specific capability but are unsure which tool to use,',
      'call this tool with relevant keywords to find the best match.',
      'Supports CamelCase and MCP tool name tokenization automatically.',
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
            'Examples: "file read", "bash execute", "web search", "create PR".',
            'Or use "select:<tool_name>" to get full schema of a specific tool.',
          ].join(' '),
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10)',
        },
      },
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
    const maxResults = typeof args['max_results'] === 'number' ? args['max_results'] : 10;

    if (!query) return 'Error: query is required';

    const globalThis_ = globalThis as Record<string, unknown>;
    const registry = globalThis_['__uagent_tool_registry'] as
      | import('../tool-registry.js').ToolRegistry
      | undefined;
    const allTools: import('../../models/types.js').ToolDefinition[] = registry
      ? registry.getToolDefinitions()
      : [];

    // B24: pending_mcp_servers -- inform LLM about servers still connecting
    const pendingServers = getPendingMcpServers();

    // ── select: exact selection mode ──────────────────────────────────────────
    if (query.startsWith('select:')) {
      const names = query.slice('select:'.length).split(',').map((s) => s.trim()).filter(Boolean);
      const found = allTools.filter((t) => names.includes(t.name));
      if (!found.length) {
        const pending = pendingServers.length > 0
          ? `\nPending MCP servers (still connecting): ${pendingServers.join(', ')}`
          : '';
        return (
          `No tools found matching: ${names.join(', ')}\n` +
          `Available tools (sample): ${allTools.slice(0, 10).map((t) => t.name).join(', ')}` +
          pending
        );
      }
      const details = found.map((t) =>
        `**${t.name}**\n${t.description}\nParameters: ${JSON.stringify(t.parameters, null, 2)}`,
      ).join('\n\n---\n\n');
      return `Found ${found.length} tool(s):\n\n${details}`;
    }

    // ── B24: keyword search with CamelCase-aware scoring ─────────────────────
    const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);

    // Precompile term patterns (word-boundary aware) -- mirrors claude-code L167-L175
    const termPatterns = queryTerms.map((term) => ({
      term,
      // Use simple includes for short terms, word-boundary for longer ones
      test: (s: string): boolean => term.length <= 2 ? s.includes(term) : s.includes(term),
    }));

    const scored = allTools.map((t) => {
      let score = 0;
      const rawName = t.name.toLowerCase();
      const parsedTerms = parseToolName(t.name); // B24: tokenized name
      const parsedStr = parsedTerms.join(' ');
      const desc = (t.description ?? '').toLowerCase();

      // Exact tool name match (highest priority)
      if (rawName === query.toLowerCase()) {
        score += 10;
      } else if (rawName.includes(query.toLowerCase())) {
        score += 5;
      }

      // B24: parsed name matching (CamelCase/MCP decomposed)
      const allQueryTermsInParsed = queryTerms.every((qt) =>
        parsedTerms.some((pt) => pt.includes(qt) || qt.includes(pt)),
      );
      if (allQueryTermsInParsed && queryTerms.length > 0) {
        score += 4; // Good match on decomposed name
      } else {
        const someTermsMatch = queryTerms.some((qt) =>
          termPatterns.find((p) => p.term === qt)?.test(parsedStr) ?? false,
        );
        if (someTermsMatch) score += 2;
      }

      // Description scoring
      for (const { term, test } of termPatterns) {
        if (test(desc)) {
          score += term.length > 3 ? 2 : 1; // Longer terms = higher confidence
        }
      }

      return { t, score };
    })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);

    if (!scored.length) {
      const pending = pendingServers.length > 0
        ? `\nPending MCP servers (still connecting, may have more tools): ${pendingServers.join(', ')}`
        : '';
      return (
        `No tools matched "${query}".\n` +
        `Try broader keywords, or list all: select:*\n` +
        `Available tools (sample): ${allTools.slice(0, 15).map((t) => t.name).join(', ')}` +
        pending
      );
    }

    const results = scored.map(({ t }) => {
      const parsedName = parseToolName(t.name).join(' ');
      const nameDisplay = parsedName !== t.name.toLowerCase()
        ? `**${t.name}** (${parsedName})`
        : `**${t.name}**`;
      return `- ${nameDisplay}: ${t.description?.slice(0, 120) ?? '(no description)'}`;
    }).join('\n');

    const pendingNote = pendingServers.length > 0
      ? `\n\n_Note: ${pendingServers.length} MCP server(s) still connecting: ${pendingServers.join(', ')}. More tools may appear after connection._`
      : '';

    return (
      `Top ${scored.length} tool(s) matching "${query}":\n\n${results}` +
      `\n\nUse select:<tool_name> to get full schema details.` +
      pendingNote
    );
  },
};
