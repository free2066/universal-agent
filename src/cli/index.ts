#!/usr/bin/env node
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
import { initAgentsMd } from '../core/context-loader.js';
import { MCPManager } from '../core/mcp-manager.js';
import { codeInspectorTool } from '../core/tools/code-inspector.js';
import { selfHealTool } from '../core/tools/self-heal.js';
import { getRecentHistory } from '../core/session-history.js';
import { printBanner, printHelp } from './ui.js';

// Load env
config({ path: resolve(process.cwd(), '.env') });
if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
  const homeEnv = resolve(process.env.HOME || '~', '.uagent', '.env');
  if (existsSync(homeEnv)) config({ path: homeEnv });
}

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')
);

program
  .name('uagent')
  .description(pkg.description)
  .version(pkg.version);

// ── chat (default) ──────────────────────────────────────
program
  .command('chat', { isDefault: true })
  .description('Start interactive agent session')
  .option('-d, --domain <domain>', 'Domain (data|dev|service|auto)', 'auto')
  .option('-m, --model <model>', 'Model to use', 'gpt-4o')
  .option('--safe', 'Enable safe mode (blocks dangerous commands)', false)
  .option('-v, --verbose', 'Show tool call details')
  .action(async (options) => {
    printBanner();
    const agent = new AgentCore({
      domain: options.domain,
      model: options.model,
      stream: true,
      verbose: options.verbose,
      safeMode: options.safe,
    });
    await agent.initMCP().catch(() => {});
    await runREPL(agent, options);
  });

// ── run ──────────────────────────────────────────────────
program
  .command('run <prompt>')
  .description('Execute a single agent task')
  .option('-d, --domain <domain>', 'Domain', 'auto')
  .option('-m, --model <model>', 'Model', 'gpt-4o')
  .option('-f, --file <file>', 'Input file path')
  .option('--safe', 'Safe mode')
  .action(async (prompt, options) => {
    const agent = new AgentCore({
      domain: options.domain,
      model: options.model,
      stream: false,
      verbose: false,
      safeMode: options.safe,
    });
    const fullPrompt = options.file ? `${prompt}\n\n[File: ${options.file}]` : prompt;
    const spinner = ora('Thinking...').start();
    try {
      const result = await agent.run(fullPrompt, options.file);
      spinner.stop();
      console.log('\n' + result);
    } catch (err) {
      spinner.fail('Error: ' + (err instanceof Error ? err.message : String(err)));
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

// ── mcp ──────────────────────────────────────────────────
const mcpCmd = program.command('mcp').description('Manage MCP servers');

mcpCmd.command('list').description('List MCP servers').action(() => {
  const mgr = new MCPManager();
  const servers = mgr.listServers();
  if (!servers.length) { console.log(chalk.gray('No MCP servers configured. See .mcp.json')); return; }
  console.log(chalk.yellow('\n🔌 MCP Servers:\n'));
  for (const s of servers) {
    const status = s.enabled ? chalk.green('enabled') : chalk.red('disabled');
    console.log(`  ${status} ${chalk.white(s.name)} [${s.type}] ${s.url || s.command || ''}`);
  }
  console.log();
});

mcpCmd.command('init').description('Initialize .mcp.json in current directory').action(() => {
  const result = MCPManager.initConfig();
  console.log(chalk.green(result));
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

// ── init ─────────────────────────────────────────────────
program
  .command('init')
  .description('Initialize AGENTS.md for this project')
  .action(() => {
    const result = initAgentsMd(process.cwd());
    console.log(chalk.green(result));
  });

// ── REPL ─────────────────────────────────────────────────
async function runREPL(agent: AgentCore, options: { domain: string; verbose: boolean }) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: chalk.cyan(`[${options.domain}] `) + chalk.green('❯ '),
  });

  console.log(chalk.gray('Type your request, or /help, /cost, /model <name>, /domain <name>, /agents, /inspect, /purify, /exit\n'));

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── slash commands ──
    if (input === '/exit' || input === '/quit') {
      console.log(chalk.yellow('\nGoodbye! 👋'));
      process.exit(0);
    }
    if (input === '/help') { printHelp(); rl.prompt(); return; }
    if (input === '/cost') {
      console.log('\n' + modelManager.getCostSummary() + '\n');
      rl.prompt(); return;
    }
    if (input.startsWith('/model')) {
      const parts = input.split(/\s+/);
      if (parts.length === 1) {
        // Cycle
        const next = modelManager.cycleMainModel();
        agent.setModel(next);
        rl.setPrompt(chalk.cyan(`[${options.domain}|${next}] `) + chalk.green('❯ '));
        console.log(chalk.green(`✓ Model → ${next}`));
      } else {
        const m = parts[1];
        agent.setModel(m);
        rl.setPrompt(chalk.cyan(`[${options.domain}|${m}] `) + chalk.green('❯ '));
        console.log(chalk.green(`✓ Model → ${m}`));
      }
      rl.prompt(); return;
    }
    if (input.startsWith('/domain ')) {
      const domain = input.replace('/domain ', '').trim();
      agent.setDomain(domain);
      options.domain = domain;
      rl.setPrompt(chalk.cyan(`[${domain}] `) + chalk.green('❯ '));
      console.log(chalk.green(`✓ Domain → ${domain}`));
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
    if (input === '/models') {
      const profiles = modelManager.listProfiles();
      const pointers = modelManager.getPointers();
      console.log(chalk.yellow('\n🤖 Models:'));
      for (const p of profiles) {
        const role = Object.entries(pointers).filter(([, v]) => v === p.name).map(([k]) => k).join('/');
        console.log(`  ${chalk.white(p.name.padEnd(22))} ${chalk.gray(p.provider)} ${role ? chalk.cyan(`[${role}]`) : ''}`);
      }
      console.log();
      rl.prompt(); return;
    }
    if (input === '/clear') {
      agent.clearHistory();
      console.clear();
      printBanner();
      rl.prompt();
      return;
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
      await agent.runStream(input, (chunk) => process.stdout.write(chunk));
      process.stdout.write('\n\n');
    } catch (err) {
      console.error(chalk.red('\n✗ ') + (err instanceof Error ? err.message : String(err)));
    }
    rl.resume();
    rl.prompt();
  });

  rl.on('close', () => { console.log(chalk.yellow('\nGoodbye! 👋')); process.exit(0); });
}

program.parse();
