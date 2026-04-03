/**
 * Unit Tests: tool-registry.ts
 *
 * Covers: register / registerMany / getToolDefinitions / execute / schema validation
 *         / isConcurrencySafe / registerConditional / evaluateConditionals
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolRegistry } from '../core/tool-registry.js';
import type { ToolRegistration } from '../models/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStringTool(name: string, required: string[] = []): ToolRegistration {
  return {
    definition: {
      name,
      description: `Tool ${name}`,
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'Input string' },
          optional: { type: 'string', description: 'Optional param' },
        },
        required,
      },
    },
    handler: async (args) => `echo:${args.input ?? 'none'}`,
  };
}

function makeTypedTool(name: string): ToolRegistration {
  return {
    definition: {
      name,
      description: `Typed tool ${name}`,
      parameters: {
        type: 'object',
        properties: {
          count: { type: 'number', description: 'A count' },
          flag: { type: 'boolean', description: 'A flag' },
          tags: {
            type: 'array',
            description: 'Tags array',
            items: { type: 'string', description: 'A tag' },
          },
          mode: { type: 'string', enum: ['fast', 'slow', 'auto'], description: 'Mode enum' },
        },
        required: ['count'],
      },
    },
    handler: async (args) => args.count,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. register / registerMany / getToolDefinitions / list
// ─────────────────────────────────────────────────────────────────────────────
describe('ToolRegistry — register / list', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('registers a single tool and lists it', () => {
    registry.register(makeStringTool('MyTool'));
    expect(registry.list()).toContain('MyTool');
    expect(registry.list().length).toBe(1);
  });

  it('registerMany registers all provided tools', () => {
    registry.registerMany([makeStringTool('ToolA'), makeStringTool('ToolB'), makeStringTool('ToolC')]);
    expect(registry.list()).toContain('ToolA');
    expect(registry.list()).toContain('ToolB');
    expect(registry.list()).toContain('ToolC');
    expect(registry.list().length).toBe(3);
  });

  it('re-registering same name overwrites the tool', () => {
    const t1: ToolRegistration = { ...makeStringTool('Same'), handler: async () => 'v1' };
    const t2: ToolRegistration = { ...makeStringTool('Same'), handler: async () => 'v2' };
    registry.register(t1);
    registry.register(t2);
    expect(registry.list().length).toBe(1);
    // Execution should use the latest registered handler
    // We'll verify via execute
  });

  it('getToolDefinitions returns only definitions (no handlers)', () => {
    registry.register(makeStringTool('Alpha'));
    const defs = registry.getToolDefinitions();
    expect(defs.length).toBe(1);
    expect(defs[0].name).toBe('Alpha');
    // Should NOT contain handler
    expect((defs[0] as unknown as Record<string, unknown>)['handler']).toBeUndefined();
  });

  it('clear() removes all tools', () => {
    registry.registerMany([makeStringTool('A'), makeStringTool('B')]);
    expect(registry.list().length).toBe(2);
    registry.clear();
    expect(registry.list().length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. execute — happy path
// ─────────────────────────────────────────────────────────────────────────────
describe('ToolRegistry — execute (happy path)', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    // Disable schema validation for basic execute tests
    process.env.AGENT_SCHEMA_VALIDATE = '0';
    registry = new ToolRegistry();
  });

  afterEach(() => {
    delete process.env.AGENT_SCHEMA_VALIDATE;
  });

  it('executes a registered tool and returns its result', async () => {
    registry.register(makeStringTool('Echo', ['input']));
    const result = await registry.execute('Echo', { input: 'hello' });
    expect(result).toBe('echo:hello');
  });

  it('throws for unknown tool with helpful message', async () => {
    registry.register(makeStringTool('Known'));
    await expect(registry.execute('Unknown', {})).rejects.toThrow('Unknown tool: "Unknown"');
    await expect(registry.execute('Unknown', {})).rejects.toThrow('Known'); // includes available tools
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Schema validation
// ─────────────────────────────────────────────────────────────────────────────
describe('ToolRegistry — schema validation', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    delete process.env.AGENT_SCHEMA_VALIDATE; // ensure it's ON (default)
    registry = new ToolRegistry();
  });

  it('throws when required field is missing', async () => {
    registry.register(makeStringTool('RequiredTool', ['input']));
    await expect(registry.execute('RequiredTool', {})).rejects.toThrow(/Required field "input" is missing/);
  });

  it('throws when field has wrong type', async () => {
    registry.register(makeTypedTool('TypedTool'));
    await expect(registry.execute('TypedTool', { count: 'not-a-number' })).rejects.toThrow(
      /Schema validation failed/,
    );
  });

  it('throws when enum value is invalid', async () => {
    registry.register(makeTypedTool('TypedTool'));
    await expect(registry.execute('TypedTool', { count: 5, mode: 'invalid' })).rejects.toThrow(
      /Schema validation failed/,
    );
  });

  it('accepts valid enum values', async () => {
    registry.register(makeTypedTool('TypedTool'));
    for (const mode of ['fast', 'slow', 'auto']) {
      await expect(registry.execute('TypedTool', { count: 5, mode })).resolves.toBe(5);
    }
  });

  it('validates nested array items', async () => {
    registry.register(makeTypedTool('TypedTool'));
    // tags should be string[], passing number should fail
    await expect(registry.execute('TypedTool', { count: 5, tags: [1, 2, 3] })).rejects.toThrow(
      /Schema validation failed/,
    );
  });

  it('allows valid array items', async () => {
    registry.register(makeTypedTool('TypedTool'));
    await expect(
      registry.execute('TypedTool', { count: 5, tags: ['a', 'b'] }),
    ).resolves.toBe(5);
  });

  it('passes with all required fields present and valid types', async () => {
    registry.register(makeTypedTool('TypedTool'));
    const result = await registry.execute('TypedTool', { count: 42, flag: true, mode: 'fast' });
    expect(result).toBe(42);
  });

  it('AGENT_SCHEMA_VALIDATE=0 skips validation', async () => {
    process.env.AGENT_SCHEMA_VALIDATE = '0';
    const reg = new ToolRegistry(); // new instance reads env at construction time
    reg.register(makeStringTool('SkipValidation', ['input']));
    // Missing required field — should NOT throw when validation disabled
    await expect(reg.execute('SkipValidation', {})).resolves.toBe('echo:none');
    delete process.env.AGENT_SCHEMA_VALIDATE;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. isConcurrencySafe
// ─────────────────────────────────────────────────────────────────────────────
describe('ToolRegistry — isConcurrencySafe', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  const SAFE_TOOLS = ['Read', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoRead', 'MemoryRead'];
  const UNSAFE_TOOLS = ['Write', 'Edit', 'Bash', 'TodoWrite', 'ScriptRun', 'TestRun', 'DbQuery', 'Redis'];

  for (const name of SAFE_TOOLS) {
    it(`"${name}" is concurrency-safe`, () => {
      expect(registry.isConcurrencySafe(name)).toBe(true);
    });
  }

  for (const name of UNSAFE_TOOLS) {
    it(`"${name}" is NOT concurrency-safe`, () => {
      expect(registry.isConcurrencySafe(name)).toBe(false);
    });
  }

  it('unknown tool defaults to unsafe (fail-closed)', () => {
    expect(registry.isConcurrencySafe('SomeRandomTool')).toBe(false);
    expect(registry.isConcurrencySafe('CustomAnalyze')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. registerConditional / evaluateConditionals
// ─────────────────────────────────────────────────────────────────────────────
describe('ToolRegistry — conditional tools', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    process.env.AGENT_SCHEMA_VALIDATE = '0';
    registry = new ToolRegistry();
  });

  afterEach(() => {
    delete process.env.AGENT_SCHEMA_VALIDATE;
  });

  it('conditional tool is NOT visible before trigger fires', () => {
    const conditionalTool = makeStringTool('CondTool');
    registry.registerConditional(conditionalTool, (name) => name === 'Grep');
    expect(registry.list()).not.toContain('CondTool');
  });

  it('conditional tool becomes visible after trigger fires', () => {
    const conditionalTool = makeStringTool('CondTool');
    registry.registerConditional(conditionalTool, (name) => name === 'Grep');

    // Simulate Grep tool execution with results
    const activated = registry.evaluateConditionals('Grep', 'some grep results');
    expect(activated).toContain('CondTool');
    expect(registry.list()).toContain('CondTool');
  });

  it('conditional tool only activates once (not re-registered on subsequent triggers)', () => {
    const conditionalTool = makeStringTool('CondTool');
    const triggerSpy = vi.fn((name: string) => name === 'Grep');
    registry.registerConditional(conditionalTool, triggerSpy);

    // First trigger
    registry.evaluateConditionals('Grep', 'result 1');
    // Second trigger — should not re-activate (already activated)
    registry.evaluateConditionals('Grep', 'result 2');

    // Tool is still in registry (not deregistered)
    expect(registry.list()).toContain('CondTool');
    // But trigger was only called twice (once per evaluateConditionals call)
    expect(triggerSpy).toHaveBeenCalledTimes(1); // activated flag prevents 2nd check
  });

  it('trigger with non-matching tool name does NOT activate', () => {
    const conditionalTool = makeStringTool('CondTool');
    registry.registerConditional(conditionalTool, (name) => name === 'Grep');

    registry.evaluateConditionals('Write', 'irrelevant'); // wrong tool
    expect(registry.list()).not.toContain('CondTool');
  });

  it('trigger with result predicate works correctly', () => {
    const conditionalTool = makeStringTool('CondTool');
    registry.registerConditional(
      conditionalTool,
      (name, result) => name === 'Search' && typeof result === 'string' && result.length > 10,
    );

    // Short result — should not trigger
    registry.evaluateConditionals('Search', 'short');
    expect(registry.list()).not.toContain('CondTool');

    // Long enough result — should trigger
    registry.evaluateConditionals('Search', 'this is a long enough result string');
    expect(registry.list()).toContain('CondTool');
  });

  it('trigger throwing an error does not crash evaluateConditionals', () => {
    const conditionalTool = makeStringTool('CondTool');
    registry.registerConditional(conditionalTool, () => {
      throw new Error('trigger error');
    });

    // Should not throw
    expect(() => registry.evaluateConditionals('AnyTool', 'result')).not.toThrow();
  });

  it('multiple conditionals can be registered independently', () => {
    const tool1 = makeStringTool('ByGrep');
    const tool2 = makeStringTool('ByWrite');

    registry.registerConditional(tool1, (name) => name === 'Grep');
    registry.registerConditional(tool2, (name) => name === 'Write');

    registry.evaluateConditionals('Grep', 'results');
    expect(registry.list()).toContain('ByGrep');
    expect(registry.list()).not.toContain('ByWrite');

    registry.evaluateConditionals('Write', 'file written');
    expect(registry.list()).toContain('ByWrite');
  });

  it('executeConditional tool works after activation', async () => {
    const conditionalTool: ToolRegistration = {
      definition: {
        name: 'ConditionalEcho',
        description: 'Echo conditionally',
        parameters: { type: 'object', properties: { msg: { type: 'string', description: 'msg' } }, required: [] },
      },
      handler: async (args) => `conditional:${args.msg}`,
    };

    registry.registerConditional(conditionalTool, (name) => name === 'Unlock');
    registry.evaluateConditionals('Unlock', 'token');

    const result = await registry.execute('ConditionalEcho', { msg: 'hello' });
    expect(result).toBe('conditional:hello');
  });
});
