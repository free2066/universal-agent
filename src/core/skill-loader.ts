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
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

export interface SkillMeta {
  name: string;
  description: string;
  tags?: string;
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

  private parseFrontmatter(text: string): { meta: Record<string, unknown>; body: string } {
    const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return { meta: {}, body: text.trim() };
    const meta: Record<string, unknown> = {};
    for (const line of match[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      meta[key] = val;
    }
    return { meta, body: match[2].trim() };
  }

  /**
   * Layer 1: short descriptions for injection into system prompt.
   * Only called once per session (result is cached by caller).
   */
  getDescriptions(): string {
    this.ensureLoaded();
    if (this.skills.size === 0) return '';
    const lines: string[] = [];
    for (const [name, skill] of this.skills) {
      const tags = skill.meta.tags ? ` [${skill.meta.tags}]` : '';
      lines.push(`  - ${name}: ${skill.meta.description}${tags}`);
    }
    return lines.join('\n');
  }

  /**
   * Layer 2: full body returned via tool_result when agent calls load_skill(name).
   */
  getContent(name: string): string {
    this.ensureLoaded();
    const skill = this.skills.get(name);
    if (!skill) {
      const available = [...this.skills.keys()].join(', ') || '(none)';
      return `Error: Unknown skill '${name}'. Available skills: ${available}`;
    }
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
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
