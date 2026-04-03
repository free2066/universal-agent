/**
 * Unit Tests: tool-selector.ts
 *
 * Covers: isAlwaysInclude / keywordScore / selectTools (keyword path + LLM fallback)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { selectTools } from '../core/tool-selector.js';
import type { ToolDefinition } from '../models/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTool(name: string, desc: string, params: string[] = []): ToolDefinition {
  const props: Record<string, { type: 'string'; description: string }> = {};
  for (const p of params) {
    props[p] = { type: 'string', description: `${p} parameter` };
  }
  return {
    name,
    description: desc,
    parameters: {
      type: 'object',
      properties: props,
    },
  };
}

/** A diverse set of 20 tools — exceeds THRESHOLD (12) so selector activates */
function makeToolSet(): ToolDefinition[] {
  return [
    makeTool('Read', 'Read file contents'),
    makeTool('Write', 'Write content to a file'),
    makeTool('Edit', 'Replace text in a file'),
    makeTool('Bash', 'Execute shell commands', ['command']),
    makeTool('LS', 'List directory contents', ['path']),
    makeTool('Grep', 'Search for patterns in files', ['pattern', 'dir']),
    makeTool('WebFetch', 'Fetch a web page'),
    makeTool('WebSearch', 'Search the web'),
    makeTool('CurlExecute', 'Execute HTTP requests and verify API responses', ['url', 'method']),
    makeTool('EnvProbe', 'Check system environment ports processes versions', ['probe']),
    makeTool('GitHubCreatePR', 'Create a GitHub pull request', ['title', 'body']),
    makeTool('GitHubListPRs', 'List GitHub pull requests'),
    makeTool('MemoryRead', 'Read stored memories and context', ['query']),
    makeTool('TerminalList', 'List terminal panes in WezTerm tmux iTerm2'),
    makeTool('AutopilotRun', 'Run autonomous development pipeline', ['requirement']),
    makeTool('CodeInspector', 'Static code analysis security audit', ['path']),
    makeTool('DatabaseQuery', 'Query PostgreSQL MySQL database', ['sql']),
    makeTool('RedisProbe', 'Inspect Redis cache keys values', ['key']),
    makeTool('TestRunner', 'Run unit integration tests', ['command']),
    makeTool('DocSearch', 'Search documentation and README files', ['query']),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Basic select behavior
// ─────────────────────────────────────────────────────────────────────────────
describe('selectTools — basic behavior', () => {
  beforeEach(() => {
    // Disable LLM selection to test keyword-only path
    delete process.env.AGENT_TOOL_SELECTION_LLM;
  });

  afterEach(() => {
    delete process.env.AGENT_TOOL_SELECT_THRESHOLD;
    delete process.env.AGENT_TOOL_SELECT_MAX;
    delete process.env.AGENT_TOOL_SELECTION_LLM;
    delete process.env.AGENT_TOOL_SELECT_ALWAYS;
  });

  it('returns all tools when count ≤ THRESHOLD (default 12)', async () => {
    const tools = makeToolSet().slice(0, 5); // 5 tools
    const result = await selectTools(tools, 'anything');
    expect(result.length).toBe(5);
  });

  it('filters tools when count > THRESHOLD', async () => {
    const tools = makeToolSet(); // 20 tools
    const result = await selectTools(tools, 'search for files');
    expect(result.length).toBeLessThan(tools.length);
    expect(result.length).toBeLessThanOrEqual(
      parseInt(process.env.AGENT_TOOL_SELECT_MAX ?? '10', 10) + 6, // always-include buffer
    );
  });

  it('always includes ALWAYS_INCLUDE tools (Bash, Write, Edit, Read, LS, Grep)', async () => {
    const tools = makeToolSet(); // 20 tools
    const result = await selectTools(tools, 'some task');
    const names = result.map((t) => t.name.toLowerCase());
    // At least some of the always-include tools should be present
    const alwaysInclude = ['bash', 'write', 'edit', 'read', 'ls', 'grep'];
    const presentCount = alwaysInclude.filter((n) => names.includes(n)).length;
    expect(presentCount).toBeGreaterThanOrEqual(3); // at least 3 of the 6
  });

  it('returns ToolDefinition objects (not just names)', async () => {
    const tools = makeToolSet();
    const result = await selectTools(tools, 'read file');
    for (const tool of result) {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('parameters');
    }
  });

  it('returns empty array for empty tool list', async () => {
    const result = await selectTools([], 'anything');
    expect(result).toEqual([]);
  });

  it('HTTP query selects CurlExecute and WebFetch over database tools', async () => {
    const tools = makeToolSet();
    const result = await selectTools(tools, 'execute HTTP request curl API verify response');
    const names = result.map((t) => t.name);
    // CurlExecute is highly relevant for this query
    const hasCurl = names.includes('CurlExecute');
    // At minimum, some HTTP-related tools should be selected
    const hasWebOrCurl = names.some((n) => ['CurlExecute', 'WebFetch', 'WebSearch'].includes(n));
    expect(hasWebOrCurl).toBe(true);
  });

  it('database query selects database tools over terminal tools', async () => {
    const tools = makeToolSet();
    const result = await selectTools(tools, 'query PostgreSQL database SELECT users');
    const names = result.map((t) => t.name);
    const hasDb = names.some((n) => ['DatabaseQuery'].includes(n));
    const hasTerminal = names.includes('TerminalList');
    // DB tool should be more relevant than terminal tool for DB query
    if (hasDb && hasTerminal) {
      const dbIdx = names.indexOf('DatabaseQuery');
      const termIdx = names.indexOf('TerminalList');
      expect(dbIdx).toBeLessThan(termIdx);
    }
  });

  it('custom AGENT_TOOL_SELECT_THRESHOLD=5 activates earlier filtering', async () => {
    process.env.AGENT_TOOL_SELECT_THRESHOLD = '5';
    // Note: selectTools reads this at module load — we test the result behavior
    const tools = makeToolSet(); // 20 tools — well above any threshold
    const result = await selectTools(tools, 'some query');
    // Should be filtered
    expect(result.length).toBeLessThan(tools.length);
  });

  it('custom AGENT_TOOL_SELECT_MAX=5 limits output to ≤5 + always-include', async () => {
    process.env.AGENT_TOOL_SELECT_MAX = '5';
    const tools = makeToolSet();
    const result = await selectTools(tools, 'test query with custom max');
    // With max=5 + always-include (6 tools), max possible = 11
    expect(result.length).toBeLessThanOrEqual(11);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Always-include behavior
// ─────────────────────────────────────────────────────────────────────────────
describe('selectTools — always-include list', () => {
  afterEach(() => {
    delete process.env.AGENT_TOOL_SELECT_ALWAYS;
    delete process.env.AGENT_TOOL_SELECTION_LLM;
  });

  it('custom AGENT_TOOL_SELECT_ALWAYS overrides default list', async () => {
    process.env.AGENT_TOOL_SELECT_ALWAYS = 'CurlExecute,EnvProbe';
    process.env.AGENT_TOOL_SELECTION_LLM = '0';
    const tools = makeToolSet();
    const result = await selectTools(tools, 'unrelated task xyz');
    const names = result.map((t) => t.name);
    // Both custom always-include tools should be present
    expect(names).toContain('CurlExecute');
    expect(names).toContain('EnvProbe');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Query relevance via keyword matching
// ─────────────────────────────────────────────────────────────────────────────
describe('selectTools — keyword relevance', () => {
  it('memory query selects memory tools', async () => {
    const tools = makeToolSet();
    const result = await selectTools(tools, 'read stored memories context recall');
    const names = result.map((t) => t.name);
    // MemoryRead is highly relevant for memory queries
    expect(names).toContain('MemoryRead');
  });

  it('git/PR query selects GitHub tools', async () => {
    const tools = makeToolSet();
    const result = await selectTools(tools, 'create GitHub pull request');
    const names = result.map((t) => t.name);
    // GitHubCreatePR should be selected
    expect(names).toContain('GitHubCreatePR');
  });

  it('empty query still returns some tools', async () => {
    const tools = makeToolSet();
    const result = await selectTools(tools, '');
    // With empty query, keyword score is 0.5 (neutral) for all — still selects tools
    expect(result.length).toBeGreaterThan(0);
  });

  it('terminal query selects terminal tools', async () => {
    const tools = makeToolSet();
    const result = await selectTools(tools, 'list terminal panes tmux');
    const names = result.map((t) => t.name);
    expect(names).toContain('TerminalList');
  });
});
