import type { ToolDefinition, ToolRegistration, ParameterSchema } from '../models/types.js';
import { createLogger } from './logger.js';

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

// ── Conditional Tool Registration ─────────────────────────────────────────────
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
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(name);
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

    return tool.handler(args);
  }

  list(): string[] {
    return Array.from(this.tools.keys());
  }
}
