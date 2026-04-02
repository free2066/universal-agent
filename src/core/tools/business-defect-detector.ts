/**
 * Business Defect Detector — 5-Stage Serial Pipeline
 *
 * Inspired by kstack article #15360 "业务缺陷检测流水线：让 AI 成为你的代码质量守门员"
 *
 * Problem: Static tools (ESLint, SonarQube) catch syntax/generic issues but CANNOT
 * detect business logic defects — cases where code is syntactically correct but
 * violates business rules defined in PRD/TRD.
 *
 * Solution: A 5-stage serial pipeline where each stage's output feeds the next,
 * building a full evidence chain for multi-source defect reasoning:
 *
 *   Stage 1 — Architecture Analysis:
 *     Scan the codebase structure, entry points, module boundaries.
 *     Output: Architecture map (similar to AGENTS.md — who owns what, how modules connect)
 *
 *   Stage 2 — PRD/Requirements Extraction:
 *     Parse requirement documents (markdown, URLs, plain text) into structured JSON.
 *     Output: Structured requirements: { id, title, rule, acceptance_criteria, risk_level }[]
 *
 *   Stage 3 — Technical Spec Mapping:
 *     Map each business rule to the technical entities that implement it.
 *     Output: { req_id, business_rule, tech_entities: [file, function, line_range][], risk }[]
 *
 *   Stage 4 — Function-level Git Diff Analysis:
 *     Analyze git diff at FUNCTION granularity (not file level).
 *     Output: { function_name, file, change_type, diff_snippet, risk_notes }[]
 *
 *   Stage 5 — Multi-source Defect Judgment:
 *     Cross-reference: Architecture + Requirements + Spec Mapping + Diff Analysis.
 *     Output: BusinessDefect[] with severity, evidence chain, and fix suggestions.
 *
 * Usage:
 *   BusinessDefectDetect({ prd_text: "...", diff: "...", project_root: "..." })
 *   BusinessDefectDetect({ prd_url: "...", staged_only: true })
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { modelManager } from '../../models/model-manager.js';
import type { ToolRegistration } from '../../models/types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type DefectSeverity = 'P0' | 'P1' | 'P2' | 'P3';

/**
 * A single business logic defect detected by the pipeline.
 *
 * Unlike generic ReviewIssue (which catches code style/security),
 * BusinessDefect specifically identifies WHERE a business rule is violated
 * and links it back to the original requirement.
 */
export interface BusinessDefect {
  /** Severity: P0=critical business logic broken, P1=must fix, P2=should fix, P3=minor */
  severity: DefectSeverity;
  /** File path where the defect manifests */
  file: string;
  /** Function name (function-level precision from Stage 4) */
  function?: string;
  /** Line number or range (e.g. "45-58") */
  line?: string;
  /** Short defect title */
  title: string;
  /** Detailed explanation of WHY this violates the business rule */
  detail: string;
  /** The requirement ID this defect traces back to (from Stage 2) */
  requirement_id?: string;
  /** The business rule being violated */
  business_rule?: string;
  /** Concrete fix suggestion with code example if possible */
  fix_suggestion?: string;
  /**
   * Evidence chain — traces the reasoning path:
   * architecture_context → business_rule → tech_mapping → code_change → defect
   */
  evidence_chain?: {
    architecture_context?: string;
    business_rule_source?: string;
    tech_entity?: string;
    code_change_summary?: string;
  };
}

export interface ArchitectureMap {
  /** Module/service name → description + entry files */
  modules: Array<{ name: string; description: string; entry_files: string[]; key_functions: string[] }>;
  /** Cross-cutting concerns (auth, logging, error handling) */
  cross_cutting: string[];
  /** Data flow summary */
  data_flow: string;
  /** Raw text for prompt injection */
  raw: string;
}

export interface StructuredRequirement {
  id: string;
  title: string;
  /** The concrete business rule that must hold */
  rule: string;
  /** What a correct implementation looks like */
  acceptance_criteria: string[];
  /** How risky a violation would be: high / medium / low */
  risk_level: 'high' | 'medium' | 'low';
}

export interface TechSpecMapping {
  req_id: string;
  business_rule: string;
  /** Technical entities (files/functions) that implement this rule */
  tech_entities: Array<{ file: string; function_name?: string; line_range?: string }>;
  /** Overall implementation risk */
  risk: 'high' | 'medium' | 'low';
}

export interface FunctionLevelChange {
  /** Function name */
  function_name: string;
  /** File containing the function */
  file: string;
  /** Type of change */
  change_type: 'added' | 'modified' | 'deleted' | 'moved';
  /** The relevant diff snippet for this function */
  diff_snippet: string;
  /** AI-identified risk notes for this specific function change */
  risk_notes: string[];
}

export interface BusinessDefectReport {
  /** Total defects by severity */
  summary: { P0: number; P1: number; P2: number; P3: number };
  /** All detected defects, sorted by severity */
  defects: BusinessDefect[];
  /** Whether P0/P1 blockers exist */
  hasBlockers: boolean;
  /** Stage metadata (for debugging/transparency) */
  stages: {
    architecture?: string;
    requirementsCount?: number;
    mappingsCount?: number;
    functionsAnalyzed?: number;
  };
  /** Full markdown report */
  markdown: string;
}

// ─── Stage 1: Architecture Analysis ─────────────────────────────────────────

/**
 * Stage 1: Analyze the codebase architecture.
 * Produces a module map that contextualizes ALL subsequent stages.
 * Similar to AGENTS.md generation but focused on business module boundaries.
 */
async function stage1_architectureAnalysis(projectRoot: string): Promise<ArchitectureMap> {
  const client = modelManager.getClient('main');

  // Gather file structure signals
  let fileTree = '';
  try {
    fileTree = execSync(
      'find . -type f \\( -name "*.ts" -o -name "*.js" -o -name "*.go" -o -name "*.py" -o -name "*.java" \\) ' +
      '! -path "*/node_modules/*" ! -path "*/.git/*" ! -path "*/dist/*" ! -path "*/build/*" | head -80',
      { cwd: projectRoot, encoding: 'utf-8', timeout: 5000 },
    ).trim();
  } catch { /* non-fatal */ }

  // Read key files if they exist
  const contextFiles: string[] = [];
  for (const name of ['AGENTS.md', 'README.md', 'package.json', 'go.mod', 'pom.xml']) {
    const p = join(projectRoot, name);
    if (existsSync(p)) {
      contextFiles.push(`### ${name}\n${readFileSync(p, 'utf-8').slice(0, 2000)}`);
    }
  }

  const prompt = [
    `# Stage 1: Architecture Analysis`,
    ``,
    `Analyze the codebase architecture to build a module map.`,
    `This map will be used in subsequent stages to understand WHICH modules are responsible for WHICH business rules.`,
    ``,
    `## File Structure`,
    '```',
    fileTree || '(could not list files)',
    '```',
    ``,
    ...(contextFiles.length > 0 ? [`## Key Files`, ...contextFiles] : []),
    ``,
    `## Output Format (JSON only, no markdown fences)`,
    `{`,
    `  "modules": [`,
    `    { "name": "module-name", "description": "what it does", "entry_files": ["src/..."], "key_functions": ["functionName"] }`,
    `  ],`,
    `  "cross_cutting": ["auth middleware", "error handler", ...],`,
    `  "data_flow": "brief description of how data flows through the system"`,
    `}`,
  ].join('\n');

  try {
    const response = await client.chat({
      systemPrompt: 'You are a senior software architect. Analyze code structures and produce precise architecture maps. Output ONLY valid JSON.',
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = response.content.trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Omit<ArchitectureMap, 'raw'>;
      return { ...parsed, raw };
    }
  } catch { /* fall through */ }

  // Fallback: minimal architecture map
  return {
    modules: [],
    cross_cutting: [],
    data_flow: 'Could not determine architecture automatically.',
    raw: fileTree,
  };
}

// ─── Stage 2: PRD Requirements Extraction ────────────────────────────────────

/**
 * Stage 2: Parse PRD/TRD documents into structured requirement objects.
 * Each requirement gets an ID, a business rule, acceptance criteria, and risk level.
 */
async function stage2_extractRequirements(
  prdText: string,
  architectureMap: ArchitectureMap,
): Promise<StructuredRequirement[]> {
  const client = modelManager.getClient('main');

  const prompt = [
    `# Stage 2: PRD Requirements Extraction`,
    ``,
    `Extract structured business requirements from the following PRD/TRD document.`,
    `Focus on BUSINESS RULES — constraints that the code MUST enforce (not UI/UX requirements).`,
    ``,
    `## Architecture Context (from Stage 1)`,
    architectureMap.data_flow,
    architectureMap.modules.map((m) => `- ${m.name}: ${m.description}`).join('\n'),
    ``,
    `## PRD/TRD Document`,
    prdText.slice(0, 6000),
    ``,
    `## Output Format (JSON array only, no markdown fences)`,
    `[`,
    `  {`,
    `    "id": "REQ-001",`,
    `    "title": "Short requirement title",`,
    `    "rule": "The precise business rule that code must enforce",`,
    `    "acceptance_criteria": ["criterion 1", "criterion 2"],`,
    `    "risk_level": "high|medium|low"`,
    `  }`,
    `]`,
    ``,
    `Include ONLY requirements that can be verified by inspecting code.`,
    `Exclude pure UI requirements, copy requirements, or design requirements.`,
  ].join('\n');

  try {
    const response = await client.chat({
      systemPrompt: 'You are a business analyst who converts PRD documents into structured technical requirements. Output ONLY valid JSON.',
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = response.content.trim();
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as StructuredRequirement[];
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch { /* fall through */ }

  return [];
}

// ─── Stage 3: Technical Spec Mapping ─────────────────────────────────────────

/**
 * Stage 3: Map each business requirement to the technical entities that implement it.
 * This creates the "business rule → code location" traceability chain.
 */
async function stage3_techSpecMapping(
  requirements: StructuredRequirement[],
  architectureMap: ArchitectureMap,
  diff: string,
): Promise<TechSpecMapping[]> {
  if (requirements.length === 0) return [];

  const client = modelManager.getClient('main');

  const reqList = requirements.map((r) =>
    `[${r.id}] ${r.title}: ${r.rule} (risk: ${r.risk_level})`,
  ).join('\n');

  const moduleList = architectureMap.modules.map((m) =>
    `${m.name} (${m.description}): files=${m.entry_files.join(', ')}, fns=${m.key_functions.join(', ')}`,
  ).join('\n');

  const prompt = [
    `# Stage 3: Technical Specification Mapping`,
    ``,
    `For each business requirement below, identify WHICH technical entities (files, functions) implement it.`,
    `Use the architecture map and git diff to locate the implementation.`,
    ``,
    `## Business Requirements (from Stage 2)`,
    reqList,
    ``,
    `## Architecture Modules (from Stage 1)`,
    moduleList || '(no module info)',
    ``,
    `## Git Diff (changed code)`,
    diff.slice(0, 5000),
    ``,
    `## Output Format (JSON array only, no markdown fences)`,
    `[`,
    `  {`,
    `    "req_id": "REQ-001",`,
    `    "business_rule": "the rule being mapped",`,
    `    "tech_entities": [`,
    `      { "file": "src/handler.ts", "function_name": "processOrder", "line_range": "45-80" }`,
    `    ],`,
    `    "risk": "high|medium|low"`,
    `  }`,
    `]`,
  ].join('\n');

  try {
    const response = await client.chat({
      systemPrompt: 'You are a technical architect who traces business requirements to code implementations. Output ONLY valid JSON.',
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = response.content.trim();
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as TechSpecMapping[];
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch { /* fall through */ }

  return [];
}

// ─── Stage 4: Function-level Git Diff Analysis ───────────────────────────────

/**
 * Stage 4: Analyze git diff at FUNCTION granularity.
 *
 * Key innovation from article #15360:
 * "精准变更分析：聚焦函数级别，避免全库扫描噪音"
 *
 * Instead of treating diff as a flat text blob, we extract per-function changes
 * and annotate each with risk notes based on the function's role.
 */
async function stage4_functionLevelDiffAnalysis(
  diff: string,
  architectureMap: ArchitectureMap,
  specMappings: TechSpecMapping[],
): Promise<FunctionLevelChange[]> {
  if (!diff) return [];

  const client = modelManager.getClient('main');

  // Build a list of high-risk functions from spec mappings
  const highRiskFunctions = specMappings
    .filter((m) => m.risk === 'high')
    .flatMap((m) => m.tech_entities.map((e) => e.function_name).filter(Boolean))
    .join(', ');

  const prompt = [
    `# Stage 4: Function-level Git Diff Analysis`,
    ``,
    `Analyze the following git diff at FUNCTION granularity.`,
    `For each changed function, extract the function name, file, change type, diff snippet, and risk notes.`,
    ``,
    `High-risk functions identified in Stage 3: ${highRiskFunctions || '(none identified)'}`,
    ``,
    `## Git Diff`,
    diff.slice(0, 8000),
    ``,
    `## Output Format (JSON array only, no markdown fences)`,
    `[`,
    `  {`,
    `    "function_name": "processOrder",`,
    `    "file": "src/order/handler.ts",`,
    `    "change_type": "modified",`,
    `    "diff_snippet": "the relevant 5-10 lines of diff for this function",`,
    `    "risk_notes": ["removed null check for userId", "timezone not applied to timestamp"]`,
    `  }`,
    `]`,
    ``,
    `Focus on extracting RISK NOTES — specific concerns about what the change might break.`,
    `Each risk note should be a concrete, actionable statement.`,
  ].join('\n');

  try {
    const response = await client.chat({
      systemPrompt: 'You are a senior code reviewer specializing in function-level change analysis. Output ONLY valid JSON.',
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = response.content.trim();
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as FunctionLevelChange[];
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch { /* fall through */ }

  return [];
}

// ─── Stage 5: Multi-source Defect Judgment ───────────────────────────────────

/**
 * Stage 5: Cross-reference all four evidence sources to detect business defects.
 *
 * Evidence chain:
 *   Architecture context (Stage 1)
 *   + Business rules (Stage 2)
 *   + Tech entity mapping (Stage 3)
 *   + Function-level changes (Stage 4)
 *   → Business defect report
 *
 * This is the "multi-source evidence reasoning" described in article #15360.
 */
async function stage5_defectJudgment(
  architectureMap: ArchitectureMap,
  requirements: StructuredRequirement[],
  specMappings: TechSpecMapping[],
  functionChanges: FunctionLevelChange[],
): Promise<BusinessDefect[]> {
  if (functionChanges.length === 0 && specMappings.length === 0) return [];

  const client = modelManager.getClient('main');

  const archSummary = [
    `Modules: ${architectureMap.modules.map((m) => m.name).join(', ')}`,
    `Data flow: ${architectureMap.data_flow}`,
  ].join('\n');

  const reqSummary = requirements.map((r) =>
    `[${r.id}] ${r.title} (${r.risk_level} risk)\n  Rule: ${r.rule}\n  Criteria: ${r.acceptance_criteria.join('; ')}`,
  ).join('\n\n');

  const mappingSummary = specMappings.map((m) =>
    `[${m.req_id}] ${m.business_rule}\n  → ${m.tech_entities.map((e) => `${e.file}:${e.function_name ?? '?'}`).join(', ')} (risk: ${m.risk})`,
  ).join('\n\n');

  const changeSummary = functionChanges.map((c) =>
    `[${c.change_type}] ${c.function_name} in ${c.file}\n  Risks: ${c.risk_notes.join('; ')}\n  Diff: ${c.diff_snippet.slice(0, 300)}`,
  ).join('\n\n');

  const prompt = [
    `# Stage 5: Multi-source Business Defect Judgment`,
    ``,
    `You are the final judgment stage of a business defect detection pipeline.`,
    `Cross-reference the four evidence sources below to identify business logic defects.`,
    ``,
    `A BUSINESS DEFECT is: code that is syntactically correct but violates a business rule.`,
    `NOT a business defect: syntax errors, style issues, generic null checks.`,
    ``,
    `## Evidence 1: Architecture Context (Stage 1)`,
    archSummary,
    ``,
    `## Evidence 2: Business Requirements (Stage 2)`,
    reqSummary || '(no requirements provided)',
    ``,
    `## Evidence 3: Requirement→Code Mapping (Stage 3)`,
    mappingSummary || '(no mappings identified)',
    ``,
    `## Evidence 4: Function-level Changes (Stage 4)`,
    changeSummary || '(no function changes analyzed)',
    ``,
    `## Output Format (JSON array only, no markdown fences)`,
    `[`,
    `  {`,
    `    "severity": "P0|P1|P2|P3",`,
    `    "file": "src/...",`,
    `    "function": "functionName",`,
    `    "line": "45-58",`,
    `    "title": "Short defect title",`,
    `    "detail": "Why this violates the business rule — be specific",`,
    `    "requirement_id": "REQ-001",`,
    `    "business_rule": "The rule being violated",`,
    `    "fix_suggestion": "Concrete fix — include code example if possible",`,
    `    "evidence_chain": {`,
    `      "architecture_context": "module/service context",`,
    `      "business_rule_source": "where the rule comes from",`,
    `      "tech_entity": "file:function",`,
    `      "code_change_summary": "what changed that causes this defect"`,
    `    }`,
    `  }`,
    `]`,
    ``,
    `Severity guide:`,
    `  P0: Critical business logic broken — data corruption, financial error, security bypass`,
    `  P1: Business rule clearly violated — must fix before deploy`,
    `  P2: Business rule at risk — should fix, may cause edge case failures`,
    `  P3: Minor deviation — best practice not followed, low immediate risk`,
    ``,
    `If no business defects are found, return: []`,
  ].join('\n');

  try {
    const response = await client.chat({
      systemPrompt: [
        'You are an expert business logic auditor. Your job is to find places where code changes violate business rules.',
        'You reason from evidence: architecture context + business rules + code mapping + specific changes.',
        'You ONLY flag genuine business logic violations — not generic code quality issues.',
        'Output ONLY valid JSON.',
      ].join('\n'),
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = response.content.trim();
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as BusinessDefect[];
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch { /* fall through */ }

  return [];
}

// ─── Report Builder ───────────────────────────────────────────────────────────

function buildDefectMarkdownReport(
  defects: BusinessDefect[],
  stages: BusinessDefectReport['stages'],
): string {
  const lines: string[] = [
    `## 🔍 Business Defect Detection Report`,
    `> Powered by 5-Stage Serial Pipeline (kstack article #15360)`,
    ``,
  ];

  if (defects.length === 0) {
    lines.push(`✅ **No business defects detected** — all inspected changes appear to comply with business rules.`);
    lines.push('');
  } else {
    const p0 = defects.filter((d) => d.severity === 'P0');
    const p1 = defects.filter((d) => d.severity === 'P1');
    const p2 = defects.filter((d) => d.severity === 'P2');
    const p3 = defects.filter((d) => d.severity === 'P3');

    lines.push(`> **${p0.length} P0** (critical) · **${p1.length} P1** (must fix) · **${p2.length} P2** (should fix) · **${p3.length} P3** (minor)`);
    lines.push('');

    const groups: [string, BusinessDefect[]][] = [
      ['🚨 P0 — Critical Business Logic Broken', p0],
      ['🔴 P1 — Must Fix Before Deploy', p1],
      ['🟡 P2 — Should Fix', p2],
      ['🔵 P3 — Minor Deviation', p3],
    ];

    for (const [label, group] of groups) {
      if (group.length === 0) continue;
      lines.push(`### ${label}`, '');
      for (const defect of group) {
        const loc = defect.function ? `:${defect.function}` : '';
        const lineLoc = defect.line ? `#L${defect.line}` : '';
        lines.push(`**[${defect.file}${loc}${lineLoc}]** ${defect.title}`);
        if (defect.requirement_id) {
          lines.push(`> 📋 Requirement: \`${defect.requirement_id}\` — ${defect.business_rule ?? ''}`);
        }
        lines.push(`> ${defect.detail}`);
        if (defect.fix_suggestion) {
          lines.push(`> 💡 **Fix:** ${defect.fix_suggestion}`);
        }
        if (defect.evidence_chain) {
          const ec = defect.evidence_chain;
          const chainParts = [
            ec.architecture_context && `arch: ${ec.architecture_context}`,
            ec.tech_entity && `entity: ${ec.tech_entity}`,
            ec.code_change_summary && `change: ${ec.code_change_summary}`,
          ].filter(Boolean);
          if (chainParts.length > 0) {
            lines.push(`> 🔗 Evidence: ${chainParts.join(' → ')}`);
          }
        }
        lines.push('');
      }
    }
  }

  // Pipeline transparency block
  lines.push('---', '', '### 🔬 Pipeline Execution Summary', '');
  lines.push(`| Stage | Result |`);
  lines.push(`|-------|--------|`);
  lines.push(`| Stage 1 — Architecture Analysis | ${stages.architecture ? '✅ Completed' : '⚠️ Skipped'} |`);
  lines.push(`| Stage 2 — Requirements Extraction | ✅ ${stages.requirementsCount ?? 0} requirements parsed |`);
  lines.push(`| Stage 3 — Tech Spec Mapping | ✅ ${stages.mappingsCount ?? 0} mappings generated |`);
  lines.push(`| Stage 4 — Function-level Diff | ✅ ${stages.functionsAnalyzed ?? 0} functions analyzed |`);
  lines.push(`| Stage 5 — Defect Judgment | ✅ ${defects.length} defects found |`);
  lines.push('');

  return lines.join('\n');
}

// ─── Main Pipeline Orchestrator ───────────────────────────────────────────────

export interface BusinessDefectOptions {
  /**
   * PRD/TRD text content (paste directly).
   * If not provided, the tool will attempt to detect requirements from AGENTS.md.
   */
  prd_text?: string;
  /**
   * Git diff to analyze. If not provided, auto-detects from `git diff HEAD`.
   */
  diff?: string;
  /**
   * Project root directory. Defaults to cwd.
   */
  project_root?: string;
  /**
   * If true, only analyze staged changes (git diff --cached HEAD).
   */
  staged_only?: boolean;
  /**
   * Skip Stage 1 (architecture analysis) — faster but less context.
   */
  skip_architecture?: boolean;
}

/**
 * Run the full 5-stage business defect detection pipeline.
 */
export async function detectBusinessDefects(
  options: BusinessDefectOptions = {},
): Promise<BusinessDefectReport> {
  const root = resolve(options.project_root ?? process.cwd());

  // ── Get git diff ──────────────────────────────────────────────────────────
  let diff = options.diff ?? '';
  if (!diff) {
    try {
      const diffCmd = options.staged_only
        ? 'git diff --cached HEAD 2>/dev/null'
        : 'git diff HEAD 2>/dev/null';
      diff = execSync(diffCmd, { cwd: root, encoding: 'utf-8', timeout: 5000 }).trim();
      if (!diff) {
        diff = execSync('git diff HEAD~1 HEAD 2>/dev/null', {
          cwd: root, encoding: 'utf-8', timeout: 5000,
        }).trim();
      }
    } catch { /* no diff */ }
  }

  // ── PRD text ──────────────────────────────────────────────────────────────
  let prdText = options.prd_text ?? '';
  if (!prdText) {
    // Try to load from AGENTS.md or README as fallback
    for (const name of ['AGENTS.md', 'PRD.md', 'REQUIREMENTS.md', 'README.md']) {
      const p = join(root, name);
      if (existsSync(p)) {
        prdText = readFileSync(p, 'utf-8').slice(0, 4000);
        break;
      }
    }
  }

  const stagesMeta: BusinessDefectReport['stages'] = {};

  // ── Stage 1: Architecture Analysis ────────────────────────────────────────
  let architectureMap: ArchitectureMap = { modules: [], cross_cutting: [], data_flow: '', raw: '' };
  if (!options.skip_architecture) {
    architectureMap = await stage1_architectureAnalysis(root);
    stagesMeta.architecture = architectureMap.data_flow;
  }

  // ── Stage 2: PRD Requirements Extraction ──────────────────────────────────
  let requirements: StructuredRequirement[] = [];
  if (prdText) {
    requirements = await stage2_extractRequirements(prdText, architectureMap);
  }
  stagesMeta.requirementsCount = requirements.length;

  // ── Stage 3: Technical Spec Mapping ───────────────────────────────────────
  let specMappings: TechSpecMapping[] = [];
  if (requirements.length > 0 && diff) {
    specMappings = await stage3_techSpecMapping(requirements, architectureMap, diff);
  }
  stagesMeta.mappingsCount = specMappings.length;

  // ── Stage 4: Function-level Diff Analysis ─────────────────────────────────
  let functionChanges: FunctionLevelChange[] = [];
  if (diff) {
    functionChanges = await stage4_functionLevelDiffAnalysis(diff, architectureMap, specMappings);
  }
  stagesMeta.functionsAnalyzed = functionChanges.length;

  // ── Stage 5: Multi-source Defect Judgment ─────────────────────────────────
  const defects = await stage5_defectJudgment(
    architectureMap,
    requirements,
    specMappings,
    functionChanges,
  );

  // Sort: P0 → P1 → P2 → P3
  defects.sort((a, b) => a.severity.localeCompare(b.severity));

  const summary = {
    P0: defects.filter((d) => d.severity === 'P0').length,
    P1: defects.filter((d) => d.severity === 'P1').length,
    P2: defects.filter((d) => d.severity === 'P2').length,
    P3: defects.filter((d) => d.severity === 'P3').length,
  };

  const markdown = buildDefectMarkdownReport(defects, stagesMeta);

  return {
    summary,
    defects,
    hasBlockers: summary.P0 > 0 || summary.P1 > 0,
    stages: stagesMeta,
    markdown,
  };
}

// ─── Tool Registration ────────────────────────────────────────────────────────

export const businessDefectDetectorTool: ToolRegistration = {
  definition: {
    name: 'BusinessDefectDetect',
    description: [
      'Detect business logic defects in code changes using a 5-stage serial pipeline.',
      'Inspired by kstack article #15360 "业务缺陷检测流水线".',
      '',
      'Unlike ESLint/SonarQube (which catch syntax/generic issues), this tool detects',
      'WHERE CODE IS CORRECT but VIOLATES BUSINESS RULES defined in PRD/TRD documents.',
      '',
      '5-Stage Evidence Chain Pipeline:',
      '  Stage 1 — Architecture Analysis: maps module boundaries and data flow',
      '  Stage 2 — PRD Extraction: parses requirements into structured business rules',
      '  Stage 3 — Tech Spec Mapping: traces each rule to the functions that implement it',
      '  Stage 4 — Function-level Diff: analyzes git changes at function granularity with risk notes',
      '  Stage 5 — Multi-source Judgment: cross-references all 4 evidence sources → defect report',
      '',
      'Output includes:',
      '  - Severity P0/P1/P2/P3 defects with evidence chains',
      '  - Each defect linked back to the specific requirement it violates',
      '  - Concrete fix suggestions with code examples',
      '  - Full markdown report with pipeline execution summary',
      '',
      'Use before: code review, pre-deploy quality gate, requirement change impact analysis.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        prd_text: {
          type: 'string',
          description: [
            'PRD/TRD document text content (paste directly).',
            'Should contain business rules, acceptance criteria, and functional requirements.',
            'If omitted, the tool will attempt to load from AGENTS.md / README.md.',
          ].join('\n'),
        },
        diff: {
          type: 'string',
          description: [
            'Git diff to analyze (raw output of `git diff`). If omitted, auto-detects from HEAD.',
          ].join('\n'),
        },
        project_root: {
          type: 'string',
          description: 'Project root directory path. Defaults to current working directory.',
        },
        staged_only: {
          type: 'boolean',
          description: 'If true, analyze only staged changes (git diff --cached). Default: false.',
        },
        skip_architecture: {
          type: 'boolean',
          description: 'Skip Stage 1 architecture analysis for faster runs. Default: false.',
        },
      },
      required: [],
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const {
      prd_text,
      diff,
      project_root,
      staged_only,
      skip_architecture,
    } = args as {
      prd_text?: string;
      diff?: string;
      project_root?: string;
      staged_only?: boolean;
      skip_architecture?: boolean;
    };

    try {
      const report = await detectBusinessDefects({
        prd_text,
        diff,
        project_root: project_root ?? process.cwd(),
        staged_only,
        skip_architecture,
      });

      const header = [
        `Business Defect Detection Complete`,
        `Defects: ${report.summary.P0} P0 · ${report.summary.P1} P1 · ${report.summary.P2} P2 · ${report.summary.P3} P3`,
        `Blockers: ${report.hasBlockers ? '⚠️ YES — P0/P1 issues found' : '✅ None'}`,
        ``,
      ].join('\n');

      return header + report.markdown;
    } catch (err) {
      return `BusinessDefectDetect error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
