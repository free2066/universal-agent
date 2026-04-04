/**
 * handlers/session-handlers.ts
 * 会话相关命令：/log /logs /resume /clear /exit /branch /rename /export /copy /status /bug
 */
import chalk from 'chalk';
import type { SlashContext } from './shared.js';
import { done } from './shared.js';
import { listLogs } from '../../session-logger.js';
import { modelManager } from '../../../models/model-manager.js';
import { clearStatusBar, printStatusBar } from '../../statusbar.js';
import { printBanner } from '../../ui-enhanced.js';

export async function handleLog(ctx: SlashContext): Promise<true> {
  const { rl, sessionLogger } = ctx;
  console.log(chalk.yellow('\n📝 Current session log:'));
  console.log(`  ${chalk.cyan(sessionLogger.path)}`);
  console.log(chalk.gray('  To share with AI: cat "' + sessionLogger.path + '" | pbcopy\n'));
  return done(rl);
}

export async function handleLogs(ctx: SlashContext): Promise<true> {
  const { rl } = ctx;
  const logs = listLogs();
  if (!logs.length) {
    console.log(chalk.gray('\n  No session logs found.\n'));
  } else {
    console.log(chalk.yellow('\n📋 Recent session logs (newest first):'));
    for (const [i, l] of logs.entries()) {
      const kb = (l.size / 1024).toFixed(1);
      const age = l.mtime ? new Date(l.mtime).toLocaleString('zh-CN', { hour12: false }) : '';
      const marker = i === 0 ? chalk.green(' ← current/latest') : '';
      console.log(`  ${chalk.gray(String(i + 1).padStart(2) + '.')} ${chalk.cyan(l.name)}  ${chalk.gray(kb + 'KB  ' + age)}${marker}`);
    }
    console.log(chalk.gray('\n  To copy latest log to clipboard:'));
    console.log(chalk.gray(`  cat "${logs[0]?.path}" | pbcopy\n`));
  }
  return done(rl);
}

export async function handleContinue(ctx: SlashContext): Promise<true> {
  const { agent, rl } = ctx;
  const h = agent.getHistory();
  if (h.length < 2) {
    console.log(chalk.gray('\n  Nothing to continue (no active session).\n'));
    return done(rl);
  }
  setTimeout(() => rl.emit('line', '[SYSTEM] Continue from where you left off — complete any remaining tasks.'), 50);
  return true;
}

export async function handleExit(ctx: SlashContext): Promise<true> {
  const { agent, rl, hookRunner, SESSION_ID, saveSnapshot } = ctx;
  clearStatusBar();
  process.stdout.write('\n' + chalk.dim('  Bye!') + '\n');
  await hookRunner.run({ event: 'on_session_end', cwd: process.cwd() }).catch(() => {});
  const h = agent.getHistory();
  if (h.length >= 2) saveSnapshot(SESSION_ID, h);
  process.exit(0);
}

export async function handleClear(ctx: SlashContext): Promise<true> {
  const { agent, rl } = ctx;
  agent.clearHistory();
  console.clear();
  printBanner();
  rl.prompt(); printStatusBar();
  return true;
}

export async function handleResume(input: string, ctx: SlashContext): Promise<true> {
  const { agent, rl, loadLastSnapshot, saveSnapshot: _save, formatAge } = ctx;
  const parts = input.split(/\s+/);
  const sessionId = parts[1];
  if (sessionId) {
    const { loadSnapshot: _loadSnap } = await import('../../../core/memory/session-snapshot.js');
    const snap = _loadSnap(sessionId);
    if (snap && snap.messages.length >= 2) {
      agent.setHistory(snap.messages as never);
      process.stdout.write(chalk.green(`  ✓ Restored session "${sessionId}" from ${formatAge(snap.savedAt)} (${snap.messages.length} messages)`) + '\n\n');
    } else {
      const { readdirSync: _rds, statSync: _ss, existsSync: _es } = await import('fs');
      const { resolve: _res, join: _jn } = await import('path');
      const sessDir = _res(process.env.HOME ?? '~', '.uagent', 'sessions');
      if (_es(sessDir)) {
        const files = _rds(sessDir).filter(f => f.endsWith('.json'));
        if (files.length) {
          console.log(chalk.yellow('\n💾 Available sessions:\n'));
          const sorted = files
            .map(f => ({ f, mtime: _ss(_jn(sessDir, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, 10);
          for (const { f, mtime } of sorted) {
            const id = f.replace('.json', '');
            console.log(`  ${chalk.cyan(id.padEnd(30))} ${chalk.gray(new Date(mtime).toLocaleString('zh-CN', { hour12: false }))}`);
          }
          console.log(chalk.gray('\n  Use: /resume <session-id>\n'));
        } else {
          process.stdout.write(chalk.dim(`  Session "${sessionId}" not found.\n\n`));
        }
      } else {
        process.stdout.write(chalk.dim(`  Session "${sessionId}" not found.\n\n`));
      }
    }
  } else {
    const snap = loadLastSnapshot();
    if (snap && snap.messages.length >= 2) {
      agent.setHistory(snap.messages as never);
      process.stdout.write(chalk.green(`  ✓ Restored session from ${formatAge(snap.savedAt)} (${snap.messages.length} messages)`) + '\n\n');
    } else {
      process.stdout.write(chalk.dim('  No saved session found.') + '\n\n');
    }
  }
  return done(rl);
}

export async function handleBranch(ctx: SlashContext): Promise<true> {
  const { agent, rl, saveSnapshot } = ctx;
  const history = agent.getHistory();
  const branchId = `branch-${Date.now()}`;
  saveSnapshot(branchId, history);
  console.log(chalk.green(`\n✓ Branched session saved as: ${branchId}`));
  console.log(chalk.gray('  Use /resume to restore this session later.'));
  console.log(chalk.gray('  Current session continues unchanged.\n'));
  return done(rl);
}

export async function handleRename(input: string, ctx: SlashContext): Promise<true> {
  const { agent, rl, saveSnapshot } = ctx;
  const newName = input.replace('/rename', '').trim();
  if (!newName) {
    console.log(chalk.gray('\n  Usage: /rename <session-name>\n'));
    return done(rl);
  }
  const history = agent.getHistory();
  saveSnapshot(`named-${newName}`, history);
  console.log(chalk.green(`\n✓ Session renamed to: ${newName}`));
  console.log(chalk.gray('  Restore with: /resume (then pick from list)\n'));
  return done(rl);
}

export async function handleExport(input: string, ctx: SlashContext): Promise<true> {
  const { agent, rl, SESSION_ID } = ctx;
  const parts = input.split(/\s+/);
  const { mkdirSync: _mkdir, writeFileSync: _wfs } = await import('fs');
  const { join: _jn2 } = await import('path');
  const outDir = parts[1] ? parts[1] : process.cwd();
  const filename = `uagent-session-${SESSION_ID.slice(0, 8)}-${Date.now()}.md`;
  const outPath = _jn2(outDir, filename);
  const history = agent.getHistory();
  const { getContentText: _gct3 } = await import('../../../models/types.js');
  const lines: string[] = [`# Session Export — ${new Date().toLocaleString()}\n`];
  for (const msg of history) {
    const icon = msg.role === 'user' ? '👤 **User**' : msg.role === 'assistant' ? '🤖 **Assistant**' : `🔧 **${msg.role}**`;
    lines.push(`### ${icon}\n\n${_gct3(msg.content)}\n`);
  }
  try {
    _mkdir(outDir, { recursive: true });
    _wfs(outPath, lines.join('\n---\n\n'), 'utf-8');
    console.log(chalk.green(`\n✓ Session exported → ${outPath}\n`));
  } catch (err) {
    console.log(chalk.red(`\n✗ Export failed: ${err instanceof Error ? err.message : String(err)}\n`));
  }
  return done(rl);
}

export async function handleCopy(ctx: SlashContext): Promise<true> {
  const { agent, rl } = ctx;
  const history = agent.getHistory();
  const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant');
  if (!lastAssistant) {
    console.log(chalk.gray('\n  No AI reply to copy yet.\n'));
    return done(rl);
  }
  const { getContentText: _gct2 } = await import('../../../models/types.js');
  const text = _gct2(lastAssistant.content);
  try {
    const { execSync: _exec } = await import('child_process');
    const cmd = process.platform === 'darwin' ? 'pbcopy' : 'xclip -selection clipboard';
    _exec(cmd, { input: text });
    console.log(chalk.green(`\n✓ Copied ${text.length} chars to clipboard.\n`));
  } catch {
    console.log(chalk.yellow('\n⚠ Clipboard not available. Last reply:\n'));
    console.log(text.slice(0, 500) + (text.length > 500 ? '\n...(truncated)' : ''));
    console.log();
  }
  return done(rl);
}

export async function handleStatus(ctx: SlashContext): Promise<true> {
  const { agent, rl, options, SESSION_ID, sessionLogger } = ctx;
  const { readFileSync: _rfs } = await import('fs');
  const { dirname: _dn, join: _jn } = await import('path');
  const { fileURLToPath: _ftu } = await import('url');
  let version = '(unknown)';
  try {
    const pkgPath = _jn(_dn(_ftu(import.meta.url)), '../../../../package.json');
    version = JSON.parse(_rfs(pkgPath, 'utf-8')).version ?? version;
  } catch { /* */ }
  const currentModel = modelManager.getCurrentModel('main');
  const h = agent.getHistory();
  console.log(chalk.yellow('\n📋 Status:'));
  console.log(`  Version  : ${chalk.white('v' + version)}`);
  console.log(`  CWD      : ${chalk.cyan(process.cwd())}`);
  console.log(`  Model    : ${chalk.white(currentModel)}`);
  console.log(`  Domain   : ${chalk.white(options.domain)}`);
  console.log(`  Session  : ${chalk.white(SESSION_ID)}`);
  console.log(`  Messages : ${chalk.white(String(h.length))}`);
  console.log(`  Log      : ${chalk.cyan(sessionLogger.path)}`);
  console.log(chalk.gray('\n  /model — switch model  |  /log — session log path\n'));
  return done(rl);
}

export async function handleBug(input: string, ctx: SlashContext): Promise<true> {
  const { rl, sessionLogger, SESSION_ID } = ctx;
  const desc = input.replace('/bug', '').trim();
  console.log(chalk.yellow('\n🐛 Bug Report\n'));
  const logPath = sessionLogger.path;
  console.log(`  Session log  : ${chalk.cyan(logPath)}`);
  console.log(`  Working dir  : ${chalk.cyan(process.cwd())}`);
  console.log(`  Model        : ${chalk.white(modelManager.getCurrentModel('main'))}`);
  console.log(`  Session      : ${chalk.white(SESSION_ID)}`);
  if (desc) console.log(`  Description  : ${chalk.white(desc)}`);
  console.log();
  console.log(chalk.yellow('  Steps to report:'));
  console.log(chalk.gray('  1. Copy log to clipboard:'));
  console.log(chalk.gray(`     cat "${logPath}" | pbcopy`));
  console.log(chalk.gray('  2. Open issue tracker or KOncall'));
  console.log(chalk.gray('  3. Paste log and describe the problem'));
  console.log();
  console.log(chalk.dim('  Tip: /export — save full conversation to a file\n'));
  return done(rl);
}
