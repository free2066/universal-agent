/**
 * output-styles/loader.ts — Custom Output Style loader
 *
 * Upgraded to match claude-code's outputStyles.ts implementation:
 *
 *  Priority (low → high): builtin → plugin → user → project
 *   - Plugin styles can set forceForPlugin: true to override user selection
 *   - memoized by projectRoot (5s stale time) for performance
 *
 * Supports loading output style definitions from Markdown files:
 *   ~/.uagent/plugins/<plugin-name>/output-styles/*.md  (plugin-level)
 *   ~/.uagent/output-styles/*.md            (user-level)
 *   <project>/.uagent/output-styles/*.md    (project-level, highest)
 *
 * Markdown file format:
 * ---
 * name: My Style          (optional, defaults to filename without .md)
 * description: Short desc (optional, defaults to first line of body)
 * keep-coding-instructions: true  (optional, default: true)
 * force: true             (optional: plugin-only, forces this style on all sessions)
 * ---
 * Prompt body injected into system prompt as "# Output Style: <name>\n<body>"
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { resolve, join, basename } from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OutputStyleConfig {
  /** Style name (also the key used with /output-style) */
  name: string;
  /** Short description shown in /output-style list */
  description: string;
  /** System prompt content to inject */
  prompt: string;
  /**
   * Whether to keep default coding instructions alongside the custom prompt.
   * Default: true.
   */
  keepCodingInstructions: boolean;
  /** Where this style was loaded from */
  source: 'builtin' | 'plugin' | 'user' | 'project';
  /**
   * Plugin-only: when true, this style overrides user/project selection.
   * Multiple forceForPlugin styles: first one wins (with warning).
   * Mirrors claude-code's forceForPlugin behavior.
   */
  forceForPlugin?: boolean;
}

// ── Built-in styles ───────────────────────────────────────────────────────────

export const BUILTIN_STYLES: Record<string, OutputStyleConfig> = {
  markdown: {
    name: 'markdown',
    description: 'Full markdown with headers, code fences, and lists (default)',
    prompt: '',  // No extra directive — markdown is the default
    keepCodingInstructions: true,
    source: 'builtin',
  },
  plain: {
    name: 'plain',
    description: 'Plain text, no markdown syntax',
    prompt:
      'IMPORTANT: Format ALL your responses as plain text. Do NOT use markdown, ' +
      'code fences, headers, bold, italics, bullet lists, or any other markdown syntax. ' +
      'Write in simple, clean prose.',
    keepCodingInstructions: true,
    source: 'builtin',
  },
  compact: {
    name: 'compact',
    description: 'Concise output, minimal headers, no preamble',
    prompt:
      'IMPORTANT: Keep all responses concise and minimal. Avoid preamble, lengthy ' +
      'explanations, or redundant headers. Prefer short bullet points over paragraphs. ' +
      'Omit confirmations like "I will…" or "Sure, I can…".',
    keepCodingInstructions: true,
    source: 'builtin',
  },
};

// ── Frontmatter parser ────────────────────────────────────────────────────────
// Lightweight YAML-ish frontmatter parser to avoid adding a new dependency.

interface Frontmatter {
  name?: string;
  description?: string;
  'keep-coding-instructions'?: boolean | string;
  force?: boolean | string;
}

function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const FENCE = '---';
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== FENCE) {
    return { frontmatter: {}, body: raw };
  }

  const endIdx = lines.findIndex((l, i) => i > 0 && l.trim() === FENCE);
  if (endIdx === -1) {
    return { frontmatter: {}, body: raw };
  }

  const fmLines = lines.slice(1, endIdx);
  const body = lines.slice(endIdx + 1).join('\n');

  const fm: Frontmatter = {};
  for (const line of fmLines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key === 'name') fm.name = value;
    else if (key === 'description') fm.description = value;
    else if (key === 'keep-coding-instructions') {
      fm['keep-coding-instructions'] = value === 'true' ? true : value === 'false' ? false : value;
    }
    else if (key === 'force') {
      fm.force = value === 'true' ? true : value === 'false' ? false : value;
    }
  }

  return { frontmatter: fm, body };
}

// ── File loader ───────────────────────────────────────────────────────────────

function parseOutputStyleFile(
  filePath: string,
  source: 'user' | 'project' | 'plugin',
  forceForPlugin?: boolean,
): OutputStyleConfig | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(raw);
    const prompt = body.trim();

    const nameFromFile = basename(filePath, '.md');
    const name = frontmatter.name ?? nameFromFile;

    let description = frontmatter.description;
    if (!description) {
      const firstLine = body.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
      description = firstLine.slice(0, 100);
    }

    const keepRaw = frontmatter['keep-coding-instructions'];
    const keepCodingInstructions = keepRaw === false || keepRaw === 'false' ? false : true;

    // For plugin styles: use frontmatter 'force' field or caller-provided override
    const isForced = forceForPlugin ?? (frontmatter.force === true || frontmatter.force === 'true');

    return {
      name, description, prompt, keepCodingInstructions, source,
      ...(isForced ? { forceForPlugin: true } : {}),
    };
  } catch {
    return null;
  }
}

function loadStylesFromDir(
  dir: string,
  source: 'user' | 'project' | 'plugin',
  forceForPlugin?: boolean,
): OutputStyleConfig[] {
  if (!existsSync(dir)) return [];
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort();
    return files
      .map((f) => parseOutputStyleFile(join(dir, f), source, forceForPlugin))
      .filter((s): s is OutputStyleConfig => s !== null);
  } catch { return []; }
}

/**
 * Load plugin output styles from ~/.uagent/plugins/<plugin>/output-styles/*.md
 *
 * Round 3 upgrades (claude-code loadPluginOutputStyles parity):
 *  1. Plugin styles are namespace-prefixed: "plugin-name:style-name"
 *     — prevents name collision between two plugins that both have "concise.md"
 *  2. loadedPaths Set deduplicates files (e.g. if manifest references same path twice)
 *  3. Reads plugin.json manifest for additional outputStylesPaths if present
 */
function loadPluginOutputStyles(): OutputStyleConfig[] {
  const pluginsDir = join(resolve(process.env.HOME ?? '~', '.uagent'), 'plugins');
  if (!existsSync(pluginsDir)) return [];
  const results: OutputStyleConfig[] = [];
  const loadedPaths = new Set<string>(); // dedup guard (Round 3)

  try {
    const pluginDirs = readdirSync(pluginsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const pluginName of pluginDirs) {
      const pluginBase = join(pluginsDir, pluginName);

      // ── Collect style paths from manifest (plugin.json) ─────────────────
      // Mirrors claude-code's plugin.outputStylesPaths support.
      const extraStyleDirs: string[] = [];
      try {
        const manifestPath = join(pluginBase, 'plugin.json');
        if (existsSync(manifestPath)) {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
          const outputStylesPaths = manifest['outputStylesPaths'];
          if (Array.isArray(outputStylesPaths)) {
            for (const p of outputStylesPaths as string[]) {
              extraStyleDirs.push(resolve(pluginBase, p));
            }
          } else if (typeof outputStylesPaths === 'string') {
            extraStyleDirs.push(resolve(pluginBase, outputStylesPaths));
          }
        }
      } catch { /* non-fatal: manifest parse failure */ }

      // ── Load from default output-styles/ directory ───────────────────────
      const defaultStylesDir = join(pluginBase, 'output-styles');
      if (existsSync(defaultStylesDir)) {
        extraStyleDirs.unshift(defaultStylesDir); // default dir has lowest priority
      }

      // ── Parse styles with namespace prefix ──────────────────────────────
      for (const stylesDir of extraStyleDirs) {
        try {
          const mdFiles = existsSync(stylesDir)
            ? readdirSync(stylesDir).filter((f) => f.endsWith('.md')).sort()
            : [];
          for (const f of mdFiles) {
            const filePath = resolve(join(stylesDir, f));
            if (loadedPaths.has(filePath)) continue; // dedup
            loadedPaths.add(filePath);

            const style = parseOutputStyleFile(filePath, 'plugin');
            if (!style) continue;

            // ── Namespace: "plugin-name:style-base-name" ─────────────────
            // Mirrors claude-code: name = `${pluginName}:${baseStyleName}`
            const baseStyleName = style.name; // already stripped of .md
            style.name = `${pluginName}:${baseStyleName}`;

            results.push(style);
          }
        } catch { /* non-fatal: directory read failure */ }
      }
    }
  } catch { /* non-fatal */ }
  return results;
}

// ── Memoize cache (claude-code parity) ───────────────────────────────────────
// Cache by projectRoot with 5-second stale time to avoid repeated file I/O.
// Invalidated by TTL (simple approach; no fs.watch needed for CLI use).

const MEMOIZE_TTL_MS = 5_000;
const _styleCache = new Map<string, { styles: Record<string, OutputStyleConfig>; expiresAt: number }>();

function getCachedStyles(cacheKey: string): Record<string, OutputStyleConfig> | undefined {
  const entry = _styleCache.get(cacheKey);
  if (!entry) return undefined;
  if (Date.now() < entry.expiresAt) return entry.styles;
  _styleCache.delete(cacheKey);
  return undefined;
}

// ── Main API ──────────────────────────────────────────────────────────────────

/**
 * Load all output styles, merging builtin + plugin + user + project.
 *
 * Priority (low → high): builtin → plugin → user → project
 * Same-name styles at higher priority override lower-priority ones.
 *
 * Plugin styles with forceForPlugin: true override user selection — first
 * forceForPlugin style wins; subsequent ones are ignored with a warning.
 *
 * @param projectRoot  Project directory (default: cwd)
 * @returns  Map of style name → OutputStyleConfig
 */
export function getAllOutputStyles(projectRoot?: string): Record<string, OutputStyleConfig> {
  const cacheKey = resolve(projectRoot ?? process.cwd());
  const cached = getCachedStyles(cacheKey);
  if (cached) return cached;

  const result: Record<string, OutputStyleConfig> = { ...BUILTIN_STYLES };

  // Plugin styles (~/.uagent/plugins/*/output-styles/*.md)
  for (const style of loadPluginOutputStyles()) {
    result[style.name] = style;
  }

  // User-level styles (~/.uagent/output-styles/*.md)
  const userDir = join(resolve(process.env.HOME ?? '~', '.uagent'), 'output-styles');
  for (const style of loadStylesFromDir(userDir, 'user')) {
    result[style.name] = style;
  }

  // Project-level styles (<project>/.uagent/output-styles/*.md)
  const projDir = join(cacheKey, '.uagent', 'output-styles');
  for (const style of loadStylesFromDir(projDir, 'project')) {
    result[style.name] = style;
  }

  _styleCache.set(cacheKey, { styles: result, expiresAt: Date.now() + MEMOIZE_TTL_MS });
  return result;
}

/**
 * Get a specific output style by name.
 * Returns null if not found.
 */
export function getOutputStyle(name: string, projectRoot?: string): OutputStyleConfig | null {
  const all = getAllOutputStyles(projectRoot);
  return all[name] ?? null;
}

/**
 * Get the effective output style, respecting plugin force overrides.
 *
 * If any plugin style has forceForPlugin: true, it overrides the requested name.
 * Multiple forced plugins: first wins (with console.warn).
 * Mirrors claude-code's getOutputStyleConfig() logic.
 */
export function getEffectiveOutputStyle(
  requestedName: string,
  projectRoot?: string,
): OutputStyleConfig | null {
  const all = getAllOutputStyles(projectRoot);

  // Check for plugin force override
  const forcedPlugins = Object.values(all).filter(
    (s) => s.source === 'plugin' && s.forceForPlugin,
  );
  if (forcedPlugins.length > 0) {
    if (forcedPlugins.length > 1) {
      console.warn(
        `[output-styles] Multiple plugins have forceForPlugin=true: ${forcedPlugins.map((s) => s.name).join(', ')}. Using first.`,
      );
    }
    return forcedPlugins[0];
  }

  return all[requestedName] ?? null;
}

/**
 * Build the system prompt segment for a given output style.
 * Returns empty string for 'markdown' (default, no injection needed).
 */
export function buildOutputStylePrompt(style: OutputStyleConfig | null | undefined): string {
  if (!style || !style.prompt) return '';
  // Format: "# Output Style: <name>\n<prompt>" (same as claude-code)
  return `# Output Style: ${style.name}\n${style.prompt}`;
}

/** Invalidate memoize cache (call after plugin install/update) */
export function invalidateOutputStyleCache(): void {
  _styleCache.clear();
}
