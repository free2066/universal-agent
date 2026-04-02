/**
 * Reverse Analyze Tool — Codebase Reverse Engineering
 *
 * Inspired by Cowork Forge's "Project Import & Reverse Analysis" feature
 * (kstack article #15345 "我组建了一个虚拟产研团队，7个成员全是AI"):
 *
 * "让'沉默'的代码'开口说话'" — Make silent code speak.
 *
 * For any existing project (legacy, inherited, or undocumented), this tool:
 *   Step 1 — Project Scan:    Detect tech stack, read key config files, list structure
 *   Step 2 — Reverse Reasoning: LLM infers original requirements, architecture decisions,
 *                               module responsibilities, and tech debt
 *   Step 3 — Document Output: Generate 4 core documents to .uagent/reverse/:
 *             idea.md   — Background, motivation, core features, target users
 *             prd.md    — Functional requirements, non-functional requirements, constraints
 *             design.md — Tech architecture, module design, data model, API definitions
 *             plan.md   — Current implementation state, roadmap, TODO items, tech debt
 *
 * Use cases:
 *   - Quickly understand an inherited or legacy project
 *   - Onboard new team members without documentation
 *   - Import an existing project into an AI-assisted workflow
 *   - Identify tech debt before refactoring
 *
 * Tool: ReverseAnalyze
 * REPL: /reverse [path]
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { basename, join, resolve } from 'path';
import { execSync } from 'child_process';
import { modelManager } from '../../../models/model-manager.js';
import type { ToolRegistration } from '../../../models/types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ReverseAnalysisResult {
  projectPath: string;
  techStack: string[];
  outputDir: string;
  documents: {
    idea: string;
    prd: string;
    design: string;
    plan: string;
  };
  summary: string;
}

interface ScanResult {
  projectName: string;
  techStack: string[];
  entryPoints: string[];
  keyFiles: Array<{ path: string; content: string }>;
  directoryTree: string;
  stats: { totalFiles: number; mainLanguage: string };
}

// ─── Step 1: Project Scanner ─────────────────────────────────────────────────

const CONFIG_FILES = [
  'package.json',
  'Cargo.toml',
  'requirements.txt',
  'pyproject.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'composer.json',
  'Gemfile',
  'mix.exs',
];

const DOC_FILES = [
  'README.md',
  'README.rst',
  'README.txt',
  'CHANGELOG.md',
  'ARCHITECTURE.md',
  'DESIGN.md',
  'docs/README.md',
];

/**
 * Detect tech stack from config files and source file extensions.
 */
function detectTechStack(projectRoot: string): string[] {
  const stack: string[] = [];

  // Check config files
  for (const cfg of CONFIG_FILES) {
    const p = join(projectRoot, cfg);
    if (!existsSync(p)) continue;

    switch (cfg) {
      case 'package.json': {
        try {
          const pkg = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
          const deps = { ...((pkg.dependencies ?? {}) as Record<string, unknown>), ...((pkg.devDependencies ?? {}) as Record<string, unknown>) };
          stack.push('Node.js / JavaScript');
          if ('typescript' in deps || existsSync(join(projectRoot, 'tsconfig.json'))) stack.push('TypeScript');
          if ('react' in deps) stack.push('React');
          if ('vue' in deps) stack.push('Vue');
          if ('express' in deps) stack.push('Express');
          if ('fastify' in deps) stack.push('Fastify');
          if ('next' in deps) stack.push('Next.js');
          if ('vitest' in deps || 'jest' in deps) stack.push('Testing (Vitest/Jest)');
        } catch { stack.push('Node.js'); }
        break;
      }
      case 'Cargo.toml': stack.push('Rust'); break;
      case 'requirements.txt':
      case 'pyproject.toml': {
        stack.push('Python');
        try {
          const content = readFileSync(p, 'utf-8');
          if (content.includes('fastapi')) stack.push('FastAPI');
          if (content.includes('django')) stack.push('Django');
          if (content.includes('flask')) stack.push('Flask');
          if (content.includes('torch') || content.includes('tensorflow')) stack.push('ML/Deep Learning');
        } catch { break; }
        break;
      }
      case 'go.mod': stack.push('Go'); break;
      case 'pom.xml':
      case 'build.gradle': stack.push('Java / JVM'); break;
      case 'composer.json': stack.push('PHP'); break;
      case 'Gemfile': stack.push('Ruby'); break;
    }
  }

  if (stack.length === 0) {
    // Fallback: detect from source file extensions
    try {
      const files = execSync(`find ${projectRoot} -maxdepth 3 -name "*.ts" -o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.java" 2>/dev/null | head -20`, {
        encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (files.includes('.ts')) stack.push('TypeScript');
      else if (files.includes('.py')) stack.push('Python');
      else if (files.includes('.go')) stack.push('Go');
      else if (files.includes('.rs')) stack.push('Rust');
      else if (files.includes('.java')) stack.push('Java');
    } catch { /* ignore */ }
  }

  return [...new Set(stack)];
}

/**
 * Get a compact directory tree (2 levels deep, skipping noise).
 */
function getDirectoryTree(projectRoot: string): string {
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'target', 'vendor', '.uagent']);

  function walk(dir: string, depth: number, prefix = ''): string[] {
    if (depth > 2) return [];
    const lines: string[] = [];
    try {
      const entries = readdirSync(dir).sort();
      for (const entry of entries) {
        if (SKIP.has(entry) || entry.startsWith('.')) continue;
        const fullPath = join(dir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            lines.push(`${prefix}${entry}/`);
            lines.push(...walk(fullPath, depth + 1, prefix + '  '));
          } else {
            lines.push(`${prefix}${entry}`);
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
    return lines;
  }

  const tree = walk(projectRoot, 0);
  return tree.slice(0, 80).join('\n'); // cap at 80 lines
}

/**
 * Count source files and detect primary language.
 */
function countFiles(projectRoot: string): { totalFiles: number; mainLanguage: string } {
  const langCounts: Record<string, number> = {};
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'target', 'vendor', '.uagent']);

  function walk(dir: string, depth: number) {
    if (depth > 4) return;
    try {
      for (const entry of readdirSync(dir)) {
        if (SKIP.has(entry) || entry.startsWith('.')) continue;
        const fullPath = join(dir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            walk(fullPath, depth + 1);
          } else {
            const ext = entry.split('.').pop() ?? '';
            langCounts[ext] = (langCounts[ext] ?? 0) + 1;
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  walk(projectRoot, 0);
  const total = Object.values(langCounts).reduce((a, b) => a + b, 0);
  const mainExt = Object.entries(langCounts).sort(([, a], [, b]) => b - a)[0]?.[0] ?? 'unknown';
  const extToLang: Record<string, string> = {
    ts: 'TypeScript', js: 'JavaScript', py: 'Python', go: 'Go',
    rs: 'Rust', java: 'Java', rb: 'Ruby', php: 'PHP', cs: 'C#',
  };
  return { totalFiles: total, mainLanguage: extToLang[mainExt] ?? mainExt };
}

/**
 * Read key files for context (README + config + core source files).
 * Limits each file to first N chars to control context size.
 */
function readKeyFiles(projectRoot: string): Array<{ path: string; content: string }> {
  const results: Array<{ path: string; content: string }> = [];
  const MAX_FILE_CHARS = 2000;
  const MAX_FILES = 8;

  // 1. Doc files
  for (const doc of DOC_FILES) {
    const p = join(projectRoot, doc);
    if (!existsSync(p)) continue;
    try {
      const content = readFileSync(p, 'utf-8').slice(0, MAX_FILE_CHARS);
      results.push({ path: doc, content });
      if (results.length >= 2) break; // max 2 doc files
    } catch { /* skip */ }
  }

  // 2. Config files (first match)
  for (const cfg of CONFIG_FILES) {
    const p = join(projectRoot, cfg);
    if (!existsSync(p)) continue;
    try {
      const content = readFileSync(p, 'utf-8').slice(0, MAX_FILE_CHARS);
      results.push({ path: cfg, content });
      break;
    } catch { /* skip */ }
  }

  // 3. Main entry point candidates
  const entryPoints = [
    'src/index.ts', 'src/main.ts', 'src/app.ts', 'index.ts', 'main.ts',
    'src/index.js', 'index.js', 'main.go', 'src/main.rs', 'main.py', 'app.py',
  ];
  for (const ep of entryPoints) {
    const p = join(projectRoot, ep);
    if (!existsSync(p)) continue;
    try {
      const content = readFileSync(p, 'utf-8').slice(0, MAX_FILE_CHARS);
      results.push({ path: ep, content });
      break;
    } catch { /* skip */ }
  }

  // 4. Core source files (look for `core/` or `lib/` or `src/core/`)
  const coreDir = ['src/core', 'core', 'lib', 'src/lib'].find((d) => existsSync(join(projectRoot, d)));
  if (coreDir) {
    try {
      const entries = readdirSync(join(projectRoot, coreDir)).filter((f) => /\.(ts|js|py|go|rs)$/.test(f)).slice(0, 3);
      for (const entry of entries) {
        if (results.length >= MAX_FILES) break;
        const p = join(projectRoot, coreDir, entry);
        try {
          const content = readFileSync(p, 'utf-8').slice(0, MAX_FILE_CHARS);
          results.push({ path: `${coreDir}/${entry}`, content });
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return results.slice(0, MAX_FILES);
}

/**
 * Full project scan: detect stack, read key files, get directory tree.
 */
function scanProject(projectRoot: string): ScanResult {
  const techStack = detectTechStack(projectRoot);
  const keyFiles = readKeyFiles(projectRoot);
  const directoryTree = getDirectoryTree(projectRoot);
  const { totalFiles, mainLanguage } = countFiles(projectRoot);
  const projectName = basename(projectRoot);

  const entryPoints = keyFiles.map((f) => f.path).filter((p) =>
    p.includes('main') || p.includes('index') || p.includes('app'),
  );

  return { projectName, techStack, entryPoints, keyFiles, directoryTree, stats: { totalFiles, mainLanguage } };
}

// ─── Step 2: LLM Reverse Reasoning ───────────────────────────────────────────

function buildReversePrompt(scan: ScanResult, focus?: string): string {
  const keyFilesSection = scan.keyFiles
    .map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join('\n\n');

  const focusSection = focus
    ? `\n## Focus Area\nPay special attention to: ${focus}\n`
    : '';

  return `You are a senior software architect performing reverse engineering on an existing codebase.
Your job is to infer the original requirements, architecture decisions, and project state from the code itself.

## Project: ${scan.projectName}
- Tech Stack: ${scan.techStack.join(', ') || 'Unknown'}
- Main Language: ${scan.stats.mainLanguage}
- Total Files: ${scan.stats.totalFiles}
- Entry Points: ${scan.entryPoints.join(', ') || 'None detected'}
${focusSection}
## Directory Structure
\`\`\`
${scan.directoryTree}
\`\`\`

## Key Files
${keyFilesSection}

## Your Task
Based on the above, infer and generate 4 documents. Output as JSON with exactly these keys:
{
  "idea": "...",
  "prd": "...",
  "design": "...",
  "plan": "..."
}

### idea.md content should cover:
- Project background and motivation (why was this built?)
- Core features and capabilities
- Target users / stakeholders
- Key value proposition

### prd.md content should cover:
- Functional requirements (what the system does)
- Non-functional requirements (performance, security, scalability)
- Known constraints and limitations
- Edge cases and boundary conditions you can infer from the code

### design.md content should cover:
- Overall architecture pattern (MVC, event-driven, microservices, etc.)
- Module breakdown and responsibilities
- Key data models and their relationships
- API interfaces (if detectable)
- Tech choices and likely rationale

### plan.md content should cover:
- Current implementation state (what's built, what's partial)
- Obvious TODO items or incomplete features
- Identified tech debt (code smells, workarounds, fragile areas)
- Suggested next steps / roadmap

Rules:
- Be concrete and specific — reference actual file names, class names, function names from the code
- If something is unclear, say "Cannot determine from code alone — needs clarification"
- Do NOT make up features that aren't in the code
- Output ONLY the JSON object — no prose, no markdown fences around the JSON itself
`;
}

// ─── Step 3: Document Writer ──────────────────────────────────────────────────

const DOC_TEMPLATES = {
  idea: (projectName: string) => `# ${projectName}: Project Idea & Background\n\n_Generated by ReverseAnalyze — ${new Date().toISOString().slice(0, 10)}_\n\n`,
  prd: (projectName: string) => `# ${projectName}: Product Requirements Document\n\n_Generated by ReverseAnalyze — ${new Date().toISOString().slice(0, 10)}_\n\n`,
  design: (projectName: string) => `# ${projectName}: Technical Design Document\n\n_Generated by ReverseAnalyze — ${new Date().toISOString().slice(0, 10)}_\n\n`,
  plan: (projectName: string) => `# ${projectName}: Implementation Plan & Roadmap\n\n_Generated by ReverseAnalyze — ${new Date().toISOString().slice(0, 10)}_\n\n`,
};

function writeDocuments(
  outputDir: string,
  projectName: string,
  docs: { idea: string; prd: string; design: string; plan: string },
): { idea: string; prd: string; design: string; plan: string } {
  mkdirSync(outputDir, { recursive: true, mode: 0o755 });

  const paths = {
    idea: join(outputDir, 'idea.md'),
    prd: join(outputDir, 'prd.md'),
    design: join(outputDir, 'design.md'),
    plan: join(outputDir, 'plan.md'),
  };

  for (const [key, content] of Object.entries(docs)) {
    const k = key as keyof typeof docs;
    const header = DOC_TEMPLATES[k](projectName);
    writeFileSync(paths[k], header + content, { encoding: 'utf-8', mode: 0o644 });
  }

  return paths;
}

// ─── JSON Parse Fallback ─────────────────────────────────────────────────────

/**
 * Fallback document field extractor for when JSON.parse fails.
 *
 * Inspired by Cowork Forge's robust JSON handling: rather than throwing on
 * malformed LLM output, attempt to extract each field individually using
 * targeted regex patterns. This dramatically improves reliability on models
 * that occasionally wrap JSON in prose or use non-standard escaping.
 *
 * Strategy:
 *   1. Try to extract each field using regex: "key": "value" or "key": `...`
 *   2. For multiline values, look for the field up to the next top-level key
 *   3. Fill in placeholder text for any field that cannot be extracted
 *
 * @param raw          Raw LLM response text (may contain partial JSON)
 * @param projectName  Project name for placeholder fallback text
 * @returns            Extracted document fields (never null — fills in placeholders)
 */
function extractDocFieldsFallback(
  raw: string,
  projectName: string,
): { idea: string; prd: string; design: string; plan: string } {
  const fields = ['idea', 'prd', 'design', 'plan'] as const;
  const result: Record<string, string> = {};

  for (const field of fields) {
    // Strategy 1: Match JSON string value (handles escaped newlines)
    // Pattern: "idea": "...", (up to next top-level key or end)
    const jsonStringMatch = raw.match(
      new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`),
    );
    if (jsonStringMatch) {
      // Unescape JSON string escapes
      try {
        result[field] = JSON.parse(`"${jsonStringMatch[1]}"`);
        continue;
      } catch { /* fall through */ }
    }

    // Strategy 2: Match value between field and next top-level key or closing brace
    // Handles cases where the LLM used unescaped newlines inside the string
    const nextFieldPattern = fields.filter((f) => f !== field).join('|');
    const multilineMatch = raw.match(
      new RegExp(`"${field}"\\s*:\\s*"([\\s\\S]*?)(?=",\\s*"(?:${nextFieldPattern})"|}\\s*$)`, 'm'),
    );
    if (multilineMatch) {
      result[field] = multilineMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').trim();
      continue;
    }

    // Strategy 3: Placeholder
    result[field] = `_Could not extract ${field} document for ${projectName} — LLM response was malformed._`;
  }

  return result as { idea: string; prd: string; design: string; plan: string };
}

// ─── Main Export ─────────────────────────────────────────────────────────────

/**
 * Reverse-engineer an existing project into 4 documentation files.
 *
 * @param projectPath  Path to the project to analyze (defaults to cwd)
 * @param focus        Optional area to focus on (e.g. "auth module", "database layer")
 * @returns            ReverseAnalysisResult with document paths and summary
 */
export async function reverseAnalyze(
  projectPath?: string,
  focus?: string,
): Promise<ReverseAnalysisResult> {
  const projectRoot = resolve(projectPath ?? process.cwd());
  if (!existsSync(projectRoot)) {
    throw new Error(`Project path does not exist: ${projectRoot}`);
  }

  // ── Step 1: Scan ────────────────────────────────────────────────────────
  const scan = scanProject(projectRoot);

  // ── Step 2: LLM Reverse Reasoning ──────────────────────────────────────
  const prompt = buildReversePrompt(scan, focus);

  const client = modelManager.getClient('main');
  const response = await client.chat({
    systemPrompt: [
      'You are a senior software architect performing reverse engineering.',
      'Analyze existing code and infer requirements, architecture, and project state.',
      'Be specific and reference actual code artifacts. Output only valid JSON.',
    ].join(' '),
    messages: [{ role: 'user', content: prompt }],
  });

  // Parse LLM output
  // Inspired by Cowork Forge's robust JSON parsing with field-level fallback:
  // "When full JSON parse fails, attempt per-field extraction before giving up"
  const raw = response.content.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);

  let docs: { idea: string; prd: string; design: string; plan: string };

  if (!jsonMatch) {
    // Full JSON extraction failed — use per-field regex fallback
    docs = extractDocFieldsFallback(raw, scan.projectName);
  } else {
    try {
      docs = JSON.parse(jsonMatch[0]) as typeof docs;
    } catch {
      // JSON parse failed even with matched block — use per-field regex fallback
      docs = extractDocFieldsFallback(jsonMatch[0], scan.projectName);
    }
  }

  // Validate required keys — fill in any missing fields
  for (const key of ['idea', 'prd', 'design', 'plan']) {
    if (!docs[key as keyof typeof docs] || typeof docs[key as keyof typeof docs] !== 'string') {
      docs[key as keyof typeof docs] = `_Could not generate ${key} document — LLM response was incomplete._`;
    }
  }

  // ── Step 3: Write Documents ─────────────────────────────────────────────
  const outputDir = join(projectRoot, '.uagent', 'reverse');
  const docPaths = writeDocuments(outputDir, scan.projectName, docs);

  const summary = [
    `# Reverse Analysis: ${scan.projectName}`,
    ``,
    `## Project Overview`,
    `- **Tech Stack**: ${scan.techStack.join(', ') || 'Unknown'}`,
    `- **Main Language**: ${scan.stats.mainLanguage}`,
    `- **Total Files**: ${scan.stats.totalFiles}`,
    ``,
    `## Generated Documents`,
    `- 📋 \`idea.md\` — Background, motivation, core features`,
    `- 📑 \`prd.md\` — Functional & non-functional requirements`,
    `- 🏗️ \`design.md\` — Architecture, modules, data model`,
    `- 🗺️ \`plan.md\` — Current state, roadmap, tech debt`,
    ``,
    `**Output directory**: \`${outputDir}\``,
    ``,
    `## Quick Summary`,
    docs.idea.slice(0, 300) + (docs.idea.length > 300 ? '\n...(see idea.md for full details)' : ''),
  ].join('\n');

  return {
    projectPath: projectRoot,
    techStack: scan.techStack,
    outputDir,
    documents: docPaths,
    summary,
  };
}

// ─── Tool Registration ────────────────────────────────────────────────────────

export const reverseAnalyzeTool: ToolRegistration = {
  definition: {
    name: 'ReverseAnalyze',
    description: [
      'Reverse-engineer an existing codebase into 4 documentation files.',
      'Inspired by Cowork Forge\'s project import feature: "让沉默的代码开口说话" (make silent code speak).',
      '',
      'Performs 3-step analysis:',
      '  Step 1 — Scan: Detect tech stack, read key config/source files, map directory structure',
      '  Step 2 — Reason: LLM infers original requirements, architecture decisions, tech debt',
      '  Step 3 — Write: Generate 4 documents to .uagent/reverse/',
      '    idea.md   — Background, motivation, core features, target users',
      '    prd.md    — Functional & non-functional requirements, constraints',
      '    design.md — Tech architecture, module design, data model, API definitions',
      '    plan.md   — Current state, roadmap, TODO items, tech debt',
      '',
      'Use cases:',
      '  - Understand an inherited or legacy project quickly',
      '  - Onboard new team members without existing documentation',
      '  - Import a project into an AI-assisted development workflow',
      '  - Identify tech debt before a refactor',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        project_path: {
          type: 'string',
          description: 'Absolute path to the project root to analyze. Defaults to current working directory.',
        },
        focus: {
          type: 'string',
          description: 'Optional: focus the analysis on a specific area (e.g. "auth module", "database layer", "API design").',
        },
      },
      required: [],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const { project_path, focus } = args as { project_path?: string; focus?: string };

    try {
      const result = await reverseAnalyze(project_path, focus);
      return result.summary;
    } catch (err) {
      return `ReverseAnalyze error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
