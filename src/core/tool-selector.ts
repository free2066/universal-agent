/**
 * Tool Selector — filter tools by relevance before each LLM call
 *
 * Inspired by kwaibi's ToolSelectionInterceptor pattern.
 *
 * When the agent has many tools registered (e.g. MCP servers add dozens),
 * sending all of them in every LLM call:
 *   - Wastes input tokens on irrelevant schema definitions
 *   - Can confuse the model with too many choices
 *
 * This module implements two selection strategies:
 *   1. Keyword scoring  — fast, zero-latency, no extra LLM call
 *   2. LLM selection    — accurate, uses a cheap model when count > threshold
 *
 * The keyword scorer runs always; LLM selection is only triggered when
 * `AGENT_TOOL_SELECTION_LLM=1` env var is set and count > threshold.
 *
 * Usage:
 *   const selectedDefs = await selectTools(allDefs, userQuery, history);
 *   // Pass selectedDefs to llm.chat({ tools: selectedDefs })
 */

import type { ToolDefinition, Message } from '../models/types.js';
import { createLogger } from './logger.js';

const log = createLogger('tool-selector');

// ── Config ───────────────────────────────────────────────────────────────────

/** Only filter when count exceeds this (default: 12) */
const THRESHOLD = parseInt(process.env.AGENT_TOOL_SELECT_THRESHOLD ?? '12', 10);

/** Max tools to send to the model (default: 10) */
const MAX_TOOLS = parseInt(process.env.AGENT_TOOL_SELECT_MAX ?? '10', 10);

/** Tools that are always included regardless of query.
 *
 * Default list uses the actual registered tool names from fs-tools.ts:
 *   Bash, Write, Edit, Read, LS, Grep
 * Override via AGENT_TOOL_SELECT_ALWAYS env var (comma-separated).
 */
const ALWAYS_INCLUDE = new Set(
  (process.env.AGENT_TOOL_SELECT_ALWAYS ?? 'Bash,Write,Edit,Read,LS,Grep')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

// ── Types ─────────────────────────────────────────────────────────────────────

interface ScoredTool {
  definition: ToolDefinition;
  score: number;
}

// ── Keyword scorer ────────────────────────────────────────────────────────────

/**
 * Score a tool definition against a user query using keyword overlap.
 * Returns a score in [0, 1] — higher = more relevant.
 */
function keywordScore(def: ToolDefinition, queryTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0.5; // treat as neutral

  const toolText = `${def.name} ${def.description}`.toLowerCase();
  const toolTokens = new Set(toolText.match(/[a-z0-9_]+/g) ?? []);

  let matches = 0;
  for (const t of queryTokens) {
    if (toolTokens.has(t)) matches++;
  }

  // Also check parameter names/descriptions
  for (const [, schema] of Object.entries(def.parameters.properties ?? {})) {
    const propText = `${schema.description ?? ''}`.toLowerCase();
    for (const t of queryTokens) {
      if (propText.includes(t)) matches++;
    }
  }

  // Normalize to [0, 1] with a soft cap
  return Math.min(1, matches / Math.max(1, queryTokens.size));
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
}

// ── LLM selector ─────────────────────────────────────────────────────────────

async function llmSelectTools(
  tools: ToolDefinition[],
  query: string,
  maxTools: number,
): Promise<string[]> {
  const { createLLMClient } = await import('../models/llm-client.js');
  const { modelManager } = await import('../models/model-manager.js');

  const toolList = tools.map((t) => `- ${t.name}: ${t.description}`).join('\n');
  const prompt = `You are selecting relevant tools for an agent.

User query: "${query}"

Available tools:
${toolList}

Select at most ${maxTools} tools that are most likely needed. Respond with a JSON array of tool names only:
{"tools": ["tool1", "tool2"]}`;

  const model = modelManager.getCurrentModel('quick');
  const client = createLLMClient(model);

  const response = await client.chat({
    systemPrompt: 'You are a precise tool selector. Return only JSON.',
    messages: [{ role: 'user', content: prompt }],
  });

  try {
    // Extract JSON from response
    const jsonMatch = response.content.match(/\{[^}]*"tools"\s*:\s*\[[^\]]*\][^}]*\}/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]) as { tools: string[] };
    return Array.isArray(parsed.tools) ? parsed.tools : [];
  } catch {
    return [];
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Select tools relevant to the user's query.
 * Returns the same list unmodified if count is below threshold.
 *
 * @param tools   Full list of registered tool definitions
 * @param query   The latest user message text
 * @param history Conversation history (used for contextual scoring)
 */
export async function selectTools(
  tools: ToolDefinition[],
  query: string,
  _history?: Message[],
): Promise<ToolDefinition[]> {
  // Skip if below threshold
  if (tools.length <= THRESHOLD) return tools;

  log.debug(`Tool selection: ${tools.length} tools, query="${query.slice(0, 80)}"`);

  const alwaysIncluded = tools.filter((t) => ALWAYS_INCLUDE.has(t.name));
  const candidates = tools.filter((t) => !ALWAYS_INCLUDE.has(t.name));

  const remaining = MAX_TOOLS - alwaysIncluded.length;
  if (remaining <= 0) {
    log.debug(`Always-include tools (${alwaysIncluded.length}) already fill quota`);
    return alwaysIncluded;
  }

  let selectedNames: Set<string> | null = null;

  // Try LLM selection if enabled
  if (process.env.AGENT_TOOL_SELECTION_LLM === '1') {
    try {
      const names = await llmSelectTools(candidates, query, remaining);
      if (names.length > 0) {
        selectedNames = new Set(names.slice(0, remaining));
        log.debug(`LLM selected ${selectedNames.size} tools: ${[...selectedNames].join(', ')}`);
      }
    } catch (err) {
      log.warn(`LLM tool selection failed, falling back to keyword: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Fallback: keyword scoring
  if (!selectedNames) {
    const queryTokens = tokenize(query);
    const scored: ScoredTool[] = candidates.map((def) => ({
      definition: def,
      score: keywordScore(def, queryTokens),
    }));

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);
    selectedNames = new Set(scored.slice(0, remaining).map((s) => s.definition.name));
    log.debug(`Keyword selected ${selectedNames.size} tools: ${[...selectedNames].join(', ')}`);
  }

  const selected = [
    ...alwaysIncluded,
    ...candidates.filter((t) => selectedNames!.has(t.name)),
  ];

  log.info(`Tool selection: ${tools.length} → ${selected.length} tools`);
  return selected;
}
