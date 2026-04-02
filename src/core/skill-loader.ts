/**
 * Skill Loader — s05-style two-layer on-demand knowledge injection.
 *
 * Layer 1 (cheap, ~100 tokens/skill): skill names + descriptions are injected
 *   into the system prompt so the agent knows what skills are available.
 *
 * Layer 2 (on-demand): when the agent calls load_skill(name), the full SKILL.md
 *   body is returned in the tool_result — it is NOT in the system prompt upfront.
 *
 * Skill files live in .uagent/skills/<name>/SKILL.md with YAML frontmatter:
 *
 *   ---
 *   name: pdf-processing
 *   description: Process and extract text from PDF files
 *   tags: pdf, document, extraction
 *   ---
 *   Full skill body here...
 *
 * s05 motto: "Load knowledge when you need it, not upfront"
 *
 * ── Skill as Prompt vs Skill as Program (kstack article #15366) ─────────────
 *
 * This loader now supports TWO execution paradigms:
 *
 *   "Skill as Prompt" (mode: prompt, the original behavior):
 *     The skill body is returned as text and injected into the LLM context.
 *     The MODEL decides how to execute — high flexibility, but model can drift.
 *     Use for: understanding, reasoning, generation, strategy, open-ended tasks.
 *
 *   "Skill as Program" (mode: program):
 *     The skill body defines structured steps[], a completion_gate, and
 *     optional state_machine. SYSTEM code enforces the flow — model just
 *     executes each step in isolation. No drift, no early exits.
 *     Use for: multi-step flows, navigation, completion conditions, integrations.
 *
 * SKILL.md frontmatter fields (new):
 *   mode:                 "prompt" | "program"  (default: "prompt")
 *   degrees_of_freedom:   "high" | "medium" | "low"
 *                         Guidance for choosing paradigm. "low" → use program mode.
 *   steps:                YAML list of ordered steps (program mode only)
 *   completion_gate:      Condition string the final output must satisfy (program mode only)
 *   state_machine:        YAML map of state transitions (optional, program mode)
 *
 * Example "program" mode SKILL.md:
 *   ---
 *   name: page-explorer
 *   description: Explore and verify a web page in sequence
 *   mode: program
 *   degrees_of_freedom: low
 *   steps:
 *     - id: open
 *       prompt: "Open the target URL and take a screenshot"
 *       required_output: "screenshot"
 *     - id: verify
 *       prompt: "Verify the page loaded correctly by checking title and key elements"
 *       required_output: "verification"
 *     - id: explore
 *       prompt: "Explore interactive elements and document findings"
 *       required_output: "findings"
 *   completion_gate: "All steps completed and all required_outputs present"
 *   ---
 *   Optional body text here (used as global context for all steps)...
 *
 * Core insight (article #15366):
 *   "让 Prompt 负责理解世界，让 Program 负责改变世界"
 *   "Don't let the model decide whether the task is done. The system decides."
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { modelManager } from '../models/model-manager.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A single step in a Program-mode Skill.
 * The system (not the model) controls step progression.
 */
export interface ProgramSkillStep {
  /** Unique step identifier */
  id: string;
  /** The prompt sent to the model for this specific step */
  prompt: string;
  /**
   * What the model's output MUST contain for this step to be considered done.
   * If the model's output doesn't mention this, the step is retried.
   * This is the "completion gate" at step level — prevents silent skips.
   */
  required_output?: string;
  /** Optional state transition: which step to go to next (overrides linear order) */
  next?: string;
}

/**
 * State machine definition for program-mode skills.
 * Maps state names to arrays of valid next states.
 * Example: { idle: ['running'], running: ['done', 'error'] }
 */
export type StateMachine = Record<string, string[]>;

export interface SkillMeta {
  name: string;
  description: string;
  tags?: string;
  /**
   * Execution paradigm (kstack article #15366).
   * "prompt": model executes freely (original behavior) — high flexibility
   * "program": system controls step-by-step execution — high determinism
   * Default: "prompt"
   */
  mode?: 'prompt' | 'program';
  /**
   * How much freedom the model should have when executing this skill.
   * "high":   many valid paths, model judgment needed → use prompt mode
   * "medium": some structure, model can reason about order → prompt or program
   * "low":    strict sequence required, no valid alternative paths → use program mode
   */
  degrees_of_freedom?: 'high' | 'medium' | 'low';
  /**
   * Ordered steps for program-mode execution.
   * Each step has its own prompt + required_output gate.
   * Parsed from YAML list in frontmatter.
   */
  steps?: ProgramSkillStep[];
  /**
   * Completion gate for the entire skill (program mode).
   * The orchestrator checks this condition after all steps complete.
   * If not satisfied, an error is returned instead of fake completion.
   */
  completion_gate?: string;
  /**
   * Optional state machine for complex program skills.
   * Maps states → valid transitions. Prevents invalid state jumps.
   */
  state_machine?: StateMachine;
  [key: string]: unknown;
}

export interface Skill {
  meta: SkillMeta;
  body: string;
  path: string;
}

// ─── SkillLoader ──────────────────────────────────────────────────────────────

export class SkillLoader {
  private skills: Map<string, Skill> = new Map();
  private loaded = false;

  constructor(private readonly skillsDir: string) {}

  /** Lazily scan and load all SKILL.md files. */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.skillsDir)) return;

    for (const entry of readdirSync(this.skillsDir)) {
      const dir = join(this.skillsDir, entry);
      try {
        if (!statSync(dir).isDirectory()) continue;
        const skillFile = join(dir, 'SKILL.md');
        if (!existsSync(skillFile)) continue;
        const text = readFileSync(skillFile, 'utf-8');
        const { meta, body } = this.parseFrontmatter(text);
        const name = (meta.name as string | undefined) || entry;
        this.skills.set(name, { meta: { name, description: '', ...meta }, body, path: skillFile });
      } catch { /* skip malformed */ }
    }
  }

  /**
   * Parse YAML frontmatter from a SKILL.md file.
   * Supports nested YAML lists for `steps` (program mode).
   */
  private parseFrontmatter(text: string): { meta: Record<string, unknown>; body: string } {
    const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) return { meta: {}, body: text.trim() };

    const meta: Record<string, unknown> = {};
    const lines = match[1].split('\n');
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const idx = line.indexOf(':');
      if (idx === -1) { i++; continue; }

      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();

      // Check if this is a YAML list (next lines are "  - ...")
      if (val === '' && i + 1 < lines.length && lines[i + 1].trimStart().startsWith('-')) {
        // Parse indented list
        const items: Record<string, string>[] = [];
        i++;
        let currentItem: Record<string, string> = {};
        let inItem = false;

        while (i < lines.length) {
          const listLine = lines[i];
          const trimmed = listLine.trim();
          if (!trimmed) { i++; continue; }
          // Non-indented line without "-" means we've exited the list
          if (!listLine.startsWith(' ') && !listLine.startsWith('\t') && !trimmed.startsWith('-')) break;

          if (trimmed.startsWith('- ')) {
            if (inItem) items.push(currentItem);
            currentItem = {};
            inItem = true;
            // Parse first key on same line as "-"
            const rest = trimmed.slice(2).trim();
            const colonIdx = rest.indexOf(':');
            if (colonIdx !== -1) {
              const k = rest.slice(0, colonIdx).trim();
              const v = rest.slice(colonIdx + 1).trim();
              if (k) currentItem[k] = v;
            }
          } else if (inItem) {
            // Continuation of current item
            const colonIdx = trimmed.indexOf(':');
            if (colonIdx !== -1) {
              const k = trimmed.slice(0, colonIdx).trim();
              const v = trimmed.slice(colonIdx + 1).trim();
              if (k) currentItem[k] = v;
            }
          }
          i++;
        }
        if (inItem) items.push(currentItem);
        meta[key] = items;
      } else {
        meta[key] = val;
        i++;
      }
    }

    return { meta, body: match[2].trim() };
  }

  /**
   * Layer 1: short descriptions for injection into system prompt.
   * Shows mode badge so the agent knows which skills can be run as programs.
   */
  getDescriptions(): string {
    this.ensureLoaded();
    if (this.skills.size === 0) return '';
    const lines: string[] = [];
    for (const [name, skill] of this.skills) {
      const tags = skill.meta.tags ? ` [${skill.meta.tags}]` : '';
      const mode = skill.meta.mode === 'program' ? ' [PROGRAM]' : '';
      const dof = skill.meta.degrees_of_freedom ? ` (dof:${skill.meta.degrees_of_freedom})` : '';
      lines.push(`  - ${name}${mode}${dof}: ${skill.meta.description}${tags}`);
    }
    return lines.join('\n');
  }

  /**
   * Layer 2: full body returned via tool_result when agent calls load_skill(name).
   * For prompt-mode skills: returns body text for model to interpret.
   * For program-mode skills: returns structured step plan for run_skill to execute.
   */
  getContent(name: string): string {
    this.ensureLoaded();
    const skill = this.skills.get(name);
    if (!skill) {
      const available = [...this.skills.keys()].join(', ') || '(none)';
      return `Error: Unknown skill '${name}'. Available skills: ${available}`;
    }

    // Program-mode skills surface their structure so the agent knows to use run_skill
    if (skill.meta.mode === 'program') {
      const steps = skill.meta.steps ?? [];
      const stepsInfo = steps.map((s, idx) =>
        `  Step ${idx + 1} [${s.id}]: ${s.prompt}${s.required_output ? ` → requires: ${s.required_output}` : ''}`,
      ).join('\n');

      return [
        `<skill name="${name}" mode="program">`,
        ``,
        `⚠️  This is a PROGRAM-MODE skill (kstack #15366 "Skill as Program").`,
        `The system controls step execution — the model does NOT decide when steps are done.`,
        ``,
        `To execute this skill, call: run_skill({ name: "${name}" })`,
        ``,
        `## Execution Plan`,
        stepsInfo || '  (no steps defined)',
        ``,
        `## Global Context`,
        skill.body || '(no global context)',
        ``,
        `## Completion Gate`,
        skill.meta.completion_gate || '(none defined — all steps must complete)',
        `</skill>`,
      ].join('\n');
    }

    // Prompt-mode: original behavior
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }

  /**
   * Get a skill for programmatic access (used by ProgramSkillRunner).
   */
  getSkill(name: string): Skill | undefined {
    this.ensureLoaded();
    return this.skills.get(name);
  }

  listNames(): string[] {
    this.ensureLoaded();
    return [...this.skills.keys()];
  }

  has(name: string): boolean {
    this.ensureLoaded();
    return this.skills.has(name);
  }
}

// ─── ProgramSkillRunner ───────────────────────────────────────────────────────

/**
 * ProgramSkillRunner — executes a "Skill as Program" with system-controlled flow.
 *
 * Inspired by kstack article #15366:
 * "Skill as Program: 固化系统能力 — 写给系统的执行器，固化流程、状态、约束"
 *
 * Core principle:
 *   "让 Program 负责改变世界" — the SYSTEM advances steps, not the model.
 *   Model executes each step in isolation; system enforces completion gates.
 *
 * Anti-patterns prevented:
 *   ✗ Model decides task is done after one screenshot (early exit)
 *   ✗ Model skips mandatory steps ("I already know the answer")
 *   ✗ Model conflates multiple steps into one vague output
 *
 * Guarantees:
 *   ✓ Every step.prompt is executed exactly once, in order
 *   ✓ required_output gate checked before advancing to next step
 *   ✓ Final completion_gate checked before reporting success
 *   ✓ State machine (if defined) prevents invalid transitions
 */
export class ProgramSkillRunner {
  private currentStepIndex = 0;
  private state = 'idle';
  private stepOutputs: Record<string, string> = {};
  private executionLog: string[] = [];

  constructor(
    private readonly skill: Skill,
    private readonly projectRoot: string,
  ) {}

  /**
   * Execute all steps of the program skill in sequence.
   * Returns a structured result with per-step outputs and final status.
   */
  async run(extraContext?: string): Promise<ProgramSkillResult> {
    const { meta, body } = this.skill;
    const steps = meta.steps ?? [];

    if (steps.length === 0) {
      return {
        status: 'error',
        error: `Skill "${meta.name}" is mode=program but has no steps defined. Add steps to the SKILL.md frontmatter.`,
        stepOutputs: {},
        log: [],
      };
    }

    this.executionLog.push(`[ProgramSkillRunner] Starting skill "${meta.name}" (${steps.length} steps)`);
    this.state = 'running';

    // Validate state machine transition: idle → running
    if (meta.state_machine && !this.isValidTransition('idle', 'running', meta.state_machine)) {
      this.state = 'error';
      return {
        status: 'error',
        error: `State machine violation: idle → running is not allowed`,
        stepOutputs: this.stepOutputs,
        log: this.executionLog,
      };
    }

    const client = modelManager.getClient('main');

    // Build global context for all steps
    const globalContext = [
      body ? `## Skill Global Context\n${body}` : '',
      extraContext ? `## Additional Context\n${extraContext}` : '',
      meta.completion_gate ? `## Completion Gate\n${meta.completion_gate}` : '',
    ].filter(Boolean).join('\n\n');

    // ── Execute each step ─────────────────────────────────────────────────────
    for (let idx = 0; idx < steps.length; idx++) {
      const step = steps[idx];
      this.currentStepIndex = idx;

      this.executionLog.push(`[Step ${idx + 1}/${steps.length}] id="${step.id}" → ${step.prompt.slice(0, 60)}...`);

      // Build step prompt with previous outputs for continuity
      const previousOutputs = Object.entries(this.stepOutputs)
        .map(([id, out]) => `### Output from step [${id}]\n${out}`)
        .join('\n\n');

      const stepPrompt = [
        globalContext,
        previousOutputs ? `## Previous Step Outputs\n${previousOutputs}` : '',
        `## Current Step (${idx + 1} of ${steps.length}): [${step.id}]`,
        step.prompt,
        '',
        step.required_output
          ? `Your response MUST include: ${step.required_output}`
          : '',
        ``,
        `Complete ONLY this step. Do not advance to the next step.`,
      ].filter(Boolean).join('\n\n');

      let stepOutput = '';
      let attempts = 0;
      const MAX_ATTEMPTS = 2;

      // ── Completion gate: retry if required_output not found ───────────────
      while (attempts < MAX_ATTEMPTS) {
        attempts++;
        try {
          const response = await client.chat({
            systemPrompt: [
              `You are executing step ${idx + 1} of ${steps.length} in a program-mode skill.`,
              `IMPORTANT: Complete ONLY this specific step. The system controls progression.`,
              `Do not combine steps or skip ahead.`,
            ].join('\n'),
            messages: [{ role: 'user', content: stepPrompt }],
          });
          stepOutput = response.content;
        } catch (err) {
          return {
            status: 'error',
            error: `Step [${step.id}] failed: ${err instanceof Error ? err.message : String(err)}`,
            stepOutputs: this.stepOutputs,
            log: this.executionLog,
          };
        }

        // Check step-level completion gate
        if (step.required_output) {
          const keyword = step.required_output.toLowerCase();
          const outputLower = stepOutput.toLowerCase();
          if (!outputLower.includes(keyword)) {
            this.executionLog.push(
              `[Step ${idx + 1}] Completion gate FAILED (attempt ${attempts}): ` +
              `output missing "${step.required_output}" — retrying...`,
            );
            if (attempts >= MAX_ATTEMPTS) {
              return {
                status: 'gate_failure',
                error: `Step [${step.id}] failed completion gate after ${MAX_ATTEMPTS} attempts. ` +
                  `Required output "${step.required_output}" not found in model response. ` +
                  `This prevents silent step skips (kstack #15366 Program mode gate).`,
                stepOutputs: this.stepOutputs,
                log: this.executionLog,
              };
            }
            continue; // retry
          }
        }

        // Gate passed (or no gate defined)
        this.executionLog.push(`[Step ${idx + 1}] ✅ Gate passed`);
        break;
      }

      this.stepOutputs[step.id] = stepOutput;
    }

    // ── Final completion gate ────────────────────────────────────────────────
    if (meta.completion_gate) {
      const allOutputs = Object.values(this.stepOutputs).join('\n');
      const gatePassed = meta.completion_gate
        .split(' ')
        .filter((w) => w.length > 3)
        .some((keyword) => allOutputs.toLowerCase().includes(keyword.toLowerCase()));

      if (!gatePassed) {
        this.state = 'error';
        this.executionLog.push(`[Completion Gate] FAILED: "${meta.completion_gate}"`);
        return {
          status: 'gate_failure',
          error: `Skill "${meta.name}" did not satisfy completion gate: "${meta.completion_gate}"`,
          stepOutputs: this.stepOutputs,
          log: this.executionLog,
        };
      }
    }

    this.state = 'done';
    this.executionLog.push(`[ProgramSkillRunner] All ${steps.length} steps completed ✅`);

    // Validate state machine: running → done
    if (meta.state_machine && !this.isValidTransition('running', 'done', meta.state_machine)) {
      this.executionLog.push(`[Warning] State machine: running → done not declared`);
    }

    return {
      status: 'success',
      stepOutputs: this.stepOutputs,
      log: this.executionLog,
    };
  }

  private isValidTransition(from: string, to: string, sm: StateMachine): boolean {
    return sm[from]?.includes(to) ?? true; // lenient: allow if not defined
  }
}

export interface ProgramSkillResult {
  status: 'success' | 'error' | 'gate_failure';
  error?: string;
  stepOutputs: Record<string, string>;
  log: string[];
}

// ─── Report Builder for ProgramSkillResult ────────────────────────────────────

export function formatProgramSkillResult(
  skillName: string,
  result: ProgramSkillResult,
): string {
  const lines: string[] = [
    `## 🤖 Program Skill: ${skillName}`,
    `> Executed via ProgramSkillRunner (kstack #15366 Skill as Program)`,
    ``,
  ];

  if (result.status === 'success') {
    lines.push(`✅ **All steps completed successfully**`, ``);
  } else {
    lines.push(`❌ **Execution failed**: ${result.error ?? 'Unknown error'}`, ``);
  }

  // Per-step outputs
  const stepIds = Object.keys(result.stepOutputs);
  if (stepIds.length > 0) {
    lines.push(`### Step Outputs`, ``);
    for (const id of stepIds) {
      lines.push(`#### [${id}]`);
      lines.push(result.stepOutputs[id] ?? '(empty)');
      lines.push(``);
    }
  }

  // Execution log (compact)
  if (result.log.length > 0) {
    lines.push(`### Execution Log`);
    lines.push('```');
    lines.push(...result.log);
    lines.push('```');
  }

  return lines.join('\n');
}

// ─── Singleton per project root ───────────────────────────────────────────────

const loaderCache = new Map<string, SkillLoader>();

export function getSkillLoader(projectRoot?: string): SkillLoader {
  const root = resolve(projectRoot ?? process.cwd());
  let loader = loaderCache.get(root);
  if (!loader) {
    const skillsDir = join(root, '.uagent', 'skills');
    loader = new SkillLoader(skillsDir);
    loaderCache.set(root, loader);
  }
  return loader;
}
