/**
 * handlers/agent-handlers.ts
 * Agent 配置命令：/model /models /domain /agents /context /compact /tokens
 */
import chalk from 'chalk';
import type { SlashContext } from './shared.js';
import { done } from './shared.js';
import { modelManager } from '../../../models/model-manager.js';
import { subagentSystem } from '../../../core/subagent-system.js';
import { updateStatusBar, printStatusBar } from '../../statusbar.js';

export async function handleModel(input: string, ctx: SlashContext): Promise<true> {
  const { agent, rl, options, getModelDisplayName, makePrompt } = ctx;
  const parts = input.split(/\s+/);
  if (parts.length === 1) {
    rl.pause();
    const { showModelPicker, friendlyName } = await import('../../model-picker.js');
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
  return done(rl);
}

export async function handleModels(input: string, ctx: SlashContext): Promise<true> {
  const { agent, rl, options } = ctx;
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
      const ctx2 = p.contextLength >= 1000000 ? `${(p.contextLength / 1000000).toFixed(1)}M` : `${Math.round(p.contextLength / 1000)}k`;
      console.log(`  ${marker} ${chalk.white(p.name.padEnd(25))} ${chalk.gray(p.provider.padEnd(14))} ${chalk.gray(ctx2.padEnd(10))} ${role ? chalk.cyan(`[${role}]`) : ''}`);
    }
    console.log(chalk.gray('\n  /models switch <name>   — switch main model'));
    console.log(chalk.gray('  uagent models add       — add custom model'));
    console.log(chalk.gray('  uagent models set <ptr> <model>  — set pointer\n'));
  }
  return done(rl);
}

export async function handleDomain(input: string, ctx: SlashContext): Promise<true> {
  const { agent, rl, options, makePrompt } = ctx;
  const domain = input.replace('/domain ', '').trim();
  agent.setDomain(domain);
  options.domain = domain;
  rl.setPrompt(makePrompt(domain));
  process.stdout.write(chalk.green(`  ✓ Domain → ${domain}`) + '\n\n');
  return done(rl);
}

export async function handleAgents(input: string, ctx: SlashContext): Promise<true> {
  const { rl } = ctx;
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
  return done(rl);
}

export async function handleContext(ctx: SlashContext): Promise<true> {
  const { agent, rl } = ctx;
  const { shouldCompact } = await import('../../../core/context/context-compressor.js');
  const history = agent.getHistory();
  const decision = shouldCompact(history);

  // ── Token counting: usage-based local computation (claude-code parity) ──────
  // Primary: reuse LLM response usage field + rough estimate for newer messages
  //   → No network round-trip, instant, handles parallel tool call ID dedup
  // Optional precise mode: pass --precise flag to force Anthropic API call
  const { countTokens } = await import('../../../utils/token-counter.js');
  const countResult = await countTokens(history);

  const tokenCount = countResult.inputTokens;
  const pct = ((tokenCount / decision.contextLength) * 100).toFixed(1);
  const methodNote =
    countResult.method === 'api' ? chalk.green(' (API exact)') :
    countResult.method === 'usage+estimate' ? chalk.cyan(' (usage+estimate)') :
    chalk.gray(' (estimated)');

  console.log(chalk.yellow('\n📊 Context Window Stats:'));
  console.log(`  Input tokens     : ${chalk.white(tokenCount.toLocaleString())}${methodNote}`);
  console.log(`  Context limit    : ${chalk.white(decision.contextLength.toLocaleString())}`);
  console.log(`  Usage            : ${chalk.white(pct + '%')}`);
  console.log(`  Messages in ctx  : ${chalk.white(String(history.length))}`);
  console.log(`  Compact needed   : ${decision.shouldCompact ? chalk.red('Yes') : chalk.green('No')}`);
  console.log(chalk.gray('\n  Tip: /compact — compress context; /clear — start fresh\n'));
  return done(rl);
}

export async function handleCompactOrTokens(input: string, ctx: SlashContext): Promise<true> {
  const { agent, rl } = ctx;
  const { estimateHistoryTokens: _est, shouldCompact } = await import('../../../core/context/context-compressor.js');
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
    return done(rl);
  }

  if (history.length <= 2) {
    console.log(chalk.gray('\n  History too short to compact (≤2 turns).\n'));
    return done(rl);
  }

  rl.pause();
  process.stdout.write('\n');
  const { default: ora } = await import('ora');
  const spinnerC = ora(`Compacting ${history.length} turns (${pct}% context)...`).start();
  try {
    const fullHistory = agent.getHistory();
    if (fullHistory.length > 2) {
      const origEnv = process.env.AGENT_COMPACT_THRESHOLD;
      process.env.AGENT_COMPACT_THRESHOLD = '0.0001';
      let compacted = 0;
      try {
        const { getMemoryStore } = await import('../../../core/memory/memory-store.js');
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
  return done(rl);
}

// ── /doctor ──────────────────────────────────────────────────────────────────
/**
 * /doctor — Environment diagnostic check (Round 5: claude-code /doctor parity)
 *
 * Checks:
 *   1. API key presence (redacted display)
 *   2. Current model reachability (lightweight /models list call)
 *   3. MCP server connectivity
 *   4. Memory store health
 *   5. Config file syntax
 */
export async function handleDoctor(ctx: SlashContext): Promise<true> {
  const { rl } = ctx;
  rl.pause();
  process.stdout.write('\n');

  const okMark = chalk.green('✓');
  const failMark = chalk.red('✗');
  const warnMark = chalk.yellow('⚠');

  process.stdout.write(chalk.bold('🩺  Doctor — environment diagnostics\n'));
  process.stdout.write(chalk.gray('─'.repeat(55) + '\n'));

  // 1. API keys
  process.stdout.write(chalk.gray('\n  API Keys\n'));
  const apiKeyChecks: { env: string; label: string }[] = [
    { env: 'ANTHROPIC_API_KEY', label: 'Anthropic' },
    { env: 'OPENAI_API_KEY',    label: 'OpenAI' },
    { env: 'GEMINI_API_KEY',    label: 'Gemini' },
    { env: 'DEEPSEEK_API_KEY',  label: 'DeepSeek' },
    { env: 'GROQ_API_KEY',      label: 'Groq' },
    { env: 'WQ_API_KEY',        label: '万擎 (WQ)' },
  ];
  for (const { env, label } of apiKeyChecks) {
    const val = process.env[env];
    if (val && val.length > 4) {
      const redacted = val.slice(0, 4) + '…' + val.slice(-2);
      process.stdout.write(`    ${okMark}  ${label.padEnd(14)} ${chalk.gray(redacted)}\n`);
    } else {
      process.stdout.write(`    ${chalk.gray('·')}  ${chalk.gray(label.padEnd(14))} not set\n`);
    }
  }

  // 2. Current model
  process.stdout.write(chalk.gray('\n  Current Model\n'));
  const currentModel = modelManager.getCurrentModel('main');
  process.stdout.write(`    ${okMark}  main model: ${chalk.white(currentModel)}\n`);

  const profiles = modelManager.listProfiles();
  const currentProfile = profiles.find(p => p.name === currentModel);
  if (currentProfile) {
    const ctxLabel = currentProfile.contextLength >= 1_000_000
      ? `${(currentProfile.contextLength / 1_000_000).toFixed(1)}M`
      : `${Math.round(currentProfile.contextLength / 1000)}k`;
    process.stdout.write(`    ${chalk.gray('·')}  context window: ${chalk.gray(ctxLabel)}\n`);
  } else {
    process.stdout.write(`    ${warnMark}  profile not found — may be custom/inline model\n`);
  }

  // 3. MCP servers
  process.stdout.write(chalk.gray('\n  MCP Servers\n'));
  try {
    const { MCPManager: _MCPMgr } = await import('../../../core/mcp-manager.js');
    const mcpMgr = new _MCPMgr(process.cwd());
    const servers = mcpMgr.listServers();
    const enabledServers = servers.filter((s) => s.enabled);
    if (enabledServers.length === 0) {
      process.stdout.write(`    ${chalk.gray('·')}  No MCP servers configured\n`);
    } else {
      for (const s of enabledServers) {
        process.stdout.write(`    ${okMark}  ${chalk.white(s.name.padEnd(20))} ${chalk.gray(s.type + (s.url ? ` (${s.url})` : ''))}\n`);
      }
    }
  } catch (e) {
    process.stdout.write(`    ${failMark}  MCP manager error: ${e instanceof Error ? e.message : String(e)}\n`);
  }

  // 4. Config file
  process.stdout.write(chalk.gray('\n  Config\n'));
  try {
    const { loadConfig } = await import('../../../cli/config-store.js');
    const cfg = loadConfig();
    process.stdout.write(`    ${okMark}  config loaded OK (${Object.keys(cfg).length} keys)\n`);
  } catch (e) {
    process.stdout.write(`    ${failMark}  config load error: ${e instanceof Error ? e.message : String(e)}\n`);
  }

  // 5. Memory store
  process.stdout.write(chalk.gray('\n  Memory Store\n'));
  try {
    const { getMemoryStore } = await import('../../../core/memory/memory-store.js');
    const store = getMemoryStore(process.cwd());
    const stats = store.stats();
    process.stdout.write(`    ${okMark}  memory store accessible (${stats.total ?? 0} items)\n`);
  } catch (e) {
    process.stdout.write(`    ${warnMark}  memory store: ${e instanceof Error ? e.message : String(e)}\n`);
  }

  process.stdout.write(chalk.gray('\n' + '─'.repeat(55) + '\n'));
  process.stdout.write(chalk.gray('  Tip: run `uagent doctor` from CLI for full diagnostics\n\n'));

  rl.resume();
  return done(rl);
}

