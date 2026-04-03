#!/usr/bin/env node
/**
 * smoke-test.mjs — Runtime integration smoke test for universal-agent
 *
 * Tests that all newly implemented tools can:
 *   1. Import successfully (no missing exports, no path errors)
 *   2. Initialize without crashing (constructor / handler dry-run)
 *   3. Handle error conditions gracefully (not throw unhandled exceptions)
 *
 * Usage:
 *   node scripts/smoke-test.mjs
 *   node scripts/smoke-test.mjs --verbose
 *
 * Exit code: 0 = all pass, 1 = at least one failure
 */

const VERBOSE = process.argv.includes('--verbose');
const results = [];

function pass(name, detail = '') {
  results.push({ ok: true, name, detail });
  console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`);
}

function fail(name, err) {
  results.push({ ok: false, name, err: String(err) });
  console.error(`  ❌ ${name} — ${err}`);
}

async function test(name, fn) {
  try {
    const detail = await fn();
    pass(name, detail ?? '');
  } catch (err) {
    fail(name, err.message ?? String(err));
  }
}

// ── 0. Build check ─────────────────────────────────────────────────────────────
console.log('\n▶ Section 0: Build artifact exists');
await test('dist/cli/index.js exists', async () => {
  const { existsSync } = await import('fs');
  if (!existsSync('./dist/cli/index.js')) throw new Error('Build artifact missing — run npm run build first');
  return 'OK';
});

// ── 1. Tool imports ────────────────────────────────────────────────────────────
console.log('\n▶ Section 1: Tool imports');

await test('autopilotRunTool import', async () => {
  const { autopilotRunTool } = await import('../dist/core/tools/agents/autopilot-tool.js');
  if (!autopilotRunTool?.definition?.name) throw new Error('Missing definition.name');
  return autopilotRunTool.definition.name;
});

await test('githubCreatePRTool import', async () => {
  const { githubCreatePRTool } = await import('../dist/core/tools/productivity/github-pr-tool.js');
  return githubCreatePRTool.definition.name;
});

await test('githubListPRsTool import', async () => {
  const { githubListPRsTool } = await import('../dist/core/tools/productivity/github-pr-tool.js');
  return githubListPRsTool.definition.name;
});

await test('terminalListTool import', async () => {
  const { terminalListTool } = await import('../dist/core/tools/productivity/terminal-ipc-tool.js');
  return terminalListTool.definition.name;
});

await test('terminalExecTool import', async () => {
  const { terminalExecTool } = await import('../dist/core/tools/productivity/terminal-ipc-tool.js');
  return terminalExecTool.definition.name;
});

await test('curlExecuteTool import', async () => {
  const { curlExecuteTool } = await import('../dist/core/tools/productivity/curl-tool.js');
  return curlExecuteTool.definition.name;
});

// ── 2. AgentCore init ─────────────────────────────────────────────────────────
console.log('\n▶ Section 2: AgentCore initialization');

await test('AgentCore init with domain=dev', async () => {
  const { AgentCore } = await import('../dist/core/agent.js');
  new AgentCore({ domain: 'dev', model: 'main', stream: false, verbose: false });
  return 'tool registry loaded';
});

// ── 3. Tool handler smoke runs ────────────────────────────────────────────────
console.log('\n▶ Section 3: Tool handler smoke runs');

await test('TerminalList — no backend graceful error', async () => {
  // Remove any backend override
  delete process.env.TERMINAL_IPC_BACKEND;
  const { terminalListTool } = await import('../dist/core/tools/productivity/terminal-ipc-tool.js');
  const result = await terminalListTool.handler({});
  if (typeof result !== 'string') throw new Error('Handler returned non-string');
  // Should either list panes OR return a friendly error message
  return result.includes('No terminal') || result.includes('Pane') ? 'returns friendly message' : result.slice(0, 60);
});

await test('TerminalList — invalid backend env graceful error', async () => {
  process.env.TERMINAL_IPC_BACKEND = 'tmux';
  const mod = await import('../dist/core/tools/productivity/terminal-ipc-tool.js?cachebust=' + Date.now());
  const result = await mod.terminalListTool.handler({});
  delete process.env.TERMINAL_IPC_BACKEND;
  // Should fail gracefully (tmux not installed = known error, not crash)
  if (typeof result !== 'string') throw new Error('Handler threw instead of returning string');
  return 'graceful error: ' + result.slice(0, 50);
});

await test('CurlExecute — real HTTP GET', async () => {
  const { curlExecuteTool } = await import('../dist/core/tools/productivity/curl-tool.js');
  const result = await curlExecuteTool.handler({
    url: 'https://httpbin.org/get',
    method: 'GET',
    timeout_ms: 8000,
  });
  if (!result.includes('200') && !result.includes('httpbin')) {
    throw new Error('Unexpected response: ' + result.slice(0, 100));
  }
  return 'HTTP 200 OK';
});

await test('GitHubListPRs — no token (graceful)', async () => {
  const savedToken = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  const { githubListPRsTool } = await import('../dist/core/tools/productivity/github-pr-tool.js');
  // Without token and with HTTPS remote that has token embedded, may still succeed
  // Just check it returns a string (not throws)
  const result = await githubListPRsTool.handler({ state: 'open' });
  if (savedToken) process.env.GITHUB_TOKEN = savedToken;
  if (typeof result !== 'string') throw new Error('Must return string');
  return result.slice(0, 60);
});

// ── 4. Memory subsystem ────────────────────────────────────────────────────────
console.log('\n▶ Section 4: Memory subsystem');

await test('MemoryStore add/get/list', async () => {
  const { MemoryStore } = await import('../dist/core/memory/memory-store.js');
  const store = new MemoryStore('/tmp/uagent-smoke-test');
  store.clear(); // start fresh

  const id = store.add({
    type: 'fact',
    content: 'JWT auth uses RS256',
    tags: ['auth', 'jwt'],
    source: 'user',
  });

  const item = store.get(id);
  if (!item) throw new Error('get() returned undefined after add()');
  if (item.content !== 'JWT auth uses RS256') throw new Error('Content mismatch');

  const list = store.list();
  if (list.length === 0) throw new Error('list() is empty after add()');

  return `add/get/list OK (${list.length} items)`;
});

await test('MemoryStore recall — returns MemoryItem[]', async () => {
  const { MemoryStore } = await import('../dist/core/memory/memory-store.js');
  const store = new MemoryStore('/tmp/uagent-smoke-test');

  store.add({ type: 'fact', content: 'JWT auth uses RS256 signing', tags: ['auth', 'jwt'], source: 'user' });
  store.add({ type: 'fact', content: 'Database uses PostgreSQL 15', tags: ['db', 'postgres'], source: 'agent' });

  const results = await store.recall('JWT authentication');
  if (!Array.isArray(results)) throw new Error('recall() must return array');

  // Each element should be a MemoryItem (has content field)
  for (const r of results) {
    if (typeof r.content !== 'string') {
      throw new Error(`recall() returned item without content field: ${JSON.stringify(Object.keys(r))}`);
    }
  }

  return `recall OK — ${results.length} items, first: "${results[0]?.content?.slice(0, 30)}"`;
});

// ── 5. Autopilot state machine ────────────────────────────────────────────────
console.log('\n▶ Section 5: Autopilot state machine (unit)');

await test('AutopilotRun tool handler — resume with no active session', async () => {
  const { autopilotRunTool } = await import('../dist/core/tools/agents/autopilot-tool.js');
  // Calling with empty requirement and no active session should return a friendly message
  const result = await autopilotRunTool.handler({
    requirement: '',
    project_root: '/tmp/uagent-smoke-autopilot',
  });
  if (typeof result !== 'string') throw new Error('Must return string');
  if (!result.includes('No active') && !result.includes('session') && !result.includes('❌')) {
    // Might have started a new pipeline — check it contains something meaningful
    if (result.length < 10) throw new Error('Too short response: ' + result);
  }
  return result.slice(0, 80);
});

// ── Summary ────────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(60));
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;

console.log(`\n📊 Results: ${passed} passed, ${failed} failed (${results.length} total)\n`);

if (failed > 0) {
  console.log('Failed tests:');
  for (const r of results.filter((r) => !r.ok)) {
    console.error(`  ❌ ${r.name}\n     ${r.err}`);
  }
  process.exit(1);
} else {
  console.log('✅ All smoke tests passed!\n');
  process.exit(0);
}
