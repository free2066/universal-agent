/**
 * skills/mcpSkillBuilders.ts — MCP-based skill builders
 *
 * Mirrors claude-code's skills/mcpSkillBuilders.ts.
 * Provides utilities to create skills from MCP tool definitions.
 */

import type { BundledSkill } from './bundledSkills.js';

/**
 * Build a skill definition from an MCP tool registration.
 */
export function buildSkillFromMcpTool(
  serverName: string,
  toolName: string,
  toolDescription: string,
): BundledSkill {
  return {
    name: `mcp-${serverName}-${toolName}`,
    description: `MCP tool: ${toolDescription}`,
    tags: ['mcp', serverName],
    content: `# MCP Tool Skill: ${toolName}
Use the ${serverName} MCP server's ${toolName} tool.
Tool description: ${toolDescription}`,
  };
}

/**
 * Build skill summary from MCP server metadata.
 */
export function buildMcpServerSkillSummary(
  serverName: string,
  tools: Array<{ name: string; description: string }>,
): string {
  const toolLines = tools.map(t => `  - ${t.name}: ${t.description}`).join('\n');
  return `MCP Server: ${serverName}\nAvailable tools:\n${toolLines}`;
}
