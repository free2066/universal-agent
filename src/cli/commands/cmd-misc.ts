/**
 * Miscellaneous single CLI commands extracted from src/cli/index.ts.
 * Covers: run, config, debug, usage, limits, domains, agents,
 *         inspect, purify, review, hooks, insights, update, init, commit, log
 */

import chalk from 'chalk';
import ora from 'ora';
import type { Command } from 'commander';
import { AgentCore } from '../../core/agent.js';
import { modelManager } from '../../models/model-manager.js';
import { subagentSystem } from '../../core/subagent-system.js';
import { initAgentsMd } from '../../core/context/context-loader.js';
import { codeInspectorTool } from '../../core/tools/code/code-inspector.js';
import { selfHealTool } from '../../core/tools/code/self-heal.js';
import { HookRunner } from '../../core/hooks.js';
import { sanitizeName, safeResolve } from '../../utils/path-security.js';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { WorktreeManager } from '../../core/tools/agents/worktree-tools.js';

export type InferProviderEnvKey = (errMsg: string) => string | undefined;

export interface MiscHelpers {
  validateDomain: (domain: string) => void;
  validateModel: (model: string) => void;
  inferProviderEnvKey: InferProviderEnvKey;
}

export function registerMiscCommands(program: Command, helpers: MiscHelpers): void {
  const { validateDomain, validateModel, inferProviderEnvKey } = helpers;

  // ── run ──────────────────────────────────────────────────
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
      if (!options.task) {
        const { runShell } = await import('../shell.js');
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

      if (!prompt) {
        console.error(chalk.red('\n✗ --task mode requires a prompt argument'));
        process.exit(1);
      }
      validateDomain(options.domain);

      let fullPrompt: string = options.file ? `${prompt}\n\n[File: ${options.file}]` : prompt;
      if (options.context) {
        const { existsSync, readFileSync } = await import('fs');
        const contextIds: string[] = (options.context as string).split(',').map((s: string) => s.trim()).filter(Boolean);
        const contextParts: string[] = [];
        const ctxBase = join(process.cwd(), '.uagent', 'context');
        for (const id of contextIds) {
          let ctxFile: string;
          try {
            sanitizeName(id, 'context id');
            ctxFile = safeResolve(`${id}.md`, ctxBase);
          } catch {
            console.warn(chalk.yellow(`  ⚠ Skipping invalid context id: ${id}`));
            continue;
          }
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

      const agent = new AgentCore({ domain: options.domain, model: options.model, stream: false, verbose: false, safeMode: options.safe });
      const spinner = ora('Thinking...').start();
      try {
        const result = await agent.run(fullPrompt, options.file);
        spinner.stop();
        console.log('\n' + result);

        if (options.saveContext) {
          const ctxDir = join(process.cwd(), '.uagent', 'context');
          let saveName: string;
          try {
            saveName = sanitizeName(options.saveContext as string, 'context name');
          } catch (e) {
            console.warn(chalk.yellow(`  ⚠ Invalid context name: ${e instanceof Error ? e.message : String(e)}`));
            saveName = '';
          }
          if (saveName) {
            mkdirSync(ctxDir, { recursive: true });
            const ctxContent = [`# Agent Context: ${saveName}`, '', `> Generated at: ${new Date().toISOString()}`, '', result].join('\n');
            writeFileSync(safeResolve(`${saveName}.md`, ctxDir), ctxContent, 'utf-8');
            console.log(chalk.green(`\n✓ Context saved → .uagent/context/${saveName}.md`));
          }
        }
      } catch (err) {
        spinner.stop();
        const msg = err instanceof Error ? err.message : String(err);
        const isAuthError = msg.includes('API_KEY') || msg.includes('api key') || msg.includes('authentication') ||
          msg.includes('401') || msg.includes('403') || msg.includes('Unauthorized') || msg.includes('invalid_api_key') ||
          msg.includes('No API key') || msg.includes('api-key');
        if (isAuthError) {
          console.error(chalk.red('\n✗ API key missing or invalid.'));
          console.log(chalk.yellow('  Let\'s set up your API keys now...\n'));
          const { configureAgent } = await import('../configure.js');
          await configureAgent('API authentication failed — please add or update your key', inferProviderEnvKey(msg));
          console.log(chalk.gray('  Restart uagent to apply the new key.'));
        } else {
          console.error(chalk.red('\n✗ ') + msg);
        }
        process.exit(1);
      }
    });

  // ── config ───────────────────────────────────────────────
  // Top-level `uagent config` (no subcommand) → API key wizard (backward compat)
  const configCmd = program
    .command('config')
    .description('Configure API keys and settings (or use subcommands: ls/get/set/add/rm)');

  // uagent config ls
  configCmd
    .command('ls')
    .description('List all resolved settings')
    .action(async () => {
      const { formatConfigList } = await import('../config-store.js') as typeof import('../config-store.js');
      console.log(formatConfigList());
    });

  // uagent config get <key>
  configCmd
    .command('get <key>')
    .description('Get a specific setting value')
    .action(async (key: string) => {
      const { getConfigValue } = await import('../config-store.js') as typeof import('../config-store.js');
      const val = getConfigValue(key as never);
      if (val === undefined) {
        console.log(chalk.gray(`(not set: ${key})`));
      } else {
        console.log(JSON.stringify(val));
      }
    });

  // uagent config set <key> <value> [-g]
  configCmd
    .command('set <key> <value>')
    .description('Set a setting value (project-level by default)')
    .option('-g, --global', 'Write to global config (~/.codeflicker/config.json)')
    .action(async (key: string, rawValue: string, opts: { global?: boolean }) => {
      const { setConfigValue, parseCliValue } = await import('../config-store.js') as typeof import('../config-store.js');
      const value = parseCliValue(rawValue);
      setConfigValue(key, value, opts.global ?? false);
      const scope = opts.global ? chalk.cyan('global') : chalk.yellow('project');
      console.log(chalk.green(`✓ Set ${key}=${JSON.stringify(value)} [${scope}]`));
    });

  // uagent config add <key> <value>
  configCmd
    .command('add <key> <value>')
    .description('Append a value to an array-typed setting')
    .action(async (key: string, rawValue: string) => {
      const { addConfigValue, parseCliValue } = await import('../config-store.js') as typeof import('../config-store.js');
      const value = parseCliValue(rawValue);
      addConfigValue(key, value);
      console.log(chalk.green(`✓ Added ${JSON.stringify(value)} to ${key}`));
    });

  // uagent config rm <key> [value] [-g]
  configCmd
    .command('rm <key> [value]')
    .description('Remove a setting key (or one item from an array)')
    .option('-g, --global', 'Remove from global config (~/.codeflicker/config.json)')
    .action(async (key: string, rawValue: string | undefined, opts: { global?: boolean }) => {
      const { removeConfigValue, parseCliValue } = await import('../config-store.js') as typeof import('../config-store.js');
      const value = rawValue !== undefined ? parseCliValue(rawValue) : undefined;
      removeConfigValue(key, value, opts.global ?? false);
      const scope = opts.global ? chalk.cyan('global') : chalk.yellow('project');
      if (value !== undefined) {
        console.log(chalk.green(`✓ Removed ${JSON.stringify(value)} from ${key} [${scope}]`));
      } else {
        console.log(chalk.green(`✓ Deleted ${key} [${scope}]`));
      }
    });

  // uagent config migrate [--dry-run] [-y]
  configCmd
    .command('migrate')
    .description('One-click import of CodeFlicker IDE / KwaiPilot preferences into uagent config')
    .option('--dry-run', 'Preview what would be migrated without writing')
    .option('-y, --yes', 'Skip confirmation prompt and apply immediately')
    .action(async (opts: { dryRun?: boolean; yes?: boolean }) => {
      const {
        buildMigrationPlan,
        detectSources,
      } = await import('../config-migrate.js') as typeof import('../config-migrate.js');
      const {
        loadConfig,
        globalConfigPath,
      } = await import('../config-store.js') as typeof import('../config-store.js');

      const { existsSync, mkdirSync, writeFileSync } = await import('fs');
      const { resolve } = await import('path');

      // Show source detection
      const detected = detectSources();
      const found = detected.filter((s) => s.exists);
      const notFound = detected.filter((s) => !s.exists);

      console.log(chalk.bold('\n🔍 Scanning for CodeFlicker / KwaiPilot settings...\n'));
      for (const s of found) {
        console.log(chalk.green(`  ✓  ${s.name}`));
        console.log(chalk.gray(`     ${s.path}`));
      }
      if (notFound.length > 0) {
        console.log(chalk.gray(`\n  (${notFound.length} sources not found, skipped)\n`));
      } else {
        console.log();
      }

      // Build migration plan
      const existingGlobal = (() => {
        try { return loadConfig(); } catch { return {}; }
      })();
      const plan = buildMigrationPlan(existingGlobal);

      if (plan.sources.length === 0 || plan.changedCount === 0) {
        console.log(chalk.yellow('  ℹ  Nothing to migrate — your uagent config is already up-to-date.\n'));
        return;
      }

      // Show what will be written
      console.log(chalk.bold(`📋 Migration preview (${plan.changedCount} settings to update):\n`));
      for (const source of plan.sources) {
        const fields = Object.keys(source.discovered);
        if (fields.length === 0) continue;
        console.log(chalk.cyan(`  From: ${source.name}`));
        for (const field of fields) {
          const oldVal = existingGlobal[field as keyof typeof existingGlobal];
          const newVal = source.discovered[field as keyof typeof source.discovered];
          const oldStr = oldVal !== undefined ? chalk.red(`${JSON.stringify(oldVal)} →`) : '';
          console.log(`    ${chalk.bold(field)}: ${oldStr} ${chalk.green(JSON.stringify(newVal))}`);
        }
        console.log();
      }

      const dest = globalConfigPath();
      console.log(chalk.dim(`  Target: ${dest}\n`));

      if (opts.dryRun) {
        console.log(chalk.yellow('  [dry-run] No changes written.\n'));
        return;
      }

      // Confirm
      if (!opts.yes) {
        const { createInterface } = await import('readline');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question(chalk.bold('Apply migration? [Y/n] '), resolve);
        });
        rl.close();
        if (answer.trim().toLowerCase() === 'n') {
          console.log(chalk.gray('\n  Cancelled.\n'));
          return;
        }
        console.log();
      }

      // Write global config (merge plan into existing)
      const merged = { ...existingGlobal, ...plan.merged } as Record<string, unknown>;
      const dir = resolve(dest, '..');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(dest, JSON.stringify(merged, null, 2) + '\n', 'utf-8');

      console.log(chalk.green(`✓ Migrated ${plan.changedCount} settings to ${dest}`));
      console.log(chalk.dim('  Run `uagent config ls` to verify.\n'));
    });

  // Default action when no subcommand given → API key wizard
  configCmd.action(async () => {
    const { configureAgent } = await import('../configure.js');
    await configureAgent();
  });

  // ── debug ────────────────────────────────────────────────
  program.command('debug')
    .description('Run diagnostic health check (keys, connectivity, models, config files)')
    .option('--ping', 'Also run live connectivity tests to each configured provider')
    .option('--json', 'Output report as JSON (for bug reports / CI)')
    .action(async (options) => {
      const { runDebugCheck } = await import('../debug-check.js');
      await runDebugCheck({ ping: options.ping, json: options.json });
    });

  // ── usage ────────────────────────────────────────────────
  program.command('usage')
    .description('Show token usage statistics and cost summary')
    .option('--days <n>', 'Number of days to show (default: 7)', '7')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const { usageTracker } = await import('../../models/usage-tracker.js');
      const days = parseInt(options.days) || 7;
      if (options.json) {
        console.log(JSON.stringify(usageTracker.getRawHistory(days), null, 2));
      } else {
        console.log('\n' + usageTracker.getSummary(days) + '\n');
      }
    });

  // ── limits ───────────────────────────────────────────────
  program.command('limits')
    .description('View or set daily usage limits')
    .option('--tokens <n>', 'Set daily token limit (input+output combined)')
    .option('--cost <usd>', 'Set daily cost limit in USD (e.g. 1.0)')
    .option('--warn <pct>', 'Warn when usage reaches this % (default: 80)')
    .option('--block <pct>', 'Block when usage reaches this % (default: 100)')
    .option('--reset', 'Clear all daily limits')
    .action(async (options) => {
      const { usageTracker } = await import('../../models/usage-tracker.js');
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
  program.command('domains').description('List available domains and their tools').action(async () => {
    const { DomainRouter } = await import('../../core/domain-router.js');
    const router = new DomainRouter();
    router.listDomains();
  });

  // ── agents ───────────────────────────────────────────────
  program.command('agents').description('List available subagents').action(() => {
    console.log(chalk.yellow('\n👤 Available Subagents:\n'));
    for (const agent of subagentSystem.listAgents()) {
      console.log(chalk.cyan(`  @run-agent-${agent.name.padEnd(20)}`), chalk.gray(agent.description));
    }
    console.log();
  });

  // ── inspect ──────────────────────────────────────────────
  program.command('inspect [path]')
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
  program.command('purify [path]')
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

  // ── review ────────────────────────────────────────────────
  program.command('review [path]')
    .description('AI Code Review: P1/P2/P3 graded issues on git diff or specified path')
    .option('--skip-static', 'Skip static analysis, only AI review')
    .option('--skip-ai', 'Skip AI review, only static analysis')
    .option('--diff <base>', 'Diff against a specific git ref (default: HEAD)')
    .action(async (reviewPath, options) => {
      const spinner = ora('Running code review...').start();
      try {
        const { reviewCode, getGitDiff } = await import('../../core/tools/code/ai-reviewer.js');
        const diff = options.diff ? (getGitDiff(process.cwd(), options.diff) ?? undefined) : undefined;
        const files = reviewPath ? [reviewPath] : undefined;
        const report = await reviewCode({ diff, files, projectRoot: process.cwd(), skipStatic: options.skipStatic, skipAI: options.skipAi });
        spinner.stop();
        console.log('\n' + report.markdown);
        console.log(chalk.gray(`Summary: P1=${report.summary.P1}  P2=${report.summary.P2}  P3=${report.summary.P3}\n`));
        if (report.hasBlockers) process.exit(1);
      } catch (err) {
        spinner.fail('Review failed: ' + (err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  // ── hooks ────────────────────────────────────────────────
  program.command('hooks')
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
  program.command('insights')
    .description('Analyze your uagent usage history and generate a report')
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
        const { runInsights } = await import('../insights.js');
        let llmClient: import('../insights.js').InsightsOptions['llmClient'] = undefined;
        if (options.ai) {
          const rawClient = modelManager.getClient('compact');
          llmClient = rawClient as import('../insights.js').InsightsOptions['llmClient'];
        }
        const report = await runInsights({
          days, maxPrompts, cwdOnly: options.cwdOnly, projectRoot: process.cwd(),
          outputPath: options.output, html: options.html, llmClient,
        });
        spinner.succeed('Report generated');
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
  program.command('update')
    .description('Check for updates and apply them (git pull + rebuild)')
    .option('--check', 'Only check, do not apply')
    .action(async (opts) => {
      if (opts.check) {
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
      const { checkAndUpdate } = await import('../auto-update.js');
      const updated = await checkAndUpdate().catch(() => false);
      if (updated) {
        console.log(chalk.bold.green('\n  ✓ Updated! Please restart uagent.\n'));
      } else {
        console.log(chalk.green('  ✓ Already up to date.'));
      }
    });

  // ── init ─────────────────────────────────────────────────
  program.command('init').description('Initialize AGENTS.md for this project').action(() => {
    const result = initAgentsMd(process.cwd());
    console.log(chalk.green(result));
  });

  // ── commit ─────────────────────────────────────────────── (aligns with flickcli commit)
  program.command('commit')
    .description('Generate and commit git changes with AI-generated message')
    .option('-s, --stage', 'Stage all changes (git add -A) before generating')
    .option('-c, --commit', 'Auto-commit without confirmation')
    .option('--push', 'Push after commit')
    .option('-n, --no-verify', 'Skip pre-commit hooks (--no-verify)')
    .option('-m, --model <model>', 'Model to use')
    .option('--language <lang>', 'Commit message language (e.g. Chinese, English)')
    .option('--copy', 'Copy message to clipboard')
    .option('--follow-style', 'Infer commit style from recent commits')
    .option('--checkout', 'Create a new branch before committing')
    .action(async (opts) => {
      const { runCommit } = await import('../commit.js');
      await runCommit({
        stage: opts.stage,
        commit: opts.commit,
        push: opts.push,
        noVerify: opts.noVerify === false,
        model: opts.model,
        language: opts.language,
        copy: opts.copy,
        followStyle: opts.followStyle,
        checkout: opts.checkout,
      });
    });

  // ── workspace ──────────────────────────────────────────── (aligns with flickcli workspace)
  const wsCmd = program.command('workspace').alias('ws').description('Manage git worktrees for isolated development');

  wsCmd.command('list').alias('ls').description('List all tracked worktrees')
    .action(() => {
      console.log(new WorktreeManager(process.cwd()).listAll());
    });

  wsCmd.command('create <name>').description('Create a new git worktree on a fresh branch')
    .option('-t, --task <id>', 'Bind to task ID')
    .option('-b, --base <ref>', 'Git ref to branch from (default: HEAD)')
    .action((name: string, opts: { task?: string; base?: string }) => {
      try {
        const result = new WorktreeManager(process.cwd()).create(
          name,
          opts.task !== undefined ? parseInt(opts.task, 10) : undefined,
          opts.base ?? 'HEAD',
        );
        console.log(chalk.green(result));
      } catch (e) {
        console.error(chalk.red('Error: ') + (e instanceof Error ? e.message : String(e)));
        process.exit(1);
      }
    });

  wsCmd.command('remove <name>').alias('rm').description('Remove a worktree')
    .option('--force', 'Force removal even with uncommitted changes')
    .option('--complete', 'Mark the bound task as completed')
    .action((name: string, opts: { force?: boolean; complete?: boolean }) => {
      try {
        const result = new WorktreeManager(process.cwd()).remove(name, opts.force ?? false, opts.complete ?? false);
        console.log(chalk.green(result));
      } catch (e) {
        console.error(chalk.red('Error: ') + (e instanceof Error ? e.message : String(e)));
        process.exit(1);
      }
    });

  wsCmd.command('status <name>').description('Show git status for a worktree')
    .action((name: string) => {
      console.log(new WorktreeManager(process.cwd()).status(name));
    });

  wsCmd.command('events').description('Show recent worktree lifecycle events')
    .option('-n, --limit <n>', 'Max events to show (default: 20)', '20')
    .action((opts: { limit: string }) => {
      console.log(new WorktreeManager(process.cwd()).eventsRecent(parseInt(opts.limit, 10)));
    });

  // ── log ────────────────────────────────────────────────── (aligns with flickcli log)
  program.command('log')
    .description('Show session history')
    .option('-n <count>', 'Number of sessions to show (default: 10)', '10')
    .option('--json', 'Output as JSON')
    .option('--id <id>', 'Filter by session ID')
    .action(async (opts) => {
      const { runLog } = await import('../log.js');
      runLog({ n: opts.n, json: opts.json, id: opts.id });
    });
}
