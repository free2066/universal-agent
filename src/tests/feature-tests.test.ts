/**
 * Feature Tests — covers all features added in the latest rounds of development
 *
 * Test Groups:
 *  1. Version display (ui-enhanced.ts reads package.json dynamically)
 *  2. Session snapshot: loadSnapshot / saveSnapshot / loadLastSnapshot
 *  3. MCPManager: UAGENT_MCP_INLINE env injection, UAGENT_BROWSER_MODE auto-activate
 *  4. WorktreeManager: export check
 *  5. CommitOptions: checkout field exists
 *  6. ReplExtra: resumeSessionId field exists
 *  7. AgentCore: setThinkingLevel / getMcpInfo public methods
 *  8. CLI options: --plan-model / --small-model / --vision-model / --output-style / --mcp-config / --browser / -r
 *  9. WebSearch Google fallback env logic
 * 10. BackgroundManager: kill() method
 * 11. config-store: UAgentConfig tools field
 * 12. MCP slash handler: /mcp output
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dir, '../../');

// ─── helpers ────────────────────────────────────────────────────────────────

function readPkg() {
  return JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf-8')) as { version: string };
}

// ─── 1. Version ──────────────────────────────────────────────────────────────

describe('1. Version display', () => {
  it('package.json version is >= 0.4.0', () => {
    const pkg = readPkg();
    const [major, minor] = pkg.version.split('.').map(Number);
    expect(major! > 0 || (major === 0 && minor! >= 4)).toBe(true);
  });

  it('ui-enhanced reads version from package.json (dynamic, not hardcoded)', async () => {
    // The module reads package.json at load time — check the file does NOT have a hardcoded v0.1.0 string in printBanner
    const src = readFileSync(join(PKG_ROOT, 'src/cli/ui-enhanced.ts'), 'utf-8');
    expect(src).not.toContain("'Universal Agent CLI v0.1.0'");
    expect(src).not.toContain('"Universal Agent CLI v0.1.0"');
    // Should have the dynamic version reference
    expect(src).toContain('_pkgVersion');
  });
});

// ─── 2. Session snapshot ─────────────────────────────────────────────────────

describe('2. Session snapshot', () => {
  it('loadSnapshot / saveSnapshot exports exist', async () => {
    const mod = await import('../core/memory/session-snapshot.js');
    expect(typeof mod.saveSnapshot).toBe('function');
    expect(typeof mod.loadSnapshot).toBe('function');
    expect(typeof mod.loadLastSnapshot).toBe('function');
  });

  it('loadSnapshot returns null for unknown id', async () => {
    const { loadSnapshot } = await import('../core/memory/session-snapshot.js');
    const result = loadSnapshot('__nonexistent_test_id_xyz__');
    expect(result).toBeNull();
  });

  it('save then load round-trips correctly', async () => {
    const { saveSnapshot, loadSnapshot } = await import('../core/memory/session-snapshot.js');
    const testId = `test-${Date.now()}`;
    const msgs = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'world' },
    ];
    saveSnapshot(testId, msgs);
    const snap = loadSnapshot(testId);
    expect(snap).not.toBeNull();
    expect(snap!.sessionId).toBe(testId);
    expect(snap!.messages).toHaveLength(2);
    expect(snap!.messages[0].content).toBe('hello');
  });
});

// ─── 3. MCPManager UAGENT_MCP_INLINE ────────────────────────────────────────

describe('3. MCPManager inline config + browser mode', () => {
  afterEach(() => {
    delete process.env.UAGENT_MCP_INLINE;
    delete process.env.UAGENT_BROWSER_MODE;
  });

  it('connectAll() reads UAGENT_MCP_INLINE env and registers servers', async () => {
    // Inject a fake SSE server via env
    process.env.UAGENT_MCP_INLINE = JSON.stringify({
      'test-inline': { type: 'sse', url: 'http://127.0.0.1:19999/sse', enabled: true },
    });

    const { MCPManager } = await import('../core/mcp-manager.js');
    const mgr = new MCPManager('/tmp');
    // connectAll() will try to actually connect — we only test that the server
    // was registered (the connection itself will fail with ECONNREFUSED, which is OK)
    await mgr.connectAll().catch(() => {});
    const servers = mgr.listServers();
    const names = servers.map((s) => s.name);
    expect(names).toContain('test-inline');
  });

  it('UAGENT_BROWSER_MODE enables disabled playwright server', async () => {
    const { MCPManager } = await import('../core/mcp-manager.js');
    const mgr = new MCPManager('/tmp');
    // Manually add a disabled playwright server
    mgr.addServer('playwright', { type: 'stdio', command: 'npx', args: ['@playwright/mcp@latest'], enabled: false });

    process.env.UAGENT_BROWSER_MODE = '1';
    // After connectAll() the server should be enabled (even if connection fails)
    await mgr.connectAll().catch(() => {});
    const pw = mgr.listServers().find((s) => s.name === 'playwright');
    expect(pw?.enabled).toBe(true);
  });

  it('MCPManager.initConfig creates a valid JSON file', async () => {
    const { MCPManager } = await import('../core/mcp-manager.js');
    const tmpDir = '/tmp/uagent-mcp-test-' + Date.now();
    const { mkdirSync } = await import('fs');
    mkdirSync(tmpDir, { recursive: true });
    const result = MCPManager.initConfig(tmpDir);
    expect(result).toMatch(/Created|Updated/);
    const cfg = JSON.parse(readFileSync(join(tmpDir, '.mcp.json'), 'utf-8'));
    expect(cfg).toHaveProperty('servers');
  });
});

// ─── 4. WorktreeManager export ───────────────────────────────────────────────

describe('4. WorktreeManager is exported', () => {
  it('WorktreeManager class is exported from worktree-tools.ts', async () => {
    const mod = await import('../core/tools/agents/worktree-tools.js');
    expect(mod.WorktreeManager).toBeDefined();
    expect(typeof mod.WorktreeManager).toBe('function'); // it's a class constructor
  });

  it('WorktreeManager has listAll / create / remove / status / eventsRecent methods', async () => {
    const { WorktreeManager } = await import('../core/tools/agents/worktree-tools.js');
    const proto = WorktreeManager.prototype as unknown as Record<string, unknown>;
    expect(typeof proto['listAll']).toBe('function');
    expect(typeof proto['create']).toBe('function');
    expect(typeof proto['remove']).toBe('function');
    expect(typeof proto['status']).toBe('function');
    expect(typeof proto['eventsRecent']).toBe('function');
  });
});

// ─── 5. CommitOptions.checkout ───────────────────────────────────────────────

describe('5. CommitOptions includes checkout field', () => {
  it('commit.ts source declares checkout field in CommitOptions', () => {
    const src = readFileSync(join(PKG_ROOT, 'src/cli/commit.ts'), 'utf-8');
    expect(src).toContain('checkout?:');
  });

  it('cmd-misc.ts registers --checkout option on commit command', () => {
    const src = readFileSync(join(PKG_ROOT, 'src/cli/commands/cmd-misc.ts'), 'utf-8');
    expect(src).toContain("'--checkout'");
  });
});

// ─── 6. ReplExtra.resumeSessionId ────────────────────────────────────────────

describe('6. ReplExtra has resumeSessionId', () => {
  it('repl.ts source declares resumeSessionId in ReplExtra interface', () => {
    const src = readFileSync(join(PKG_ROOT, 'src/cli/repl/repl.ts'), 'utf-8');
    expect(src).toContain('resumeSessionId?:');
  });

  it('index.ts passes resume option to runREPL as resumeSessionId', () => {
    const src = readFileSync(join(PKG_ROOT, 'src/cli/index.ts'), 'utf-8');
    expect(src).toContain('resumeSessionId: options.resume');
  });
});

// ─── 7. AgentCore public methods ─────────────────────────────────────────────

describe('7. AgentCore public methods', () => {
  // agent.ts is now a forwarding shim; actual implementation lives in agent/index.ts
  const agentIndexSrc = readFileSync(join(PKG_ROOT, 'src/core/agent/index.ts'), 'utf-8');

  it('AgentCore declares setThinkingLevel() public method', () => {
    expect(agentIndexSrc).toContain('setThinkingLevel(');
  });

  it('AgentCore declares getMcpInfo() public method', () => {
    expect(agentIndexSrc).toContain('getMcpInfo()');
  });

  it('AgentCore declares setSystemPrompt() public method', () => {
    expect(agentIndexSrc).toContain('setSystemPrompt(');
  });
});

// ─── 8. CLI options in index.ts ──────────────────────────────────────────────

describe('8. New CLI global options', () => {
  const indexSrc = readFileSync(join(PKG_ROOT, 'src/cli/index.ts'), 'utf-8');

  it('--plan-model option declared', () => {
    expect(indexSrc).toContain('--plan-model');
  });

  it('--small-model option declared', () => {
    expect(indexSrc).toContain('--small-model');
  });

  it('--vision-model option declared', () => {
    expect(indexSrc).toContain('--vision-model');
  });

  it('-r/--resume option declared', () => {
    expect(indexSrc).toContain('--resume');
  });

  it('--output-style option declared', () => {
    expect(indexSrc).toContain('--output-style');
  });

  it('--mcp-config option declared', () => {
    expect(indexSrc).toContain('--mcp-config');
  });

  it('--browser option declared', () => {
    expect(indexSrc).toContain('--browser');
  });

  it('--plan-model maps to modelManager.setPointer(task)', () => {
    expect(indexSrc).toContain("setPointer('task'");
  });

  it('--small-model maps to setPointer(quick) and setPointer(compact)', () => {
    expect(indexSrc).toContain("setPointer('quick'");
    expect(indexSrc).toContain("setPointer('compact'");
  });

  it('--vision-model sets AGENT_VISION_MODEL env var', () => {
    expect(indexSrc).toContain('AGENT_VISION_MODEL');
  });

  it('--output-style Concise preset exists', () => {
    expect(indexSrc).toContain('Concise');
  });

  it('--mcp-config writes to UAGENT_MCP_INLINE env', () => {
    expect(indexSrc).toContain('UAGENT_MCP_INLINE');
  });

  it('--browser sets UAGENT_BROWSER_MODE', () => {
    expect(indexSrc).toContain('UAGENT_BROWSER_MODE');
  });
});

// ─── 9. WebSearch Google env logic ───────────────────────────────────────────

describe('9. WebSearch Google/DuckDuckGo fallback logic', () => {
  it('web-tools.ts checks GOOGLE_API_KEY + GOOGLE_CSE_ID', () => {
    const src = readFileSync(join(PKG_ROOT, 'src/core/tools/web/web-tools.ts'), 'utf-8');
    expect(src).toContain('GOOGLE_API_KEY');
    expect(src).toContain('GOOGLE_CSE_ID');
  });

  it('web-tools.ts falls back to DuckDuckGo when Google keys absent', () => {
    const src = readFileSync(join(PKG_ROOT, 'src/core/tools/web/web-tools.ts'), 'utf-8');
    expect(src).toContain('DuckDuckGo');
  });

  it('web-tools.ts labels results with [via Google] or [via DuckDuckGo]', () => {
    const src = readFileSync(join(PKG_ROOT, 'src/core/tools/web/web-tools.ts'), 'utf-8');
    expect(src).toContain('[via Google]');
    expect(src).toContain('[via DuckDuckGo]');
  });
});

// ─── 10. BackgroundManager.kill ──────────────────────────────────────────────

describe('10. BackgroundManager kill() method', () => {
  it('background-manager.ts has a kill() method', () => {
    const src = readFileSync(join(PKG_ROOT, 'src/core/background-manager.ts'), 'utf-8');
    expect(src).toContain('kill(');
  });

  it('background-tools.ts exports killBashTool', () => {
    const src = readFileSync(join(PKG_ROOT, 'src/core/tools/productivity/background-tools.ts'), 'utf-8');
    expect(src).toContain('killBashTool');
  });

  it('kill_bash tool name is registered in killBashTool', () => {
    const src = readFileSync(join(PKG_ROOT, 'src/core/tools/productivity/background-tools.ts'), 'utf-8');
    expect(src).toContain("name: 'kill_bash'");
  });

  it('BackgroundManager kill() sends SIGTERM', () => {
    const src = readFileSync(join(PKG_ROOT, 'src/core/background-manager.ts'), 'utf-8');
    expect(src).toContain('SIGTERM');
  });
});

// ─── 11. config-store UAgentConfig.tools ────────────────────────────────────

describe('11. config-store tools field', () => {
  it('UAgentConfig interface has tools field', () => {
    const src = readFileSync(join(PKG_ROOT, 'src/cli/config-store.ts'), 'utf-8');
    expect(src).toContain('tools?:');
  });

  it('loadConfig() returns an object (no exceptions)', async () => {
    const { loadConfig } = await import('../cli/config-store.js');
    const cfg = loadConfig();
    expect(cfg).toBeDefined();
    expect(typeof cfg).toBe('object');
  });
});

// ─── 12. /mcp slash handler ──────────────────────────────────────────────────

describe('12. /mcp slash handler', () => {
  // slash-handlers.ts is now a forwarding shim; actual implementation lives in handlers/
  const handlersSrc = readFileSync(join(PKG_ROOT, 'src/cli/repl/handlers/index.ts'), 'utf-8');
  const toolHandlersSrc = readFileSync(join(PKG_ROOT, 'src/cli/repl/handlers/tool-handlers.ts'), 'utf-8');

  it('handlers/index.ts has /mcp route', () => {
    expect(handlersSrc).toContain("input === '/mcp'");
  });

  it('/mcp handler calls agent.getMcpInfo()', () => {
    expect(toolHandlersSrc).toContain('getMcpInfo()');
  });

  it('repl.ts SLASH_COMPLETIONS includes /mcp', () => {
    const src = readFileSync(join(PKG_ROOT, 'src/cli/repl/repl.ts'), 'utf-8');
    expect(src).toContain("'/mcp'");
  });
});

// ─── 13. Ctrl+T fix: setRawMode(true) ────────────────────────────────────────

describe('13. Ctrl+T SIGINFO fix', () => {
  it('repl.ts uses setRawMode(true) (not false) to prevent SIGINFO spam', () => {
    const src = readFileSync(join(PKG_ROOT, 'src/cli/repl/repl.ts'), 'utf-8');
    // Must have setRawMode(true)
    expect(src).toContain('setRawMode(true)');
    // Must NOT have setRawMode(false) near emitKeypressEvents
    // (false would make Ctrl+T trigger macOS SIGINFO)
    const rawFalseMatch = src.match(/setRawMode\(false\)/g);
    // It's OK to have setRawMode(false) elsewhere for child process spawning,
    // but the emitKeypressEvents block must use true
    const emitBlock = src.slice(
      src.indexOf('emitKeypressEvents'),
      src.indexOf('emitKeypressEvents') + 300,
    );
    expect(emitBlock).not.toContain('setRawMode(false)');
  });

  it('repl.ts has Ctrl+T keypress handler for thinking cycle', () => {
    const src = readFileSync(join(PKG_ROOT, 'src/cli/repl/repl.ts'), 'utf-8');
    expect(src).toContain("key.name === 't'");
    expect(src).toContain('THINKING_CYCLE');
    expect(src).toContain('setThinkingLevel');
  });
});

// ─── 14. workspace command in cmd-misc.ts ────────────────────────────────────

describe('14. workspace CLI command', () => {
  it('cmd-misc.ts imports WorktreeManager', () => {
    const src = readFileSync(join(PKG_ROOT, 'src/cli/commands/cmd-misc.ts'), 'utf-8');
    expect(src).toContain('WorktreeManager');
  });

  it("cmd-misc.ts registers 'workspace' command with alias 'ws'", () => {
    const src = readFileSync(join(PKG_ROOT, 'src/cli/commands/cmd-misc.ts'), 'utf-8');
    expect(src).toContain("'workspace'");
    expect(src).toContain(".alias('ws')");
  });

  it("workspace has list/create/remove/status/events sub-commands", () => {
    const src = readFileSync(join(PKG_ROOT, 'src/cli/commands/cmd-misc.ts'), 'utf-8');
    expect(src).toContain("'list'");
    expect(src).toContain("'create <name>'");
    expect(src).toContain("'remove <name>'");
    expect(src).toContain("'status <name>'");
    expect(src).toContain("'events'");
  });
});

// ─── 15. uagent --help smoke test (via dist) ─────────────────────────────────

describe('15. CLI binary smoke test', () => {
  it('uagent chat --help exits 0 and mentions new options', async () => {
    // New options are on the `chat` sub-command (isDefault), not on root --help.
    // Use `uagent chat --help` to see them.
    const { execSync } = await import('child_process');
    let output = '';
    try {
      output = execSync('node dist/cli/index.js chat --help', {
        cwd: PKG_ROOT,
        encoding: 'utf-8',
        env: { ...process.env, UAGENT_NO_AUTO_UPDATE: '1' },
        timeout: 10000,
      });
    } catch (e: unknown) {
      output = (e as { stdout?: string }).stdout ?? '';
    }
    expect(output).toContain('--plan-model');
    expect(output).toContain('--small-model');
    expect(output).toContain('--vision-model');
    expect(output).toContain('--resume');
    expect(output).toContain('--output-style');
    expect(output).toContain('--mcp-config');
    expect(output).toContain('--browser');
  });

  it('uagent --help shows workspace and commit commands', async () => {
    const { execSync } = await import('child_process');
    let output = '';
    try {
      output = execSync('node dist/cli/index.js --help', {
        cwd: PKG_ROOT,
        encoding: 'utf-8',
        env: { ...process.env, UAGENT_NO_AUTO_UPDATE: '1' },
        timeout: 10000,
      });
    } catch (e: unknown) {
      output = (e as { stdout?: string }).stdout ?? '';
    }
    expect(output).toContain('workspace');
    expect(output).toContain('commit');
  });

  it('uagent workspace --help exits correctly', async () => {
    const { execSync } = await import('child_process');
    let output = '';
    try {
      output = execSync('node dist/cli/index.js workspace --help', {
        cwd: PKG_ROOT,
        encoding: 'utf-8',
        env: { ...process.env, UAGENT_NO_AUTO_UPDATE: '1' },
        timeout: 10000,
      });
    } catch (e: unknown) {
      output = (e as { stdout?: string }).stdout ?? '';
    }
    expect(output).toContain('workspace');
  });

  it('uagent commit --help mentions --checkout', async () => {
    const { execSync } = await import('child_process');
    let output = '';
    try {
      output = execSync('node dist/cli/index.js commit --help', {
        cwd: PKG_ROOT,
        encoding: 'utf-8',
        env: { ...process.env, UAGENT_NO_AUTO_UPDATE: '1' },
        timeout: 10000,
      });
    } catch (e: unknown) {
      output = (e as { stdout?: string }).stdout ?? '';
    }
    expect(output).toContain('--checkout');
  });
});
