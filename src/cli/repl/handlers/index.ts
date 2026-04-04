/**
 * handlers/index.ts — slash 命令路由入口
 *
 * 将 1,192 行的 slash-handlers.ts 拆分为：
 *   - shared.ts          SlashContext 类型、工具函数
 *   - session-handlers.ts  /log /logs /resume /clear /exit /branch /rename /export /copy /status /bug
 *   - agent-handlers.ts    /model /models /domain /agents /context /compact /tokens
 *   - memory-handlers.ts   /memory /history /init /rules /review /spec /spec:*
 *   - tool-handlers.ts     /mcp /inspect /team /inbox /tasks /purify /skills /plugin /logout
 *                           /hooks /insights /image /add-dir /terminal-setup /output-style /cost
 *
 * 此文件保持与原 slash-handlers.ts 完全相同的对外接口（handleSlash + SlashContext），
 * 使 repl.ts 无需修改 import 路径。
 */

export type { SlashContext } from './shared.js';

import type { SlashContext } from './shared.js';
import { HookRunner } from '../../../core/hooks.js';
import { printStatusBar } from '../../statusbar.js';

// Session handlers
import {
  handleLog, handleLogs, handleContinue, handleExit, handleClear,
  handleResume, handleBranch, handleRename, handleExport, handleCopy,
  handleStatus, handleBug,
} from './session-handlers.js';

// Agent handlers
import {
  handleModel, handleModels, handleDomain, handleAgents,
  handleContext, handleCompactOrTokens,
} from './agent-handlers.js';

// Memory handlers
import {
  handleMemory, handleHistory, handleInit, handleRules, handleReview,
  handleSpec, handleSpecBrainstorm, handleSpecWritePlan, handleSpecExecutePlan,
} from './memory-handlers.js';

// Tool handlers
import {
  handleMcp, handleInspect, handleTeam, handleInbox, handleTasks, handlePurify,
  handleSkills, handlePlugin, handleLogout, handleHooks, handleInsights,
  handleImage, handleAddDir, handleTerminalSetup, handleOutputStyle, handleCost,
} from './tool-handlers.js';

/**
 * Handle a slash command line. Returns true if handled, false if the input
 * should be forwarded to the LLM.
 */
export async function handleSlash(input: string, ctx: SlashContext): Promise<boolean> {
  const { rl, agent, hookRunner } = ctx;

  // ── Session commands ──────────────────────────────────────────────────────
  if (input === '/log') return handleLog(ctx);
  if (input === '/logs' || input === '/logs list') return handleLogs(ctx);
  if (input === '/continue') return handleContinue(ctx);
  if (input === '/exit' || input === '/quit') return handleExit(ctx);
  if (input === '/clear') return handleClear(ctx);
  if (input === '/resume' || input.startsWith('/resume ')) return handleResume(input, ctx);
  if (input === '/branch') return handleBranch(ctx);
  if (input.startsWith('/rename')) return handleRename(input, ctx);
  if (input.startsWith('/export')) return handleExport(input, ctx);
  if (input === '/copy') return handleCopy(ctx);
  if (input === '/status') return handleStatus(ctx);
  if (input.startsWith('/bug')) return handleBug(input, ctx);

  // ── Agent config commands ─────────────────────────────────────────────────
  if (input.startsWith('/model')) return handleModel(input, ctx);
  if (input.startsWith('/models')) return handleModels(input, ctx);
  if (input.startsWith('/domain ')) return handleDomain(input, ctx);
  if (input.startsWith('/agents')) return handleAgents(input, ctx);
  if (input === '/context') return handleContext(ctx);
  if (input === '/compact' || input === '/tokens') return handleCompactOrTokens(input, ctx);

  // ── Memory / knowledge commands ────────────────────────────────────────────
  if (input.startsWith('/memory')) return handleMemory(input, ctx);
  if (input.startsWith('/history')) return handleHistory(input, ctx);
  if (input === '/init') return handleInit(ctx);
  if (input === '/rules') return handleRules(ctx);
  if (input.startsWith('/review')) return handleReview(ctx);
  if (input.startsWith('/spec:brainstorm')) return handleSpecBrainstorm(input, ctx);
  if (input.startsWith('/spec:write-plan')) return handleSpecWritePlan(input, ctx);
  if (input.startsWith('/spec:execute-plan')) return handleSpecExecutePlan(ctx);
  if (input.startsWith('/spec')) return handleSpec(input, ctx);

  // ── Tool / infra commands ─────────────────────────────────────────────────
  if (input === '/mcp') return handleMcp(ctx);
  if (input.startsWith('/inspect')) return handleInspect(input, ctx);
  if (input === '/team') return handleTeam(ctx);
  if (input === '/inbox') return handleInbox(ctx);
  if (input === '/tasks') return handleTasks(ctx);
  if (input.startsWith('/purify')) return handlePurify(input, ctx);
  if (input === '/skills') return handleSkills(ctx);
  if (input.startsWith('/plugin')) return handlePlugin(input, ctx);
  if (input === '/logout') return handleLogout(ctx);
  if (input.startsWith('/hooks')) return handleHooks(input, ctx);
  if (input.startsWith('/insights')) return handleInsights(input, ctx);
  if (input.startsWith('/image ')) return handleImage(input, ctx);
  if (input.startsWith('/add-dir ')) return handleAddDir(input, ctx);
  if (input === '/terminal-setup') return handleTerminalSetup(ctx);
  if (input.startsWith('/output-style')) return handleOutputStyle(input, ctx);
  if (input === '/cost') return handleCost(ctx);

  // ── /help ─────────────────────────────────────────────────────────────────
  if (input === '/help' || input === '/help ') {
    const { printHelp } = await import('../../ui-enhanced.js');
    printHelp();
    rl.prompt(); printStatusBar();
    return true;
  }

  // ── CF-compatible custom skill commands (.uagent/commands/*.md) ───────────
  if (input.startsWith('/')) {
    const cmdName = input.split(/\s+/)[0]!.slice(1);
    const cmdArgs = input.split(/\s+/).slice(1).join(' ');
    const { existsSync: _es2, readFileSync: _rfs2 } = await import('fs');
    const { join: _jn4 } = await import('path');
    const searchDirs = [
      _jn4(process.cwd(), '.uagent', 'commands'),
      _jn4(process.env.HOME ?? '~', '.uagent', 'commands'),
    ];
    for (const dir of searchDirs) {
      const mdPath = _jn4(dir, `${cmdName}.md`);
      if (_es2(mdPath)) {
        let template = _rfs2(mdPath, 'utf-8');
        if (template.startsWith('---\n')) {
          const endFm = template.indexOf('\n---\n', 4);
          if (endFm !== -1) template = template.slice(endFm + 5);
        }
        const argParts = cmdArgs.split(/\s+/);
        let body = template.replace(/\$ARGUMENTS/g, cmdArgs);
        argParts.forEach((arg, idx) => {
          body = body.replace(new RegExp(`\\$${idx + 1}`, 'g'), arg);
        });
        body = body.trim();
        if (body) {
          rl.pause();
          process.stdout.write('\n');
          try {
            await agent.runStream(body, (chunk) => process.stdout.write(chunk));
            process.stdout.write('\n\n');
          } catch (err) {
            console.error(chalk.red('\n✗ ') + (err instanceof Error ? err.message : String(err)));
          }
          rl.resume();
        }
        rl.prompt(); printStatusBar();
        return true;
      }
    }
  }

  // ── Hook-defined custom slash commands ────────────────────────────────────
  if (input.startsWith('/') && !input.startsWith('/exit') && !input.startsWith('/help') && !input.startsWith('/cost')) {
    const hookResult = await hookRunner.handleSlashCmd(input).catch(() => ({ handled: false, output: '' }));
    if (hookResult.handled) {
      if (hookResult.output) {
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
      rl.prompt(); printStatusBar();
      return true;
    }
  }

  return false; // not handled — send to LLM
}

// --- chalk needed for fallback handlers ---
import chalk from 'chalk';
