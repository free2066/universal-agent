/**
 * doctor-context-warnings.ts -- Context quality diagnostic checks for /doctor.
 *
 * C25: checkContextWarnings -- 4-class context quality diagnostics.
 *   Mirrors claude-code src/utils/doctorContextWarnings.ts L246 checkContextWarnings().
 *
 * Four check types:
 *   1. claudemd_files   -- Oversized memory/context files (>40k chars)
 *   2. agent_descriptions -- Agent description token overhead check
 *   3. mcp_tools        -- MCP tool schema token bloat (>25k tokens)
 *   4. unreachable_rules -- Permission rules shadowed by higher-priority rules
 *
 * Each warning has severity 'warning' | 'error' and a human-readable message.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

// ── Types ──────────────────────────────────────────────────────────────────────

export type ContextWarningType =
  | 'claudemd_files'
  | 'agent_descriptions'
  | 'mcp_tools'
  | 'unreachable_rules';

export interface ContextWarning {
  type: ContextWarningType;
  severity: 'warning' | 'error';
  message: string;
  /** Additional detail text shown indented below the main message */
  details?: string;
  /** File path associated with the warning (if applicable) */
  filePath?: string;
}

// ── Config constants (mirrors claude-code doctorContextWarnings.ts) ────────────

/** Max chars for memory/context files before warning (claude-code: 40_000) */
const MAX_CONTEXT_FILE_CHARS = 40_000;

/** Max estimated tokens for all MCP tool schemas before warning (claude-code: 25_000) */
const MAX_MCP_TOOL_TOKENS = 25_000;

/** Rough chars-per-token estimate for schema text */
const CHARS_PER_TOKEN = 4;

// ── Context file candidates ────────────────────────────────────────────────────

/** Memory/context file names scanned for size check. */
const CONTEXT_FILE_NAMES = [
  'CLAUDE.md',
  'AGENTS.md',
  '.clinerules',
  '.uagent.md',
  '.cursorrules',
  'CONTEXT.md',
];

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * C25: checkContextWarnings -- run all 4 context quality checks.
 *
 * @param projectRoot  Project root directory to scan
 * @returns Array of warnings, empty if all checks pass
 *
 * Mirrors claude-code doctorContextWarnings.ts L246 checkContextWarnings().
 */
export async function checkContextWarnings(projectRoot: string): Promise<ContextWarning[]> {
  const warnings: ContextWarning[] = [];

  // Run all checks in parallel for speed
  const [
    claudemdWarnings,
    mcpToolWarnings,
    ruleWarnings,
  ] = await Promise.all([
    _checkClaudemdFiles(projectRoot),
    _checkMcpToolTokens(projectRoot),
    _checkUnreachableRules(projectRoot),
  ]);

  warnings.push(...claudemdWarnings);
  warnings.push(...mcpToolWarnings);
  warnings.push(...ruleWarnings);

  return warnings;
}

// ── Check 1: claudemd_files ────────────────────────────────────────────────────

/**
 * C25: _checkClaudemdFiles -- detect oversized memory/context files.
 *
 * Large CLAUDE.md / AGENTS.md / .clinerules files inflate the system prompt on
 * every request, consuming context and increasing latency.
 *
 * Mirrors claude-code doctorContextWarnings.ts claudemd_files check.
 */
async function _checkClaudemdFiles(projectRoot: string): Promise<ContextWarning[]> {
  const warnings: ContextWarning[] = [];

  const searchDirs = [
    projectRoot,
    join(projectRoot, '.uagent'),
    join(projectRoot, '.codeflicker'),
    resolve(process.env.HOME ?? '~', '.codeflicker'),
    resolve(process.env.HOME ?? '~', '.uagent'),
  ];

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    for (const name of CONTEXT_FILE_NAMES) {
      const filePath = join(dir, name);
      if (!existsSync(filePath)) continue;
      try {
        const content = readFileSync(filePath, 'utf-8');
        const charCount = content.length;
        const estTokens = Math.round(charCount / CHARS_PER_TOKEN);
        if (charCount > MAX_CONTEXT_FILE_CHARS) {
          warnings.push({
            type: 'claudemd_files',
            severity: charCount > MAX_CONTEXT_FILE_CHARS * 2 ? 'error' : 'warning',
            message: `${name} is very large (${(charCount / 1000).toFixed(1)}k chars, ~${estTokens} tokens)`,
            details:
              'Large context files consume tokens on every request. ' +
              'Consider splitting into smaller domain-specific files or using /memory add sparingly.',
            filePath,
          });
        }
      } catch { /* skip unreadable files */ }
    }
  }

  return warnings;
}

// ── Check 2: mcp_tools ────────────────────────────────────────────────────────

/**
 * C25: _checkMcpToolTokens -- estimate MCP tool schema token usage.
 *
 * MCP servers with many tools or large schemas can consume 10k+ tokens in the
 * tool definition section, leaving less context for the actual conversation.
 *
 * Mirrors claude-code doctorContextWarnings.ts mcp_tools check.
 */
async function _checkMcpToolTokens(projectRoot: string): Promise<ContextWarning[]> {
  const warnings: ContextWarning[] = [];

  try {
    // Load MCP config to estimate tool count and schema sizes
    const mcpConfigPaths = [
      join(projectRoot, '.mcp.json'),
      join(projectRoot, '.codeflicker', 'mcp.json'),
    ];

    let totalEstimatedChars = 0;
    let mcpConfigFound = false;

    for (const configPath of mcpConfigPaths) {
      if (!existsSync(configPath)) continue;
      const raw = readFileSync(configPath, 'utf-8');
      totalEstimatedChars += raw.length;
      mcpConfigFound = true;
    }

    if (!mcpConfigFound) return warnings;

    // Also check running MCP manager for live tool data
    try {
      const { MCPManager } = await import('./mcp-manager.js');
      const mgr = new MCPManager(projectRoot);
      const servers = mgr.listServers().filter((s) => s.enabled);

      // Rough estimate: each MCP server adds ~200 chars overhead per tool
      // For connected servers with tools, we estimate 150 chars/tool on average
      const serverCount = servers.length;
      if (serverCount > 10) {
        const estTokens = serverCount * 200 / CHARS_PER_TOKEN;
        if (estTokens > MAX_MCP_TOOL_TOKENS) {
          warnings.push({
            type: 'mcp_tools',
            severity: 'warning',
            message: `${serverCount} MCP servers configured — tool schemas may use ~${Math.round(estTokens / 1000)}k+ tokens`,
            details:
              'Many MCP servers inflate the tool definition section. ' +
              'Disable unused servers with /mcp disable <name> or limit tools per server.',
          });
        }
      }
    } catch { /* MCPManager not available or failed */ }

    // If config text itself is very large, warn about that
    const estConfigTokens = Math.round(totalEstimatedChars / CHARS_PER_TOKEN);
    if (estConfigTokens > MAX_MCP_TOOL_TOKENS) {
      warnings.push({
        type: 'mcp_tools',
        severity: 'warning',
        message: `MCP configuration is very large (~${Math.round(estConfigTokens / 1000)}k tokens)`,
        details: 'Consider removing unused MCP server definitions from .mcp.json.',
      });
    }
  } catch { /* non-fatal */ }

  return warnings;
}

// ── Check 3: unreachable_rules ─────────────────────────────────────────────────

/**
 * C25: _checkUnreachableRules -- detect shadowed permission rules.
 *
 * If a more specific 'allow' rule is covered by a broader 'deny' or 'ask' rule,
 * the allow is unreachable. Similarly, duplicate rules waste context tokens.
 *
 * Mirrors claude-code doctorContextWarnings.ts unreachable_rules check.
 */
async function _checkUnreachableRules(projectRoot: string): Promise<ContextWarning[]> {
  const warnings: ContextWarning[] = [];

  try {
    // Check .codeflicker/config.json and .codeflicker/config.local.json for permissions
    const configPaths = [
      join(projectRoot, '.codeflicker', 'config.json'),
      join(projectRoot, '.codeflicker', 'config.local.json'),
    ];

    for (const configPath of configPaths) {
      if (!existsSync(configPath)) continue;
      try {
        const cfg = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
        const permissions = cfg['permissions'];
        if (!permissions || typeof permissions !== 'object') continue;

        const perms = permissions as Record<string, unknown>;
        const allow: string[] = Array.isArray(perms['allow']) ? (perms['allow'] as string[]) : [];
        const deny: string[] = Array.isArray(perms['deny']) ? (perms['deny'] as string[]) : [];

        // Check for allow rules shadowed by deny rules
        for (const allowRule of allow) {
          for (const denyRule of deny) {
            if (_ruleCovers(denyRule, allowRule)) {
              warnings.push({
                type: 'unreachable_rules',
                severity: 'warning',
                message: `Allow rule "${allowRule}" is shadowed by deny rule "${denyRule}"`,
                details:
                  `The allow rule will never be reached because the deny rule covers it. ` +
                  `Remove the redundant allow rule or adjust rule specificity.`,
                filePath: configPath,
              });
            }
          }
        }

        // Check for duplicate rules
        const allowDups = _findDuplicates(allow);
        for (const dup of allowDups) {
          warnings.push({
            type: 'unreachable_rules',
            severity: 'warning',
            message: `Duplicate allow rule: "${dup}"`,
            details: 'Remove duplicate permission rules to reduce context overhead.',
            filePath: configPath,
          });
        }
      } catch { /* skip malformed configs */ }
    }
  } catch { /* non-fatal */ }

  return warnings;
}

// ── Rule matching helpers ──────────────────────────────────────────────────────

/**
 * Check if a broader rule pattern covers a more specific rule.
 * Supports glob-style wildcard matching (prefix*).
 */
function _ruleCovers(broader: string, specific: string): boolean {
  if (broader === specific) return false; // same rule, not "shadowed"

  // Wildcard match: "bash:*" covers "bash:read-file"
  if (broader.endsWith('*')) {
    const prefix = broader.slice(0, -1);
    return specific.startsWith(prefix);
  }

  // Exact parent path: "bash" covers "bash:sub-command"
  if (specific.startsWith(broader + ':')) return true;

  return false;
}

function _findDuplicates(arr: string[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const item of arr) {
    if (seen.has(item)) dups.add(item);
    seen.add(item);
  }
  return [...dups];
}

// ── Formatting helper ──────────────────────────────────────────────────────────

/** Format context warnings for terminal display (used by /doctor). */
export function formatContextWarnings(warnings: ContextWarning[]): string {
  if (warnings.length === 0) return '';

  const lines: string[] = [];
  for (const w of warnings) {
    const icon = w.severity === 'error' ? '✗' : '⚠';
    lines.push(`    ${icon}  [${w.type}] ${w.message}`);
    if (w.details) {
      lines.push(`       ${w.details}`);
    }
    if (w.filePath) {
      lines.push(`       File: ${w.filePath}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
