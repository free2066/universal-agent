import type { ToolDefinition, ToolHandler, ToolRegistration } from '../models/types.js';

export class ToolRegistry {
  private tools = new Map<string, ToolRegistration>();

  register(registration: ToolRegistration) {
    this.tools.set(registration.definition.name, registration);
  }

  registerMany(registrations: ToolRegistration[]) {
    for (const reg of registrations) this.register(reg);
  }

  clear() {
    this.tools.clear();
  }

  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.handler(args);
  }

  list(): string[] {
    return Array.from(this.tools.keys());
  }
}
