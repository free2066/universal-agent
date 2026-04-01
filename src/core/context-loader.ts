import { existsSync, readFileSync, writeFileSync, statSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { execSync } from 'child_process';

export interface AgentsContext {
  instructions: string;
  sources: string[];
  totalBytes: number;
}

const MAX_BYTES = parseInt(process.env.AGENT_PROJECT_DOC_MAX_BYTES || String(32 * 1024));

export function loadProjectContext(startDir?: string): AgentsContext {
  const cwd = startDir || process.cwd();
  const gitRoot = findGitRoot(cwd);
  const searchRoot = gitRoot || cwd;
  const dirs = getPathChain(searchRoot, cwd);

  const sources: string[] = [];
  const parts: string[] = [];
  let totalBytes = 0;

  for (const dir of dirs) {
    const candidates = [
      join(dir, 'AGENTS.override.md'),
      join(dir, 'AGENTS.md'),
      join(dir, 'CLAUDE.md'),
    ];

    for (const filePath of candidates) {
      if (!existsSync(filePath)) continue;
      try {
        const stat = statSync(filePath);
        if (totalBytes + stat.size > MAX_BYTES) break;
        const content = readFileSync(filePath, 'utf-8').trim();
        if (content) {
          parts.push(`<!-- From: ${filePath} -->\n${content}`);
          sources.push(filePath);
          totalBytes += stat.size;
        }
        break;
      } catch { /* skip */ }
    }
  }

  // Also check .uagent/context.md
  const localCtx = join(cwd, '.uagent', 'context.md');
  if (existsSync(localCtx)) {
    try {
      const content = readFileSync(localCtx, 'utf-8').trim();
      if (content && totalBytes + content.length <= MAX_BYTES) {
        parts.push(`<!-- From: ${localCtx} -->\n${content}`);
        sources.push(localCtx);
        totalBytes += content.length;
      }
    } catch { /* skip */ }
  }

  return { instructions: parts.join('\n\n'), sources, totalBytes };
}

/**
 * Harness Engineering: Behavior constraints injected into every system prompt.
 *
 * Inspired by kstack article #15309 — prevent "fallback scripting" where the
 * AI writes code instead of using provided tools.
 */
const HARNESS_CONSTRAINTS = `
---
## ⚠️ Execution Rules (Mandatory)

You MUST follow these rules at all times:

1. **Use provided tools only** — Never write inline scripts or helper code to perform tasks
   that can be accomplished with the available tools (Bash, Read, Write, Edit, Grep, LS, etc.).
   - ✅ Correct: Call the \`Bash\` tool with a shell command
   - ❌ Wrong: Write a Python script to wrap a shell command

2. **CLI-first execution** — When a capability is available as a CLI command, execute it
   directly via the \`Bash\` tool. Do not import modules or create wrapper scripts.

3. **No fallback scripting** — If a tool call fails, report the error clearly and ask for
   guidance. Do NOT silently fall back to writing custom code to work around the failure.

4. **Tool failure handling** — On tool failure:
   - Report the exact error message
   - Suggest the correct invocation
   - Request human intervention if needed
   - Never attempt to emulate tool behavior with hand-written code

5. **Schema adherence** — Always pass tool arguments using the exact parameter names
   from the tool's schema. Do not infer or rename fields.
---`;

export function buildSystemPromptWithContext(basePrompt: string, startDir?: string): string {
  const ctx = loadProjectContext(startDir);
  const gitStatus = getGitStatus(startDir);

  const sections: string[] = [basePrompt, HARNESS_CONSTRAINTS];

  if (ctx.instructions) {
    sections.push(`---\n## Project Context\n${ctx.instructions}\n---`);
  }

  if (gitStatus) {
    sections.push(`---\n## Git Status (at session start — may be stale)\n\`\`\`\n${gitStatus}\n\`\`\`\n---`);
  }

  return sections.join('\n\n');
}

/**
 * Capture a one-time git status snapshot for the system prompt.
 * Truncated to ~2 KB to avoid inflating the context with large diffs.
 */
function getGitStatus(cwd?: string): string | null {
  const dir = cwd || process.cwd();
  try {
    const raw = execSync('git status --short --branch 2>/dev/null', {
      cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000,
    }).trim();
    if (!raw) return null;
    // Truncate to 2 KB
    return raw.length > 2048 ? raw.slice(0, 2048) + '\n...(truncated)' : raw;
  } catch {
    return null;
  }
}

export function initAgentsMd(dir: string): string {
  const filePath = join(dir, 'AGENTS.md');
  if (existsSync(filePath)) return `AGENTS.md already exists at ${filePath}`;
  const content = [
    '# Project Agent Instructions',
    '',
    '## Overview',
    'Describe your project here.',
    '',
    '## Development Setup',
    '```bash',
    'npm install',
    'npm run dev',
    '```',
    '',
    '## Testing',
    '```bash',
    'npm test',
    '```',
    '',
    '## Code Style',
    'Follow existing patterns in the codebase.',
    '',
    '## Important Notes',
    'Add any constraints or important notes here.',
    '',
  ].join('\n');
  writeFileSync(filePath, content);
  return `✓ Created AGENTS.md at ${filePath}`;
}

function findGitRoot(dir: string): string | null {
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch { return null; }
}

function getPathChain(root: string, leaf: string): string[] {
  const normRoot = resolve(root);
  const normLeaf = resolve(leaf);

  // Walk from leaf up to root, collecting dirs bottom-up, then reverse
  const dirs: string[] = [];
  let current = normLeaf;
  while (current !== normRoot && current !== dirname(current)) {
    dirs.push(current);
    current = dirname(current);
  }
  dirs.push(normRoot); // always include the root

  // Return root-to-leaf order so parent instructions are loaded first
  return [...new Set(dirs.reverse())];
}
