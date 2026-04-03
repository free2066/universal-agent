import chalk from 'chalk';
import { readFileSync } from 'fs';
import { resolve } from 'path';

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));
    return pkg.version ?? '0.1.0';
  } catch {
    return '0.1.0';
  }
}

/** CodeFlicker-style clean banner — no box border */
export function printBanner() {
  const ver = getVersion();
  process.stdout.write('\n');
  process.stdout.write(
    chalk.bold.white('  Universal Agent') +
    chalk.gray(` v${ver}`) +
    '\n',
  );
  process.stdout.write(
    chalk.gray('  Multi-domain AI assistant') +
    '  ' +
    chalk.dim('auto · dev · data · service') +
    '\n\n',
  );
}

/** Grouped slash-command help, CodeFlicker-style */
export function printHelp() {
  const col1 = 20;

  const group = (title: string, items: [string, string][]) => {
    process.stdout.write('\n' + chalk.bold.white('  ' + title) + '\n');
    for (const [cmd, desc] of items) {
      process.stdout.write(
        '    ' +
        chalk.cyan(cmd.padEnd(col1)) +
        chalk.gray(desc) +
        '\n',
      );
    }
  };

  group('Session', [
    ['/help',           'Show this help'],
    ['/clear',          'Clear screen & conversation history'],
    ['/exit',           'Exit (saves session snapshot)'],
    ['/resume',         'Restore last session'],
    ['/compact',        'Compress conversation to save tokens'],
    ['/tokens',         'Show context token usage'],
    ['/cost',           'Show token cost this session'],
  ]);

  group('Models & Domains', [
    ['/model',          'Interactive model picker (↑↓ navigate, Enter select)'],
    ['/model <id>',     'Switch model directly'],
    ['/models',         'List all registered models'],
    ['/domain <name>',  'Switch domain: auto | dev | data | service'],
  ]);

  group('Code', [
    ['/review',         'AI code review on current changes'],
    ['/inspect [path]', 'Static code inspection'],
    ['/purify [path]',  'Auto-fix code issues'],
    ['/spec <desc>',    'Generate technical specification'],
  ]);

  group('Agents & Tasks', [
    ['/agents',         'List subagents & their status'],
    ['/team',           'List AI teammates'],
    ['/tasks',          'Task board'],
    ['/inbox',          'Lead inbox'],
  ]);

  group('Utilities', [
    ['/image <path>',   'Attach image to next message'],
    ['/history [n]',    'Show last n prompts'],
    ['/hooks',          'Lifecycle hooks'],
    ['/insights [days]','Usage analytics'],
    ['/init',           'Create AGENTS.md for this project'],
    ['/rules',          'Show loaded rule files'],
    ['/memory',         'Memory stats & search'],
  ]);

  process.stdout.write('\n' + chalk.bold.white('  Tips') + '\n');
  process.stdout.write(
    '    ' + chalk.gray('Reference files with ') +
    chalk.cyan('@path/to/file') +
    chalk.gray(' in your message') + '\n',
  );
  process.stdout.write(
    '    ' + chalk.gray('Example: ') +
    chalk.white('explain this project') + '\n',
  );
  process.stdout.write(
    '    ' + chalk.gray('Example: ') +
    chalk.white('review @src/cli/index.ts for security issues') + '\n',
  );
  process.stdout.write(
    '    ' + chalk.gray('Example: ') +
    chalk.white('write tests for the model-picker') + '\n\n',
  );
}
