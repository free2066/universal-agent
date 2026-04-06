import { existsSync, readFileSync, writeFileSync, statSync, readdirSync } from 'fs';
import { resolve, join, dirname, isAbsolute } from 'path';
import { spawnSync } from 'child_process';
import { homedir } from 'os';
import { getSkillLoader } from '../skills/skill-loader.js';

// ── @include directive parser (Round 4: claude-code claudemd.ts parity) ─────────────────
//
// Supports:
//   @./relative/path.md       — relative to the including file's directory
//   @~/home/path.md           — relative to user's home directory
//   @/absolute/path.md        — absolute path
//
// Maximum recursion depth: MAX_INCLUDE_DEPTH (mirrors claude-code's value of 5)

const MAX_INCLUDE_DEPTH = 5;

/**
 * Parse YAML-like frontmatter from a Markdown file.
 * Returns { body, paths } where paths is an optional glob list from `paths:` key.
 *
 * Example frontmatter:
 * ```
 * ---
 * paths:
 *   - src/**\/*.ts
 *   - tests/**
 * ---
 * ```
 */
function parseFrontmatter(content: string): { body: string; paths: string[] | null } {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return { body: content, paths: null };
  }
  const endIdx = content.indexOf('\n---', 4);
  if (endIdx === -1) return { body: content, paths: null };

  const fm = content.slice(4, endIdx);
  const body = content.slice(endIdx + 4).replace(/^\r?\n/, '');

  // Parse `paths:` list from YAML frontmatter
  const pathsMatch = fm.match(/^paths:\s*\n((?:\s+-\s+.+\n?)*)/m);
  if (!pathsMatch) return { body, paths: null };

  const pathLines = pathsMatch[1]!
    .split('\n')
    .map((l) => l.replace(/^\s*-\s+/, '').trim())
    .filter(Boolean);

  return { body, paths: pathLines.length > 0 ? pathLines : null };
}

/**
 * Check whether a given file path matches any of the scope patterns.
 * Uses simple glob matching (same approach as permission-manager.ts).
 */
function matchesPathScope(filePath: string, scopePatterns: string[]): boolean {
  if (scopePatterns.length === 0) return true; // no scope = always inject
  for (const pattern of scopePatterns) {
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '__DSTAR__')
      .replace(/\*/g, '[^/]*')
      .replace(/__DSTAR__/g, '.*');
    if (new RegExp(`^${regexStr}$`).test(filePath)) return true;
  }
  return false;
}

/**
 * Resolve an @include path relative to the including file's directory.
 * Returns the resolved absolute path, or null if invalid.
 */
function resolveIncludePath(includePath: string, fromDir: string): string | null {
  const cleaned = includePath.trim();
  if (cleaned.startsWith('~/')) {
    return join(homedir(), cleaned.slice(2));
  }
  if (isAbsolute(cleaned)) {
    return cleaned;
  }
  // Relative path — resolve from the including file's directory
  return resolve(fromDir, cleaned);
}

/**
 * Process @include directives in a markdown file's content.
 * Recursively expands included files up to MAX_INCLUDE_DEPTH.
 *
 * @param content   Raw file content (may contain @include lines)
 * @param fileDir   Directory of the file being processed (for relative paths)
 * @param depth     Current recursion depth (starts at 0)
 * @param visited   Set of already-included paths (prevents cycles)
 * @returns         Content with all @include directives expanded
 */
function expandIncludes(
  content: string,
  fileDir: string,
  depth: number,
  visited: Set<string>,
): string {
  if (depth >= MAX_INCLUDE_DEPTH) return content;

  return content.replace(/^@([^\n]+)$/gm, (_match, includePathRaw: string) => {
    const includePath = resolveIncludePath(includePathRaw.trim(), fileDir);
    if (!includePath) return `<!-- @include: invalid path "${includePathRaw}" -->`;
    if (visited.has(includePath)) return `<!-- @include: skipped (cycle) "${includePath}" -->`;
    if (!existsSync(includePath)) return `<!-- @include: not found "${includePath}" -->`;

    try {
      const includeContent = readFileSync(includePath, 'utf-8');
      visited.add(includePath);
      // Recursively expand includes in the included file
      const expanded = expandIncludes(includeContent, dirname(includePath), depth + 1, visited);
      return `<!-- @include: ${includePath} -->\n${expanded.trim()}`;
    } catch {
      return `<!-- @include: error reading "${includePath}" -->`;
    }
  });
}

export interface AgentsContext {
  instructions: string;
  sources: string[];
  totalBytes: number;
}

const MAX_BYTES = parseInt(process.env.AGENT_PROJECT_DOC_MAX_BYTES || String(32 * 1024));

export function loadProjectContext(startDir?: string, currentFilePath?: string): AgentsContext {
  const cwd = startDir || process.cwd();
  const gitRoot = findGitRoot(cwd);
  const searchRoot = gitRoot || cwd;
  const dirs = getPathChain(searchRoot, cwd);

  const sources: string[] = [];
  const parts: string[] = [];
  let totalBytes = 0;

  // Shared visited set for @include cycle prevention across all loaded files
  const includeVisited = new Set<string>();

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
        const rawContent = readFileSync(filePath, 'utf-8').trim();
        if (!rawContent) { break; }

        // ── @include expansion (Round 4: claude-code @include parity) ──────────
        includeVisited.add(filePath);
        const expandedContent = expandIncludes(rawContent, dir, 0, includeVisited);

        // ── YAML frontmatter paths: scope filter (Round 4: claude-code parity) ──
        const { body, paths: scopePaths } = parseFrontmatter(expandedContent);

        // If the file has a paths: scope filter and we know the current file being edited,
        // only inject this rule block if the current file matches one of the scope patterns.
        if (scopePaths && currentFilePath) {
          // Normalize to relative path for matching
          const relPath = currentFilePath.startsWith('/') && cwd
            ? currentFilePath.startsWith(cwd + '/')
              ? currentFilePath.slice(cwd.length + 1)
              : currentFilePath
            : currentFilePath;
          if (!matchesPathScope(relPath, scopePaths)) {
            break; // Scope doesn't match — skip this file's instructions
          }
        }

        const contentToInject = scopePaths ? body : expandedContent;
        if (contentToInject.trim()) {
          parts.push(`<!-- From: ${filePath} -->\n${contentToInject.trim()}`);
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
 * Load rules from .uagent/rules/*.md (project) and ~/.uagent/rules/*.md (global).
 *
 * Inspired by kstack article #15310 "规范体系" pattern:
 * Rule files are the SSOT for coding conventions, API style guides, naming rules, etc.
 * They are injected into every system prompt so the agent always follows project standards.
 *
 * File priority: project-level (.uagent/rules/) overrides global (~/.uagent/rules/).
 * Files are sorted alphabetically so load order is deterministic.
 *
 * Example files:
 *   .uagent/rules/coding.md       — TypeScript coding standards
 *   .uagent/rules/api-style.md    — API naming and response conventions
 *   .uagent/rules/spec-standard.md — Spec document format rules
 */

// Module-level cache for loadRules results.
// Key = resolved cwd; value = { result, timestamp }.
// TTL = 5 minutes — balances freshness vs. I/O savings.
// Note: in normal agent usage the parent agent already builds the system prompt once
// and shares it via setSystemPrompt(), so this cache mostly benefits edge cases where
// loadRules() is called directly multiple times (e.g. unit tests, debug-check).
const _rulesCache = new Map<string, { result: { content: string; sources: string[] }; ts: number }>();
const _RULES_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function loadRules(startDir?: string): { content: string; sources: string[] } {
  const cwd = startDir || process.cwd();

  // Fast path: return cached result if still fresh (5-minute TTL)
  const cached = _rulesCache.get(cwd);
  if (cached && Date.now() - cached.ts < _RULES_CACHE_TTL_MS) {
    return cached.result;
  }

  const rulesDir = join(cwd, '.uagent', 'rules');
  // #29: process.env.HOME || '~' is wrong — Node.js does NOT shell-expand '~'.
  // join('~', '.uagent') produces the literal string "~/.uagent", not the home dir.
  // Use os.homedir() as the authoritative cross-platform home directory.
  const globalRulesDir = join(process.env.HOME ?? homedir(), '.uagent', 'rules');

  const parts: string[] = [];
  const sources: string[] = [];

  // Helper: load all .md files from a directory, sorted for determinism
  function loadFromDir(dir: string) {
    if (!existsSync(dir)) return;
    let entries: string[];
    try { entries = readdirSync(dir).sort(); } catch { return; }
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const filePath = join(dir, entry);
      // Skip if already loaded (project overrides global)
      if (sources.some((s) => s.endsWith(entry))) continue;
      try {
        const content = readFileSync(filePath, 'utf-8').trim();
        if (content) {
          parts.push(`<!-- Rule: ${entry} -->\n${content}`);
          sources.push(filePath);
        }
      } catch { /* skip */ }
    }
  }

  // Helper: load a single .md file (if it exists and not already loaded by filename)
  function loadFile(filePath: string) {
    if (!existsSync(filePath)) return;
    const fileName = filePath.split('/').pop() ?? filePath;
    if (sources.some((s) => s.endsWith(fileName))) return; // already loaded
    try {
      const content = readFileSync(filePath, 'utf-8').trim();
      if (content) {
        parts.push(`<!-- Rule: ${fileName} -->\n${content}`);
        sources.push(filePath);
      }
    } catch { /* skip unreadable file */ }
  }

  // Project-level rules take precedence (loaded first so they win dedup check)
  loadFromDir(rulesDir);
  // Global rules fill in the rest
  loadFromDir(globalRulesDir);

  // Compat patch: also read ~/.codeflicker/AGENTS.md (CodeFlicker CLI global rules path).
  // CodeFlicker CLI stores global rules at ~/.codeflicker/AGENTS.md, while uagent uses
  // ~/.uagent/rules/*.md. This patch makes both paths work transparently.
  const cfAgentsMd = join(process.env.HOME ?? homedir(), '.codeflicker', 'AGENTS.md');
  loadFile(cfAgentsMd);

  const result = { content: parts.join('\n\n'), sources };
  // Write back to cache; evict oldest entry if Map grows beyond 20 keys
  _rulesCache.set(cwd, { result, ts: Date.now() });
  if (_rulesCache.size > 20) {
    const oldest = _rulesCache.keys().next().value;
    if (oldest) _rulesCache.delete(oldest);
  }
  return result;
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

6. **Parallel execution (Multi-Agent awareness)** — For complex tasks with independent subtasks:
   - Identify subtasks that have NO mutual dependencies and can run concurrently
   - Use the \`Task\` tool with \`parallel_tasks\` for fan-out execution across multiple subagents
   - Use \`SpawnAgent\` tool to delegate isolated subtasks to a fresh agent context
   - Phases with dependencies must run sequentially; phases without dependencies SHOULD run in parallel
   - After spawning subtasks, collect their outputs and synthesize a final result
   - Example: "Analyze project structure" AND "Audit dependencies" → run in parallel, not serial
---`;

export function buildSystemPromptWithContext(basePrompt: string, startDir?: string, currentFilePath?: string): string {
  const ctx = loadProjectContext(startDir, currentFilePath);
  const gitStatus = getGitStatus(startDir);
  const rules = loadRules(startDir);

  const sections: string[] = [basePrompt, HARNESS_CONSTRAINTS];

  // Inject project coding rules (SSOT — kstack article #15310)
  if (rules.content) {
    sections.push(`---\n## 📐 Project Rules (SSOT — follow these exactly)\n${rules.content}\n---`);
  }

  if (ctx.instructions) {
    sections.push(`---\n## Project Context\n${ctx.instructions}\n---`);
  }

  if (gitStatus) {
    sections.push(`---\n## Git Status (at session start — may be stale)\n\`\`\`\n${gitStatus}\n\`\`\`\n---`);
  }

  // s05 — Layer 1 skill injection: skill names + descriptions only (~100 tokens total).
  // Full skill bodies are loaded on-demand via the load_skill tool (Layer 2).
  try {
    const skillDescriptions = getSkillLoader(startDir ?? process.cwd()).getDescriptions();
    if (skillDescriptions) {
      sections.push(
        `---\n## Available Skills (use load_skill to access full instructions)\n${skillDescriptions}\n---`,
      );
    }
  } catch { /* non-fatal: no skills dir */ }

  return sections.join('\n\n');
}

/**
 * Capture a one-time git status snapshot for the system prompt.
 * Truncated to ~2 KB to avoid inflating the context with large diffs.
 *
 * Performance: git status result is cached per (cwd, startupTime) so that
 * repeated calls within the same process (one per agent turn) only pay the
 * execSync cost ONCE per session.  The cache key includes process.uptime()
 * rounded to the minute so it auto-expires on restart without extra logic.
 */
const _gitStatusCache = new Map<string, string | null>();

function getGitStatus(cwd?: string): string | null {
  const dir = cwd || process.cwd();
  // Cache key: directory + minute-bucket (auto-expires after ~1 min)
  const bucket = Math.floor(process.uptime() / 60);
  const key = `${dir}:${bucket}`;

  if (_gitStatusCache.has(key)) return _gitStatusCache.get(key)!;

  let result: string | null = null;
  try {
    // Use spawnSync instead of execSync to avoid shell injection and for better cross-platform safety
    const r = spawnSync('git', ['status', '--short', '--branch'], {
      cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000,
    });
    const raw = (r.status === 0 ? r.stdout : '').trim();
    if (raw) {
      // Truncate to 2 KB
      result = raw.length > 2048 ? raw.slice(0, 2048) + '\n...(truncated)' : raw;
    }
  } catch {
    result = null;
  }

  _gitStatusCache.set(key, result);
  // Evict stale keys to prevent unbounded Map growth on long sessions
  if (_gitStatusCache.size > 10) {
    const oldest = _gitStatusCache.keys().next().value;
    if (oldest) _gitStatusCache.delete(oldest);
  }
  return result;
}

export function initAgentsMd(dir: string): string {
  const filePath = join(dir, 'AGENTS.md');
  if (existsSync(filePath)) return `AGENTS.md already exists at ${filePath}`;
  // kstack article #15343 insight: AGENTS.md is re-inserted into every turn,
  // so it should read like instructions that are useful on EVERY turn, not a
  // one-time project background blurb. Write it as a set of standing orders.
  const content = [
    '# Agent Standing Orders',
    '',
    '<!-- Re-read every turn. Write rules that are useful EVERY time, not one-time background. -->',
    '<!-- Ref: kstack article #15343 — claude.md is re-inserted every turn, write accordingly. -->',
    '',
    '## Always Do',
    '- Use the provided tools (Bash, Read, Write, Edit, Grep) instead of writing helper scripts',
    '- Run `npm test` or `npm run build` after any code change to verify correctness',
    '- Follow the existing code style (indentation, naming, import order) of each file you edit',
    '- When unsure about a requirement, ask before writing code',
    '',
    '## Never Do',
    '- Hardcode API keys or secrets — use environment variables',
    '- Skip error handling on I/O or network calls',
    '- Commit broken builds',
    '',
    '## Project Setup',
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
    '## Security Constitution (enforced on every code change)',
    '1. **No hardcoded credentials** (CWE-798) — use env vars; throw at startup if missing.',
    '2. **Parameterized queries** (CWE-89) — no string interpolation in SQL/NoSQL.',
    '3. **Input validation** (CWE-20) — validate type, length, format at all external boundaries.',
    '4. **No command injection** (CWE-78) — use execFile(cmd, argsArray) not exec(string).',
    '5. **XSS prevention** (CWE-79) — never assign raw user data to innerHTML.',
    '6. **Minimal error exposure** (CWE-209) — log full errors server-side; return generic messages.',
    '7. **Path traversal prevention** (CWE-22) — resolve + assert paths stay within base dir.',
    '',
    '## Project-specific Notes',
    '<!-- Add anything the agent should remember on EVERY turn, e.g.:          -->',
    '<!-- - The primary database is PostgreSQL, always use parameterised queries -->',
    '<!-- - API responses must follow the {data, error, meta} envelope format    -->',
    '',
  ].join('\n');
  writeFileSync(filePath, content);
  return `✓ Created AGENTS.md at ${filePath}`;
}

function findGitRoot(dir: string): string | null {
  try {
    // Use spawnSync to avoid shell injection (no shell interpolation)
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000,
    });
    return r.status === 0 ? r.stdout.trim() : null;
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
