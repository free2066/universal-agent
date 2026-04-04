#!/usr/bin/env node
// Suppress Node.js DeprecationWarnings from third-party deps (e.g. punycode in openai SDK)
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'DeprecationWarning') process.stderr.write(String(w) + '\n'); });

// Auto-update: pull + rebuild if a new version is available, then prompt restart.
import { checkAndUpdate, printUpdateBanner } from './auto-update.js';
const _hasUpdate = await checkAndUpdate();

import { program } from 'commander';
import chalk from 'chalk';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { config } from 'dotenv';

import { AgentCore } from '../core/agent.js';
import { modelManager } from '../models/model-manager.js';
import { printBanner } from './ui-enhanced.js';
import { loadConfig } from './config-store.js';

// Command module registrations
import { validateDomain, validateModel, inferProviderEnvKey } from './commands/shared.js';
import { registerModelsCommands } from './commands/cmd-models.js';
import { registerMcpCommands } from './commands/cmd-mcp.js';
import { registerMemoryCommands } from './commands/cmd-memory.js';
import { registerSchemaCommands } from './commands/cmd-schema.js';
import { registerSpecCommands } from './commands/cmd-spec.js';
import { registerMiscCommands } from './commands/cmd-misc.js';

// REPL
import { runREPL } from './repl/repl.js';

// ── Environment setup ────────────────────────────────────────────────────────
// Load env — ~/.uagent/.env is the primary config store (override: true so it
// always wins over any stale values from the project .env or shell environment).
const homeEnv = resolve(process.env.HOME || '~', '.uagent', '.env');
if (existsSync(homeEnv)) config({ path: homeEnv, override: true });
// Also load project-level .env (without override — home .env takes precedence)
config({ path: resolve(process.cwd(), '.env') });

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
  .option('-m, --model <model>', 'Model to use')
  .option('-q, --quiet', 'Non-interactive: print response and exit (pipe-friendly)')
  .option('-c, --continue', 'Continue from last session snapshot')
  .option('--safe', 'Enable safe mode (blocks dangerous commands)', false)
  .option('-v, --verbose', 'Show tool call details')
  .option('--system-prompt <text>', 'Override system prompt')
  .option('--append-system-prompt <text>', 'Append text to the system prompt')
  .option('--thinking <level>', 'Claude extended-thinking level: low | medium | high | max | xhigh | maxOrXhigh')
  .option('--output-format <fmt>', 'Output format: text | stream-json | json', 'text')
  .option('--language <lang>', 'Response language (e.g. Chinese, English)')
  .option('--cwd <path>', 'Set working directory')
  .option('--approval-mode <mode>', 'Approval mode: default | autoEdit | yolo')
  .action(async (promptArg: string | undefined, options: {
    domain: string; model?: string; quiet?: boolean; continue?: boolean;
    safe: boolean; verbose?: boolean; systemPrompt?: string;
    appendSystemPrompt?: string; thinking?: string; outputFormat?: string;
    language?: string; cwd?: string; approvalMode?: string;
  }) => {
    if (options.cwd) process.chdir(options.cwd);
    validateDomain(options.domain);

    // ── Read config defaults (CLI flags take precedence over config file) ──
    const cfg = loadConfig();

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

    // --quiet (-q): one-shot non-interactive mode
    if (options.quiet && promptArg) {
      const agent = new AgentCore({
        domain: options.domain, model: resolvedModel,
        stream: true, verbose: false, safeMode: options.safe,
        systemPromptOverride: resolvedSystemPrompt,
        appendSystemPrompt: options.appendSystemPrompt,
        thinkingLevel: resolvedThinkingLevel,
        approvalMode: resolvedApprovalMode as 'default' | 'autoEdit' | 'yolo',
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
      appendSystemPrompt: options.appendSystemPrompt,
      thinkingLevel: resolvedThinkingLevel,
      approvalMode: resolvedApprovalMode as 'default' | 'autoEdit' | 'yolo',
    });
    await agent.initMCP().catch(() => {});
    await runREPL(agent, options, {
      initialPrompt: promptArg,
      continueSession: options.continue ?? false,
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
