/**
 * commit.ts — uagent commit subcommand
 *
 * Aligns with `flickcli commit`:
 *   uagent commit [-s] [-c] [--push] [-n] [--copy] [--language zh] [--model <m>]
 *
 * Flow:
 *   1. git diff --staged (or --diff HEAD if -s)
 *   2. Call LLM to generate conventional commit message
 *   3. Show message + ask user to confirm (or -c to auto-commit)
 */

import chalk from 'chalk';
import { execSync, spawnSync } from 'child_process';
import { AgentCore } from '../core/agent.js';
import { modelManager } from '../models/model-manager.js';

export interface CommitOptions {
  stage?: boolean;         // -s: git add -A before generating
  commit?: boolean;        // -c: auto git commit
  push?: boolean;          // --push: git push after commit
  noVerify?: boolean;      // -n: --no-verify
  copy?: boolean;          // --copy: copy to clipboard
  language?: string;       // --language zh|en|auto
  model?: string;          // -m: model override
  followStyle?: boolean;   // --follow-style: infer from recent commits
}

function getDiff(stage: boolean): string {
  try {
    if (stage) execSync('git add -A', { stdio: 'ignore' });
    const staged = execSync('git diff --staged --stat', { encoding: 'utf-8' }).trim();
    if (!staged) return execSync('git diff HEAD --stat', { encoding: 'utf-8' }).trim();
    return staged;
  } catch {
    return '';
  }
}

function getFullDiff(stage: boolean): string {
  try {
    if (stage) execSync('git add -A', { stdio: 'ignore' });
    const staged = execSync('git diff --staged', { encoding: 'utf-8' }).trim();
    if (staged) return staged.slice(0, 8000); // limit to 8KB
    return execSync('git diff HEAD', { encoding: 'utf-8' }).trim().slice(0, 8000);
  } catch {
    return '';
  }
}

function getRecentCommits(): string {
  try {
    return execSync('git log --oneline -10', { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function copyToClipboard(text: string): boolean {
  try {
    const r = spawnSync('pbcopy', [], { input: text });
    return r.status === 0;
  } catch {
    try {
      spawnSync('xclip', ['-selection', 'clipboard'], { input: text });
      return true;
    } catch { return false; }
  }
}

export async function runCommit(opts: CommitOptions): Promise<void> {
  // Resolve model
  const model = opts.model || modelManager.getCurrentModel('main') ||
    await modelManager.autoSelectFreeModel(true).then(() => modelManager.getCurrentModel('main'));

  // Get diff
  const stat = getDiff(opts.stage ?? false);
  if (!stat) {
    console.log(chalk.yellow('\n  No staged changes found. Use -s to stage all changes first.\n'));
    process.exit(0);
  }

  const fullDiff = getFullDiff(opts.stage ?? false);
  const recentCommits = opts.followStyle ? getRecentCommits() : '';

  // Build prompt
  const langInstruction = opts.language
    ? `Write the commit message in ${opts.language}.`
    : 'Write the commit message in the same language as the code/comments. Default to English.';

  const styleContext = recentCommits
    ? `\n\nRecent commits (follow this style):\n${recentCommits}`
    : '';

  const prompt = `Generate a conventional commit message for the following git diff.

Rules:
- Follow Conventional Commits spec: type(scope): description
- Types: feat, fix, refactor, docs, test, chore, perf, style
- First line ≤ 72 chars
- Add a body if the change is complex (blank line between subject and body)
- Be concise and specific
- ${langInstruction}
- Output ONLY the commit message, no explanation, no markdown fences${styleContext}

Git diff:
${fullDiff}`;

  // Stream commit message
  process.stdout.write('\n');
  const agent = new AgentCore({ domain: 'dev', model, stream: true, verbose: false });

  let message = '';
  process.stdout.write(chalk.dim('  Generating commit message...\n\n'));

  // Collect streamed output
  const chunks: string[] = [];
  await agent.runStream(prompt, (chunk) => {
    process.stdout.write(chunk);
    chunks.push(chunk);
  });
  message = chunks.join('').trim();

  // Strip markdown fences if model added them
  message = message.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '').trim();

  process.stdout.write('\n');

  // Copy to clipboard
  if (opts.copy) {
    const ok = copyToClipboard(message);
    process.stdout.write(ok
      ? chalk.green('\n  ✓ Copied to clipboard\n')
      : chalk.yellow('\n  ⚠ Could not copy to clipboard\n'));
  }

  // Auto-commit
  if (opts.commit) {
    try {
      const noVerifyFlag = opts.noVerify ? '--no-verify' : '';
      const cmd = `git commit -m ${JSON.stringify(message)} ${noVerifyFlag}`.trim();
      execSync(cmd, { stdio: 'inherit' });
      process.stdout.write(chalk.green('\n  ✓ Committed\n'));

      if (opts.push) {
        process.stdout.write(chalk.dim('\n  Pushing...\n'));
        execSync('git push', { stdio: 'inherit' });
        process.stdout.write(chalk.green('  ✓ Pushed\n'));
      }
    } catch (err) {
      console.error(chalk.red('\n  ✗ Commit failed: ') + (err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  } else {
    // Interactive confirm
    const { createInterface } = await import('readline');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((res) =>
      rl.question(chalk.dim('\n  Commit with this message? [y/N/e(edit)] '), res),
    );
    rl.close();

    if (answer.toLowerCase() === 'y') {
      try {
        const noVerifyFlag = opts.noVerify ? '--no-verify' : '';
        const cmd = `git commit -m ${JSON.stringify(message)} ${noVerifyFlag}`.trim();
        execSync(cmd, { stdio: 'inherit' });
        process.stdout.write(chalk.green('  ✓ Committed\n'));
        if (opts.push) {
          execSync('git push', { stdio: 'inherit' });
          process.stdout.write(chalk.green('  ✓ Pushed\n'));
        }
      } catch (err) {
        console.error(chalk.red('  ✗ Commit failed: ') + (err instanceof Error ? err.message : String(err)));
      }
    } else {
      process.stdout.write(chalk.dim('  Skipped.\n'));
    }
  }

  process.stdout.write('\n');
}
