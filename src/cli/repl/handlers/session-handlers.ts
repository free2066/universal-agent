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
  // /resume [sessionId-or-keyword] [--fork]
  const forkFlag = parts.includes('--fork');
  const rawArg = parts.filter((p) => !p.startsWith('--') && p !== '/resume')[0];
  const sessionIdOrKeyword = rawArg;

  if (sessionIdOrKeyword) {
    const { loadSnapshot: _loadSnap, listAllSnapshots: _listAll, searchSnapshots: _search } = await import('../../../core/memory/session-snapshot.js');

    // Step 1: Try exact sessionId match
    let snap = _loadSnap(sessionIdOrKeyword);

    // Step 2: Try title match (exact then prefix)
    if (!snap) {
      const allSnaps = _listAll(50);
      const titleMatch = allSnaps.find(
        (s) => s.displayTitle?.toLowerCase() === sessionIdOrKeyword.toLowerCase()
      ) ?? allSnaps.find(
        (s) => s.displayTitle?.toLowerCase().startsWith(sessionIdOrKeyword.toLowerCase())
      );
      if (titleMatch) snap = _loadSnap(titleMatch.sessionId);
    }

    // Step 3: Content keyword search (claude-code parity — UUID → title → content)
    if (!snap) {
      const searchResults = _search(sessionIdOrKeyword, 10);
      if (searchResults.length === 1) {
        // Single result — restore directly
        snap = _loadSnap(searchResults[0]!.sessionId);
        if (snap) {
          process.stdout.write(
            chalk.gray(`  (Keyword match in session from ${formatAge(snap.savedAt)})\n`)
          );
        }
      } else if (searchResults.length > 1) {
        // Multiple matches — show list for user to pick from
        console.log(chalk.yellow(`\n🔍 Found ${searchResults.length} sessions matching "${sessionIdOrKeyword}":\n`));
        for (let i = 0; i < searchResults.length && i < 8; i++) {
          const r = searchResults[i]!;
          const age = formatAge(r.savedAt);
          console.log(
            `  ${chalk.cyan((i + 1).toString().padEnd(3))} ${chalk.white(r.sessionId.slice(0, 18).padEnd(20))} ` +
            `${chalk.gray(age.padEnd(12))} ${chalk.dim(r.snippet.slice(0, 60))}`
          );
        }
        console.log(chalk.gray('\n  Use: /resume <session-id> to restore a specific session\n'));
        return done(rl);
      }
    }

    if (snap && snap.messages.length >= 2) {
      // --fork: create a new session ID instead of resuming the original
      if (forkFlag) {
        const newId = `fork-${Date.now()}`;
        _save(newId, snap.messages);
        agent.setHistory(snap.messages as never);
        (agent as unknown as Record<string, unknown>).sessionId = newId;
        process.stdout.write(
          chalk.green(`  ✓ Forked session "${sessionIdOrKeyword}" → "${newId}" from ${formatAge(snap.savedAt)} (${snap.messages.length} messages)`) + '\n\n'
        );
      } else {
        agent.setHistory(snap.messages as never);
        process.stdout.write(
          chalk.green(`  ✓ Restored session "${sessionIdOrKeyword}" from ${formatAge(snap.savedAt)} (${snap.messages.length} messages)`) + '\n\n'
        );
      }
    } else {
      // Nothing found — show available sessions list
      const { listAllSnapshots: _list } = await import('../../../core/memory/session-snapshot.js');
      const sessions = _list(12);
      if (sessions.length) {
        console.log(chalk.yellow('\n💾 Available sessions:\n'));
        for (const s of sessions) {
          const titlePart = s.displayTitle ? chalk.white(s.displayTitle.slice(0, 25).padEnd(26)) : chalk.dim('(untitled)'.padEnd(26));
          console.log(
            `  ${chalk.cyan(s.sessionId.slice(0, 18).padEnd(20))} ${titlePart} ` +
            `${chalk.gray(formatAge(s.savedAt).padEnd(12))} ${chalk.dim(s.messageCount + ' msgs')}`
          );
        }
        console.log(chalk.gray('\n  Use: /resume <session-id> or /resume <keyword>\n'));
      } else {
        process.stdout.write(chalk.dim(`  Session "${sessionIdOrKeyword}" not found.\n\n`));
      }
    }
  } else {
    // No argument: restore last session or show picker
    const snap = loadLastSnapshot();
    if (snap && snap.messages.length >= 2) {
      agent.setHistory(snap.messages as never);
      process.stdout.write(chalk.green(`  ✓ Restored session from ${formatAge(snap.savedAt)} (${snap.messages.length} messages)`) + '\n\n');
    } else {
      // Show recent sessions list as fallback (claude-code interactive picker equivalent)
      const { listAllSnapshots: _list } = await import('../../../core/memory/session-snapshot.js');
      const sessions = _list(10);
      if (sessions.length) {
        console.log(chalk.yellow('\n💾 Recent sessions (use /resume <session-id> to restore):\n'));
        for (const s of sessions) {
          const titlePart = s.displayTitle ? chalk.white(s.displayTitle.slice(0, 30).padEnd(31)) : chalk.dim('(untitled)'.padEnd(31));
          console.log(
            `  ${chalk.cyan(s.sessionId.slice(0, 20).padEnd(22))} ${titlePart} ` +
            `${chalk.gray(formatAge(s.savedAt).padEnd(12))} ${chalk.dim(s.messageCount + ' msgs')}`
          );
        }
        console.log(chalk.gray('\n  Tip: /resume <keyword> searches session content\n'));
      } else {
        process.stdout.write(chalk.dim('  No saved sessions found.\n\n'));
      }
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
  const { agent, rl, saveSnapshot, SESSION_ID } = ctx;
  const nameArg = input.replace('/rename', '').trim();
  const history = agent.getHistory();

  // ── AI auto-generate title if no argument provided ────────────────────────
  // Inspired by claude-code's /rename + saveAiGeneratedTitle():
  //   - AI-generated titles use 'ai-title' semantics (lower priority)
  //   - User-provided names use 'custom-title' semantics (highest priority)
  // This prevents AI from ever overwriting a user's explicit rename.
  let finalName = nameArg;
  const isUserProvided = !!nameArg;

  if (!finalName) {
    if (history.length < 2) {
      console.log(chalk.gray('\n  No conversation history to generate a title from.\n  Usage: /rename <session-name>\n'));
      return done(rl);
    }
    const spinner = (await import('ora')).default({ text: 'Generating session title...', spinner: 'dots' }).start();
    try {
      const { generateSessionTitle } = await import('../../../core/memory/session-snapshot.js');
      const generated = await generateSessionTitle(history);
      if (generated) {
        finalName = generated;
        spinner.succeed(`Generated title: ${chalk.cyan(finalName)}`);
      } else {
        spinner.fail('Could not generate title — please provide a name manually');
        console.log(chalk.gray('  Usage: /rename <session-name>\n'));
        return done(rl);
      }
    } catch {
      spinner.fail('Title generation failed');
      console.log(chalk.gray('  Usage: /rename <session-name>\n'));
      return done(rl);
    }
  }

  // Save snapshot under new name
  saveSnapshot(`named-${finalName}`, history);

  // ── Type-separated title storage (claude-code parity) ─────────────────────
  // User-provided → setCustomTitle (highest priority, AI can never overwrite)
  // AI-generated  → setAiGeneratedTitle (lower priority, skipped if customTitle exists)
  const { setCustomTitle, setAiGeneratedTitle } = await import('../../../core/memory/session-snapshot.js');
  if (isUserProvided) {
    setCustomTitle(`session-${SESSION_ID}`, finalName);
  } else {
    setAiGeneratedTitle(`session-${SESSION_ID}`, finalName);
  }

  const sourceNote = isUserProvided ? '' : chalk.gray(' (AI-generated)');
  console.log(chalk.green(`\n✓ Session renamed to: ${finalName}`) + sourceNote);
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
