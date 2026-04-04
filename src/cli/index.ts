#!/usr/bin/env node
// Suppress Node.js DeprecationWarnings from third-party deps (e.g. punycode in openai SDK)
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'DeprecationWarning') process.stderr.write(String(w) + '\n'); });

// ── Environment setup (MUST be before all other imports) ──────────────────────
// dotenv must load BEFORE any module is imported because model-manager.ts,
// free-model-detector.ts, and llm-client.ts all read process.env at import time
// (static initializers / export const singletons).
import { config as dotenvConfig } from 'dotenv';
import { existsSync as _existsSync } from 'fs';
import { resolve as _resolve } from 'path';
{
  const homeEnv = _resolve(process.env.HOME || '~', '.uagent', '.env');
  if (_existsSync(homeEnv)) dotenvConfig({ path: homeEnv, override: true });
  dotenvConfig({ path: _resolve(process.cwd(), '.env') });
}

// Auto-update: pull + rebuild if a new version is available, then prompt restart.
import { checkAndUpdate, printUpdateBanner } from './auto-update.js';
const _hasUpdate = await checkAndUpdate();

import { program } from 'commander';
import chalk from 'chalk';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

import { AgentCore } from '../core/agent.js';
import { modelManager } from '../models/model-manager.js';
import { printBanner } from './ui-enhanced.js';
import { loadConfig } from './config-store.js';

import { validateDomain, validateModel, inferProviderEnvKey } from './commands/shared.js';
import { registerModelsCommands } from './commands/cmd-models.js';
import { registerMcpCommands } from './commands/cmd-mcp.js';
import { registerMemoryCommands } from './commands/cmd-memory.js';
import { registerSchemaCommands } from './commands/cmd-schema.js';
import { registerSpecCommands } from './commands/cmd-spec.js';
import { registerMiscCommands } from './commands/cmd-misc.js';
import { runREPL } from './repl/repl.js';

// ── Program metadata ─────────────────────────────────────────────────────────
const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')
);

program
  .name('uagent')
  .description(pkg.description)
  .version(pkg.version);

// ── Default command: uagent [prompt] (aligns with `flickcli [prompt]`) ───────
program
  .command('chat', { isDefault: true })
  .description('Start interactive agent session')
  .argument('[prompt]', 'Initial prompt — starts interactive mode (or -q for one-shot)')
  .option('-d, --domain <domain>', 'Domain (data|dev|service|auto)', 'auto')
  .option('-m, --model <model>', 'Model to use (main/planning model)')
  .option('--plan-model <model>', 'Model for planning/complex reasoning tasks (maps to task pointer)')
  .option('--small-model <model>', 'Fast/cheap model for quick operations (maps to quick/compact pointer)')
  .option('--vision-model <model>', 'Vision-capable model for image tasks')
  .option('-q, --quiet', 'Non-interactive: print response and exit (pipe-friendly)')
  .option('-c, --continue', 'Continue from last session snapshot')
  .option('-r, --resume <sessionId>', 'Resume a specific session by ID (see: uagent log)')
  .option('--safe', 'Enable safe mode (blocks dangerous commands)', false)
  .option('-v, --verbose', 'Show tool call details')
  .option('--system-prompt <text>', 'Override system prompt')
  .option('--append-system-prompt <text>', 'Append text to the system prompt')
  .option('--output-style <style>', 'Output style: named preset, path to .md file, or inline JSON {"prompt":"..."}')
  .option('--thinking <level>', 'Claude extended-thinking level: low | medium | high | max | xhigh | maxOrXhigh')
  .option('--output-format <fmt>', 'Output format: text | stream-json | json', 'text')
  .option('--language <lang>', 'Response language (e.g. Chinese, English)')
  .option('--cwd <path>', 'Set working directory')
  .option('--approval-mode <mode>', 'Approval mode: default | autoEdit | yolo')
  .option('--tools <json>', 'Disable specific tools as JSON, e.g. \'{"bash":false,"write":false}\'')
  .option('--mcp-config <jsonOrFile>', 'One-shot MCP server config (JSON string or path to .json file). Not persisted.')
  .option('--browser', 'Enable browser integration (requires Playwright MCP server)')
  .action(async (promptArg: string | undefined, options: {
    domain: string; model?: string; planModel?: string; smallModel?: string; visionModel?: string;
    quiet?: boolean; continue?: boolean; resume?: string;
    safe: boolean; verbose?: boolean; systemPrompt?: string;
    appendSystemPrompt?: string; outputStyle?: string; thinking?: string; outputFormat?: string;
    language?: string; cwd?: string; approvalMode?: string; tools?: string;
    mcpConfig?: string; browser?: boolean;
  }) => {
    if (options.cwd) process.chdir(options.cwd);
    validateDomain(options.domain);

    // ── Read config defaults (CLI flags take precedence over config file) ──
    const cfg = loadConfig();

    // ── Resolve --plan-model / --small-model / --vision-model ──────────────
    // These map to model-manager pointers: task, quick/compact, and a env hint
    if (options.planModel) modelManager.setPointer('task', options.planModel);
    if (options.smallModel) {
      modelManager.setPointer('quick', options.smallModel);
      modelManager.setPointer('compact', options.smallModel);
    }
    if (options.visionModel) process.env.AGENT_VISION_MODEL = options.visionModel;

    // ── Resolve --output-style ────────────────────────────────────────────────
    // Formats: named preset (e.g. "Concise"), file path (./style.md), JSON ({"prompt":"..."})
    let resolvedOutputStylePrompt: string | undefined;
    if (options.outputStyle) {
      const style = options.outputStyle.trim();
      if (style.startsWith('{')) {
        try {
          const parsed = JSON.parse(style) as { prompt?: string };
          resolvedOutputStylePrompt = parsed.prompt ?? style;
        } catch { resolvedOutputStylePrompt = style; }
      } else if (existsSync(resolve(style))) {
        try { resolvedOutputStylePrompt = readFileSync(resolve(style), 'utf-8').trim(); } catch {}
      } else {
        // Named presets
        const presets: Record<string, string> = {
          Concise: 'Be concise and direct. Avoid unnecessary explanations.',
          Explanatory: 'Explain your reasoning step by step. Be thorough and educational.',
          Formal: 'Use formal language and precise technical terminology.',
          Casual: 'Use a casual, friendly tone.',
        };
        resolvedOutputStylePrompt = presets[style] ?? `Respond in ${style} style.`;
      }
    }

    // ── Resolve --mcp-config (one-shot, not persisted) ───────────────────────
    if (options.mcpConfig) {
      try {
        let raw = options.mcpConfig.trim();
        if (!raw.startsWith('{') && existsSync(resolve(raw))) {
          raw = readFileSync(resolve(raw), 'utf-8');
        }
        const mcpCfg = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
        const servers = mcpCfg.mcpServers ?? {};
        // Temporarily inject into the environment so MCPManager picks it up via .mcp.json
        // We do this by writing to a temp env var; MCPManager reads this in connectAll()
        process.env.UAGENT_MCP_INLINE = JSON.stringify(servers);
      } catch (e) {
        console.error(`Invalid --mcp-config: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    }

    // ── --browser: ensure Playwright MCP is active ───────────────────────────
    if (options.browser) {
      // Hint to MCPManager to auto-activate the playwright server if configured
      process.env.UAGENT_BROWSER_MODE = '1';
    }

    // ── Resolve tools disable map ──────────────────────────────────────────
    // Priority: CLI --tools > project config.tools > global config.tools
    // loadConfig() already merges project + global (project wins), so cfg.tools
    // represents the merged baseline; CLI --tools is applied on top.
    let resolvedDisabledTools: Record<string, boolean> | undefined = cfg.tools;
    if (options.tools) {
      let cliTools: Record<string, boolean>;
      try {
        cliTools = JSON.parse(options.tools);
      } catch {
        console.error(`Invalid --tools JSON: ${options.tools}`);
        process.exit(1);
      }
      // Merge: CLI overrides config (CLI wins for same keys)
      resolvedDisabledTools = { ...(cfg.tools ?? {}), ...cliTools };
    }

    // Model: CLI flag > config file > auto-select
    // Note: wanqing/* model names in config are CodeFlicker-internal service-discovery IDs.
    // uagent has its own wanqing endpoint detector (autoSelectFreeModel) that finds the
    // correct ep-* endpoint at runtime — skip the config value and let it auto-detect.
    const cfgModel = cfg.model;
    const skipCfgModel = typeof cfgModel === 'string' && cfgModel.startsWith('wanqing/');
    let resolvedModel = options.model ?? (skipCfgModel ? '' : cfgModel ?? '');
    if (!resolvedModel) {
      await modelManager.autoSelectFreeModel(options.quiet ?? false);
      resolvedModel = modelManager.getCurrentModel('main');
    } else {
      validateModel(resolvedModel);
    }

    // Other options resolved from config
    const resolvedSystemPrompt   = options.systemPrompt  ?? cfg.systemPrompt;
    const resolvedLanguage       = options.language       ?? cfg.language;
    const resolvedApprovalMode   = options.approvalMode   ?? cfg.approvalMode  ?? 'default';
    const resolvedThinkingLevel  = (options.thinking      ?? cfg.thinkingLevel) as
      import('./config-store.js').ThinkingLevelExtended | undefined;

    // ── Resolve --output-style → appendSystemPrompt ─────────────────────────
    const resolvedAppendPrompt = resolvedOutputStylePrompt
      ? [options.appendSystemPrompt, resolvedOutputStylePrompt].filter(Boolean).join('\n')
      : options.appendSystemPrompt;

    // --quiet (-q): one-shot non-interactive mode
    if (options.quiet && promptArg) {
      const agent = new AgentCore({
        domain: options.domain, model: resolvedModel,
        stream: true, verbose: false, safeMode: options.safe,
        systemPromptOverride: resolvedSystemPrompt,
        appendSystemPrompt: resolvedAppendPrompt,
        thinkingLevel: resolvedThinkingLevel,
        approvalMode: resolvedApprovalMode as 'default' | 'autoEdit' | 'yolo',
        disabledTools: resolvedDisabledTools,
      });
      await agent.initMCP().catch(() => {});
      let finalPrompt = promptArg;
      if (resolvedLanguage) finalPrompt += `\n\nRespond in ${resolvedLanguage}.`;
      await agent.runStream(finalPrompt, (chunk) => process.stdout.write(chunk));
      process.stdout.write('\n');
      process.exit(0);
    }

    // Interactive mode
    printBanner();
    if (_hasUpdate) printUpdateBanner();
    const summary = await modelManager.autoSelectFreeModel(true);
    const firstLine = summary.split('\n')[0];
    if (firstLine) console.log(chalk.cyan(`\n${firstLine}\n`));

    const agent = new AgentCore({
      domain: options.domain, model: resolvedModel,
      stream: true, verbose: options.verbose ?? false, safeMode: options.safe,
      systemPromptOverride: resolvedSystemPrompt,
      appendSystemPrompt: resolvedAppendPrompt,
      thinkingLevel: resolvedThinkingLevel,
      approvalMode: resolvedApprovalMode as 'default' | 'autoEdit' | 'yolo',
      disabledTools: resolvedDisabledTools,
    });
    await agent.initMCP().catch(() => {});
    await runREPL(agent, options, {
      initialPrompt: promptArg,
      continueSession: options.continue ?? false,
      resumeSessionId: options.resume,
      inferProviderEnvKey,
      notification: cfg.notification,
    });
  });

// ── Register all subcommand groups ──────────────────────────────────────────
const helpers = { validateDomain, validateModel, inferProviderEnvKey };
registerModelsCommands(program);
registerMcpCommands(program);
registerMemoryCommands(program);
registerSchemaCommands(program);
registerSpecCommands(program);
registerMiscCommands(program, helpers);

program.parse();
