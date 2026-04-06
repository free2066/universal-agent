import type { ToolDefinition, ToolRegistration, ParameterSchema } from '../models/types.js';
import { createLogger } from './logger.js';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const log = createLogger('tool-registry');

// ── Data Contract: Schema Validation ─────────────────────────────────────────
//
// Inspired by kstack article #15309 "Data Contract" principle:
// Tool input schemas are enforced as hard boundaries — mismatched args are
// rejected immediately with a clear error instead of letting the AI guess.

type SchemaError = { field: string; message: string };

function validateAgainstSchema(
  args: Record<string, unknown>,
  schema: ToolDefinition['parameters'],
): SchemaError[] {
  const errors: SchemaError[] = [];
  const { properties = {}, required = [] } = schema;

  // Check required fields
  for (const field of required) {
    if (!(field in args) || args[field] === undefined || args[field] === null) {
      errors.push({ field, message: `Required field "${field}" is missing` });
    }
  }

  // Type-check provided fields
  for (const [key, value] of Object.entries(args)) {
    if (!(key in properties)) {
      // Unknown field — warn but don't reject (LLMs sometimes pass extra fields)
      log.debug(`Tool received unknown field "${key}" (not in schema)`);
      continue;
    }
    const propSchema = properties[key] as ParameterSchema;
    const typeError = checkType(key, value, propSchema);
    if (typeError) errors.push(typeError);
  }

  return errors;
}

function checkType(
  field: string,
  value: unknown,
  schema: ParameterSchema,
): SchemaError | null {
  if (value === null || value === undefined) return null;

  const actualType = Array.isArray(value) ? 'array' : typeof value;
  const expectedType = schema.type;

  if (actualType !== expectedType) {
    return {
      field,
      message: `Field "${field}" expects type "${expectedType}" but received "${actualType}"`,
    };
  }

  // Enum check
  if (schema.enum && !schema.enum.includes(String(value))) {
    return {
      field,
      message: `Field "${field}" must be one of [${schema.enum.join(', ')}] but got "${value}"`,
    };
  }

  // Recursively validate array items against schema.items (bug report #9)
  if (actualType === 'array' && schema.items && Array.isArray(value)) {
    for (let i = 0; i < (value as unknown[]).length; i++) {
      const itemErr = checkType(`${field}[${i}]`, (value as unknown[])[i], schema.items);
      if (itemErr) return itemErr;
    }
  }

  return null;
}

// ── E12: ValidationResult 语义验证结果类型（claude-code Tool.ts 对标）─────────────────
//
// 工具可声明可选的 validate() 方法，进行 JSON schema 之外的语义层验证。
// errorCode 让 LLM 能读懂失败原因，从而自我纠正进一步调用。
// D18: Now formally typed as ToolValidationResult in models/types.ts (re-exported here for compat)

import type { ToolValidationResult } from '../models/types.js';
export type ValidationResult = ToolValidationResult;

// Extend ToolRegistration with E12 + F12 fields
// （这些字段在 types.ts 中的 ToolRegistration interface 添加）


//
// Inspired by kstack article #15309 "Conditional Skill Activation":
// Tools can declare a trigger predicate — they are only added to the registry
// (and visible to the LLM) after the predicate fires.
// This prevents "scope creep": the LLM doesn't see tools it shouldn't use yet.

export interface ConditionalRegistration {
  registration: ToolRegistration;
  /**
   * Return true when the tool should be added.
   * Called after each tool execution with the tool name and its result.
   */
  trigger: (toolName: string, result: unknown) => boolean;
  /** Whether this conditional tool has been activated yet */
  activated: boolean;
}

export class ToolRegistry {
  private tools = new Map<string, ToolRegistration>();
  private conditionals: ConditionalRegistration[] = [];
  /** Schema validation is on by default; set AGENT_SCHEMA_VALIDATE=0 to disable */
  private validateSchema = process.env.AGENT_SCHEMA_VALIDATE !== '0';

  register(registration: ToolRegistration) {
    this.tools.set(registration.definition.name, registration);
  }

  registerMany(registrations: ToolRegistration[]) {
    for (const reg of registrations) this.register(reg);
  }

  /**
   * Register a tool that only becomes active once its trigger fires.
   * Trigger is evaluated after every tool execution.
   *
   * Example — activate code-inspector only after grep finds results:
   *   registry.registerConditional(codeInspectorTool, (name, result) =>
   *     name === 'Grep' && typeof result === 'string' && result.length > 0
   *   );
   */
  registerConditional(registration: ToolRegistration, trigger: ConditionalRegistration['trigger']) {
    this.conditionals.push({ registration, trigger, activated: false });
  }

  /**
   * Called after each tool execution to check if any conditional tools
   * should now be unlocked.
   * Returns the names of newly activated tools (empty array if none).
   */
  evaluateConditionals(toolName: string, result: unknown): string[] {
    const activated: string[] = [];
    for (const cond of this.conditionals) {
      if (cond.activated) continue;
      try {
        if (cond.trigger(toolName, result)) {
          cond.activated = true;
          this.tools.set(cond.registration.definition.name, cond.registration);
          activated.push(cond.registration.definition.name);
          log.info(`Conditional tool "${cond.registration.definition.name}" activated by "${toolName}"`);
        }
      } catch (err) {
        log.debug(`Conditional trigger error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return activated;
  }

  clear() {
    this.tools.clear();
    this.conditionals = [];
  }

  getToolDefinitions(): ToolDefinition[] {
    // H15: 分区排序（内置工具先排序 + MCP 工具尾部排序）
    // 对标 claude-code assembleToolPool：防止 MCP 工具混入内置工具破坏 prompt cache breakpoint
    // 服务端在 last built-in tool 处打 cache breakpoint，MCP 工具混入会导致每次 cache miss
    const builtIn: ToolDefinition[] = [];
    const mcp: ToolDefinition[] = [];
    const byName = (a: ToolDefinition, b: ToolDefinition) => a.name.localeCompare(b.name);
    for (const tool of this.tools.values()) {
      const t = tool as ToolRegistration & { isMcp?: boolean };
      if (t.isMcp) mcp.push(t.definition);
      else builtIn.push(t.definition);
    }
    return [...builtIn.sort(byName), ...mcp.sort(byName)];
  }

  /**
   * I15: getToolDefinitionsForPrompt — 支持 deferred 懒加载
   * 工具数超过 DEFER_THRESHOLD 时，只展开非 deferred 的工具，其余通过 ToolSearch 工具按需加载
   */
  getToolDefinitionsForPrompt(): ToolDefinition[] {
    const DEFER_THRESHOLD = 50;
    const all = this.getToolDefinitions();
    if (all.length <= DEFER_THRESHOLD) return all;
    // 超过阈值：只展开非 deferred 工具 + ToolSearch 自身
    return all.filter(t => {
      const tool = this.tools.get(t.name) as (ToolRegistration & { shouldDefer?: boolean; isMcp?: boolean; alwaysLoad?: boolean }) | undefined;
      if (!tool) return false;
      if (tool.alwaysLoad) return true;         // alwaysLoad 工具始终展开
      if (t.name === 'ToolSearch') return true; // ToolSearch 自身不 defer
      if (tool.isMcp) return false;             // MCP 工具默认 defer
      if (tool.shouldDefer) return false;       // 明确标记 shouldDefer 的工具
      return true;
    });
  }

  /**
   * Classify whether a tool is safe to run concurrently with other tools.
   *
   * Inspired by Claude Code's tool concurrency safety classification (kstack #15375):
   * "工具并发安全分类: 读工具并发/写工具独占"
   *
   * Read-only tools can run concurrently (no shared state mutation).
   * Write/side-effect tools must run exclusively to avoid conflicts.
   *
   * Classification rules:
   *   SAFE (concurrent):  Read, Grep, LS, WebFetch, WebSearch, AskExpertModel, TodoRead
   *   UNSAFE (exclusive): Write, Edit, Bash, Task, Spawn*, Worktree*, MCP tools
   *
   * Usage in agent.ts: when the LLM requests multiple tool calls in one turn,
   * we can run SAFE tools in parallel using Promise.allSettled, while UNSAFE tools
   * must be executed sequentially.
   */
  isConcurrencySafe(name: string): boolean {
    // Explicitly safe: pure read operations with no side effects
    const SAFE_TOOLS = new Set([
      'Read', 'Grep', 'LS', 'ListFiles',
      'WebFetch', 'WebSearch', 'Fetch',
      'AskExpertModel',
      'TodoRead', 'GetTask', 'ListTasks',
      'MemoryRead', 'MemoryList',
      'DocSearch', 'FetchDoc',
    ]);
    // Explicitly unsafe: write / side-effect tools
    const UNSAFE_PREFIXES = [
      'Write', 'Edit', 'Bash', 'Task',
      'Spawn', 'Worktree', 'Teammate',
      'Proxy', 'Ws', 'WS',
      'DbQuery', 'DatabaseQuery', 'Redis',
      'TodoWrite', 'CreateTask', 'UpdateTask',
      'ScriptRun', 'ScriptSave', 'TestRun',
    ];

    if (SAFE_TOOLS.has(name)) return true;
    for (const prefix of UNSAFE_PREFIXES) {
      if (name.startsWith(prefix)) return false;
    }
    // Default: treat unknown tools as unsafe (fail-closed principle)
    return false;
  }

  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    // I13: alias 查找 — 先用 name 直接查，找不到则遍历别名
    // 对标 claude-code Tool.ts toolMatchesName() / findToolByName() 逻辑
    let tool = this.tools.get(name);
    if (!tool) {
      for (const [, t] of this.tools) {
        if (t.definition.aliases?.includes(name)) {
          log.debug(`Tool alias "${name}" resolved to canonical name "${t.definition.name}"`);
          tool = t;
          break;
        }
      }
    }
    if (!tool) throw new Error(`Unknown tool: "${name}". Available: ${Array.from(this.tools.keys()).join(', ')}`);

    // Data Contract: enforce schema before execution
    if (this.validateSchema) {
      const errors = validateAgainstSchema(args, tool.definition.parameters);
      if (errors.length > 0) {
        const msg = errors.map((e) => e.message).join('; ');
        throw new Error(
          `Schema validation failed for tool "${name}": ${msg}. ` +
          `Required fields: [${(tool.definition.parameters.required ?? []).join(', ')}]`,
        );
      }
    }

    // E12: Semantic validation (claude-code Tool.validateInput parity)
    // D18: validate field now formally declared in ToolRegistration interface (types.ts)
    // Runs after schema validation; provides domain-specific checks with errorCode
    // that give the LLM actionable feedback to self-correct on the next call.
    if (tool.validate) {
      try {
        const vr = await Promise.resolve(tool.validate(args));
        if (!vr.result) {
          const code = vr.errorCode ? ` [${vr.errorCode}]` : '';
          throw new Error(`Tool "${name}" validation failed${code}: ${vr.message}`);
        }
      } catch (err) {
        // Re-throw validation errors; catch only to add tool name context
        throw err;
      }
    }

    const result = await tool.handler(args);

    // F12: Auto-persist large tool results (claude-code maxResultSizeChars parity)
    // D18: maxResultSizeBytes now formally declared in ToolRegistration interface (types.ts)
    const maxBytes = tool.maxResultSizeBytes ?? 50_000; // 50KB default
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
    if (Buffer.byteLength(resultStr, 'utf-8') > maxBytes) {
      try {
        const tmpDir = mkdtempSync(join(tmpdir(), 'uagent-result-'));
        const outPath = join(tmpDir, `${name}-result.txt`);
        writeFileSync(outPath, resultStr, 'utf-8');
        const lines = resultStr.split('\n').length;
        const kb = Math.round(Buffer.byteLength(resultStr, 'utf-8') / 1024);
        return (
          `Result too large (${lines} lines, ${kb}KB) — full output saved to: ${outPath}\n` +
          `First 200 lines:\n${resultStr.split('\n').slice(0, 200).join('\n')}`
        );
      } catch { /* non-fatal: fall through to return original result */ }
    }

    return result;
  }

  list(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * A18: Get the full ToolRegistration for a tool name (including contextModifier).
   * Used by StreamingToolExecutor to collect contextModifiers after execution.
   */
  getRegistration(name: string): ToolRegistration | undefined {
    let tool = this.tools.get(name);
    if (!tool) {
      for (const [, t] of this.tools) {
        if (t.definition.aliases?.includes(name)) {
          tool = t;
          break;
        }
      }
    }
    return tool;
  }
}
