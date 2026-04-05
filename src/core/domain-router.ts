/**
 * core/domain-router.ts — Domain routing + dynamic plugin registry
 *
 * Built-in domains: data / dev / service
 *
 * External domains can be loaded at runtime from:
 *   `.uagent/plugins/*.{js,mjs}`       (project-level, loaded first)
 *   `~/.uagent/plugins/*.{js,mjs}`     (global, loaded second)
 *
 * Each plugin file must export a default {@link DomainPlugin} object:
 *
 * @example
 * ```js
 * // .uagent/plugins/mobile.js
 * export default {
 *   name: 'mobile',
 *   description: 'Mobile app development',
 *   keywords: ['react-native', 'ios', 'android', 'expo'],
 *   systemPrompt: 'You are a mobile development expert...',
 *   tools: [],
 * };
 * ```
 *
 * Use {@link registerDomainPlugin} to register a plugin programmatically.
 *
 * @module
 */
import chalk from 'chalk';
import { existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import type { DomainPlugin } from '../models/types.js';
import type { ToolRegistry } from './tool-registry.js';
import { dataDomain } from '../domains/data/index.js';
import { devDomain } from '../domains/dev/index.js';
import { serviceDomain } from '../domains/service/index.js';

// ── Built-in domain registry ──────────────────────────────────────────────────

const DOMAINS: Record<string, DomainPlugin> = {
  data:    dataDomain,
  dev:     devDomain,
  service: serviceDomain,
};

// Track which plugins were dynamically loaded (for /plugins command)
interface PluginMeta {
  plugin: DomainPlugin;
  source: string;   // 'builtin' | absolute file path
  loadedAt: number; // timestamp
}
const PLUGIN_REGISTRY: Map<string, PluginMeta> = new Map([
  ['data',    { plugin: dataDomain,    source: 'builtin', loadedAt: Date.now() }],
  ['dev',     { plugin: devDomain,     source: 'builtin', loadedAt: Date.now() }],
  ['service', { plugin: serviceDomain, source: 'builtin', loadedAt: Date.now() }],
]);

// ── Plugin extension registries ───────────────────────────────────────────────

/** Slash commands contributed by plugins: command → handler */
const PLUGIN_SLASH_COMMANDS: Map<string, import('../models/types.js').PluginSlashCommand> = new Map();

/** Hooks contributed by plugins */
const PLUGIN_HOOKS: Array<import('../models/types.js').PluginHookDefinition & { pluginName: string }> = [];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Register an external DomainPlugin programmatically.
 * Also registers any slashCommands and hooks the plugin contributes.
 * Overwrites any existing plugin with the same name (allows hot-reload).
 * Returns true if new, false if overwriting an existing registration.
 */
export function registerDomainPlugin(plugin: DomainPlugin, source = 'runtime'): boolean {
  const isNew = !DOMAINS[plugin.name];
  DOMAINS[plugin.name] = plugin;
  PLUGIN_REGISTRY.set(plugin.name, { plugin, source, loadedAt: Date.now() });

  // Register slash commands contributed by this plugin
  if (plugin.slashCommands) {
    for (const cmd of plugin.slashCommands) {
      if (cmd.command.startsWith('/') && typeof cmd.handler === 'function') {
        PLUGIN_SLASH_COMMANDS.set(cmd.command, cmd);
      }
    }
  }

  // Register hooks contributed by this plugin
  if (plugin.hooks) {
    // Remove any previously registered hooks from same plugin (hot-reload)
    const idx = PLUGIN_HOOKS.findIndex((h) => h.pluginName === plugin.name);
    if (idx !== -1) PLUGIN_HOOKS.splice(idx, PLUGIN_HOOKS.filter(h => h.pluginName === plugin.name).length);

    for (const hook of plugin.hooks) {
      PLUGIN_HOOKS.push({ ...hook, pluginName: plugin.name });
    }
  }

  return isNew;
}

/**
 * Get all plugin-contributed slash commands.
 * Used by handlers/index.ts to dispatch unknown slash commands to plugins.
 */
export function getPluginSlashCommands(): ReadonlyMap<string, import('../models/types.js').PluginSlashCommand> {
  return PLUGIN_SLASH_COMMANDS;
}

/**
 * Get all plugin-contributed hooks for a given event.
 * Used by agent-loop.ts to fire plugin hooks at lifecycle points.
 */
export function getPluginHooks(event: import('../models/types.js').PluginHookDefinition['event']) {
  return PLUGIN_HOOKS.filter((h) => h.event === event && h.enabled !== false);
}

/**
 * Scan `.uagent/plugins/` (project) and `~/.uagent/plugins/` (global) for
 * JS/MJS plugin files and dynamically import them.
 *
 * Each file must have a default export of type DomainPlugin.
 * Errors in individual files are caught and logged — they do not prevent
 * other plugins from loading.
 *
 * @returns Array of successfully loaded plugin names
 */
export async function loadLocalPlugins(cwd = process.cwd()): Promise<string[]> {
  const loaded: string[] = [];
  const searchDirs = [
    join(cwd, '.uagent', 'plugins'),
    join(process.env.HOME ?? '~', '.uagent', 'plugins'),
  ];

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
    } catch {
      continue;
    }

    for (const file of files) {
      const absPath = resolve(join(dir, file));
      try {
        // Dynamic import — works with both CJS and ESM plugin files
        const mod = await import(absPath) as { default?: DomainPlugin } | DomainPlugin;
        const plugin = ('default' in mod && mod.default)
          ? (mod as { default: DomainPlugin }).default
          : (mod as DomainPlugin);

        // Validate minimal structure before registering
        if (
          typeof plugin?.name === 'string' &&
          typeof plugin?.description === 'string' &&
          Array.isArray(plugin?.tools)
        ) {
          const isNew = registerDomainPlugin(plugin, absPath);
          loaded.push(plugin.name);
          const action = isNew ? 'loaded' : 'reloaded';
          process.stderr.write(
            chalk.dim(`  [plugin] ${action}: ${plugin.name} (${file})\n`),
          );
        } else {
          process.stderr.write(
            chalk.yellow(`  [plugin] invalid export in ${file} — expected { name, description, tools }\n`),
          );
        }
      } catch (err) {
        process.stderr.write(
          chalk.yellow(`  [plugin] failed to load ${file}: ${err instanceof Error ? err.message : String(err)}\n`),
        );
      }
    }
  }

  return loaded;
}

/**
 * List all registered plugins with their metadata.
 * Used by the /plugins slash command.
 */
export function listRegisteredPlugins(): Array<PluginMeta & { name: string }> {
  return Array.from(PLUGIN_REGISTRY.entries()).map(([name, meta]) => ({ name, ...meta }));
}

// ── DomainRouter class (unchanged public API) ─────────────────────────────────

export class DomainRouter {
  detectDomain(prompt: string): string {
    const lower = prompt.toLowerCase();
    const scores: Record<string, number> = {};

    for (const [name, plugin] of Object.entries(DOMAINS)) {
      scores[name] = 0;
      for (const kw of plugin.keywords) {
        if (lower.includes(kw)) scores[name]!++;
      }
    }

    const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    return (best && best[1] > 0) ? best[0] : 'dev';
  }

  getSystemPrompt(domain: string): string {
    const plugin = DOMAINS[domain] || DOMAINS['dev'];
    return plugin!.systemPrompt;
  }

  registerTools(registry: ToolRegistry, domain: string) {
    if (domain === 'auto') {
      for (const plugin of Object.values(DOMAINS)) {
        registry.registerMany(plugin.tools);
      }
    } else {
      const plugin = DOMAINS[domain];
      if (plugin) registry.registerMany(plugin.tools);
    }
  }

  listDomains() {
    console.log(chalk.yellow('\n  Available Domains:\n'));
    for (const [name, plugin] of Object.entries(DOMAINS)) {
      console.log(chalk.cyan(`  ${name.padEnd(10)}`) + chalk.white(plugin.description));
      console.log(chalk.gray(`  ${''.padEnd(10)}Tools: ${plugin.tools.map((t) => t.definition.name).join(', ')}\n`));
    }
  }
}
