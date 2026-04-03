/**
 * shell.ts — NL→Shell command generator
 * Aligns with `flickcli run`: converts natural language to shell commands,
 * shows the command for confirmation, then executes (or copies to clipboard).
 *
 * Usage:
 *   uagent run                  # interactive: asks what you want to do
 *   uagent run "list big files" # non-interactive: generate from prompt
 *   uagent run -y "..."         # auto-execute without confirmation
 *   uagent run -m gpt-4o        # use specific model
 */

import chalk from 'chalk';
import { createInterface } from 'readline';
import { execSync, spawn } from 'child_process';

export interface ShellRunOptions {
  prompt?: string;   // NL description (if empty, ask interactively)
  model?: string;    // model override
  yes?: boolean;     // -y: auto-execute without confirmation
  copy?: boolean;    // --copy: copy to clipboard instead of executing
  explain?: boolean; // --explain: show explanation alongside command
  safe?: boolean;    // --safe: refuse destructive commands
}

const SYSTEM_PROMPT = `You are a shell command generator.
Convert the user's natural language description into a single shell command.

Rules:
- Output ONLY the shell command. No explanation, no markdown, no code fences.
- Use the simplest, most portable command that works on macOS and Linux.
- If the request is ambiguous, generate the safest reasonable interpretation.
- If you cannot generate a safe command, output: ERROR: <reason>
- Combine multiple steps with && or pipes where appropriate.

Examples:
  "list large files"          → find . -size +10M -not -path './.git/*' | head -20
  "show disk usage by folder" → du -sh */ | sort -rh | head -20
  "kill port 3000"            → lsof -ti:3000 | xargs kill -9
  "count lines in ts files"   → find . -name '*.ts' -not -path '*/node_modules/*' | xargs wc -l | tail -1
`;

export async function runShell(opts: ShellRunOptions): Promise<void> {
  // ── Step 1: get NL description ─────────────────────────────────────────
  let nlPrompt = opts.prompt ?? '';

  if (!nlPrompt) {
    // Interactive: ask what the user wants to do
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    nlPrompt = await new Promise<string>((resolve) => {
      rl.question(
        chalk.bold.cyan('❯ ') + chalk.white('What do you want to do? ') + chalk.dim('(natural language) '),
        (answer) => { rl.close(); resolve(answer.trim()); },
      );
    });
    if (!nlPrompt) {
      console.log(chalk.gray('  Aborted.'));
      process.exit(0);
    }
  }

  // ── Step 2: generate shell command via LLM ──────────────────────────────
  const { modelManager } = await import('../models/model-manager.js');
  const { createLLMClient } = await import('../models/llm-client.js');

  let model = opts.model ?? '';
  if (!model) {
    await modelManager.autoSelectFreeModel(true).catch(() => {});
    model = modelManager.getCurrentModel('main');
  } else {
    modelManager.setPointer('main', model);
  }

  const spinner = (await import('ora')).default('Generating command...').start();

  let command = '';
  try {
    const client = createLLMClient(model);
    let buf = '';
    await client.streamChat(
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: nlPrompt },
        ],
      },
      (chunk: string) => { buf += chunk; },
    );
    command = buf.trim()
      .replace(/^```[\w]*\n?/, '')   // strip opening code fence
      .replace(/\n?```$/, '')        // strip closing code fence
      .replace(/^`([^`]+)`$/, '$1')  // strip single-line backticks
      .trim();
  } catch (err) {
    spinner.fail('Generation failed: ' + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  spinner.stop();

  if (command.startsWith('ERROR:')) {
    console.error(chalk.red('\n✗ Cannot generate command: ') + command.slice(6).trim());
    process.exit(1);
  }

  // ── Step 3: safety check ───────────────────────────────────────────────
  const DESTRUCTIVE = /\brm\s+-rf?\b|\bdd\b.*if=|\bformat\b|\bmkfs\b|\bshred\b|\b>\s*\/dev\//;
  if (opts.safe && DESTRUCTIVE.test(command)) {
    console.error(chalk.red('\n✗ Command looks destructive and --safe mode is on:'));
    console.error(chalk.red(`  ${command}`));
    process.exit(1);
  }

  // ── Step 4: show command ───────────────────────────────────────────────
  process.stdout.write('\n');
  process.stdout.write(chalk.bold.yellow('  Generated command:\n'));
  process.stdout.write('\n  ' + chalk.bold.green(command) + '\n\n');

  // ── Step 5: confirm or auto-execute ────────────────────────────────────
  if (opts.copy) {
    // Copy to clipboard
    try {
      const copy = process.platform === 'darwin' ? 'pbcopy' : 'xclip -selection clipboard';
      execSync(`echo ${JSON.stringify(command)} | ${copy}`);
      console.log(chalk.green('  ✓ Copied to clipboard.'));
    } catch {
      console.log(chalk.gray('  (clipboard copy failed — paste manually)'));
    }
    return;
  }

  if (!opts.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(
        chalk.dim('  Execute? ') + chalk.cyan('[Y/n] '),
        (a) => { rl.close(); resolve(a.trim().toLowerCase()); },
      );
    });
    if (answer !== '' && answer !== 'y' && answer !== 'yes') {
      console.log(chalk.gray('\n  Aborted.'));
      return;
    }
  } else {
    console.log(chalk.dim('  Auto-executing (-y)...'));
  }

  // ── Step 6: execute ────────────────────────────────────────────────────
  process.stdout.write('\n');
  const child = spawn(command, { shell: true, stdio: 'inherit' });
  await new Promise<void>((resolve) => {
    child.on('close', (code) => {
      process.stdout.write('\n');
      if (code === 0) {
        console.log(chalk.green('  ✓ Done.'));
      } else {
        console.log(chalk.red(`  ✗ Exit code ${code}`));
      }
      resolve();
    });
  });
}
