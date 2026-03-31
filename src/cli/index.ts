#!/usr/bin/env node
import { program } from 'commander';
import { createInterface } from 'readline';
import chalk from 'chalk';
import ora from 'ora';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { config } from 'dotenv';
import { AgentCore } from '../core/agent.js';
import { printBanner, printHelp } from './ui.js';

// Load .env from current directory or home
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

program
  .command('chat', { isDefault: true })
  .description('Start interactive agent session')
  .option('-d, --domain <domain>', 'Specify domain (data|dev|service|auto)', 'auto')
  .option('-m, --model <model>', 'LLM model to use (gpt-4o|claude-3-5-sonnet|ollama:llama3)', 'gpt-4o')
  .option('--no-stream', 'Disable streaming output')
  .option('-v, --verbose', 'Show tool call details')
  .action(async (options) => {
    printBanner();

    const agent = new AgentCore({
      domain: options.domain,
      model: options.model,
      stream: options.stream,
      verbose: options.verbose,
    });

    await runREPL(agent, options);
  });

program
  .command('run <prompt>')
  .description('Execute a single agent task')
  .option('-d, --domain <domain>', 'Domain (data|dev|service|auto)', 'auto')
  .option('-m, --model <model>', 'Model to use', 'gpt-4o')
  .option('-f, --file <file>', 'Input file path')
  .action(async (prompt, options) => {
    const agent = new AgentCore({
      domain: options.domain,
      model: options.model,
      stream: true,
      verbose: false,
    });

    const fullPrompt = options.file
      ? `${prompt}\n\n[File: ${options.file}]`
      : prompt;

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

program
  .command('config')
  .description('Configure API keys and settings')
  .action(async () => {
    const { configureAgent } = await import('./configure.js');
    await configureAgent();
  });

program
  .command('domains')
  .description('List available domains and their tools')
  .action(async () => {
    const { DomainRouter } = await import('../core/domain-router.js');
    const router = new DomainRouter();
    router.listDomains();
  });

async function runREPL(agent: AgentCore, options: { domain: string; verbose: boolean }) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: chalk.cyan(`[${options.domain}] `) + chalk.green('❯ '),
  });

  console.log(chalk.gray('Type your request, or use /help, /domain <name>, /exit\n'));

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // REPL commands
    if (input === '/exit' || input === '/quit') {
      console.log(chalk.yellow('\nGoodbye! 👋'));
      process.exit(0);
    }
    if (input === '/help') {
      printHelp();
      rl.prompt();
      return;
    }
    if (input.startsWith('/domain ')) {
      const domain = input.replace('/domain ', '').trim();
      agent.setDomain(domain);
      options.domain = domain;
      rl.setPrompt(chalk.cyan(`[${domain}] `) + chalk.green('❯ '));
      console.log(chalk.green(`✓ Switched to domain: ${domain}`));
      rl.prompt();
      return;
    }
    if (input === '/clear') {
      agent.clearHistory();
      console.clear();
      printBanner();
      rl.prompt();
      return;
    }

    // Pause for async processing
    rl.pause();
    process.stdout.write('\n');

    try {
      await agent.runStream(input, (chunk) => {
        process.stdout.write(chunk);
      });
      process.stdout.write('\n\n');
    } catch (err) {
      console.error(chalk.red('\n✗ Error: ') + (err instanceof Error ? err.message : String(err)));
    }

    rl.resume();
    rl.prompt();
  });

  rl.on('close', () => {
    console.log(chalk.yellow('\nGoodbye! 👋'));
    process.exit(0);
  });
}

program.parse();
