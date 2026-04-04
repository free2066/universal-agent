/**
 * v0.4.0 — Slash command handler tests
 *
 * Tests all new slash commands added in v0.4.0 via mock SlashContext.
 * Verifies: return value (true = handled), console output, and agent/rl calls.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { handleSlash, type SlashContext } from '../../src/cli/repl/slash-handlers.js';

// ── Minimal mock factory ──────────────────────────────────────────────────────
function makeCtx(overrides: Partial<SlashContext> = {}): SlashContext & {
  _output: string[];
  _prompts: number;
} {
  const output: string[] = [];
  const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
    output.push(args.map(String).join(' '));
  });

  const rl = {
    prompt: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    setPrompt: vi.fn(),
  } as unknown as SlashContext['rl'];

  const agent = {
    getHistory: vi.fn().mockReturnValue([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]),
    setHistory: vi.fn(),
    runStream: vi.fn().mockResolvedValue(undefined),
    injectContext: vi.fn(),
    clearHistory: vi.fn(),
  } as unknown as SlashContext['agent'];

  const sessionLogger = {
    path: '/tmp/uagent-test-session.log',
    log: vi.fn(),
  } as unknown as SlashContext['sessionLogger'];

  const hookRunner = {
    handleSlashCmd: vi.fn().mockResolvedValue({ handled: false, output: '' }),
  } as unknown as SlashContext['hookRunner'];

  const ctx: SlashContext = {
    agent,
    rl,
    hookRunner,
    sessionLogger,
    options: { domain: 'test', verbose: false },
    SESSION_ID: 'test-session-abc123',
    getModelDisplayName: (id: string) => id,
    makePrompt: (domain: string) => `[${domain}] > `,
    loadLastSnapshot: vi.fn().mockReturnValue(null),
    saveSnapshot: vi.fn(),
    formatAge: (ts: number) => `${Math.floor((Date.now() - ts) / 1000)}s ago`,
    inferProviderEnvKey: vi.fn().mockReturnValue(undefined),
    ...overrides,
  };

  return Object.assign(ctx, {
    _output: output,
    _prompts: 0,
    get _rlPromptCalls() { return (rl.prompt as Mock).mock.calls.length; },
  });
}

// ── /context ──────────────────────────────────────────────────────────────────
describe('/context', () => {
  it('returns true (handled)', async () => {
    const ctx = makeCtx();
    const result = await handleSlash('/context', ctx);
    expect(result).toBe(true);
  });

  it('prints context window stats', async () => {
    const ctx = makeCtx();
    await handleSlash('/context', ctx);
    const joined = ctx._output.join('\n');
    expect(joined).toMatch(/Context/i);
  });

  it('calls rl.prompt()', async () => {
    const ctx = makeCtx();
    await handleSlash('/context', ctx);
    expect((ctx.rl.prompt as Mock).mock.calls.length).toBeGreaterThan(0);
  });
});

// ── /status ───────────────────────────────────────────────────────────────────
describe('/status', () => {
  it('returns true (handled)', async () => {
    const ctx = makeCtx();
    expect(await handleSlash('/status', ctx)).toBe(true);
  });

  it('prints session ID in output', async () => {
    const ctx = makeCtx();
    await handleSlash('/status', ctx);
    const joined = ctx._output.join('\n');
    expect(joined).toMatch(/test-session-abc123/);
  });

  it('prints CWD in output', async () => {
    const ctx = makeCtx();
    await handleSlash('/status', ctx);
    const joined = ctx._output.join('\n');
    expect(joined).toMatch(/CWD|cwd|working/i);
  });

  it('prints log path in output', async () => {
    const ctx = makeCtx();
    await handleSlash('/status', ctx);
    const joined = ctx._output.join('\n');
    expect(joined).toMatch(/uagent-test-session\.log/);
  });
});

// ── /copy ─────────────────────────────────────────────────────────────────────
describe('/copy', () => {
  it('returns true (handled)', async () => {
    const ctx = makeCtx();
    expect(await handleSlash('/copy', ctx)).toBe(true);
  });

  it('handles gracefully when no assistant history', async () => {
    const ctx = makeCtx({
      agent: {
        getHistory: vi.fn().mockReturnValue([{ role: 'user', content: 'hello' }]),
      } as unknown as SlashContext['agent'],
    });
    const result = await handleSlash('/copy', ctx);
    expect(result).toBe(true);
    // Should say "no reply" or similar
    const joined = ctx._output.join('\n');
    expect(joined).toMatch(/no|yet/i);
  });

  it('attempts clipboard copy when assistant message exists', async () => {
    const ctx = makeCtx({
      agent: {
        getHistory: vi.fn().mockReturnValue([
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'This is the AI reply.' },
        ]),
      } as unknown as SlashContext['agent'],
    });
    // Should not throw, just run
    const result = await handleSlash('/copy', ctx);
    expect(result).toBe(true);
  });
});

// ── /export ───────────────────────────────────────────────────────────────────
describe('/export', () => {
  it('returns true (handled)', async () => {
    const ctx = makeCtx();
    // Use /tmp as output dir to avoid side effects
    expect(await handleSlash('/export /tmp', ctx)).toBe(true);
  });

  it('writes a markdown file to the specified directory', async () => {
    const { existsSync, readdirSync, unlinkSync } = await import('fs');
    const { join } = await import('path');
    const tmpDir = '/tmp';
    const ctx = makeCtx();

    const before = readdirSync(tmpDir).filter((f) => f.startsWith('uagent-session-'));
    await handleSlash(`/export ${tmpDir}`, ctx);
    const after = readdirSync(tmpDir).filter((f) => f.startsWith('uagent-session-'));

    const newFiles = after.filter((f) => !before.includes(f));
    expect(newFiles.length).toBe(1);

    // Cleanup
    try { unlinkSync(join(tmpDir, newFiles[0]!)); } catch { /* */ }
  });

  it('exported file contains markdown headers', async () => {
    const { readdirSync, readFileSync, unlinkSync } = await import('fs');
    const { join } = await import('path');
    const tmpDir = '/tmp';

    const ctx = makeCtx({
      agent: {
        getHistory: vi.fn().mockReturnValue([
          { role: 'user', content: 'test question' },
          { role: 'assistant', content: 'test answer' },
        ]),
      } as unknown as SlashContext['agent'],
    });

    const before = readdirSync(tmpDir).filter((f) => f.startsWith('uagent-session-'));
    await handleSlash(`/export ${tmpDir}`, ctx);
    const after = readdirSync(tmpDir).filter((f) => f.startsWith('uagent-session-'));
    const newFile = after.find((f) => !before.includes(f));

    if (newFile) {
      const content = readFileSync(join(tmpDir, newFile), 'utf-8');
      expect(content).toMatch(/# Session Export/);
      expect(content).toMatch(/User|Assistant/);
      try { unlinkSync(join(tmpDir, newFile)); } catch { /* */ }
    }
  });
});

// ── /branch ───────────────────────────────────────────────────────────────────
describe('/branch', () => {
  it('returns true (handled)', async () => {
    const ctx = makeCtx();
    expect(await handleSlash('/branch', ctx)).toBe(true);
  });

  it('calls saveSnapshot with a branch ID', async () => {
    const ctx = makeCtx();
    await handleSlash('/branch', ctx);
    expect(ctx.saveSnapshot).toHaveBeenCalledTimes(1);
    const [id] = (ctx.saveSnapshot as Mock).mock.calls[0]!;
    expect(id).toMatch(/^branch-/);
  });

  it('includes history in saveSnapshot call', async () => {
    const ctx = makeCtx();
    await handleSlash('/branch', ctx);
    const [, history] = (ctx.saveSnapshot as Mock).mock.calls[0]!;
    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBe(2); // from mock getHistory
  });

  it('prints confirmation message', async () => {
    const ctx = makeCtx();
    await handleSlash('/branch', ctx);
    const joined = ctx._output.join('\n');
    expect(joined).toMatch(/branch/i);
  });
});

// ── /rename ───────────────────────────────────────────────────────────────────
describe('/rename', () => {
  it('returns true (handled)', async () => {
    const ctx = makeCtx();
    expect(await handleSlash('/rename my-feature', ctx)).toBe(true);
  });

  it('calls saveSnapshot with named- prefix', async () => {
    const ctx = makeCtx();
    await handleSlash('/rename my-feature', ctx);
    const [id] = (ctx.saveSnapshot as Mock).mock.calls[0]!;
    expect(id).toBe('named-my-feature');
  });

  it('shows usage when no name given', async () => {
    const ctx = makeCtx();
    await handleSlash('/rename', ctx);
    const joined = ctx._output.join('\n');
    expect(joined).toMatch(/Usage/i);
  });

  it('does not call saveSnapshot when no name given', async () => {
    const ctx = makeCtx();
    await handleSlash('/rename', ctx);
    expect(ctx.saveSnapshot).not.toHaveBeenCalled();
  });
});

// ── /terminal-setup ───────────────────────────────────────────────────────────
describe('/terminal-setup', () => {
  it('returns true (handled)', async () => {
    const ctx = makeCtx();
    expect(await handleSlash('/terminal-setup', ctx)).toBe(true);
  });

  it('prints iTerm2 or VS Code instructions', async () => {
    const ctx = makeCtx();
    await handleSlash('/terminal-setup', ctx);
    const joined = ctx._output.join('\n');
    expect(joined).toMatch(/iTerm2|VS Code|inputrc/i);
  });
});

// ── /bug ──────────────────────────────────────────────────────────────────────
describe('/bug', () => {
  it('returns true (handled)', async () => {
    const ctx = makeCtx();
    expect(await handleSlash('/bug', ctx)).toBe(true);
  });

  it('shows session log path', async () => {
    const ctx = makeCtx();
    await handleSlash('/bug', ctx);
    const joined = ctx._output.join('\n');
    expect(joined).toMatch(/uagent-test-session\.log/);
  });

  it('accepts optional description', async () => {
    const ctx = makeCtx();
    const result = await handleSlash('/bug Something went wrong with the LLM', ctx);
    expect(result).toBe(true);
    const joined = ctx._output.join('\n');
    expect(joined).toMatch(/Something went wrong/);
  });
});

// ── /output-style ─────────────────────────────────────────────────────────────
describe('/output-style', () => {
  it('returns true (handled)', async () => {
    const ctx = makeCtx();
    expect(await handleSlash('/output-style markdown', ctx)).toBe(true);
  });

  it('shows style list when no argument', async () => {
    const ctx = makeCtx();
    await handleSlash('/output-style', ctx);
    const joined = ctx._output.join('\n');
    expect(joined).toMatch(/plain|markdown|compact/i);
  });

  it('injects context when valid style given', async () => {
    const ctx = makeCtx();
    await handleSlash('/output-style plain', ctx);
    expect((ctx.agent.injectContext as Mock)).toHaveBeenCalledTimes(1);
    const [injected] = (ctx.agent.injectContext as Mock).mock.calls[0]!;
    expect(injected).toMatch(/plain/);
  });

  it('rejects invalid style with error message', async () => {
    const ctx = makeCtx();
    await handleSlash('/output-style invalid-style', ctx);
    const joined = ctx._output.join('\n');
    expect(joined).toMatch(/Unknown/i);
  });

  it('does not inject context for invalid style', async () => {
    const ctx = makeCtx();
    await handleSlash('/output-style gibberish', ctx);
    expect((ctx.agent.injectContext as Mock)).not.toHaveBeenCalled();
  });
});

// ── /resume with session_id ───────────────────────────────────────────────────
describe('/resume with session_id', () => {
  it('returns true when called with session id (no snapshot found)', async () => {
    const ctx = makeCtx({
      loadLastSnapshot: vi.fn().mockReturnValue(null),
    });
    expect(await handleSlash('/resume nonexistent-session', ctx)).toBe(true);
  });

  it('returns true when called without args (no snapshot)', async () => {
    const ctx = makeCtx({ loadLastSnapshot: vi.fn().mockReturnValue(null) });
    expect(await handleSlash('/resume', ctx)).toBe(true);
  });

  it('restores history when snapshot exists', async () => {
    const mockMessages = [
      { role: 'user', content: 'restored msg' },
      { role: 'assistant', content: 'restored reply' },
    ];
    const ctx = makeCtx({
      loadLastSnapshot: vi.fn().mockReturnValue({
        messages: mockMessages,
        savedAt: Date.now() - 60000,
      }),
    });
    await handleSlash('/resume', ctx);
    expect(ctx.agent.setHistory).toHaveBeenCalledWith(mockMessages);
  });
});

// ── unrecognised slash command falls through ──────────────────────────────────
describe('unknown slash command', () => {
  it('returns false for completely unknown commands (not in hook)', async () => {
    const ctx = makeCtx({
      hookRunner: {
        handleSlashCmd: vi.fn().mockResolvedValue({ handled: false, output: '' }),
      } as unknown as SlashContext['hookRunner'],
    });
    const result = await handleSlash('/completely-unknown-cmd-xyz', ctx);
    expect(result).toBe(false);
  });
});
