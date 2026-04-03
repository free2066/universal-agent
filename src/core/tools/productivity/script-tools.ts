/**
 * Script Tools — Inspired by kstack #15370 "固定操作脚本化"
 *
 * Key insight from the article: AI wastes time rediscovering how to do common tasks
 * (e.g. "navigate to live room → open settings → toggle feature flag").
 * Saving those command sequences as named scripts lets AI reuse them instantly.
 *
 * Three tools:
 *   1. ScriptSave  — Save a shell command (or multi-line script) under a name
 *   2. ScriptRun   — Execute a saved script by name, with optional arg substitution
 *   3. ScriptList  — List all saved scripts with their descriptions
 *
 * Storage: ~/.uagent/scripts/<name>.sh  (plain shell, easy to inspect/edit)
 *          ~/.uagent/scripts/index.json  (metadata: name, description, created, lastRun, runCount)
 *
 * Usage example:
 *   Agent: ScriptSave  name="build_and_test"  command="npm run build && npm test"
 *   Agent: ScriptRun   name="build_and_test"
 *   → runs in project cwd, captures output, updates lastRun/runCount
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { execSync } from 'child_process';
import type { ToolRegistration } from '../../../models/types.js';

// ── Storage ───────────────────────────────────────────────────────────────────

const SCRIPTS_DIR = resolve(process.env.HOME || '~', '.uagent', 'scripts');
const INDEX_FILE = join(SCRIPTS_DIR, 'index.json');

interface ScriptMeta {
  name: string;
  description: string;
  command: string;       // stored for display; actual file is .sh
  created: number;
  lastRun: number | null;
  runCount: number;
  tags: string[];
}

function ensureDir(): void {
  mkdirSync(SCRIPTS_DIR, { recursive: true });
}

function loadIndex(): Record<string, ScriptMeta> {
  if (!existsSync(INDEX_FILE)) return {};
  try { return JSON.parse(readFileSync(INDEX_FILE, 'utf-8')); } catch { return {}; }
}

function saveIndex(index: Record<string, ScriptMeta>): void {
  ensureDir();
  writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

function scriptPath(name: string): string {
  return join(SCRIPTS_DIR, `${name}.sh`);
}

function validateName(name: string): string | null {
  if (!name) return 'Script name is required';
  if (!/^[a-zA-Z0-9_\-]+$/.test(name)) return 'Script name must be alphanumeric (underscores and hyphens allowed)';
  if (name.length > 64) return 'Script name must be ≤ 64 characters';
  return null;
}

// ── Tool 1: ScriptSave ────────────────────────────────────────────────────────

export const scriptSaveTool: ToolRegistration = {
  definition: {
    name: 'ScriptSave',
    description: [
      'Save a shell command or script under a memorable name for later reuse.',
      'Inspired by the "固定操作脚本化" pattern: capture common command sequences once, reuse them forever.',
      'Scripts are stored in ~/.uagent/scripts/ and survive across sessions.',
      'Use {{arg}} placeholders in the command for runtime substitution.',
      'Example: ScriptSave name="build_test" command="npm run build && npm test" description="Build + run tests"',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Unique script name (alphanumeric, underscores, hyphens). E.g. "build_test", "deploy-staging".',
        },
        command: {
          type: 'string',
          description: 'Shell command or multi-line script body. Use {{placeholder}} for runtime args.',
        },
        description: {
          type: 'string',
          description: 'Human-readable description of what this script does.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for grouping scripts, e.g. ["build", "test"].',
        },
        overwrite: {
          type: 'boolean',
          description: 'If true, overwrite an existing script with the same name (default: false).',
        },
      },
      required: ['name', 'command'],
    },
  },

  async handler(args: Record<string, unknown>): Promise<string> {
    const name = String(args.name ?? '').trim();
    const command = String(args.command ?? '').trim();
    const description = String(args.description ?? '').trim() || '(no description)';
    const tags = Array.isArray(args.tags) ? args.tags.map(String) : [];
    const overwrite = Boolean(args.overwrite ?? false);

    const nameErr = validateName(name);
    if (nameErr) return `Error: ${nameErr}`;
    if (!command) return 'Error: command is required';

    ensureDir();
    const index = loadIndex();

    if (index[name] && !overwrite) {
      return [
        `Script "${name}" already exists. Use overwrite=true to replace it.`,
        `Current command: ${index[name].command.slice(0, 120)}`,
      ].join('\n');
    }

    // Write the shell script file
    const shContent = [
      '#!/bin/sh',
      `# Script: ${name}`,
      `# Description: ${description}`,
      `# Saved by universal-agent on ${new Date().toISOString()}`,
      '',
      command,
    ].join('\n') + '\n';

    writeFileSync(scriptPath(name), shContent, { mode: 0o755 });

    // Update index
    index[name] = {
      name,
      description,
      command,
      created: Date.now(),
      lastRun: null,
      runCount: 0,
      tags,
    };
    saveIndex(index);

    const action = (args.overwrite && index[name]) ? 'updated' : 'saved';
    return [
      `✅ Script "${name}" ${action}.`,
      `   Description: ${description}`,
      `   Command: ${command.slice(0, 200)}${command.length > 200 ? '...' : ''}`,
      `   Location: ${scriptPath(name)}`,
      ``,
      `Run it with: ScriptRun name="${name}"`,
    ].join('\n');
  },
};

// ── Tool 2: ScriptRun ─────────────────────────────────────────────────────────

export const scriptRunTool: ToolRegistration = {
  definition: {
    name: 'ScriptRun',
    description: [
      'Execute a previously saved script by name.',
      'Supports {{placeholder}} substitution via the args parameter.',
      'Runs in the current working directory by default.',
      'Returns full stdout/stderr output with exit code.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the script to run (as saved with ScriptSave).',
        },
        args: {
          type: 'object',
          description: 'Key-value pairs for {{placeholder}} substitution. E.g. {"env": "staging"}.',
          properties: {},
        },
        cwd: {
          type: 'string',
          description: 'Working directory to run the script in. Defaults to the current project directory.',
        },
        timeout_seconds: {
          type: 'number',
          description: 'Timeout in seconds (default: 60, max: 300).',
        },
      },
      required: ['name'],
    },
  },

  async handler(args: Record<string, unknown>): Promise<string> {
    const name = String(args.name ?? '').trim();
    const substitutions = (args.args && typeof args.args === 'object')
      ? args.args as Record<string, string>
      : {};
    const cwd = args.cwd ? resolve(String(args.cwd)) : process.cwd();
    const timeoutSec = Math.min(Number(args.timeout_seconds ?? 60), 300);

    const nameErr = validateName(name);
    if (nameErr) return `Error: ${nameErr}`;

    const index = loadIndex();
    if (!index[name]) {
      const available = Object.keys(index).slice(0, 10).join(', ') || '(none saved yet)';
      return `Error: Script "${name}" not found.\nAvailable scripts: ${available}\nUse ScriptList to see all scripts.`;
    }

    const meta = index[name];
    let command = meta.command;

    // Apply {{placeholder}} substitutions
    for (const [key, val] of Object.entries(substitutions)) {
      command = command.replaceAll(`{{${key}}}`, String(val));
    }

    // Check for unresolved placeholders
    const unresolved = [...command.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
    if (unresolved.length > 0) {
      return [
        `Error: Unresolved placeholders in script "${name}": ${unresolved.map((p) => `{{${p}}}`).join(', ')}`,
        `Provide them via args parameter. E.g. args={"${unresolved[0]}": "value"}`,
      ].join('\n');
    }

    const startTime = Date.now();
    let output: string;
    let exitCode = 0;

    try {
      output = execSync(command, {
        cwd,
        timeout: timeoutSec * 1000,
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
        maxBuffer: 2 * 1024 * 1024, // 2 MB
      });
    } catch (err: unknown) {
      const e = err as { message?: string; stdout?: string; stderr?: string; status?: number };
      exitCode = e.status ?? 1;
      output = [
        e.stdout ? `STDOUT:\n${e.stdout}` : '',
        e.stderr ? `STDERR:\n${e.stderr}` : '',
        !e.stdout && !e.stderr ? (e.message ?? 'Command failed') : '',
      ].filter(Boolean).join('\n');
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    // Update run stats
    index[name].lastRun = Date.now();
    index[name].runCount += 1;
    saveIndex(index);

    // Truncate very long output
    const MAX_OUTPUT = 8000;
    const truncated = output.length > MAX_OUTPUT;
    if (truncated) output = output.slice(0, MAX_OUTPUT) + `\n\n... [truncated — ${output.length - MAX_OUTPUT} more chars]`;

    return [
      `▶ Script "${name}" — exit code ${exitCode} — ${elapsed}s`,
      `  CWD: ${cwd}`,
      ``,
      output || '(no output)',
    ].join('\n');
  },
};

// ── Tool 3: ScriptList ────────────────────────────────────────────────────────

export const scriptListTool: ToolRegistration = {
  definition: {
    name: 'ScriptList',
    description: [
      'List all saved scripts with their descriptions, tags, and usage stats.',
      'Use to discover available scripts before calling ScriptRun.',
      'Optionally filter by tag.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        tag: {
          type: 'string',
          description: 'Filter scripts by tag. Omit to list all.',
        },
        show_commands: {
          type: 'boolean',
          description: 'Include full command preview in output (default: false).',
        },
      },
    },
  },

  async handler(args: Record<string, unknown>): Promise<string> {
    const filterTag = args.tag ? String(args.tag) : null;
    const showCommands = Boolean(args.show_commands ?? false);

    const index = loadIndex();
    let entries = Object.values(index);

    if (filterTag) {
      entries = entries.filter((s) => s.tags.includes(filterTag));
    }

    if (entries.length === 0) {
      const hint = filterTag
        ? `No scripts with tag "${filterTag}".`
        : 'No scripts saved yet. Use ScriptSave to create one.';
      return hint;
    }

    // Sort: most recently used first, then by name
    entries.sort((a, b) => (b.lastRun ?? 0) - (a.lastRun ?? 0));

    const lines = [
      `📜 Saved Scripts (${entries.length} total):`,
      '',
    ];

    for (const s of entries) {
      const lastRun = s.lastRun
        ? `last run ${new Date(s.lastRun).toLocaleDateString()}, ${s.runCount}×`
        : 'never run';
      const tagStr = s.tags.length > 0 ? `  [${s.tags.join(', ')}]` : '';
      lines.push(`  ${s.name.padEnd(24)} ${s.description.slice(0, 50)}${tagStr}`);
      lines.push(`  ${''.padEnd(24)} ${lastRun}`);
      if (showCommands) {
        const preview = s.command.slice(0, 120).replace(/\n/g, ' ↵ ');
        lines.push(`  ${''.padEnd(24)} $ ${preview}${s.command.length > 120 ? '...' : ''}`);
      }
      lines.push('');
    }

    lines.push(`Tip: ScriptRun name="<name>"  to execute a script`);
    lines.push(`     ScriptSave name="<name>" command="..." description="..."  to save a new one`);

    return lines.join('\n');
  },
};
