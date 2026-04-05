/**
 * handlers/tool-handlers.ts
 * 工具相关命令：/mcp /inspect /team /inbox /tasks /purify /skills /plugin /logout
 *              /hooks /insights /image /add-dir /terminal-setup /output-style
 *              /context /cost /log /logs
 */
import chalk from 'chalk';
import type { SlashContext } from './shared.js';
import { done } from './shared.js';
import { codeInspectorTool } from '../../../core/tools/code/code-inspector.js';
import { selfHealTool } from '../../../core/tools/code/self-heal.js';
import { modelManager } from '../../../models/model-manager.js';
import { HookRunner } from '../../../core/hooks.js';

export async function handleMcp(ctx: SlashContext): Promise<true> {
  const { agent, rl } = ctx;
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
  return done(rl);
}

export async function handleInspect(input: string, ctx: SlashContext): Promise<true> {
  const { rl } = ctx;
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
  return done(rl);
}

export async function handleTeam(ctx: SlashContext): Promise<true> {
  const { rl } = ctx;
  const { getTeammateManager } = await import('../../../core/teammate-manager.js');
  console.log('\n' + getTeammateManager(process.cwd()).listAll() + '\n');
  return done(rl);
}

export async function handleInbox(ctx: SlashContext): Promise<true> {
  const { rl } = ctx;
  const { getTeammateManager } = await import('../../../core/teammate-manager.js');
  const msgs = getTeammateManager(process.cwd()).bus.readInbox('lead');
  console.log(msgs.length > 0
    ? '\n' + JSON.stringify(msgs, null, 2) + '\n'
    : chalk.gray('\n  (inbox empty)\n'));
  return done(rl);
}

export async function handleTasks(ctx: SlashContext): Promise<true> {
  const { rl } = ctx;
  const { getTaskBoard } = await import('../../../core/task-board.js');
  console.log('\n' + getTaskBoard(process.cwd()).listAll() + '\n');
  return done(rl);
}

export async function handlePurify(input: string, ctx: SlashContext): Promise<true> {
  const { rl } = ctx;
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
  return done(rl);
}

export async function handleSkills(ctx: SlashContext): Promise<true> {
  const { rl } = ctx;
  const { readdirSync: _rds, statSync: _ss, existsSync: _es, readFileSync: _rfs } = await import('fs');
  const { join: _jn } = await import('path');
  const searchDirs = [
    { label: 'project (.uagent/commands/)', dir: _jn(process.cwd(), '.uagent', 'commands') },
    { label: 'global (~/.uagent/commands/)', dir: _jn(process.env.HOME ?? '~', '.uagent', 'commands') },
  ];
  let totalCount = 0;
  console.log(chalk.yellow('\n🎯 Installed Skills (custom slash commands):\n'));
  for (const { label, dir } of searchDirs) {
    if (!_es(dir)) continue;
    let files: string[] = [];
    try { files = _rds(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
    if (files.length === 0) continue;
    console.log(chalk.cyan(`  📂 ${label}`));
    for (const f of files) {
      const cmdName = '/' + f.replace(/\.md$/, '');
      let description = '';
      try {
        const raw = _rfs(_jn(dir, f), 'utf-8');
        if (raw.startsWith('---\n')) {
          const match = raw.match(/^description:\s*(.+)$/m);
          if (match) description = match[1]!.trim();
        }
        if (!description) {
          const lines = raw.replace(/^---[\s\S]*?---\n/, '').split('\n').filter((l) => l.trim());
          if (lines[0]) description = lines[0].slice(0, 80) + (lines[0].length > 80 ? '...' : '');
        }
      } catch { /* */ }
      const mtime = _ss(_jn(dir, f)).mtimeMs;
      const ago = Math.floor((Date.now() - mtime) / (1000 * 60 * 60 * 24));
      console.log(`    ${chalk.white(cmdName.padEnd(24))} ${chalk.gray(ago === 0 ? 'today' : `${ago}d ago`)}  ${chalk.dim(description)}`);
      totalCount++;
    }
  }
  if (totalCount === 0) {
    console.log(chalk.gray('  No custom skills found.\n'));
    console.log(chalk.gray('  To create a skill: create .uagent/commands/<name>.md'));
    console.log(chalk.gray('  Example: .uagent/commands/summarize.md'));
    console.log(chalk.gray('  Content: "Summarize the following: $ARGUMENTS"\n'));
  } else {
    console.log(chalk.gray(`\n  Total: ${totalCount} skill(s) installed`));
    console.log(chalk.gray('  Use: /<skill-name> [arguments]'));
    console.log(chalk.gray('  Tip: create .uagent/commands/<name>.md to add a skill\n'));
  }
  return done(rl);
}

export async function handlePlugin(input: string, ctx: SlashContext): Promise<true> {
  const { rl } = ctx;
  const sub = input.replace('/plugin', '').trim();
  const { readdirSync: _rds2, existsSync: _es2, statSync: _ss2 } = await import('fs');
  const { join: _jn2 } = await import('path');
  const baseDir = _jn2(process.cwd(), '.uagent');
  const globalDir = _jn2(process.env.HOME ?? '~', '.uagent');
  const scanDir = (dir: string, sub2: string) => {
    const full = _jn2(dir, sub2);
    if (!_es2(full)) return [];
    try { return _rds2(full).map((f) => ({ name: f, mtime: _ss2(_jn2(full, f)).mtimeMs })); } catch { return []; }
  };
  if (!sub || sub === 'list') {
    console.log(chalk.yellow('\n🔌 Local Extensions (Plugins):\n'));
    const sections: Array<{ label: string; type: string }> = [
      { label: 'Custom Commands (skills)', type: 'commands' },
      { label: 'Subagents', type: 'agents' },
      { label: 'Hooks', type: 'hooks' },
    ];
    let found = false;
    for (const { label, type } of sections) {
      const items = [
        ...scanDir(baseDir, type).map((f) => ({ ...f, scope: 'project' })),
        ...scanDir(globalDir, type).map((f) => ({ ...f, scope: 'global' })),
      ];
      if (items.length === 0) continue;
      found = true;
      console.log(chalk.cyan(`  ${label}:`));
      for (const item of items.slice(0, 10)) {
        const ago = Math.floor((Date.now() - item.mtime) / (1000 * 60 * 60 * 24));
        console.log(`    ${chalk.white(item.name.padEnd(30))} ${chalk.dim(item.scope)} ${chalk.gray(ago === 0 ? '(today)' : `(${ago}d ago)`)}`);
      }
      if (items.length > 10) console.log(chalk.gray(`    ... and ${items.length - 10} more`));
      console.log();
    }
    if (!found) {
      console.log(chalk.gray('  No local extensions installed.\n'));
    }
    console.log(chalk.gray('  Plugin types:'));
    console.log(chalk.gray('    .uagent/commands/*.md — custom slash commands (skills)'));
    console.log(chalk.gray('    .uagent/agents/*.md   — custom subagents'));
    console.log(chalk.gray('    .uagent/hooks/*.json  — lifecycle hooks'));
    console.log(chalk.gray('\n  /plugin list         — show all extensions'));
    console.log(chalk.gray('  /skills              — show only custom commands\n'));
  } else {
    console.log(chalk.gray(`\n  Unknown plugin subcommand: ${sub}`));
    console.log(chalk.gray('  Usage: /plugin [list]\n'));
  }
  return done(rl);
}

export async function handleLogout(ctx: SlashContext): Promise<true> {
  const { rl } = ctx;
  console.log(chalk.yellow('\n🔑 API Key Configuration\n'));
  const keyEnvVars = [
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY',
    'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'WQ_API_KEY',
  ];
  let found = false;
  for (const envVar of keyEnvVars) {
    const val = process.env[envVar];
    if (val) {
      found = true;
      const masked = val.length > 8
        ? val.slice(0, 4) + '*'.repeat(val.length - 8) + val.slice(-4)
        : '****';
      console.log(`  ${chalk.cyan(envVar.padEnd(24))} ${chalk.green('●')} set  ${chalk.dim(masked)}`);
    } else {
      console.log(`  ${chalk.gray(envVar.padEnd(24))} ${chalk.red('○')} not set`);
    }
  }
  console.log();
  if (found) {
    console.log(chalk.yellow('  To remove a key (logout):'));
    console.log(chalk.gray('    unset OPENAI_API_KEY            # current shell only'));
    console.log(chalk.gray('    # or remove from ~/.zshrc / ~/.bashrc / .env file'));
    console.log(chalk.gray('\n  To switch models/providers:'));
    console.log(chalk.gray('    /model                           # interactive picker'));
    console.log(chalk.gray('    uagent models add                # add new model profile'));
  } else {
    console.log(chalk.red('  No API keys found. uagent requires at least one API key.'));
    console.log(chalk.gray('  Set one: export OPENAI_API_KEY=sk-...'));
  }
  console.log(chalk.dim('\n  Note: uagent uses API keys (not login sessions).'));
  console.log(chalk.dim('        Keys are read from environment variables or .env file.\n'));
  return done(rl);
}

export async function handleHooks(input: string, ctx: SlashContext): Promise<true> {
  const { rl, hookRunner } = ctx;
  if (input === '/hooks init') {
    const result = HookRunner.init(process.cwd());
    console.log(chalk.green('  ' + result));
    hookRunner.reload();
    return done(rl);
  }
  if (input === '/hooks reload') {
    hookRunner.reload();
    console.log(chalk.green(`  ✓ Reloaded ${hookRunner.listHooks().length} hook(s)`));
    return done(rl);
  }
  // /hooks or /hooks list
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
  return done(rl);
}

export async function handleInsights(input: string, ctx: SlashContext): Promise<true> {
  const { rl } = ctx;
  const parts = input.split(/\s+/);
  const days = parseInt(parts.find((p) => /^\d+$/.test(p)) ?? '30', 10);
  rl.pause();
  process.stdout.write('\n');
  const { default: ora } = await import('ora');
  const spinnerI = ora(`Analyzing last ${days} days of usage...`).start();
  try {
    const { runInsights } = await import('../../insights.js');
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
  return done(rl);
}

export async function handleImage(input: string, ctx: SlashContext): Promise<true> {
  const { agent, rl } = ctx;
  const { resolve } = await import('path');
  const { readFileSync, existsSync } = await import('fs');
  const imagePath = input.replace('/image ', '').trim();
  const absPath = resolve(imagePath);
  if (!existsSync(absPath)) {
    console.log(chalk.red(`  ✗ Image file not found: ${absPath}`));
    return done(rl);
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
    (agent as import('../../../core/agent.js').AgentCore & { _pendingImage?: string })._pendingImage = dataUrl;
    rl.setPrompt(chalk.magenta(`[image] `) + chalk.green('❯ '));
  } catch (imgErr) {
    console.log(chalk.red(`  ✗ Failed to read image: ${imgErr instanceof Error ? imgErr.message : String(imgErr)}`));
  }
  return done(rl);
}

export async function handleAddDir(input: string, ctx: SlashContext): Promise<true> {
  const { agent, rl } = ctx;
  const dirPath = input.replace('/add-dir ', '').trim();
  const { readdirSync: _rds, statSync: _ss, existsSync: _es } = await import('fs');
  const { join: _jn3, relative: _rel } = await import('path');
  if (!dirPath || !_es(dirPath)) {
    console.log(chalk.red(`\n✗ Directory not found: ${dirPath}\n`));
    return done(rl);
  }
  const files: string[] = [];
  const scanDir = (d: string, depth = 0): void => {
    if (depth > 2 || files.length > 100) return;
    try {
      for (const f of _rds(d)) {
        if (['node_modules', '.git', 'dist'].includes(f)) continue;
        const full = _jn3(d, f);
        try {
          if (_ss(full).isDirectory()) scanDir(full, depth + 1);
          else files.push(_rel(process.cwd(), full));
        } catch { /* */ }
      }
    } catch { /* */ }
  };
  scanDir(dirPath);
  agent.injectContext(`[Added directory to context: ${dirPath}]\nFiles in this directory:\n${files.slice(0, 80).join('\n')}`);
  console.log(chalk.green(`\n✓ Added ${dirPath} to context (${files.length} files indexed)\n`));
  return done(rl);
}

export async function handleTerminalSetup(ctx: SlashContext): Promise<true> {
  const { rl } = ctx;
  console.log(chalk.yellow('\n⌨  Terminal Setup — Shift+Enter line break\n'));
  console.log('This command configures Shift+Enter as a newline shortcut in your terminal.\n');
  console.log(chalk.white('Option 1: iTerm2'));
  console.log(chalk.gray('  Open Preferences → Profiles → Keys → Key Mappings'));
  console.log(chalk.gray('  Add: Shift+Enter → Send Hex Code → 0x0a\n'));
  console.log(chalk.white('Option 2: VS Code integrated terminal'));
  console.log(chalk.gray('  Add to keybindings.json:'));
  console.log(chalk.cyan('  { "key": "shift+enter", "command": "workbench.action.terminal.sendSequence",'));
  console.log(chalk.cyan('    "args": { "text": "\\n" },'));
  console.log(chalk.cyan('    "when": "terminalFocus" }\n'));
  console.log(chalk.white('Option 3: ~/.inputrc (universal readline)'));
  console.log(chalk.gray('  Add: "\\e[13;2u": "\\n"'));
  console.log(chalk.gray('  Then run: bind -f ~/.inputrc\n'));
  console.log(chalk.dim('Already supported in uagent: \\ + Enter (universal), Option+Enter (macOS)\n'));
  return done(rl);
}

export async function handleOutputStyle(input: string, ctx: SlashContext): Promise<true> {
  const { agent, rl } = ctx;
  const style = input.replace('/output-style', '').trim();
  const validStyles = ['plain', 'markdown', 'compact'];
  if (!style) {
    console.log(chalk.yellow('\n🎨 Output Styles:\n'));
    validStyles.forEach((s) => console.log(`  • ${chalk.white(s)}`));
    console.log(chalk.gray('\n  Usage: /output-style <style>\n'));
    console.log(chalk.gray('  Currently: markdown (default — all output rendered as markdown)\n'));
    return done(rl);
  }
  if (!validStyles.includes(style)) {
    console.log(chalk.red(`\n✗ Unknown style "${style}". Choose: ${validStyles.join(', ')}\n`));
    return done(rl);
  }
  agent.injectContext(`[Output style changed to: ${style}]\nFrom now on, format all responses as ${style}.`);
  console.log(chalk.green(`\n✓ Output style → ${style}\n`));
  return done(rl);
}

export async function handleCost(ctx: SlashContext): Promise<true> {  const { rl } = ctx;
  const { usageTracker } = await import('../../../models/usage-tracker.js');
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
  return done(rl);
}

export async function handleMetrics(ctx: SlashContext): Promise<true> {
  const { rl } = ctx;
  const { sessionMetrics } = await import('../../../core/metrics.js');
  console.log(chalk.yellow('\n  LLM Call Metrics (this session):\n'));
  process.stdout.write(sessionMetrics.getSummary());
  return done(rl);
}

export async function handleDomainPlugins(ctx: SlashContext): Promise<true> {  const { rl } = ctx;
  const { listRegisteredPlugins } = await import('../../../core/domain-router.js');
  const plugins = listRegisteredPlugins();

  console.log(chalk.yellow('\n  Domain Plugins:\n'));
  console.log(chalk.gray(`  ${'NAME'.padEnd(14)} ${'SOURCE'.padEnd(10)} DESCRIPTION`));
  console.log(chalk.gray('  ' + '-'.repeat(60)));

  for (const p of plugins) {
    const srcLabel = p.source === 'builtin'
      ? chalk.gray('builtin')
      : chalk.cyan('external');
    const desc = p.plugin.description.slice(0, 40) + (p.plugin.description.length > 40 ? '...' : '');
    const toolCount = chalk.gray(`(${p.plugin.tools.length} tools)`);
    console.log(`  ${chalk.white(p.name.padEnd(14))} ${srcLabel.padEnd(10)}  ${desc} ${toolCount}`);
  }

  const external = plugins.filter(p => p.source !== 'builtin');
  if (external.length === 0) {
    console.log(chalk.gray('\n  No external plugins loaded.'));
  }

  console.log(chalk.gray('\n  To add a plugin:'));
  console.log(chalk.gray('    1. Create .uagent/plugins/<name>.js'));
  console.log(chalk.gray('    2. Export a default DomainPlugin object:'));
  console.log(chalk.gray('       export default { name, description, keywords, systemPrompt, tools }'));
  console.log(chalk.gray('    3. Restart uagent — plugins load at startup\n'));
  return done(rl);
}
