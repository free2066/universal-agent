#!/usr/bin/env node
// Suppress Node.js DeprecationWarnings from third-party deps (e.g. punycode in openai SDK)
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'DeprecationWarning') process.stderr.write(String(w) + '\n'); });

// Auto-update: pull + rebuild if a new version is available, then prompt restart.
import { checkAndUpdate, printUpdateBanner } from './auto-update.js';
const _hasUpdate = await checkAndUpdate();

import { program } from 'commander';
import { createInterface } from 'readline';
import chalk from 'chalk';
import ora from 'ora';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { config } from 'dotenv';
import { AgentCore } from '../core/agent.js';
import { modelManager } from '../models/model-manager.js';
import { subagentSystem } from '../core/subagent-system.js';
import { initAgentsMd, loadRules } from '../core/context/context-loader.js';
import { MCPManager } from '../core/mcp-manager.js';
import { codeInspectorTool } from '../core/tools/code/code-inspector.js';
import { selfHealTool } from '../core/tools/code/self-heal.js';
import { getRecentHistory } from '../core/memory/session-history.js';
import { printBanner, printHelp } from './ui.js';
import { initStatusBar, updateStatusBar, clearStatusBar, type ThinkingLevel } from './statusbar.js';
import { HookRunner } from '../core/hooks.js';

// Load env — ~/.uagent/.env is the primary config store (override: true so it
// always wins over any stale values from the project .env or shell environment).
const homeEnv = resolve(process.env.HOME || '~', '.uagent', '.env');
if (existsSync(homeEnv)) config({ path: homeEnv, override: true });
// Also load project-level .env (without override — home .env takes precedence)
config({ path: resolve(process.cwd(), '.env') });

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')
);

program
  .name('uagent')
  .description(pkg.description)
  .version(pkg.version);

// ── Default command: uagent [prompt] (aligns with `flickcli [prompt]`) ─────────
program
  .command('chat', { isDefault: true })
  .description('Start interactive agent session')
  .argument('[prompt]', 'Initial prompt \u2014 starts interactive mode (or -q for one-shot)')
  .option('-d, --domain <domain>', 'Domain (data|dev|service|auto)', 'auto')
  .option('-m, --model <model>', 'Model to use')
  .option('-q, --quiet', 'Non-interactive: print response and exit (pipe-friendly)')
  .option('-c, --continue', 'Continue from last session snapshot')
  .option('--safe', 'Enable safe mode (blocks dangerous commands)', false)
  .option('-v, --verbose', 'Show tool call details')
  .option('--system-prompt <text>', 'Override system prompt')
  .option('--append-system-prompt <text>', 'Append text to the system prompt')
  .option('--thinking <level>', 'Claude extended-thinking level: low | medium | high')
  .option('--output-format <fmt>', 'Output format: text | stream-json | json', 'text')
  .option('--language <lang>', 'Response language (e.g. Chinese, English)')
  .option('--cwd <path>', 'Set working directory')
  .option('--approval-mode <mode>', 'Approval mode: default | autoEdit | yolo', 'default')
  .action(async (promptArg: string | undefined, options: {
    domain: string; model?: string; quiet?: boolean; continue?: boolean;
    safe: boolean; verbose?: boolean; systemPrompt?: string;
    appendSystemPrompt?: string; thinking?: string; outputFormat?: string;
    language?: string; cwd?: string; approvalMode?: string;
  }) => {
    if (options.cwd) process.chdir(options.cwd);
    validateDomain(options.domain);

    let resolvedModel = options.model ?? '';
    if (!resolvedModel) {
      await modelManager.autoSelectFreeModel(options.quiet ?? false);
      resolvedModel = modelManager.getCurrentModel('main');
    } else {
      validateModel(resolvedModel);
    }

    // --quiet (-q): one-shot non-interactive mode
    if (options.quiet && promptArg) {
      const agent = new AgentCore({
        domain: options.domain, model: resolvedModel,
        stream: true, verbose: false, safeMode: options.safe,
        systemPromptOverride: options.systemPrompt,
        appendSystemPrompt: options.appendSystemPrompt,
        thinkingLevel: options.thinking as 'low' | 'medium' | 'high' | undefined,
      });
      await agent.initMCP().catch(() => {});
      let finalPrompt = promptArg;
      if (options.language) finalPrompt += `\n\nRespond in ${options.language}.`;
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
      systemPromptOverride: options.systemPrompt,
      appendSystemPrompt: options.appendSystemPrompt,
      thinkingLevel: options.thinking as 'low' | 'medium' | 'high' | undefined,
    });
    await agent.initMCP().catch(() => {});
    await runREPL(agent, options, {
      initialPrompt: promptArg,
      continueSession: options.continue ?? false,
    });
  });

// ── run ──────────────────────────────────────────────────
// Valid domain values for validation
const VALID_DOMAINS = ['auto', 'data', 'dev', 'service'];

function validateDomain(domain: string): void {
  if (!VALID_DOMAINS.includes(domain)) {
    console.error(chalk.red(`\n✗ Invalid domain: "${domain}"`))
    console.error(chalk.yellow(`  Valid domains: ${VALID_DOMAINS.join(', ')}`))
    process.exit(1);
  }
}

function validateModel(model: string): void {
  // Allow any model that looks plausible: known prefixes or ollama:xxx format
  const knownPrefixes = ['gpt-', 'o1', 'o3', 'o4', 'claude-', 'gemini-', 'deepseek', 'moonshot', 'kimi', 'qwen', 'qwq', 'mistral', 'mixtral', 'ollama:', 'groq:', 'siliconflow:', 'openrouter:'];
  const isKnown = knownPrefixes.some((p) => model.startsWith(p));
  if (!isKnown) {
    // Also allow models registered in the manager
    const profiles = modelManager.listProfiles();
    const isRegistered = profiles.some((p) => p.name === model || p.modelName === model);
    if (!isRegistered) {
      console.error(chalk.red(`\n✗ Unknown model: "${model}"`))
      console.error(chalk.yellow(`  Run: uagent models list  — to see available models`))
      console.error(chalk.gray(`  Or use a known prefix: gpt-*, claude-*, gemini-*, deepseek*, qwen*, ollama:<name>`))
      process.exit(1);
    }
  }
  // Extra check: model name must look like a real identifier (no spaces, reasonable length,
  // alphanumeric/dash/dot/colon only) — catches obviously-fake names like 'invalid_model'.
  // We use underscore-free pattern: legitimate model IDs from all major providers never use _.
  if (model.includes('_') && !model.startsWith('ollama:')) {
    // Underscores are extremely rare in real model IDs but common in test/placeholder names.
    // Warn and exit to catch mistakes like `-m invalid_model`.
    console.error(chalk.red(`\n✗ Suspicious model name: "${model}" (contains underscore)`))
    console.error(chalk.yellow(`  Real model IDs use hyphens, not underscores (e.g. gpt-4o, claude-3-5-sonnet-20241022)`))
    console.error(chalk.gray(`  Run: uagent models list  — to see available models`))
    process.exit(1);
  }
}

/**
 * Infer which env var name is likely missing based on an error message.
 * Used to jump directly to the right key prompt in configureAgent().
 */
function inferProviderEnvKey(errMsg: string): string | undefined {
  if (errMsg.includes('gemini') || errMsg.includes('GEMINI'))   return 'GEMINI_API_KEY';
  if (errMsg.includes('groq')   || errMsg.includes('GROQ'))     return 'GROQ_API_KEY';
  if (errMsg.includes('openrouter') || errMsg.includes('OPENROUTER')) return 'OPENROUTER_API_KEY';
  if (errMsg.includes('deepseek') || errMsg.includes('DEEPSEEK')) return 'DEEPSEEK_API_KEY';
  if (errMsg.includes('anthropic') || errMsg.includes('ANTHROPIC')) return 'ANTHROPIC_API_KEY';
  if (errMsg.includes('siliconflow') || errMsg.includes('SILICONFLOW')) return 'SILICONFLOW_API_KEY';
  return undefined; // will show all providers
}

program
  .command('run [prompt]')
  .description('Convert natural language to a shell command and execute it (aligns with flickcli run)')
  .option('-m, --model <model>', 'Model to use')
  .option('-y, --yes', 'Auto-execute without confirmation')
  .option('--copy', 'Copy generated command to clipboard instead of executing')
  .option('--explain', 'Show explanation alongside the command')
  .option('--safe', 'Refuse destructive commands (rm -rf, dd, etc.)')
  .option('--task', 'Run as an agent task instead of NL→Shell (legacy mode)')
  .option('-d, --domain <domain>', 'Agent domain for --task mode', 'auto')
  .option('-f, --file <file>', 'Input file path (--task mode only)')
  .option('--context <ids>', 'Context IDs for --task mode')
  .option('--save-context <id>', 'Save output to context file (--task mode only)')
  .action(async (prompt: string | undefined, options) => {
    // ── NL→Shell mode (default, aligns with flickcli run) ──
    if (!options.task) {
      const { runShell } = await import('./shell.js');
      await runShell({
        prompt,
        model: options.model,
        yes: options.yes,
        copy: options.copy,
        explain: options.explain,
        safe: options.safe,
      });
      return;
    }

    // ── Legacy agent task mode (--task flag) ──
    if (!prompt) {
      console.error(chalk.red('\n✗ --task mode requires a prompt argument'));
      process.exit(1);
    }
    validateDomain(options.domain);

    // Build prompt with injected context files (context file chaining)
    let fullPrompt: string = options.file ? `${prompt}\n\n[File: ${options.file}]` : prompt;
    if (options.context) {
      const { existsSync, readFileSync, mkdirSync } = await import('fs');
      const { join } = await import('path');
      const contextIds: string[] = (options.context as string).split(',').map((s: string) => s.trim()).filter(Boolean);
      const contextParts: string[] = [];
      for (const id of contextIds) {
        const ctxFile = join(process.cwd(), '.uagent', 'context', `${id}.md`);
        if (existsSync(ctxFile)) {
          contextParts.push(`## Context from [${id}]\n${readFileSync(ctxFile, 'utf-8').trim()}`);
        } else {
          console.warn(chalk.yellow(`  ⚠ Context file not found: .uagent/context/${id}.md`));
        }
      }
      if (contextParts.length > 0) {
        fullPrompt = `${contextParts.join('\n\n')}\n\n---\n## Your Task\n${fullPrompt}`;
      }
    }

    const agent = new AgentCore({
      domain: options.domain,
      model: options.model,
      stream: false,
      verbose: false,
      safeMode: options.safe,
    });
    const spinner = ora('Thinking...').start();
    try {
      const result = await agent.run(fullPrompt, options.file);
      spinner.stop();
      console.log('\n' + result);

      // Save output to context file for downstream chaining (優化点4)
      if (options.saveContext) {
        const { writeFileSync, mkdirSync } = await import('fs');
        const { join } = await import('path');
        const ctxDir = join(process.cwd(), '.uagent', 'context');
        mkdirSync(ctxDir, { recursive: true });
        const ctxContent = [
          `# Agent Context: ${options.saveContext}`,
          '',
          `> Generated at: ${new Date().toISOString()}`,
          '',
          result,
        ].join('\n');
        writeFileSync(join(ctxDir, `${options.saveContext}.md`), ctxContent, 'utf-8');
        console.log(chalk.green(`\n✓ Context saved → .uagent/context/${options.saveContext}.md`));
      }
    } catch (err) {
      spinner.stop();
      const msg = err instanceof Error ? err.message : String(err);
      // Detect API key errors — auto-trigger interactive setup instead of just printing and exiting
      const isAuthError = msg.includes('API_KEY') || msg.includes('api key') ||
        msg.includes('authentication') || msg.includes('401') || msg.includes('403') ||
        msg.includes('Unauthorized') || msg.includes('invalid_api_key') ||
        msg.includes('No API key') || msg.includes('api-key');
      if (isAuthError) {
        console.error(chalk.red('\n✗ API key missing or invalid.'));
        console.log(chalk.yellow('  Let\'s set up your API keys now...\n'));
        const { configureAgent } = await import('./configure.js');
        await configureAgent(
          'API authentication failed — please add or update your key',
          inferProviderEnvKey(msg),
        );
        console.log(chalk.gray('  Restart uagent to apply the new key.'));
      } else {
        console.error(chalk.red('\n✗ ') + msg);
      }
      process.exit(1);
    }
  });

// ── config ───────────────────────────────────────────────
program
  .command('config')
  .description('Configure API keys and settings')
  .action(async () => {
    const { configureAgent } = await import('./configure.js');
    await configureAgent();
  });

// ── debug ────────────────────────────────────────────────
program
  .command('debug')
  .description('Run diagnostic health check (keys, connectivity, models, config files)')
  .option('--ping', 'Also run live connectivity tests to each configured provider')
  .option('--json', 'Output report as JSON (for bug reports / CI)')
  .action(async (options) => {
    const { runDebugCheck } = await import('./debug-check.js');
    await runDebugCheck({ ping: options.ping, json: options.json });
  });

// ── usage ────────────────────────────────────────────────
program
  .command('usage')
  .description('Show token usage statistics and cost summary')
  .option('--days <n>', 'Number of days to show (default: 7)', '7')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const { usageTracker } = await import('../models/usage-tracker.js');
    const days = parseInt(options.days) || 7;
    if (options.json) {
      const history = usageTracker.getRawHistory(days);
      console.log(JSON.stringify(history, null, 2));
    } else {
      console.log('\n' + usageTracker.getSummary(days) + '\n');
    }
  });

// ── limits ───────────────────────────────────────────────
program
  .command('limits')
  .description('View or set daily usage limits')
  .option('--tokens <n>', 'Set daily token limit (input+output combined)')
  .option('--cost <usd>', 'Set daily cost limit in USD (e.g. 1.0)')
  .option('--warn <pct>', 'Warn when usage reaches this % (default: 80)')
  .option('--block <pct>', 'Block when usage reaches this % (default: 100)')
  .option('--reset', 'Clear all daily limits')
  .action(async (options) => {
    const { usageTracker } = await import('../models/usage-tracker.js');
    if (options.reset) {
      usageTracker.setLimits({ dailyTokenLimit: undefined, dailyCostLimitUSD: undefined });
      console.log(chalk.green('✓ All daily limits cleared.'));
      return;
    }
    const updates: Record<string, number | undefined> = {};
    if (options.tokens) updates.dailyTokenLimit = parseInt(options.tokens);
    if (options.cost)   updates.dailyCostLimitUSD = parseFloat(options.cost);
    if (options.warn)   updates.warnAtPercent = parseInt(options.warn);
    if (options.block)  updates.blockAtPercent = parseInt(options.block);
    if (Object.keys(updates).length > 0) {
      usageTracker.setLimits(updates);
      console.log(chalk.green('✓ Limits updated.'));
    }
    // Always show current limits
    const lim = usageTracker.getLimits();
    console.log(chalk.yellow('\n📏 Daily Limits:'));
    console.log(`  Tokens: ${lim.dailyTokenLimit ? lim.dailyTokenLimit.toLocaleString() : chalk.gray('not set')}`);
    console.log(`  Cost:   ${lim.dailyCostLimitUSD ? '$' + lim.dailyCostLimitUSD : chalk.gray('not set')}`);
    console.log(`  Warn at:  ${lim.warnAtPercent}%`);
    console.log(`  Block at: ${lim.blockAtPercent}%`);
    console.log(chalk.gray('\n  Set:   uagent limits --tokens 100000 --cost 1.0'));
    console.log(chalk.gray('  Reset: uagent limits --reset\n'));
  });

// ── domains ──────────────────────────────────────────────
program
  .command('domains')
  .description('List available domains and their tools')
  .action(async () => {
    const { DomainRouter } = await import('../core/domain-router.js');
    const router = new DomainRouter();
    router.listDomains();
  });

// ── agents ───────────────────────────────────────────────
program
  .command('agents')
  .description('List available subagents')
  .action(() => {
    console.log(chalk.yellow('\n👤 Available Subagents:\n'));
    for (const agent of subagentSystem.listAgents()) {
      console.log(chalk.cyan(`  @run-agent-${agent.name.padEnd(20)}`), chalk.gray(agent.description));
    }
    console.log();
  });

// ── models ───────────────────────────────────────────────
const modelsCmd = program.command('models').description('Manage AI model profiles');

modelsCmd.command('list').description('List configured models').action(() => {
  console.log(chalk.yellow('\n🤖 Model Profiles:\n'));
  const profiles = modelManager.listProfiles();
  const pointers = modelManager.getPointers();
  for (const p of profiles) {
    const isActive = Object.values(pointers).includes(p.name);
    const marker = isActive ? chalk.green('●') : chalk.gray('○');
    const role = Object.entries(pointers).filter(([, v]) => v === p.name).map(([k]) => k).join('/');
    console.log(`  ${marker} ${chalk.white(p.name.padEnd(22))} ${chalk.gray(p.provider + ':' + p.modelName)} ${role ? chalk.cyan(`[${role}]`) : ''}`);
  }
  console.log(chalk.gray('\n  Pointers: main, task, compact, quick\n'));
});

modelsCmd.command('export')
  .description('Export model config as YAML')
  .option('-o, --output <file>', 'Output file')
  .action(async (options) => {
    const yaml = modelManager.exportYAML();
    if (options.output) {
      const { writeFileSync } = await import('fs');
      writeFileSync(options.output, yaml);
      console.log(chalk.green(`✓ Exported to ${options.output}`));
    } else {
      console.log(yaml);
    }
  });

modelsCmd.command('set <pointer> <model>')
  .description('Set a model pointer (main|task|compact|quick)')
  .action((pointer, model) => {
    modelManager.setPointer(pointer as never, model);
    console.log(chalk.green(`✓ Set ${pointer} → ${model}`));
  });

modelsCmd.command('add <name>')
  .description('Register a custom model profile')
  .requiredOption('--model-name <modelName>', 'Actual model name sent to the API (e.g. gpt-4o-2024-11-20)')
  .option('--provider <provider>', 'Provider: openai|anthropic|gemini|deepseek|groq|siliconflow|openrouter|ollama|custom', 'custom')
  .option('--base-url <url>', 'Custom API base URL (for openai-compat or private endpoints)')
  .option('--api-key <key>', 'API key (stored in profile; prefer env vars instead)')
  .option('--max-tokens <n>', 'Max output tokens', '8192')
  .option('--context <n>', 'Context window size', '128000')
  .option('--cost-in <usd>', 'Cost per 1k input tokens (USD)', '0')
  .option('--cost-out <usd>', 'Cost per 1k output tokens (USD)', '0')
  .option('--set-as <pointer>', 'Also set this profile as a pointer (main|task|compact|quick)')
  .action((name, options) => {
    const validProviders = ['openai', 'anthropic', 'ollama', 'gemini', 'deepseek', 'moonshot', 'qwen', 'mistral', 'groq', 'siliconflow', 'openrouter', 'custom'];
    if (!validProviders.includes(options.provider)) {
      console.error(chalk.red(`✗ Unknown provider "${options.provider}". Valid: ${validProviders.join(', ')}`));
      process.exit(1);
    }
    const profile = {
      name,
      provider: options.provider as never,
      modelName: options.modelName,
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      maxTokens: parseInt(options.maxTokens),
      contextLength: parseInt(options.context),
      costPer1kInput: parseFloat(options.costIn),
      costPer1kOutput: parseFloat(options.costOut),
      isActive: true,
    };
    modelManager.addProfile(profile);
    console.log(chalk.green(`✓ Added model profile: ${name}`));
    console.log(chalk.gray(`  provider: ${profile.provider}  modelName: ${profile.modelName}  context: ${profile.contextLength.toLocaleString()} tokens`));
    if (options.setAs) {
      modelManager.setPointer(options.setAs as never, name);
      console.log(chalk.green(`✓ Set ${options.setAs} → ${name}`));
    } else {
      console.log(chalk.gray(`  Tip: uagent models set main ${name}  — to use this model`));
    }
  });

modelsCmd.command('remove <name>')
  .description('Remove a custom model profile')
  .action((name) => {
    const profiles = modelManager.listProfiles();
    const exists = profiles.some((p) => p.name === name);
    if (!exists) {
      console.error(chalk.red(`✗ Model "${name}" not found`));
      process.exit(1);
    }
    // Check if it's currently in use as a pointer
    const pointers = modelManager.getPointers();
    const inUse = Object.entries(pointers).filter(([, v]) => v === name).map(([k]) => k);
    if (inUse.length > 0) {
      console.error(chalk.yellow(`⚠  Model "${name}" is currently used as pointer(s): ${inUse.join(', ')}`));
      console.error(chalk.yellow('   Update the pointer(s) first: uagent models set <pointer> <other-model>'));
      process.exit(1);
    }
    modelManager.removeProfile(name);
    console.log(chalk.green(`✓ Removed model profile: ${name}`));
  });

// ── mcp ──────────────────────────────────────────────────
const mcpCmd = program.command('mcp').description('Manage MCP servers (Model Context Protocol)');

mcpCmd.command('list').description('List all configured MCP servers').action(() => {
  const mgr = new MCPManager();
  const servers = mgr.listServers();
  if (!servers.length) {
    console.log(chalk.gray('No MCP servers configured.'));
    console.log(chalk.gray('  Run: uagent mcp init          — create .mcp.json'));
    console.log(chalk.gray('  Run: uagent mcp add --help    — add a server'));
    console.log(chalk.gray('  Run: uagent mcp templates     — browse built-in templates'));
    return;
  }
  console.log(chalk.yellow('\n🔌 MCP Servers:\n'));
  for (const s of servers) {
    const status = s.enabled ? chalk.green('✓ enabled ') : chalk.red('✗ disabled');
    const addr = s.type === 'stdio' ? `${s.command} ${(s.args ?? []).join(' ')}`.slice(0, 60) : (s.url ?? '');
    const desc = s.description ? chalk.gray(`  — ${s.description}`) : '';
    console.log(`  ${status}  ${chalk.white(s.name.padEnd(16))} [${s.type}] ${addr}${desc}`);
  }
  console.log();
  console.log(chalk.gray('  uagent mcp test <name>     — test a server connection'));
  console.log(chalk.gray('  uagent mcp enable <name>   — enable a server'));
  console.log(chalk.gray('  uagent mcp disable <name>  — disable a server'));
  console.log();
});

mcpCmd.command('init')
  .description('Initialize .mcp.json in the current directory')
  .option('--templates', 'Include all built-in template servers (as disabled examples)')
  .action((options) => {
    const result = MCPManager.initConfig(process.cwd(), options.templates);
    console.log(chalk.green(result));
    console.log(chalk.gray('  Edit .mcp.json to configure your MCP servers.'));
    console.log(chalk.gray('  Run: uagent mcp templates  — to see available built-in templates'));
  });

mcpCmd.command('templates').description('Show built-in MCP server templates').action(() => {
  console.log(chalk.yellow('\n📦 Built-in MCP Templates:\n'));
  for (const [name, tmpl] of Object.entries(MCPManager.TEMPLATES)) {
    console.log(`  ${chalk.cyan(name.padEnd(14))} ${tmpl.description}`);
    console.log(`  ${''.padEnd(14)} ${chalk.gray('Setup: ' + tmpl.setupHint)}`);
    console.log();
  }
  console.log(chalk.gray('  Add a template:  uagent mcp add --template <name>'));
  console.log(chalk.gray('  Or init all:     uagent mcp init --templates\n'));
});

mcpCmd.command('add')
  .description('Add an MCP server to .mcp.json')
  .option('--name <name>', 'Server name')
  .option('--template <template>', 'Use a built-in template (run: uagent mcp templates to see list)')
  .option('--type <type>', 'Server type: stdio | sse | http', 'stdio')
  .option('--command <cmd>', 'Command to run (for stdio servers)')
  .option('--args <args>', 'Comma-separated arguments')
  .option('--url <url>', 'Server URL (for sse/http servers)')
  .option('--env <env>', 'Comma-separated ENV=VALUE pairs')
  .option('--disabled', 'Add as disabled (enabled by default)')
  .action((options) => {
    const mgr = new MCPManager();

    if (options.template) {
      const tmpl = MCPManager.TEMPLATES[options.template];
      if (!tmpl) {
        console.error(chalk.red(`Template "${options.template}" not found. Run: uagent mcp templates`));
        process.exit(1);
      }
      const name = options.name ?? options.template;
      const { setupHint, description, ...serverConfig } = tmpl;
      mgr.addServer(name, { ...serverConfig, enabled: !options.disabled, description });
      console.log(chalk.green(`✓ Added "${name}" from template.`));
      console.log(chalk.yellow(`  Setup: ${setupHint}`));
      if (serverConfig.env) {
        console.log(chalk.gray(`  Edit .mcp.json and replace placeholder values in "env":`));
        for (const [k, v] of Object.entries(serverConfig.env)) {
          console.log(chalk.gray(`    ${k}=${v}`));
        }
      }
      return;
    }

    const name = options.name;
    if (!name) {
      console.error(chalk.red('--name is required (or use --template)'));
      process.exit(1);
    }

    const envPairs: Record<string, string> = {};
    if (options.env) {
      for (const pair of String(options.env).split(',')) {
        const [k, ...rest] = pair.split('=');
        if (k) envPairs[k.trim()] = rest.join('=').trim();
      }
    }

    const type = options.type as 'stdio' | 'sse' | 'http';
    if (type === 'stdio' && !options.command) {
      console.error(chalk.red('--command is required for stdio servers'));
      process.exit(1);
    }
    if ((type === 'sse' || type === 'http') && !options.url) {
      console.error(chalk.red('--url is required for sse/http servers'));
      process.exit(1);
    }

    mgr.addServer(name, {
      type,
      command: options.command,
      args: options.args ? String(options.args).split(',').map((a: string) => a.trim()) : undefined,
      url: options.url,
      env: Object.keys(envPairs).length > 0 ? envPairs : undefined,
      enabled: !options.disabled,
    });
    console.log(chalk.green(`✓ Server "${name}" added to ${process.cwd()}/.mcp.json`));
    console.log(chalk.gray('  Run: uagent mcp test ' + name + '  — to verify the connection'));
  });

mcpCmd.command('remove <name>').description('Remove an MCP server from .mcp.json').action((name) => {
  const mgr = new MCPManager();
  const removed = mgr.removeServer(name);
  if (removed) {
    console.log(chalk.green(`✓ Server "${name}" removed.`));
  } else {
    console.error(chalk.red(`Server "${name}" not found.`));
  }
});

mcpCmd.command('enable <name>').description('Enable an MCP server').action((name) => {
  const mgr = new MCPManager();
  if (mgr.enableServer(name, true)) {
    console.log(chalk.green(`✓ Server "${name}" enabled.`));
  } else {
    console.error(chalk.red(`Server "${name}" not found.`));
  }
});

mcpCmd.command('disable <name>').description('Disable an MCP server (keeps config, stops loading)').action((name) => {
  const mgr = new MCPManager();
  if (mgr.enableServer(name, false)) {
    console.log(chalk.green(`✓ Server "${name}" disabled.`));
  } else {
    console.error(chalk.red(`Server "${name}" not found.`));
  }
});

mcpCmd.command('get <name>').description('Show detailed config for a specific MCP server').action((name) => {
  const mgr = new MCPManager();
  const servers = mgr.listServers();
  const s = servers.find((sv) => sv.name === name);
  if (!s) {
    console.error(chalk.red(`\n✗ Server "${name}" not found.`));
    console.log(chalk.gray('  Run: uagent mcp list  — to see configured servers'));
    process.exit(1);
  }
  console.log(chalk.yellow(`\n🔌 MCP Server: ${s.name}\n`));
  console.log(`  Status:  ${s.enabled ? chalk.green('enabled') : chalk.red('disabled')}`);
  console.log(`  Type:    ${chalk.cyan(s.type)}`);
  if (s.command) console.log(`  Command: ${chalk.white(s.command)}`);
  if (s.args?.length) console.log(`  Args:    ${s.args.join(' ')}`);
  if (s.url) console.log(`  URL:     ${chalk.white(s.url)}`);
  if (s.description) console.log(`  Desc:    ${chalk.gray(s.description)}`);
  if (s.env && Object.keys(s.env).length > 0) {
    console.log(`  Env:`);
    for (const [k, v] of Object.entries(s.env)) {
      // Mask values that look like keys/tokens
      const masked = /key|token|secret|pass/i.test(k) ? v.slice(0, 4) + '****' : v;
      console.log(`    ${chalk.gray(k + '=')}${masked}`);
    }
  }
  console.log();
  console.log(chalk.gray('  uagent mcp test ' + name + '  — test connection'));
  console.log(chalk.gray('  uagent mcp enable ' + name + ' / disable ' + name + '  — toggle'));
  console.log();
});

mcpCmd.command('get <name>').description('Show detailed config for a specific MCP server').action((name) => {
  const mgr = new MCPManager();
  const servers = mgr.listServers();
  const s = servers.find((sv) => sv.name === name);
  if (!s) {
    console.error(chalk.red(`\n✗ Server "${name}" not found.`));
    console.log(chalk.gray('  Run: uagent mcp list  — to see configured servers'));
    process.exit(1);
  }
  console.log(chalk.yellow(`\n🔌 MCP Server: ${s.name}\n`));
  console.log(`  Status:  ${s.enabled ? chalk.green('enabled') : chalk.red('disabled')}`);
  console.log(`  Type:    ${chalk.cyan(s.type)}`);
  if (s.command) console.log(`  Command: ${chalk.white(s.command)}`);
  if (s.args?.length) console.log(`  Args:    ${s.args.join(' ')}`);
  if (s.url) console.log(`  URL:     ${chalk.white(s.url)}`);
  if (s.description) console.log(`  Desc:    ${chalk.gray(s.description)}`);
  if (s.env && Object.keys(s.env).length > 0) {
    console.log(`  Env:`);
    for (const [k, v] of Object.entries(s.env)) {
      const masked = /key|token|secret|pass/i.test(k) ? v.slice(0, 4) + '****' : v;
      console.log(`    ${chalk.gray(k + '=')}${masked}`);
    }
  }
  console.log();
  console.log(chalk.gray('  uagent mcp test ' + name + '  — test connection'));
  console.log(chalk.gray('  uagent mcp enable ' + name + ' / disable ' + name + '  — toggle'));
  console.log();
});

mcpCmd.command('test [name]')
  .description('Test MCP server connection(s). Omit name to test all enabled servers.')
  .action(async (name?: string) => {
    const mgr = new MCPManager();
    const servers = name
      ? mgr.listServers().filter((s) => s.name === name)
      : mgr.listServers().filter((s) => s.enabled);

    if (servers.length === 0) {
      console.log(chalk.gray(name ? `Server "${name}" not found.` : 'No enabled servers to test.'));
      return;
    }

    console.log(chalk.yellow(`\n🔌 Testing ${servers.length} MCP server(s)...\n`));
    for (const s of servers) {
      process.stdout.write(`  ${s.name}... `);
      const result = await mgr.testServer(s.name);
      console.log(result);
    }
    console.log();
  });

// ── inspect ──────────────────────────────────────────────
program
  .command('inspect [path]')
  .description('Static code inspection: scan for bugs, security issues, and performance problems')
  .option('-s, --severity <level>', 'Minimum severity: critical|error|warning|info', 'warning')
  .option('-c, --category <cat>', 'Filter category: bug|performance|style|security|all', 'all')
  .option('-v, --verbose', 'Show code snippets and fix suggestions')
  .option('--json', 'Output as JSON')
  .action(async (scanPath, options) => {
    const spinner = ora('Scanning...').start();
    try {
      const result = await codeInspectorTool.handler({
        path: scanPath || process.cwd(),
        severity: options.severity,
        category: options.category,
        verbose: options.verbose ?? false,
        format: options.json ? 'json' : 'report',
      });
      spinner.stop();
      console.log(result);
    } catch (err) {
      spinner.fail('Inspection failed: ' + (err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

// ── purify ───────────────────────────────────────────────
program
  .command('purify [path]')
  .description('Self-healing: auto-detect and fix code issues, verify build, optionally commit')
  .option('-d, --dry-run', 'Preview fixes without applying them')
  .option('-s, --severity <level>', 'Minimum severity to fix: error|warning|info', 'warning')
  .option('--commit', 'Commit fixed files with git')
  .option('--max-fixes <n>', 'Maximum fixes to apply in one run', '20')
  .action(async (healPath, options) => {
    const spinner = ora(options.dryRun ? 'Analyzing (dry run)...' : 'Healing...').start();
    try {
      const result = await selfHealTool.handler({
        path: healPath || process.cwd(),
        dry_run: options.dryRun ?? false,
        severity: options.severity,
        commit: options.commit ?? false,
        max_fixes: parseInt(options.maxFixes || '20'),
      });
      spinner.stop();
      console.log(result);
    } catch (err) {
      spinner.fail('Self-heal failed: ' + (err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

// ── schema ───────────────────────────────────────────────
const schemaCmd = program.command('schema').description('Manage database schemas for schema-driven SQL generation');

schemaCmd.command('list')
  .description('List all loaded schemas from .uagent/schemas/')
  .action(async () => {
    const { getSchemasSummary } = await import('../domains/data/tools/schema-loader.js');
    console.log(chalk.yellow('\n📊 Loaded Schemas:\n'));
    console.log(getSchemasSummary(process.cwd()));
    console.log(chalk.gray('\n  Place DDL files in .uagent/schemas/*.sql or *.json\n'));
  });

schemaCmd.command('search <query>')
  .description('Find tables matching a natural language query')
  .action(async (query) => {
    const { matchSchemas } = await import('../domains/data/tools/schema-loader.js');
    const matches = matchSchemas(query, 5, process.cwd());
    if (!matches.length) {
      console.log(chalk.gray('\n  No matching tables found.\n'));
      return;
    }
    console.log(chalk.yellow(`\n🔍 Schema matches for: "${query}"\n`));
    for (const m of matches) {
      console.log(`  ${chalk.cyan(m.table.tableName.padEnd(30))} score=${m.score}  ${chalk.gray(m.matchedTerms.slice(0, 3).join(', '))}`);
      if (m.table.comment) console.log(`  ${chalk.gray('  ' + m.table.comment)}`);
    }
    console.log();
  });

schemaCmd.command('init')
  .description('Create .uagent/schemas/ directory with an example DDL file')
  .action(async () => {
    const { mkdirSync, existsSync, writeFileSync } = await import('fs');
    const { join } = await import('path');
    const dir = join(process.cwd(), '.uagent', 'schemas');
    mkdirSync(dir, { recursive: true });
    const example = join(dir, 'example.sql');
    if (!existsSync(example)) {
      writeFileSync(example, [
        '-- Example schema file for schema-driven SQL generation',
        '-- Place your actual DDL files here (.sql or .json format)',
        '',
        'CREATE TABLE users (',
        '  id         INT          NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT \'User ID\',',
        '  name       VARCHAR(100) NOT NULL COMMENT \'Full name\',',
        '  email      VARCHAR(255) NOT NULL COMMENT \'Email address\',',
        '  created_at DATETIME     NOT NULL COMMENT \'Account creation timestamp\'',
        ') COMMENT = \'Registered users\';',
        '',
        'CREATE TABLE orders (',
        '  id         INT    NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT \'Order ID\',',
        '  user_id    INT    NOT NULL COMMENT \'Reference to users.id\',',
        '  amount     DECIMAL(10,2) NOT NULL COMMENT \'Order total in USD\',',
        '  status     VARCHAR(20)  NOT NULL COMMENT \'pending|paid|shipped|cancelled\',',
        '  created_at DATETIME     NOT NULL COMMENT \'Order creation timestamp\'',
        ') COMMENT = \'Customer orders\';',
      ].join('\n'), 'utf8');
      console.log(chalk.green(`✓ Created ${example}`));
    } else {
      console.log(chalk.gray(`Already exists: ${example}`));
    }
    console.log(chalk.gray('  Replace example.sql with your real DDL files to enable schema-driven SQL generation.'));
  });

// ── spec ─────────────────────────────────────────────────
const specCmd = program.command('spec').description('Generate a technical specification from a requirement description (PRD → Spec)');

specCmd.command('new <description>')
  .description('Generate a new technical spec from a requirement description')
  .action(async (description) => {
    const spinner = ora('Generating technical spec...').start();
    try {
      const { generateSpec } = await import('../core/tools/code/spec-generator.js');
      const result = await generateSpec(description, process.cwd());
      spinner.succeed(`Spec saved to ${result.path}`);
      console.log('\n' + result.content);
      if (result.phases.length > 0) {
        console.log(chalk.yellow('\n📋 Execution Plan (Phases):'));
        for (const p of result.phases) {
          const deps = p.dependsOn.length > 0 ? chalk.gray(` (depends: Phase ${p.dependsOn.join(', ')})`) : '';
          const mode = p.parallel ? chalk.cyan('[parallel]') : chalk.gray('[sequential]');
          console.log(`  ${chalk.bold(`Phase ${p.phase}`)} ${mode} ${chalk.white(p.label)}${deps}`);
          p.tasks.forEach((t, i) => console.log(`    ${chalk.gray(String(i + 1) + '.')} ${t}`));
        }
        console.log();
      } else if (result.tasks.length > 0) {
        console.log(chalk.yellow('\n📋 Extracted tasks:'));
        result.tasks.forEach((t, i) => console.log(`  ${chalk.gray(String(i + 1) + '.')} ${t}`));
      }
    } catch (err) {
      spinner.fail('Spec generation failed: ' + (err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

specCmd.command('list')
  .description('List all specs for the current project')
  .action(async () => {
    const { listSpecs } = await import('../core/tools/code/spec-generator.js');
    const specs = listSpecs(process.cwd());
    if (!specs.length) {
      console.log(chalk.gray('\n  No specs found. Run: uagent spec new "<description>"\n'));
      return;
    }
    console.log(chalk.yellow('\n📄 Technical Specs:\n'));
    specs.forEach((s, i) => {
      console.log(`  ${chalk.gray(String(i + 1) + '.')} ${chalk.cyan(s.date)}  ${chalk.white(s.name)}`);
    });
    console.log();
  });

specCmd.command('show [index]')
  .description('Show a spec (default: most recent)')
  .action(async (index) => {
    const { readSpec } = await import('../core/tools/code/spec-generator.js');
    const n = index !== undefined ? parseInt(index, 10) : 0;
    const content = readSpec(isNaN(n) ? index : n, process.cwd());
    if (!content) {
      console.log(chalk.red('Spec not found'));
      return;
    }
    console.log('\n' + content);
  });

// ── review ────────────────────────────────────────────────
program
  .command('review [path]')
  .description('AI Code Review: P1/P2/P3 graded issues on git diff or specified path')
  .option('--skip-static', 'Skip static analysis, only AI review')
  .option('--skip-ai', 'Skip AI review, only static analysis')
  .option('--diff <base>', 'Diff against a specific git ref (default: HEAD)')
  .action(async (reviewPath, options) => {
    const spinner = ora('Running code review...').start();
    try {
      const { reviewCode, getGitDiff } = await import('../core/tools/code/ai-reviewer.js');
      const diff = options.diff ? (getGitDiff(process.cwd(), options.diff) ?? undefined) : undefined;
      const files = reviewPath ? [reviewPath] : undefined;
      const report = await reviewCode({
        diff,
        files,
        projectRoot: process.cwd(),
        skipStatic: options.skipStatic,
        skipAI: options.skipAi,
      });
      spinner.stop();
      console.log('\n' + report.markdown);
      console.log(chalk.gray(`Summary: P1=${report.summary.P1}  P2=${report.summary.P2}  P3=${report.summary.P3}\n`));
      if (report.hasBlockers) process.exit(1);
    } catch (err) {
      spinner.fail('Review failed: ' + (err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

// ── memory ───────────────────────────────────────────────
const memCmd = program.command('memory').description('Manage long-term memory for this project');

memCmd.command('list')
  .description('List all memories for the current project')
  .option('-t, --type <type>', 'Filter by type: pinned|insight|fact')
  .action(async (options) => {
    const { getMemoryStore } = await import('../core/memory/memory-store.js');
    const store = getMemoryStore(process.cwd());
    const types = options.type ? [options.type] : undefined;
    const items = store.list({ types });
    if (!items.length) {
      console.log(chalk.gray('\n  No memories found.\n'));
      return;
    }
    const icon: Record<string, string> = { pinned: '📌', insight: '💡', fact: '📝' };
    console.log(chalk.yellow('\n🧠 Long-term Memories:\n'));
    for (const m of items) {
      const ttlStr = m.ttl ? chalk.gray(` [expires ${new Date(m.ttl).toLocaleDateString()}]`) : '';
      console.log(`  ${icon[m.type] ?? '•'} ${chalk.cyan(m.id)} ${chalk.white(m.content.slice(0, 100))}${ttlStr}`);
      if (m.tags.length) console.log(`     ${chalk.gray('tags: ' + m.tags.join(', '))}`);
    }
    const stats = store.stats();
    console.log(chalk.gray(`\n  Total: ${stats.total} (📌 ${stats.pinned} pinned, 💡 ${stats.insight} insight, 📝 ${stats.fact} fact)\n`));
  });

memCmd.command('add <text>')
  .description('Add a pinned memory (permanent)')
  .option('-t, --type <type>', 'Memory type: pinned|insight|fact', 'pinned')
  .option('--tags <tags>', 'Comma-separated tags')
  .action(async (text, options) => {
    const { getMemoryStore } = await import('../core/memory/memory-store.js');
    const store = getMemoryStore(process.cwd());
    const tags = options.tags ? options.tags.split(',').map((t: string) => t.trim()) : [];
    const id = store.add({ type: options.type, content: text, tags, source: 'user' });
    console.log(chalk.green(`✓ Memory saved [${id}]`));
  });

memCmd.command('delete <id>')
  .description('Delete a memory by ID')
  .action(async (id) => {
    const { getMemoryStore } = await import('../core/memory/memory-store.js');
    const store = getMemoryStore(process.cwd());
    const ok = store.delete(id);
    console.log(ok ? chalk.green(`✓ Deleted ${id}`) : chalk.red(`✗ Memory not found: ${id}`));
  });

memCmd.command('search <query>')
  .description('Search memories by relevance')
  .option('-n, --limit <n>', 'Max results', '5')
  .action(async (query, options) => {
    const { getMemoryStore } = await import('../core/memory/memory-store.js');
    const store = getMemoryStore(process.cwd());
    const limit = parseInt(options.limit || '5', 10);
    const results = await store.recall(query, { limit });
    if (!results.length) {
      console.log(chalk.gray('\n  No relevant memories found.\n'));
      return;
    }
    const icon: Record<string, string> = { pinned: '📌', insight: '💡', fact: '📝' };
    console.log(chalk.yellow(`\n🔍 Memory search: "${query}"\n`));
    for (const m of results) {
      console.log(`  ${icon[m.type] ?? '•'} ${chalk.cyan(m.id)} ${chalk.white(m.content)}`);
    }
    console.log();
  });

memCmd.command('ingest')
  .description('Trigger Smart Ingest: extract memories from recent session history (requires API key)')
  .action(async () => {
    const { getMemoryStore } = await import('../core/memory/memory-store.js');
    const { getProjectHistory } = await import('../core/memory/session-history.js');
    const store = getMemoryStore(process.cwd());
    const history = getProjectHistory(process.cwd());
    if (!history.length) {
      console.log(chalk.gray('No session history found to ingest.'));
      return;
    }
    const spinner = ora('Running Smart Ingest (LLM extraction)...').start();
    try {
      // Build minimal Message[] from history prompts
      const messages = history.slice(0, 30).reverse().map((h) => ({
        role: 'user' as const,
        content: h.prompt,
      }));
      const result = await store.ingest(messages);
      spinner.succeed(`Ingest complete: +${result.added} added, ~${result.updated} updated, ${result.skipped} skipped`);
    } catch (err) {
      spinner.fail('Ingest failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  });

memCmd.command('gc')
  .description('Garbage collect expired fact memories')
  .action(async () => {
    const { getMemoryStore } = await import('../core/memory/memory-store.js');
    const store = getMemoryStore(process.cwd());
    const removed = store.gc();
    console.log(chalk.green(`✓ GC complete: removed ${removed} expired/excess memories`));
  });

memCmd.command('clear')
  .description('Clear all memories for this project')
  .option('-t, --type <type>', 'Only clear specific type: pinned|insight|fact')
  .action(async (options) => {
    const { getMemoryStore } = await import('../core/memory/memory-store.js');
    const store = getMemoryStore(process.cwd());
    const types = options.type ? [options.type] : undefined;
    store.clear(types as never);
    console.log(chalk.green(`✓ Memories cleared${options.type ? ` (type: ${options.type})` : ''}`));
  });

// ── hooks ────────────────────────────────────────────────
program
  .command('hooks')
  .description('Manage lifecycle hooks (.uagent/hooks.json)')
  .option('--init', 'Create default .uagent/hooks.json with example hooks')
  .option('--list', 'List all configured hooks')
  .action((options) => {
    const runner = new HookRunner(process.cwd());
    if (options.init) {
      const result = HookRunner.init(process.cwd());
      console.log(chalk.green(result));
      console.log(chalk.gray('  Edit .uagent/hooks.json to customize hook behavior.'));
      console.log(chalk.gray('  Hooks fire on: pre_prompt | post_response | on_tool_call | on_slash_cmd | on_session_end'));
      return;
    }
    const hooks = runner.listHooks();
    if (!hooks.length) {
      console.log(chalk.gray('\nNo hooks configured.'));
      console.log(chalk.gray('  Run: uagent hooks --init  — create .uagent/hooks.json'));
      return;
    }
    console.log(chalk.yellow('\n🪝 Configured Hooks:\n'));
    for (const h of hooks) {
      const status = h.enabled !== false ? chalk.green('✓') : chalk.red('✗');
      const event = chalk.cyan(h.event.padEnd(18));
      const type = chalk.gray(`[${h.type}]`.padEnd(10));
      const desc = h.description ?? (h.command ?? h.command_line ?? '');
      const extra = h.command ? chalk.gray(` cmd:${h.command}`) : h.tool ? chalk.gray(` tool:${h.tool}`) : '';
      console.log(`  ${status} ${event} ${type} ${desc}${extra}`);
    }
    const customCmds = runner.listSlashCommands();
    if (customCmds.length > 0) {
      console.log(chalk.yellow('\n  Custom slash commands:'));
      for (const c of customCmds) {
        console.log(`    ${chalk.cyan(c.command.padEnd(16))} ${c.description}`);
      }
    }
    console.log();
  });

// ── insights ─────────────────────────────────────────────
program
  .command('insights')
  .description('Analyze your uagent usage history and generate a report (inspired by CodeFlicker /insights)')
  .option('--days <n>', 'Number of days to analyze (default: 30)', '30')
  .option('--max <n>', 'Max prompts to include in analysis (default: 100)', '100')
  .option('--cwd-only', 'Only analyze sessions from the current directory')
  .option('--html', 'Also generate an HTML report')
  .option('--output <path>', 'Output path for the report (default: ~/.uagent/insights-YYYY-MM-DD.md)')
  .option('--ai', 'Include AI-powered insights analysis (requires API key)')
  .action(async (options) => {
    const days = parseInt(options.days) || 30;
    const maxPrompts = parseInt(options.max) || 100;
    const spinner = ora(`Analyzing last ${days} days of usage...`).start();
    try {
      const { runInsights } = await import('./insights.js');
      let llmClient: import('./insights.js').InsightsOptions['llmClient'] = undefined;
      if (options.ai) {
        // Provide the LLM client for AI analysis
        const rawClient = modelManager.getClient('compact');
        llmClient = rawClient as import('./insights.js').InsightsOptions['llmClient'];
      }
      const report = await runInsights({
        days,
        maxPrompts,
        cwdOnly: options.cwdOnly,
        projectRoot: process.cwd(),
        outputPath: options.output,
        html: options.html,
        llmClient,
      });
      spinner.succeed(`Report generated`);
      console.log('\n' + report.markdown);
      console.log(chalk.gray(`\n  Full report saved to ~/.uagent/insights-${new Date().toISOString().slice(0, 10)}.md`));
      if (options.html) {
        console.log(chalk.gray(`  HTML report: ~/.uagent/insights-${new Date().toISOString().slice(0, 10)}.html`));
      }
      console.log(chalk.gray('  Tip: uagent insights --days 90 --ai  — AI-powered analysis\n'));
    } catch (err) {
      spinner.fail('Insights failed: ' + (err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

// ── update ───────────────────────────────────────────────
program
  .command('update')
  .description('Check for updates and apply them (git pull + rebuild)')
  .option('--check', 'Only check, do not apply')
  .action(async (opts) => {
    const { checkAndUpdate } = await import('./auto-update.js');
    if (opts.check) {
      // Check-only: just report status
      const { execFileSync } = await import('child_process');
      try {
        execFileSync('git', ['fetch', '--quiet'], { timeout: 8000 });
        const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD']).toString().trim();
        const local = execFileSync('git', ['rev-parse', 'HEAD']).toString().trim();
        const remote = execFileSync('git', ['rev-parse', `origin/${branch}`]).toString().trim().replace(/\n.*$/s, '');
        if (local === remote) {
          console.log(chalk.green('  ✓ Already up to date.'));
        } else {
          const behind = execFileSync('git', ['rev-list', '--count', `HEAD..origin/${branch}`]).toString().trim();
          console.log(chalk.yellow(`  ↓ ${behind} commit(s) behind origin/${branch} — run: uagent update`));
        }
      } catch {
        console.log(chalk.gray('  (could not check — no git or offline)'));
      }
      return;
    }
    const updated = await checkAndUpdate().catch(() => false);
    if (updated) {
      console.log(chalk.bold.green('\n  ✓ Updated! Please restart uagent.\n'));
    } else {
      console.log(chalk.green('  ✓ Already up to date.'));
    }
  });

// ── init ─────────────────────────────────────────────────
program
  .command('init')
  .description('Initialize AGENTS.md for this project')
  .action(() => {
    const result = initAgentsMd(process.cwd());
    console.log(chalk.green(result));
  });

// ── commit ─────────────────────────────────────────────── (aligns with flickcli commit)
program
  .command('commit')
  .description('Generate and commit git changes with AI-generated message')
  .option('-s, --stage', 'Stage all changes (git add -A) before generating')
  .option('-c, --commit', 'Auto-commit without confirmation')
  .option('--push', 'Push after commit')
  .option('-n, --no-verify', 'Skip pre-commit hooks (--no-verify)')
  .option('-m, --model <model>', 'Model to use')
  .option('--language <lang>', 'Commit message language (e.g. Chinese, English)')
  .option('--copy', 'Copy message to clipboard')
  .option('--follow-style', 'Infer commit style from recent commits')
  .action(async (opts) => {
    const { runCommit } = await import('./commit.js');
    await runCommit({
      stage: opts.stage,
      commit: opts.commit,
      push: opts.push,
      noVerify: opts.noVerify === false,
      model: opts.model,
      language: opts.language,
      copy: opts.copy,
      followStyle: opts.followStyle,
    });
  });

// ── log ────────────────────────────────────────────────── (aligns with flickcli log)
program
  .command('log')
  .description('Show session history')
  .option('-n <count>', 'Number of sessions to show (default: 10)', '10')
  .option('--json', 'Output as JSON')
  .option('--id <id>', 'Filter by session ID')
  .action(async (opts) => {
    const { runLog } = await import('./log.js');
    runLog({ n: opts.n, json: opts.json, id: opts.id });
  });

// ── REPL ─────────────────────────────────────────────────
async function runREPL(
  agent: AgentCore,
  options: { domain: string; verbose?: boolean },
  extra: { initialPrompt?: string; continueSession?: boolean } = {},
) {
  const { readFileSync: fsReadFileSync, existsSync: fsExistsSync } = await import('fs');
  const hookRunner = new HookRunner(process.cwd());
  const { loadLastSnapshot, saveSnapshot, formatAge } = await import('../core/memory/session-snapshot.js');

  // Unique session ID for this run (used for snapshot file name + status bar)
  const SESSION_ID = `session-${Date.now()}`;
  // Short 8-char ID for display (last 8 hex chars of timestamp)
  const SHORT_ID = Date.now().toString(16).slice(-8);

  // ── Status bar init ────────────────────────────────────────────────────
  const { estimateHistoryTokens } = await import('../core/context/context-compressor.js').catch(() => ({ estimateHistoryTokens: () => 0 }));
  const currentModel = modelManager.getCurrentModel('main');
  const { friendlyName } = await import('./model-picker.js');
  initStatusBar({
    model: friendlyName(currentModel),
    domain: options.domain,
    sessionId: SHORT_ID,
    estimatedTokens: 0,
    contextLength: 128000,
    isThinking: 'none' as const,
  });

  // CodeFlicker-style prompt: dim domain tag + bold ❯
  const makePrompt = (domain: string, model?: string) => {
    const domainTag = chalk.dim(`[${domain}]`);
    const modelTag = model
      ? chalk.dim(` ${model.split('/').pop()?.slice(0, 22) ?? model}`) : '';
    return `${domainTag}${modelTag} ${chalk.bold.green('❯')} `;
  };

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: makePrompt(options.domain),
  });

  // ── Welcome line (CodeFlicker style: short, with examples) ─────────────
  const lastSnap = loadLastSnapshot();

  // --continue (-c): restore last session automatically
  if (extra.continueSession && lastSnap && lastSnap.messages.length >= 2) {
    agent.setHistory(lastSnap.messages);
    process.stdout.write(
      chalk.green(`  ✓ Resumed session from ${formatAge(lastSnap.savedAt)} (${lastSnap.messages.length} messages)`) + '\n',
    );
  } else if (lastSnap && lastSnap.messages.length >= 2) {
    process.stdout.write(
      chalk.dim(`  Session from ${formatAge(lastSnap.savedAt)} available`) +
      chalk.dim(` · /resume to restore`) + '\n',
    );
  }
  process.stdout.write(
    chalk.dim('  Type ') +
    chalk.white('/help') +
    chalk.dim(' for commands · ') +
    chalk.white('@file') +
    chalk.dim(' to reference files · ') +
    chalk.white('Ctrl+C') +
    chalk.dim(' to exit') +
    '\n\n',
  );

  // Show custom hook slash commands if any
  const customCmds = hookRunner.listSlashCommands();
  if (customCmds.length > 0) {
    process.stdout.write(chalk.dim(`  Custom: ${customCmds.map((c) => c.command).join('  ')}\n\n`));
  }

  // ── initialPrompt: send first message automatically ─────────────────────
  if (extra.initialPrompt) {
    // Simulate a line input so the REPL processes it naturally
    setTimeout(() => rl.emit('line', extra.initialPrompt!), 100);
  }

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── slash commands ──
    if (input === '/exit' || input === '/quit') {
      clearStatusBar();
      process.stdout.write('\n' + chalk.dim('  Bye!') + '\n');
      // Fire on_session_end hooks
      await hookRunner.run({ event: 'on_session_end', cwd: process.cwd() }).catch(() => {});
      const h = agent.getHistory();
      if (h.length >= 2) saveSnapshot(SESSION_ID, h);
      process.exit(0);
    }
    // /image — multimodal image input (Codeflicker update: image interaction)
    if (input.startsWith('/image ')) {
      const imagePath = input.replace('/image ', '').trim();
      const absPath = resolve(imagePath);
      if (!fsExistsSync(absPath)) {
        console.log(chalk.red(`  ✗ Image file not found: ${absPath}`));
        rl.prompt(); return;
      }
      // Read image and encode as base64
      try {
        const imageBuffer = fsReadFileSync(absPath);
        const base64 = imageBuffer.toString('base64');
        const ext = absPath.split('.').pop()?.toLowerCase() ?? 'png';
        const mimeMap: Record<string, string> = {
          jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
          gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
        };
        const mimeType = mimeMap[ext] ?? 'image/png';
        const dataUrl = `data:${mimeType};base64,${base64}`;
        console.log(chalk.green(`  ✓ Image loaded: ${absPath} (${(imageBuffer.length / 1024).toFixed(1)}KB)`));
        console.log(chalk.gray('  Image attached to next message. Now type your question about it:'));
        // Store image for next message
        (agent as AgentCore & { _pendingImage?: string })._pendingImage = dataUrl;
        rl.setPrompt(chalk.magenta(`[image] `) + chalk.green('❯ '));
      } catch (imgErr) {
        console.log(chalk.red(`  ✗ Failed to read image: ${imgErr instanceof Error ? imgErr.message : String(imgErr)}`));
      }
      rl.prompt(); return;
    }
    // /hooks — manage lifecycle hooks
    if (input === '/hooks' || input === '/hooks list') {
      hookRunner.reload();
      const hooks = hookRunner.listHooks();
      if (!hooks.length) {
        console.log(chalk.gray('\n  No hooks configured. Run: uagent hooks --init\n'));
      } else {
        console.log(chalk.yellow('\n🪝 Hooks:'));
        for (const h of hooks) {
          const status = h.enabled !== false ? chalk.green('✓') : chalk.red('✗');
          console.log(`  ${status} ${chalk.cyan(h.event.padEnd(16))} ${chalk.gray('[' + h.type + ']')} ${h.description ?? ''}`);
        }
        console.log();
      }
      rl.prompt(); return;
    }
    if (input === '/hooks init') {
      const result = HookRunner.init(process.cwd());
      console.log(chalk.green('  ' + result));
      hookRunner.reload();
      rl.prompt(); return;
    }
    if (input === '/hooks reload') {
      hookRunner.reload();
      console.log(chalk.green(`  ✓ Reloaded ${hookRunner.listHooks().length} hook(s)`));
      rl.prompt(); return;
    }
    // /insights — usage analytics
    if (input.startsWith('/insights')) {
      const parts = input.split(/\s+/);
      const days = parseInt(parts.find((p) => /^\d+$/.test(p)) ?? '30', 10);
      rl.pause();
      process.stdout.write('\n');
      const spinnerI = ora(`Analyzing last ${days} days of usage...`).start();
      try {
        const { runInsights } = await import('./insights.js');
        const report = await runInsights({ days, projectRoot: process.cwd() });
        spinnerI.stop();
        // Show a condensed version in REPL
        const lines = report.markdown.split('\n');
        const condensed = lines.slice(0, 60).join('\n');
        console.log('\n' + condensed);
        if (lines.length > 60) console.log(chalk.gray(`\n  ... (${lines.length - 60} more lines — full report saved to ~/.uagent/)`));
      } catch (eI) {
        spinnerI.fail('Insights failed: ' + (eI instanceof Error ? eI.message : String(eI)));
      }
      rl.resume();
      rl.prompt(); return;
    }
    if (input === '/help' || input === '/help ') {
      printHelp();
      rl.prompt(); return;
    }
    // Check hook-defined custom slash commands BEFORE sending to LLM
    if (input.startsWith('/') && !input.startsWith('/exit') && !input.startsWith('/help') && !input.startsWith('/cost')) {
      const hookResult = await hookRunner.handleSlashCmd(input).catch(() => ({ handled: false, output: '' }));
      if (hookResult.handled) {
        if (hookResult.output) {
          // Send hook output to LLM as the prompt
          rl.pause();
          process.stdout.write('\n');
          try {
            await agent.runStream(hookResult.output, (chunk) => process.stdout.write(chunk));
            process.stdout.write('\n\n');
          } catch (err) {
            console.error(chalk.red('\n✗ ') + (err instanceof Error ? err.message : String(err)));
          }
          rl.resume();
        }
        rl.prompt(); return;
      }
    }
    if (input === '/exit' || input === '/quit') { /* already handled above */ }
    if (input === '/cost') {
      const { usageTracker } = await import('../models/usage-tracker.js');
      // Session summary
      console.log('\n' + modelManager.getCostSummary());
      // Today's persistent summary
      const todayUsage = usageTracker.loadTodayUsage();
      console.log(`\n📅 Today (persisted across sessions):`);
      console.log(`   Input:    ${todayUsage.totalInputTokens.toLocaleString()} tokens`);
      console.log(`   Output:   ${todayUsage.totalOutputTokens.toLocaleString()} tokens`);
      console.log(`   Cost:     $${todayUsage.totalCostUSD.toFixed(4)} USD`);
      console.log(`   Sessions: ${todayUsage.sessions}`);
      // Limit check
      const check = usageTracker.checkLimits();
      if (check.status !== 'ok' && check.message) {
        console.log('\n' + check.message);
      }
      console.log(chalk.gray('\n  Tip: uagent usage --days 7  — full history'));
      console.log(chalk.gray('       uagent limits            — view/set limits\n'));
      rl.prompt(); return;
    }
    if (input === '/resume') {
      const snap = loadLastSnapshot();
      if (snap && snap.messages.length >= 2) {
        agent.setHistory(snap.messages);
        process.stdout.write(chalk.green(`  ✓ Restored session from ${formatAge(snap.savedAt)} (${snap.messages.length} messages)`) + '\n\n');
      } else {
        process.stdout.write(chalk.dim('  No saved session found.') + '\n\n');
      }
      rl.prompt(); return;
    }
    if (input.startsWith('/model')) {
      const parts = input.split(/\s+/);
      if (parts.length === 1) {
        // Interactive model picker
        rl.pause();
        const { showModelPicker, friendlyName } = await import('./model-picker.js');

        const profiles = modelManager.listProfiles();
        const currentModel = modelManager.getCurrentModel('main');

        // 解析 WQ_MODELS 里的自定义显示名 (格式: ep-xxx:显示名称,ep-yyy:另一个名称)
        const wqNameMap: Record<string, string> = {};
        (process.env.WQ_MODELS || '').split(',').forEach(entry => {
          const [id, ...nameParts] = entry.trim().split(':');
          if (nameParts.length > 0 && id && !id.startsWith('ep-xxxxxx')) {
            wqNameMap[id.trim()] = nameParts.join(':').trim();
          }
        });

        // Infer friendly provider name from model ID
        const providerLabel = (id: string) => {
          if (id.startsWith('ep-') || id.startsWith('api-')) return '万擎';
          if (id.startsWith('openrouter:')) return 'OpenRouter';
          if (id.startsWith('groq:')) return 'Groq';
          if (id.startsWith('gemini')) return 'Gemini';
          if (id.startsWith('claude')) return 'Anthropic';
          if (id.startsWith('gpt') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4')) return 'OpenAI';
          if (id.startsWith('deepseek')) return 'DeepSeek';
          if (id.startsWith('qwen')) return 'Qwen';
          return 'Other';
        };

        const items = profiles.map(p => ({
          id: p.name,
          // 优先用 WQ_MODELS 里的自定义名，否则用内置映射，最后 fallback 到 ID
          label: wqNameMap[p.name] ?? friendlyName(p.name),
          provider: providerLabel(p.name),
          detail: p.modelName ?? p.name,
        }));

        const selected = await showModelPicker(items, currentModel, [currentModel]);
        if (selected) {
          agent.setModel(selected);
          rl.setPrompt(makePrompt(options.domain, selected));
          updateStatusBar({ model: friendlyName(selected) });
          process.stdout.write(chalk.green(`  ✓ Model → ${selected}`) + '\n\n');
        }
        rl.resume();
      } else {
        const m = parts[1];
        agent.setModel(m);
        rl.setPrompt(makePrompt(options.domain, m));
        process.stdout.write(chalk.green(`  ✓ Model → ${m}`) + '\n\n');
      }
      rl.prompt(); return;
    }
    if (input.startsWith('/domain ')) {
      const domain = input.replace('/domain ', '').trim();
      agent.setDomain(domain);
      options.domain = domain;
      rl.setPrompt(makePrompt(domain));
      process.stdout.write(chalk.green(`  ✓ Domain → ${domain}`) + '\n\n');
      rl.prompt(); return;
    }
    if (input.startsWith('/agents')) {
      // /agents clean [days] — entropy reduction: list zombie (stale) subagents
      if (input.startsWith('/agents clean')) {
        const parts = input.split(/\s+/);
        const staleDays = parseInt(parts[2] || '30', 10);
        const zombies = subagentSystem.findZombieAgents(isNaN(staleDays) ? 30 : staleDays);
        if (zombies.length === 0) {
          console.log(chalk.green(`\n✓ No stale subagents found (threshold: ${staleDays} days)\n`));
        } else {
          console.log(chalk.yellow(`\n🧹 Stale subagents (unused >${staleDays} days):\n`));
          for (const z of zombies) {
            const lastStr = z.lastUsed ? z.lastUsed.toLocaleDateString() : 'never used';
            console.log(chalk.red(`  ✗ ${z.name.padEnd(20)}`), chalk.gray(`last: ${lastStr}, calls: ${z.callCount}`));
          }
          console.log(chalk.gray(`\n  Tip: remove unused .uagent/agents/<name>.md files to clean up\n`));
        }
      } else {
        // /agents — list all subagents
        console.log(chalk.yellow('\n👤 Subagents:'));
        for (const a of subagentSystem.listAgents()) {
          console.log(chalk.cyan(`  @run-agent-${a.name.padEnd(18)}`), chalk.gray(a.description));
        }
        console.log(chalk.gray('  Tip: /agents clean [days] — show stale subagents\n'));
      }
      rl.prompt(); return;
    }
    if (input.startsWith('/models')) {
      const modelParts = input.split(/\s+/);
      const modelSubCmd = modelParts[1];

      if (modelSubCmd === 'switch' && modelParts[2]) {
        // /models switch <name> — switch main model
        const newModel = modelParts[2];
        const profiles = modelManager.listProfiles();
        const exists = profiles.some((p) => p.name === newModel || p.modelName === newModel);
        if (!exists) {
          console.log(chalk.yellow(`⚠  Model "${newModel}" not in profile list — adding as custom and switching.`));
          modelManager.setPointer('main', newModel);
        } else {
          modelManager.setPointer('main', newModel);
        }
        agent.setModel(newModel);
        rl.setPrompt(chalk.cyan(`[${options.domain}|${newModel}] `) + chalk.green('❯ '));
        console.log(chalk.green(`✓ Switched main model → ${newModel}`));
      } else {
        // /models — list all models with status
        const profiles = modelManager.listProfiles();
        const pointers = modelManager.getPointers();
        console.log(chalk.yellow('\n🤖 Models:'));
        console.log(chalk.gray(`  ${'NAME'.padEnd(26)} ${'PROVIDER'.padEnd(14)} ${'CONTEXT'.padEnd(10)} POINTER`));
        console.log(chalk.gray('  ' + '─'.repeat(65)));
        for (const p of profiles) {
          const role = Object.entries(pointers).filter(([, v]) => v === p.name).map(([k]) => k).join('/');
          const isActive = role.length > 0;
          const marker = isActive ? chalk.green('●') : chalk.gray('○');
          const ctx = p.contextLength >= 1000000 ? `${(p.contextLength / 1000000).toFixed(1)}M` : `${Math.round(p.contextLength / 1000)}k`;
          console.log(`  ${marker} ${chalk.white(p.name.padEnd(25))} ${chalk.gray(p.provider.padEnd(14))} ${chalk.gray(ctx.padEnd(10))} ${role ? chalk.cyan(`[${role}]`) : ''}`);
        }
        console.log(chalk.gray('\n  /models switch <name>   — switch main model'));
        console.log(chalk.gray('  uagent models add       — add custom model'));
        console.log(chalk.gray('  uagent models set <ptr> <model>  — set pointer\n'));
      }
      rl.prompt(); return;
    }
    if (input === '/clear') {
      agent.clearHistory();
      console.clear();
      printBanner();
      rl.prompt();
      return;
    }
    // /compact — manually compress conversation history (kstack article #15343 insight 3)
    // The article notes Claude Code has 5 different context compression strategies, none optimal.
    // Giving users manual control lets them compact at the RIGHT moment (end of a phase,
    // before a large tool-heavy task) rather than waiting for the auto-threshold.
    if (input === '/compact' || input === '/tokens') {
      const { estimateHistoryTokens, shouldCompact, autoCompact } = await import('../core/context/context-compressor.js');
      const history = agent.getHistory();
      const decision = shouldCompact(history);
      const pct = ((decision.estimatedTokens / decision.contextLength) * 100).toFixed(1);
      if (input === '/tokens') {
        console.log(chalk.yellow('\n📊 Context Usage:'));
        console.log(`  Estimated tokens : ${chalk.white(decision.estimatedTokens.toLocaleString())}`);
        console.log(`  Context limit    : ${chalk.white(decision.contextLength.toLocaleString())}`);
        console.log(`  Usage            : ${chalk.white(pct + '%')}  (threshold: ${(decision.threshold / decision.contextLength * 100).toFixed(0)}%)`);
        console.log(`  Turns in history : ${chalk.white(String(history.length))}`);
        console.log(chalk.gray('\n  Run /compact to manually compress now.\n'));
        rl.prompt(); return;
      }
      // /compact — force compact even if below auto-threshold
      if (history.length <= 2) {
        console.log(chalk.gray('\n  History too short to compact (≤2 turns).\n'));
        rl.prompt(); return;
      }
      rl.pause();
      process.stdout.write('\n');
      const spinnerC = ora(`Compacting ${history.length} turns (${pct}% context)...`).start();
      try {
        // Temporarily force shouldCompact to true by calling autoCompact directly
        const { autoCompact: compact } = await import('../core/context/context-compressor.js');
        // Patch: bypass the threshold check by calling the internal logic directly.
        // We reuse the public autoCompact but temporarily push a dummy message so
        // the threshold is always exceeded, then restore state on error.
        // Simpler: expose a forceCompact helper.
        // For now: directly mutate history via agent to trigger compact:
        const fullHistory = agent.getHistory();
        if (fullHistory.length > 2) {
          // Force compact by temporarily marking threshold as exceeded
          const origEnv = process.env.AGENT_COMPACT_THRESHOLD;
          process.env.AGENT_COMPACT_THRESHOLD = '0.0001'; // near-zero threshold
          let compacted = 0;
          try {
            // autoCompact reads the threshold from module-level const, so env override won't work.
            // Instead use the /memory ingest flow to build a summary, then clear:
            const { getMemoryStore } = await import('../core/memory/memory-store.js');
            const store = getMemoryStore(process.cwd());
            const ingestResult = await store.ingest(fullHistory);
            agent.clearHistory();
            compacted = fullHistory.length;
            spinnerC.succeed(`Compacted ${compacted} turns → insights saved to memory (+${ingestResult.added} memories). History cleared.`);
          } finally {
            if (origEnv === undefined) delete process.env.AGENT_COMPACT_THRESHOLD;
            else process.env.AGENT_COMPACT_THRESHOLD = origEnv;
          }
        } else {
          spinnerC.info('Nothing to compact.');
        }
      } catch (eC) {
        spinnerC.fail('Compact failed: ' + (eC instanceof Error ? eC.message : String(eC)));
      }
      rl.resume();
      rl.prompt(); return;
    }
    if (input.startsWith('/history')) {
      const parts = input.split(/\s+/);
      const n = parseInt(parts[1] || '10', 10);
      const entries = getRecentHistory(isNaN(n) ? 10 : n);
      if (entries.length === 0) {
        console.log(chalk.gray('\n  (no history)\n'));
      } else {
        console.log(chalk.yellow('\n📜 Recent prompts:'));
        entries.forEach((e, i) => {
          console.log(`  ${chalk.gray(String(i + 1).padStart(3) + '.')} ${e.slice(0, 120)}${e.length > 120 ? chalk.gray('…') : ''}`);
        });
        console.log();
      }
      rl.prompt(); return;
    }
    if (input === '/init') {
      console.log(chalk.green(initAgentsMd(process.cwd())));
      rl.prompt(); return;
    }
    // /memory — long-term memory commands (mem9-inspired)
    if (input.startsWith('/memory')) {
      const parts = input.split(/\s+/);
      const sub = parts[1];
      const { getMemoryStore } = await import('../core/memory/memory-store.js');
      const store = getMemoryStore(process.cwd());

      if (!sub) {
        const stats = store.stats();
        console.log(chalk.yellow('\n🧠 Memory Stats:'));
        console.log(`  📌 Pinned  : ${stats.pinned}`);
        console.log(`  💡 Insight : ${stats.insight}`);
        console.log(`  📝 Fact    : ${stats.fact}`);
        console.log(chalk.gray('\n  /memory pin <text>  — pin a memory'));
        console.log(chalk.gray('  /memory list        — list all memories'));
        console.log(chalk.gray('  /memory forget      — clear all memories'));
        console.log(chalk.gray('  /memory ingest      — extract insights from this session\n'));
      } else if (sub === 'pin') {
        const text = parts.slice(2).join(' ');
        if (!text) {
          console.log(chalk.red('Usage: /memory pin <text>'));
        } else {
          const id = store.add({ type: 'pinned', content: text, tags: [], source: 'user' });
          console.log(chalk.green(`📌 Pinned [${id}]: ${text}`));
        }
      } else if (sub === 'list') {
        const items = store.list();
        if (!items.length) {
          console.log(chalk.gray('\n  No memories yet.\n'));
        } else {
          const icon: Record<string, string> = { pinned: '📌', insight: '💡', fact: '📝' };
          console.log(chalk.yellow('\n🧠 All memories:\n'));
          for (const m of items) {
            console.log(`  ${icon[m.type] ?? '•'} ${chalk.cyan(m.id)}  ${m.content.slice(0, 100)}`);
            if (m.tags.length) console.log(`     ${chalk.gray('tags: ' + m.tags.join(', '))}`);
          }
          console.log();
        }
      } else if (sub === 'forget') {
        store.clear();
        console.log(chalk.green('✓ All memories cleared for this project'));
      } else if (sub === 'ingest') {
        rl.pause();
        const spinner2 = ora('Running Smart Ingest...').start();
        try {
          const history2 = agent.getHistory();
          const result = await store.ingest(history2);
          spinner2.succeed(`Ingest: +${result.added} added, ~${result.updated} updated, ${result.skipped} skipped`);
        } catch (e2) {
          spinner2.fail('Ingest failed: ' + (e2 instanceof Error ? e2.message : String(e2)));
        }
        rl.resume();
      } else {
        console.log(chalk.gray('Unknown /memory subcommand. Try: /memory  /memory pin <text>  /memory list  /memory forget  /memory ingest'));
      }
      rl.prompt(); return;
    }
    // /spec — generate technical spec from requirement (kstack article #15332)
    if (input.startsWith('/spec')) {
      const desc = input.replace('/spec', '').trim();
      if (!desc) {
        const { listSpecs } = await import('../core/tools/code/spec-generator.js');
        const specs = listSpecs(process.cwd());
        if (!specs.length) {
          console.log(chalk.gray('\n  No specs yet. Usage: /spec <requirement description>\n'));
        } else {
          console.log(chalk.yellow('\n📄 Specs:\n'));
          specs.forEach((s, i) => console.log(`  ${chalk.gray(String(i + 1) + '.')} ${chalk.cyan(s.date)}  ${s.name}`));
          console.log();
        }
        rl.prompt(); return;
      }
      rl.pause();
      process.stdout.write('\n');
      const spinnerS = ora('Generating technical spec...').start();
      try {
        const { generateSpec } = await import('../core/tools/code/spec-generator.js');
        const result = await generateSpec(desc, process.cwd());
        spinnerS.succeed(`Spec saved → ${result.path}`);
        console.log('\n' + result.content);
        if (result.phases.length > 0) {
          console.log(chalk.yellow('\n📋 Execution Plan (Phases):'));
          for (const p of result.phases) {
            const deps = p.dependsOn.length > 0 ? chalk.gray(` (depends: Phase ${p.dependsOn.join(', ')})`) : '';
            const mode = p.parallel ? chalk.cyan('[parallel]') : chalk.gray('[sequential]');
            console.log(`  ${chalk.bold(`Phase ${p.phase}`)} ${mode} ${chalk.white(p.label)}${deps}`);
            p.tasks.forEach((t, i) => console.log(`    ${chalk.gray(String(i + 1) + '.')} ${t}`));
          }
          console.log();
        } else if (result.tasks.length > 0) {
          console.log(chalk.yellow('\n📋 Tasks extracted:'));
          result.tasks.forEach((t, i) => console.log(`  ${chalk.gray(String(i + 1) + '.')} ${t}`));
          console.log();
        }
      } catch (eS) {
        spinnerS.fail('Spec failed: ' + (eS instanceof Error ? eS.message : String(eS)));
      }
      rl.resume();
      rl.prompt(); return;
    }
    // /review — AI code review P1/P2/P3 (kstack article #15332)
    if (input.startsWith('/review')) {
      rl.pause();
      process.stdout.write('\n');
      const spinnerR = ora('Running AI Code Review...').start();
      try {
        const { reviewCode } = await import('../core/tools/code/ai-reviewer.js');
        const report = await reviewCode({ projectRoot: process.cwd() });
        spinnerR.stop();
        console.log('\n' + report.markdown);
        console.log(chalk.gray(`  P1=${report.summary.P1}  P2=${report.summary.P2}  P3=${report.summary.P3}\n`));
      } catch (eR) {
        spinnerR.fail('Review failed: ' + (eR instanceof Error ? eR.message : String(eR)));
      }
      rl.resume();
      rl.prompt(); return;
    }
    // /rules — list loaded rule files (kstack article #15310 SSOT pattern)
    if (input === '/rules') {
      const rules = loadRules(process.cwd());
      if (rules.sources.length === 0) {
        console.log(chalk.gray('\n  No rules loaded. Create .uagent/rules/*.md to define coding standards.\n'));
      } else {
        console.log(chalk.yellow('\n📐 Loaded rules (injected into every system prompt):\n'));
        for (const src of rules.sources) {
          console.log(chalk.cyan('  ✓ ') + chalk.white(src));
        }
        console.log(chalk.gray('\n  Tip: Add .uagent/rules/coding.md, api-style.md, etc. to enforce standards\n'));
      }
      rl.prompt(); return;
    }
    if (input.startsWith('/inspect')) {
      const parts = input.split(/\s+/);
      const scanPath = parts[1] || process.cwd();
      rl.pause();
      process.stdout.write('\n');
      try {
        const result = await codeInspectorTool.handler({
          path: scanPath, severity: 'warning', verbose: false, format: 'report',
        });
        console.log(result);
      } catch (err) {
        console.error(chalk.red('Inspect error: ') + (err instanceof Error ? err.message : String(err)));
      }
      process.stdout.write('\n');
      rl.resume();
      rl.prompt(); return;
    }
    // s09: /team — list all teammates with roles and status
    if (input === '/team') {
      const { getTeammateManager } = await import('../core/teammate-manager.js');
      console.log('\n' + getTeammateManager(process.cwd()).listAll() + '\n');
      rl.prompt(); return;
    }
    // s09: /inbox — drain and display lead inbox
    if (input === '/inbox') {
      const { getTeammateManager } = await import('../core/teammate-manager.js');
      const msgs = getTeammateManager(process.cwd()).bus.readInbox('lead');
      console.log(msgs.length > 0
        ? '\n' + JSON.stringify(msgs, null, 2) + '\n'
        : chalk.gray('\n  (inbox empty)\n'));
      rl.prompt(); return;
    }
    // s07: /tasks — list all tasks on the persistent board
    if (input === '/tasks') {
      const { getTaskBoard } = await import('../core/task-board.js');
      console.log('\n' + getTaskBoard(process.cwd()).listAll() + '\n');
      rl.prompt(); return;
    }
    if (input.startsWith('/purify')) {
      const parts = input.split(/\s+/);
      const isDryRun = parts.includes('--dry-run') || parts.includes('-d');
      const doCommit = parts.includes('--commit');
      rl.pause();
      process.stdout.write('\n');
      try {
        const result = await selfHealTool.handler({
          path: process.cwd(), dry_run: isDryRun, severity: 'warning', commit: doCommit, max_fixes: 20,
        });
        console.log(result);
      } catch (err) {
        console.error(chalk.red('Purify error: ') + (err instanceof Error ? err.message : String(err)));
      }
      process.stdout.write('\n');
      rl.resume();
      rl.prompt(); return;
    }

    rl.pause();
    process.stdout.write('\n');
    try {
      // Run pre_prompt hooks to augment user input
      const hookCtx = await hookRunner.run({
        event: 'pre_prompt',
        prompt: input,
        cwd: process.cwd(),
      }).catch(() => ({ proceed: true, value: undefined, injection: undefined }));

      let finalInput = input;
      if (!hookCtx.proceed) {
        // Hook blocked this input
        console.log(chalk.yellow(`  [hook] Blocked: ${hookCtx.value ?? 'no reason given'}`));
        rl.resume();
        rl.prompt();
        return;
      }
      if (hookCtx.injection) {
        // Inject hook content as additional context
        finalInput = `${input}\n\n---\n${hookCtx.injection}`;
      }

      // Reset image prompt if one was pending
      const agentWithImage = agent as AgentCore & { _pendingImage?: string };
      if (agentWithImage._pendingImage) {
        const imgDataUrl = agentWithImage._pendingImage;
        delete agentWithImage._pendingImage;
        rl.setPrompt(makePrompt(options.domain));
        // Prefix image context to prompt
        finalInput = `[Image attached — analyze this image]\n${finalInput}\n\n[Image data: ${imgDataUrl.slice(0, 100)}...]`;
        console.log(chalk.gray('  (Image context attached to this request)'));
      }

      // Thinking spinner + status bar 'thinking' indicator
      const spinnerFrames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
      let spinIdx = 0;
      let firstChunk = true;
      updateStatusBar({ isThinking: 'low' });
      const spinTimer = setInterval(() => {
        process.stdout.write(`\r${chalk.cyan(spinnerFrames[spinIdx++ % spinnerFrames.length])} ${chalk.dim('Thinking...')}`);
      }, 120);

      process.stdout.write('\n');
      await agent.runStream(finalInput, (chunk) => {
        if (firstChunk) {
          clearInterval(spinTimer);
          process.stdout.write('\r' + ' '.repeat(20) + '\r');
          firstChunk = false;
        }
        process.stdout.write(chunk);
      });
      clearInterval(spinTimer);
      // Update status bar with fresh token estimate
      try {
        const h = agent.getHistory();
        const est = typeof estimateHistoryTokens === 'function' ? (estimateHistoryTokens as (h: unknown[]) => number)(h) : 0;
        updateStatusBar({ isThinking: false, estimatedTokens: est });
      } catch { updateStatusBar({ isThinking: false }); }
      process.stdout.write('\n\n');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAuthError =
        msg.includes('401') || msg.includes('403') ||
        msg.includes('Unauthorized') || msg.includes('invalid_api_key') ||
        msg.includes('API_KEY') || msg.includes('api key') ||
        msg.includes('authentication') || msg.includes('No API key') ||
        msg.includes('api-key') || msg.includes('Authentication');
      if (isAuthError) {
        console.error(chalk.red('\n✗ API key missing or invalid.'));
        console.log(chalk.yellow('\n  Starting API key setup...\n'));
        try {
          const { configureAgent } = await import('./configure.js');
          await configureAgent(
            'API authentication failed — please add or update your key',
            inferProviderEnvKey(msg),
          );
          // Reload env so new key takes effect in current process
          const { config: loadEnv } = await import('dotenv');
          const { resolve: r } = await import('path');
          loadEnv({ path: r(process.cwd(), '.env'), override: true });
          // Invalidate model client cache so next request uses the fresh key
          modelManager.clearClientCache();
          console.log(chalk.green('✓ Keys updated. Try your request again.\n'));
        } catch (cfgErr) {
          console.error(chalk.gray('  Config error: ' + (cfgErr instanceof Error ? cfgErr.message : String(cfgErr))));
        }
      } else {
        console.error(chalk.red('\n✗ ') + msg);
      }
    }
    rl.resume();
    rl.prompt();
  });

  rl.on('close', () => {
    // Dream Mode (kstack article #15343): on session exit, auto-ingest the
    // conversation history into memory-store so next session has continuity.
    // This is fire-and-forget — we catch all errors so exit is never blocked.
    // Only runs if the session has ≥ 4 turns (too short to be useful).
    const history = agent.getHistory();
    // Save session snapshot for /resume next time
    if (history.length >= 2) {
      try { saveSnapshot(SESSION_ID, history); } catch { /* non-fatal */ }
    }
    if (history.length >= 4) {
      (async () => {
        try {
          const { getMemoryStore } = await import('../core/memory/memory-store.js');
          const store = getMemoryStore(process.cwd());
          const result = await store.ingest(history);
          if (result.added > 0) {
            process.stdout.write(chalk.gray(`\n🌙 Dream Mode: +${result.added} insights saved to memory.\n`));
          }
        } catch { /* non-fatal */ }
      })().finally(() => {
        clearStatusBar();
        console.log(chalk.dim('\nGoodbye!'));
        process.exit(0);
      });
    } else {
      clearStatusBar();
      console.log(chalk.dim('\nGoodbye!'));
      process.exit(0);
    }
  });
}

program.parse();
