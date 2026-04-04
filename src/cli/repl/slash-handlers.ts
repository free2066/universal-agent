/**
 * REPL slash command handlers extracted from src/cli/index.ts.
 * Each handler receives a SlashContext and returns true when the command was
 * handled (caller should `return` without sending to LLM), or false to fall
 * through to the default LLM path.
 */

import chalk from 'chalk';
import ora from 'ora';
import { resolve } from 'path';
import { readFileSync, existsSync } from 'fs';
import type { Interface as ReadlineInterface } from 'readline';
import type { AgentCore } from '../../core/agent.js';
import { modelManager } from '../../models/model-manager.js';
import { subagentSystem } from '../../core/subagent-system.js';
import { initAgentsMd, loadRules } from '../../core/context/context-loader.js';
import { codeInspectorTool } from '../../core/tools/code/code-inspector.js';
import { selfHealTool } from '../../core/tools/code/self-heal.js';
import { getRecentHistory } from '../../core/memory/session-history.js';
import { printBanner, printHelp } from '../ui-enhanced.js';
import { updateStatusBar, clearStatusBar, buildStatusPrompt, printStatusBar } from '../statusbar.js';
import { HookRunner } from '../../core/hooks.js';
import type { SessionLogger } from '../session-logger.js';
import { listLogs } from '../session-logger.js';

export interface SlashContext {
  agent: AgentCore;
  rl: ReadlineInterface;
  hookRunner: HookRunner;
  sessionLogger: SessionLogger;
  options: { domain: string; verbose?: boolean };
  SESSION_ID: string;
  getModelDisplayName: (id: string) => string;
  makePrompt: (domain: string, model?: string) => string;
  loadLastSnapshot: () => { messages: unknown[]; savedAt: number } | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  saveSnapshot: (id: string, history: any[]) => void;
  formatAge: (ts: number) => string;
  inferProviderEnvKey: (msg: string) => string | undefined;
}

/**
 * Handle a slash command line. Returns true if handled, false if the input
 * should be forwarded to the LLM.
 */
export async function handleSlash(input: string, ctx: SlashContext): Promise<boolean> {
  const {
    agent, rl, hookRunner, sessionLogger, options,
    SESSION_ID, getModelDisplayName, makePrompt,
    loadLastSnapshot, saveSnapshot, formatAge, inferProviderEnvKey,
  } = ctx;

  // /log
  if (input === '/log') {
    console.log(chalk.yellow('\n📝 Current session log:'));
    console.log(`  ${chalk.cyan(sessionLogger.path)}`);
    console.log(chalk.gray('  To share with AI: cat "' + sessionLogger.path + '" | pbcopy\n'));
    rl.prompt(); printStatusBar(); return true;
  }

  // /logs
  if (input === '/logs' || input === '/logs list') {
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
    rl.prompt(); printStatusBar(); return true;
  }

  // /continue
  if (input === '/continue') {
    const h = agent.getHistory();
    if (h.length < 2) {
      console.log(chalk.gray('\n  Nothing to continue (no active session).\n'));
      rl.prompt(); printStatusBar(); return true;
    }
    setTimeout(() => rl.emit('line', '[SYSTEM] Continue from where you left off — complete any remaining tasks.'), 50);
    return true;
  }

  // /exit /quit
  if (input === '/exit' || input === '/quit') {
    clearStatusBar();
    process.stdout.write('\n' + chalk.dim('  Bye!') + '\n');
    await hookRunner.run({ event: 'on_session_end', cwd: process.cwd() }).catch(() => {});
    const h = agent.getHistory();
    if (h.length >= 2) saveSnapshot(SESSION_ID, h);
    process.exit(0);
  }

  // /image
  if (input.startsWith('/image ')) {
    const imagePath = input.replace('/image ', '').trim();
    const absPath = resolve(imagePath);
    if (!existsSync(absPath)) {
      console.log(chalk.red(`  ✗ Image file not found: ${absPath}`));
      rl.prompt(); printStatusBar(); return true;
    }
    try {
      const imageBuffer = readFileSync(absPath);
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
      (agent as AgentCore & { _pendingImage?: string })._pendingImage = dataUrl;
      rl.setPrompt(chalk.magenta(`[image] `) + chalk.green('❯ '));
    } catch (imgErr) {
      console.log(chalk.red(`  ✗ Failed to read image: ${imgErr instanceof Error ? imgErr.message : String(imgErr)}`));
    }
    rl.prompt(); printStatusBar(); return true;
  }

  // /hooks
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
    rl.prompt(); printStatusBar(); return true;
  }
  if (input === '/hooks init') {
    const result = HookRunner.init(process.cwd());
    console.log(chalk.green('  ' + result));
    hookRunner.reload();
    rl.prompt(); printStatusBar(); return true;
  }
  if (input === '/hooks reload') {
    hookRunner.reload();
    console.log(chalk.green(`  ✓ Reloaded ${hookRunner.listHooks().length} hook(s)`));
    rl.prompt(); printStatusBar(); return true;
  }

  // /insights
  if (input.startsWith('/insights')) {
    const parts = input.split(/\s+/);
    const days = parseInt(parts.find((p) => /^\d+$/.test(p)) ?? '30', 10);
    rl.pause();
    process.stdout.write('\n');
    const spinnerI = ora(`Analyzing last ${days} days of usage...`).start();
    try {
      const { runInsights } = await import('../insights.js');
      const report = await runInsights({ days, projectRoot: process.cwd() });
      spinnerI.stop();
      const lines = report.markdown.split('\n');
      const condensed = lines.slice(0, 60).join('\n');
      console.log('\n' + condensed);
      if (lines.length > 60) console.log(chalk.gray(`\n  ... (${lines.length - 60} more lines — full report saved to ~/.uagent/)`));
    } catch (eI) {
      spinnerI.fail('Insights failed: ' + (eI instanceof Error ? eI.message : String(eI)));
    }
    rl.resume();
    rl.prompt(); printStatusBar(); return true;
  }

  // /help
  if (input === '/help' || input === '/help ') {
    printHelp();
    rl.prompt(); printStatusBar(); return true;
  }

  // /cost
  if (input === '/cost') {
    const { usageTracker } = await import('../../models/usage-tracker.js');
    console.log('\n' + modelManager.getCostSummary());
    const todayUsage = usageTracker.loadTodayUsage();
    console.log(`\n📅 Today (persisted across sessions):`);
    console.log(`   Input:    ${todayUsage.totalInputTokens.toLocaleString()} tokens`);
    console.log(`   Output:   ${todayUsage.totalOutputTokens.toLocaleString()} tokens`);
    console.log(`   Cost:     $${todayUsage.totalCostUSD.toFixed(4)} USD`);
    console.log(`   Sessions: ${todayUsage.sessions}`);
    const check = usageTracker.checkLimits();
    if (check.status !== 'ok' && check.message) {
      console.log('\n' + check.message);
    }
    console.log(chalk.gray('\n  Tip: uagent usage --days 7  — full history'));
    console.log(chalk.gray('       uagent limits            — view/set limits\n'));
    rl.prompt(); printStatusBar(); return true;
  }

  // /resume
  if (input === '/resume') {
    const snap = loadLastSnapshot();
    if (snap && snap.messages.length >= 2) {
      agent.setHistory(snap.messages as never);
      process.stdout.write(chalk.green(`  ✓ Restored session from ${formatAge(snap.savedAt)} (${snap.messages.length} messages)`) + '\n\n');
    } else {
      process.stdout.write(chalk.dim('  No saved session found.') + '\n\n');
    }
    rl.prompt(); printStatusBar(); return true;
  }

  // /model
  if (input.startsWith('/model')) {
    const parts = input.split(/\s+/);
    if (parts.length === 1) {
      rl.pause();
      const { showModelPicker, friendlyName } = await import('../model-picker.js');
      const profiles = modelManager.listProfiles();
      const currentModel = modelManager.getCurrentModel('main');
      const wqNameMap: Record<string, string> = {};
      (process.env.WQ_MODELS || '').split(',').forEach(entry => {
        const [id, ...nameParts] = entry.trim().split(':');
        if (nameParts.length > 0 && id && !id.startsWith('ep-xxxxxx')) {
          wqNameMap[id.trim()] = nameParts.join(':').trim();
        }
      });
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
        label: wqNameMap[p.name] ?? friendlyName(p.name),
        provider: providerLabel(p.name),
        detail: p.modelName ?? p.name,
      }));
      const selected = await showModelPicker(items, currentModel, [currentModel]);
      if (selected) {
        agent.setModel(selected);
        modelManager.setPointer('main', selected);
        const newProfile = modelManager.listProfiles().find(p => p.name === selected);
        const newCtxLen = newProfile?.contextLength ?? 128000;
        updateStatusBar({ model: getModelDisplayName(selected), contextLength: newCtxLen });
        rl.setPrompt(makePrompt(options.domain, getModelDisplayName(selected)));
        process.stdout.write(chalk.green(`  ✓ Model → ${getModelDisplayName(selected)} (${selected})`) + '\n\n');
      }
      rl.resume();
    } else {
      const m = parts[1]!;
      agent.setModel(m);
      modelManager.setPointer('main', m);
      const newProfile2 = modelManager.listProfiles().find(p => p.name === m);
      updateStatusBar({ model: getModelDisplayName(m), contextLength: newProfile2?.contextLength ?? 128000 });
      rl.setPrompt(makePrompt(options.domain, getModelDisplayName(m)));
      process.stdout.write(chalk.green(`  ✓ Model → ${getModelDisplayName(m)}`) + '\n\n');
    }
    rl.prompt(); printStatusBar(); return true;
  }

  // /domain
  if (input.startsWith('/domain ')) {
    const domain = input.replace('/domain ', '').trim();
    agent.setDomain(domain);
    options.domain = domain;
    rl.setPrompt(makePrompt(domain));
    process.stdout.write(chalk.green(`  ✓ Domain → ${domain}`) + '\n\n');
    rl.prompt(); printStatusBar(); return true;
  }

  // /agents
  if (input.startsWith('/agents')) {
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
      console.log(chalk.yellow('\n👤 Subagents:'));
      for (const a of subagentSystem.listAgents()) {
        console.log(chalk.cyan(`  @run-agent-${a.name.padEnd(18)}`), chalk.gray(a.description));
      }
      console.log(chalk.gray('  Tip: /agents clean [days] — show stale subagents\n'));
    }
    rl.prompt(); printStatusBar(); return true;
  }

  // /models
  if (input.startsWith('/models')) {
    const modelParts = input.split(/\s+/);
    const modelSubCmd = modelParts[1];
    if (modelSubCmd === 'switch' && modelParts[2]) {
      const newModel = modelParts[2];
      const exists = modelManager.listProfiles().some((p) => p.name === newModel || p.modelName === newModel);
      if (!exists) {
        console.log(chalk.yellow(`⚠  Model "${newModel}" not in profile list — adding as custom and switching.`));
      }
      modelManager.setPointer('main', newModel);
      agent.setModel(newModel);
      rl.setPrompt(chalk.cyan(`[${options.domain}|${newModel}] `) + chalk.green('❯ '));
      console.log(chalk.green(`✓ Switched main model → ${newModel}`));
    } else {
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
    rl.prompt(); printStatusBar(); return true;
  }

  // /clear
  if (input === '/clear') {
    agent.clearHistory();
    console.clear();
    printBanner();
    rl.prompt(); printStatusBar();
    return true;
  }

  // /compact | /tokens
  if (input === '/compact' || input === '/tokens') {
    const { estimateHistoryTokens, shouldCompact } = await import('../../core/context/context-compressor.js');
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
      rl.prompt(); printStatusBar(); return true;
    }
    if (history.length <= 2) {
      console.log(chalk.gray('\n  History too short to compact (≤2 turns).\n'));
      rl.prompt(); printStatusBar(); return true;
    }
    rl.pause();
    process.stdout.write('\n');
    const spinnerC = ora(`Compacting ${history.length} turns (${pct}% context)...`).start();
    try {
      const fullHistory = agent.getHistory();
      if (fullHistory.length > 2) {
        const origEnv = process.env.AGENT_COMPACT_THRESHOLD;
        process.env.AGENT_COMPACT_THRESHOLD = '0.0001';
        let compacted = 0;
        try {
          const { getMemoryStore } = await import('../../core/memory/memory-store.js');
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
    rl.prompt(); printStatusBar(); return true;
  }

  // /history
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
    rl.prompt(); printStatusBar(); return true;
  }

  // /init
  if (input === '/init') {
    console.log(chalk.green(initAgentsMd(process.cwd())));
    rl.prompt(); printStatusBar(); return true;
  }

  // /memory
  if (input.startsWith('/memory')) {
    const parts = input.split(/\s+/);
    const sub = parts[1];
    const { getMemoryStore } = await import('../../core/memory/memory-store.js');
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
    rl.prompt(); printStatusBar(); return true;
  }

  // /spec
  if (input.startsWith('/spec')) {
    const desc = input.replace('/spec', '').trim();
    if (!desc) {
      const { listSpecs } = await import('../../core/tools/code/spec-generator.js');
      const specs = listSpecs(process.cwd());
      if (!specs.length) {
        console.log(chalk.gray('\n  No specs yet. Usage: /spec <requirement description>\n'));
      } else {
        console.log(chalk.yellow('\n📄 Specs:\n'));
        specs.forEach((s, i) => console.log(`  ${chalk.gray(String(i + 1) + '.')} ${chalk.cyan(s.date)}  ${s.name}`));
        console.log();
      }
      rl.prompt(); printStatusBar(); return true;
    }
    rl.pause();
    process.stdout.write('\n');
    const spinnerS = ora('Generating technical spec...').start();
    try {
      const { generateSpec } = await import('../../core/tools/code/spec-generator.js');
      const result = await generateSpec(desc, process.cwd());
      spinnerS.succeed(`Spec saved → ${result.path}`);
      console.log('\n' + result.content);
      if (result.phases.length > 0) {
        console.log(chalk.yellow('\n📋 Execution Plan (Phases):'));
        for (const p of result.phases) {
          const deps = p.dependsOn.length > 0 ? chalk.gray(` (depends: Phase ${p.dependsOn.join(', ')})`) : '';
          const mode = p.parallel ? chalk.cyan('[parallel]') : chalk.gray('[sequential]');
          console.log(`  ${chalk.bold(`Phase ${p.phase}`)} ${mode} ${chalk.white(p.label)}${deps}`);
          p.tasks.forEach((t: string, i: number) => console.log(`    ${chalk.gray(String(i + 1) + '.')} ${t}`));
        }
        console.log();
      } else if (result.tasks.length > 0) {
        console.log(chalk.yellow('\n📋 Tasks extracted:'));
        result.tasks.forEach((t: string, i: number) => console.log(`  ${chalk.gray(String(i + 1) + '.')} ${t}`));
        console.log();
      }
    } catch (eS) {
      spinnerS.fail('Spec failed: ' + (eS instanceof Error ? eS.message : String(eS)));
    }
    rl.resume();
    rl.prompt(); printStatusBar(); return true;
  }

  // /review
  if (input.startsWith('/review')) {
    rl.pause();
    process.stdout.write('\n');
    const spinnerR = ora('Running AI Code Review...').start();
    try {
      const { reviewCode } = await import('../../core/tools/code/ai-reviewer.js');
      const report = await reviewCode({ projectRoot: process.cwd() });
      spinnerR.stop();
      console.log('\n' + report.markdown);
      console.log(chalk.gray(`  P1=${report.summary.P1}  P2=${report.summary.P2}  P3=${report.summary.P3}\n`));
    } catch (eR) {
      spinnerR.fail('Review failed: ' + (eR instanceof Error ? eR.message : String(eR)));
    }
    rl.resume();
    rl.prompt(); printStatusBar(); return true;
  }

  // /rules
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
    rl.prompt(); printStatusBar(); return true;
  }

  // /mcp
  if (input === '/mcp') {
    const { servers, tools } = agent.getMcpInfo();
    if (servers.length === 0) {
      console.log(chalk.gray('\n  No MCP servers configured.'));
      console.log(chalk.gray('  Run: uagent mcp add -- npx -y <server-package>'));
      console.log(chalk.gray('  Or:  uagent mcp init --templates  (to see example configs)\n'));
    } else {
      console.log(chalk.yellow('\n🔌 MCP Servers:\n'));
      for (const s of servers) {
        const status = s.enabled ? chalk.green('✓ enabled ') : chalk.gray('○ disabled');
        const typeLabel = chalk.gray(`[${s.type ?? 'stdio'}]`);
        const detail = s.type === 'stdio'
          ? chalk.gray(`${s.command ?? ''} ${(s.args ?? []).join(' ')}`.trim())
          : chalk.gray(s.url ?? '');
        console.log(`  ${status} ${chalk.white(s.name.padEnd(20))} ${typeLabel}  ${detail}`);
      }
      if (tools.length > 0) {
        console.log(chalk.yellow('\n🛠  Active MCP tools (this session):\n'));
        for (const t of tools) {
          console.log(chalk.cyan('  ') + chalk.white(t));
        }
      } else {
        console.log(chalk.gray('\n  (No MCP tools connected this session — servers connect at startup)'));
      }
      console.log(chalk.gray('\n  uagent mcp list      — show all configured servers'));
      console.log(chalk.gray('  uagent mcp add       — add a server'));
      console.log(chalk.gray('  uagent mcp disable   — disable without removing\n'));
    }
    rl.prompt(); printStatusBar(); return true;
  }

  // /inspect
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
    rl.prompt(); printStatusBar(); return true;
  }

  // /team
  if (input === '/team') {
    const { getTeammateManager } = await import('../../core/teammate-manager.js');
    console.log('\n' + getTeammateManager(process.cwd()).listAll() + '\n');
    rl.prompt(); printStatusBar(); return true;
  }

  // /inbox
  if (input === '/inbox') {
    const { getTeammateManager } = await import('../../core/teammate-manager.js');
    const msgs = getTeammateManager(process.cwd()).bus.readInbox('lead');
    console.log(msgs.length > 0
      ? '\n' + JSON.stringify(msgs, null, 2) + '\n'
      : chalk.gray('\n  (inbox empty)\n'));
    rl.prompt(); printStatusBar(); return true;
  }

  // /tasks
  if (input === '/tasks') {
    const { getTaskBoard } = await import('../../core/task-board.js');
    console.log('\n' + getTaskBoard(process.cwd()).listAll() + '\n');
    rl.prompt(); printStatusBar(); return true;
  }

  // /purify
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
    rl.prompt(); printStatusBar(); return true;
  }

  // Not a recognised slash command — check hook-defined custom slash commands
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
      rl.prompt(); printStatusBar(); return true;
    }
  }

  return false; // not handled — send to LLM
}
