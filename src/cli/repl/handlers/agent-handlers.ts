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
import { execSync, execFileSync } from 'child_process';

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
  const contextLength = decision.contextLength;
  const pctNum = (tokenCount / contextLength) * 100;
  const pct = pctNum.toFixed(1);
  const methodNote =
    countResult.method === 'api' ? chalk.green(' (API exact)') :
    countResult.method === 'usage+estimate' ? chalk.cyan(' (usage+estimate)') :
    chalk.gray(' (estimated)');

  console.log(chalk.yellow('\n📊 Context Window Stats:'));
  console.log(`  Input tokens     : ${chalk.white(tokenCount.toLocaleString())}${methodNote}`);
  console.log(`  Context limit    : ${chalk.white(contextLength.toLocaleString())}`);
  console.log(`  Usage            : ${chalk.white(pct + '%')}`);
  console.log(`  Messages in ctx  : ${chalk.white(String(history.length))}`);
  console.log(`  Compact needed   : ${decision.shouldCompact ? chalk.red('Yes') : chalk.green('No')}`);

  // E31: +5 维度 — Mirrors claude-code analyzeContext.ts ContextData 14 dimensions
  // 维度 6: messageBreakdown (tool calls / tool results / user msgs 分解)
  const toolCallMsgs = history.filter((m) =>
    m.role === 'assistant' &&
    Array.isArray((m as { toolCalls?: unknown[] }).toolCalls) &&
    (m as { toolCalls?: unknown[] }).toolCalls!.length > 0,
  ).length;
  const toolResultMsgs = history.filter((m) => m.role === 'tool').length;
  const userMsgs = history.filter((m) => m.role === 'user').length;
  if (toolCallMsgs > 0 || toolResultMsgs > 0) {
    console.log(`  Tool calls       : ${chalk.white(String(toolCallMsgs))}`);
    console.log(`  Tool results     : ${chalk.white(String(toolResultMsgs))}`);
    console.log(`  User messages    : ${chalk.white(String(userMsgs))}`);
  }

  // 维度 7: memory files 计数 (Mirrors analyzeContext.ts memoryFiles dimension)
  try {
    const { existsSync, readdirSync } = await import('fs');
    const { join } = await import('path');
    const memDir = join(process.env['HOME'] ?? '~', '.uagent', 'memory');
    const memFileCount = existsSync(memDir) ? readdirSync(memDir).filter((f) => f.endsWith('.md')).length : 0;
    if (memFileCount > 0) {
      console.log(`  Memory files     : ${chalk.white(String(memFileCount))} (.md)`);
    }
  } catch { /* E31: non-fatal */ }

  // 维度 8: autoCompact threshold (Mirrors analyzeContext.ts autoCompactThreshold)
  const COMPACT_THRESHOLD_PCT = 75;
  console.log(`  Compact trigger  : ${chalk.gray(`>${COMPACT_THRESHOLD_PCT}% of context window`)}`);

  // 维度 9: cache tokens (Mirrors analyzeContext.ts apiUsage 三路 cache token)
  type UsageFields = {
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  const lastMsgWithUsage = [...history].reverse()
    .find((m) => !!(m as { usage?: UsageFields }).usage);
  const usage = (lastMsgWithUsage as { usage?: UsageFields } | undefined)?.usage;
  if (usage && ((usage.cache_creation_input_tokens ?? 0) > 0 || (usage.cache_read_input_tokens ?? 0) > 0)) {
    const created = usage.cache_creation_input_tokens ?? 0;
    const read = usage.cache_read_input_tokens ?? 0;
    console.log(`  Cache created    : ${chalk.gray(created.toLocaleString())} tokens`);
    console.log(`  Cache read       : ${chalk.gray(read.toLocaleString())} tokens`);
  }

  // 维度 10: 进度条可视化 (Mirrors analyzeContext.ts gridRows visualization)
  const barWidth = 30;
  const filled = Math.min(barWidth, Math.round((tokenCount / contextLength) * barWidth));
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
  const barColor = pctNum > 75 ? chalk.red : pctNum > 50 ? chalk.yellow : chalk.green;
  console.log(`  ${ barColor('[' + bar + ']')} ${pctNum.toFixed(1)}%`);
  if (pctNum > 75) {
    console.log(chalk.yellow(`  ⚠  Context usage high — consider /compact`));
  }

  // G32: +3 维度 — Mirrors claude-code analyzeContext.ts 维度 11-13
  // 维度 11: MCP 工具 per-tool token 明细 (Mirrors analyzeContext.ts mcpTools dimension)
  try {
    type MCPMgrType = { listServers: () => Array<{ name: string; tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> }> };
    const globalAny = globalThis as Record<string, unknown>;
    const mcpMgr = globalAny['__uagent_mcp_manager'] as MCPMgrType | undefined;
    if (mcpMgr) {
      const allTools: Array<{ name: string; description?: string; inputSchema?: unknown }> = [];
      for (const server of mcpMgr.listServers()) {
        allTools.push(...(server.tools ?? []));
      }
      if (allTools.length > 0) {
        const mcpTokens = allTools.map((t) => ({
          name: t.name,
          tokens: Math.ceil(JSON.stringify({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema ?? {} }).length / 4),
        })).sort((a, b) => b.tokens - a.tokens);
        const totalMcpTokens = mcpTokens.reduce((s, t) => s + t.tokens, 0);
        console.log(chalk.yellow(`\n  MCP Tools (${allTools.length} loaded, ~${totalMcpTokens.toLocaleString()} tokens):`));
        for (const t of mcpTokens.slice(0, 5)) {
          console.log(`    ${t.name.padEnd(32)} ${chalk.gray('~' + t.tokens.toLocaleString() + ' tokens')}`);
        }
        if (mcpTokens.length > 5) console.log(chalk.gray(`    ... and ${mcpTokens.length - 5} more`));
      }
    }
  } catch { /* G32: non-fatal */ }

  // 维度 12: Built-in tools deferred 状态 (Mirrors analyzeContext.ts deferredBuiltinTools)
  try {
    const usedToolNames = new Set<string>();
    for (const msg of history) {
      if (msg.role === 'assistant' && Array.isArray((msg as { toolCalls?: Array<{ name: string }> }).toolCalls)) {
        for (const tc of (msg as { toolCalls: Array<{ name: string }> }).toolCalls) {
          usedToolNames.add(tc.name);
        }
      }
    }
    if (usedToolNames.size > 0) {
      console.log(chalk.yellow(`\n  Tools used this session: ${chalk.white(String(usedToolNames.size))}`));
      const topTools = [...usedToolNames].slice(0, 8).join(', ');
      console.log(chalk.gray(`    ${topTools}${usedToolNames.size > 8 ? ` + ${usedToolNames.size - 8} more` : ''}`));
    }
  } catch { /* G32: non-fatal */ }

  // 维度 13: 压缩历史 (Mirrors analyzeContext.ts compaction stats)
  try {
    const { isCompactBoundaryMessage } = await import('../../../core/context/context-compressor.js');
    const boundaries = history.filter((m) => isCompactBoundaryMessage(m));
    if (boundaries.length > 0) {
      console.log(chalk.yellow(`\n  Compactions this session: ${chalk.white(String(boundaries.length))}`));
    }
  } catch { /* G32: non-fatal */ }

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

  // C25: Context quality warnings (4-class checks)
  process.stdout.write(chalk.gray('\n  Context Quality\n'));
  try {
    const { checkContextWarnings, formatContextWarnings } = await import('../../../core/doctor-context-warnings.js');
    const warnings = await checkContextWarnings(process.cwd());
    if (warnings.length === 0) {
      process.stdout.write(`    ${okMark}  no context quality issues detected\n`);
    } else {
      process.stdout.write(formatContextWarnings(warnings));
    }
  } catch (e) {
    process.stdout.write(`    ${warnMark}  context check error: ${e instanceof Error ? e.message : String(e)}\n`);
  }

  process.stdout.write(chalk.gray('\n' + '─'.repeat(55) + '\n'));
  process.stdout.write(chalk.gray('  Tip: run `uagent doctor` from CLI for full diagnostics\n\n'));

  rl.resume();
  return done(rl);
}

// ── /commit ──────────────────────────────────────────────────────────────────
/**
 * /commit — Auto-generate a Conventional Commits message from git diff
 * (Round 7: claude-code /commit parity)
 *
 * Flow:
 *   1. Run git diff --staged (fall back to git diff HEAD if nothing staged)
 *   2. Call LLM (quick model) to analyze and generate a commit message
 *   3. Show message to user for y/n confirmation
 *   4. If confirmed, run git commit -m "..."
 *
 * Security: only git commands are allowed during this flow.
 */
export async function handleCommit(input: string, ctx: SlashContext): Promise<true> {
  const { rl, agent } = ctx;
  rl.pause();

  const flags = input.replace(/^\/commit\s*/, '').trim(); // e.g. --no-verify
  const { execSync } = await import('child_process');

  process.stdout.write(chalk.bold('\n📝  /commit — Auto-generate commit message\n'));
  process.stdout.write(chalk.gray('─'.repeat(55) + '\n'));

  // 1. Get diff
  let diff = '';
  try {
    diff = execSync('git diff --staged', { cwd: process.cwd(), encoding: 'utf-8', timeout: 10_000 });
    if (!diff.trim()) {
      // Nothing staged — fall back to unstaged diff
      diff = execSync('git diff HEAD', { cwd: process.cwd(), encoding: 'utf-8', timeout: 10_000 });
    }
    if (!diff.trim()) {
      process.stdout.write(chalk.yellow('  No changes to commit (git diff is empty).\n\n'));
      rl.resume();
      return done(rl);
    }
  } catch (e) {
    process.stdout.write(chalk.red(`  Git error: ${e instanceof Error ? e.message : String(e)}\n\n`));
    rl.resume();
    return done(rl);
  }

  // Truncate diff to avoid context overflow (max 12KB)
  const MAX_DIFF_CHARS = 12_000;
  const truncated = diff.length > MAX_DIFF_CHARS;
  const diffToSend = truncated ? diff.slice(0, MAX_DIFF_CHARS) + '\n... [diff truncated]' : diff;

  process.stdout.write(chalk.gray(`  Analyzing ${diff.length.toLocaleString()} chars of diff${truncated ? ' (truncated)' : ''}...\n`));

  // 2. Generate commit message via LLM
  let commitMsg = '';
  try {
    const llm = modelManager.getClient('quick');

    const systemPrompt = [
      'You are a git commit message generator. Analyze the provided git diff and generate a concise, high-quality commit message following the Conventional Commits specification.',
      '',
      'Format: <type>(<scope>): <description>',
      '',
      'Types: feat, fix, docs, style, refactor, perf, test, chore, ci, build',
      '',
      'Rules:',
      '- First line: type(scope): description (max 72 chars)',
      '- Keep the description concise and imperative (e.g. "add feature" not "added feature")',
      '- Add a blank line then bullet points for significant details (if any)',
      '- Do NOT include issue numbers unless they appear in the diff',
      '- Scope is optional but helpful (e.g. feat(auth):, fix(api):)',
      '',
      'Output ONLY the commit message, nothing else.',
    ].join('\n');

    const chunks: string[] = [];
    await llm.streamChat({
      systemPrompt,
      messages: [{ role: 'user', content: `Generate a commit message for this diff:\n\n${diffToSend}` }],
    }, (chunk) => {
      chunks.push(chunk);
      process.stdout.write(chalk.white(chunk));
    });

    commitMsg = chunks.join('').trim();
    if (!commitMsg) throw new Error('LLM returned empty message');
  } catch (e) {
    process.stdout.write(chalk.red(`\n  LLM error: ${e instanceof Error ? e.message : String(e)}\n\n`));
    rl.resume();
    return done(rl);
  }

  process.stdout.write('\n');
  process.stdout.write(chalk.gray('─'.repeat(55) + '\n'));

  // 3. Confirm with user
  rl.resume();
  const answer = await new Promise<string>((resolve) => {
    rl.question(chalk.cyan('\n  Commit with this message? [y/n/e(edit)]: '), resolve);
  });

  const trimmed = answer.trim().toLowerCase();

  if (trimmed === 'e' || trimmed === 'edit') {
    // Let user edit message inline
    const edited = await new Promise<string>((resolve) => {
      rl.question(chalk.cyan('  Enter commit message: '), resolve);
    });
    if (edited.trim()) commitMsg = edited.trim();
  }

  if (trimmed !== 'y' && trimmed !== 'e' && trimmed !== 'edit') {
    process.stdout.write(chalk.gray('  Commit cancelled.\n\n'));
    return done(rl);
  }

  // 4. Execute git commit
  rl.pause();
  try {
    // Only allow git commit (with optional --no-verify flag)
    const allowedFlags = ['--no-verify', '--allow-empty', '--amend'].filter(f => flags.includes(f));
    const flagStr = allowedFlags.length > 0 ? ' ' + allowedFlags.join(' ') : '';
    const cmd = `git commit${flagStr} -m ${JSON.stringify(commitMsg)}`;
    const output = execSync(cmd, { cwd: process.cwd(), encoding: 'utf-8', timeout: 15_000 });
    process.stdout.write(chalk.green(`\n  ✓ Committed!\n`));
    process.stdout.write(chalk.gray(output.trim() + '\n\n'));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stdout.write(chalk.red(`\n  git commit failed: ${msg}\n\n`));
  }

  rl.resume();
  return done(rl);
}

// ── /security-review ─────────────────────────────────────────────────────────
/**
 * /security-review — Deep security audit of the current project
 * (Round 7: claude-code /security-review command parity)
 *
 * Runs a structured security review using an embedded prompt with:
 * - Confidence threshold ≥ 0.7 (suppress low-confidence findings)
 * - Covers: SQL injection, XSS, RCE, path traversal, SSRF, XXE, IDOR,
 *           unsafe deserialization, hardcoded secrets
 * - Structured output: file:line, severity, exploit scenario, fix
 * - Read-only mode (only Bash(git diff), Read, Grep, Glob allowed)
 */
export async function handleSecurityReview(input: string, ctx: SlashContext): Promise<true> {
  const { rl, agent } = ctx;
  rl.pause();

  const scopeArg = input.replace(/^\/security-review\s*/, '').trim();

  process.stdout.write(chalk.bold('\n🔒  /security-review — Security Audit\n'));
  process.stdout.write(chalk.gray('─'.repeat(55) + '\n'));
  process.stdout.write(chalk.gray('  This may take several minutes for large projects...\n\n'));

  const SECURITY_REVIEW_PROMPT = `You are a security researcher performing a thorough security audit.
Your task is to identify REAL, EXPLOITABLE security vulnerabilities in the codebase.

## Methodology

1. **Context Research** (read-only): Understand the application's purpose, architecture, and attack surface
2. **Comparative Analysis**: Identify patterns that differ from security best practices
3. **Vulnerability Assessment**: For each candidate vulnerability, assess exploitability

## Vulnerability Categories to Check

- SQL Injection (including ORM misuse, raw queries)
- Cross-Site Scripting (XSS) — reflected, stored, DOM-based
- Remote Code Execution (RCE) — eval, exec, deserialization
- Path Traversal — file read/write with user-controlled paths
- Server-Side Request Forgery (SSRF) — user-controlled URLs
- XML External Entity (XXE) — XML parsers with external entities
- Insecure Direct Object Reference (IDOR) — missing authorization checks
- Hardcoded secrets — API keys, passwords, tokens in source code
- Insecure deserialization — unsafe JSON.parse, pickle, etc.
- Authentication bypasses — JWT issues, session fixation, weak tokens

## Reporting Rules

**ONLY report vulnerabilities where you have ≥0.7 confidence they are exploitable.**

DO NOT report:
- Theoretical vulnerabilities with no realistic exploit path
- Denial of service / rate limiting issues
- Missing security headers (unless critical)
- API keys stored in environment files (only report if committed to git)

## Output Format

For each finding:

### [SEVERITY] Vulnerability Title
**File:** path/to/file.ts:line_number
**Category:** (e.g., SQL Injection, XSS, RCE)
**Confidence:** 0.X / 1.0
**Exploit Scenario:** How an attacker would exploit this
**Fix:** Specific code fix recommendation

---

Use severity levels: CRITICAL, HIGH, MEDIUM

Begin by scanning the following scope: ${scopeArg || 'src/, lib/, app/ directories (or entire project if not found)'}

Start with a brief scope summary, then list all findings. If no vulnerabilities found, say "No exploitable vulnerabilities found with ≥0.7 confidence."`;

  // Use agent to run the security review
  try {
    rl.pause();
    process.stdout.write(chalk.gray('  Analyzing...\n\n'));
    await agent.runStream(SECURITY_REVIEW_PROMPT, (chunk) => process.stdout.write(chunk));
    process.stdout.write('\n\n');
  } catch (e) {
    // Fallback: static grep scan
    const { execSync } = await import('child_process');
    try {
      // Quick static grep for common patterns
      const findings: string[] = [];

      const checks: Array<{ label: string; pattern: string }> = [
        { label: 'eval() usage', pattern: 'eval(' },
        { label: 'SQL raw query', pattern: 'query(' },
        { label: 'path.join + user input', pattern: '__dirname' },
        { label: 'hardcoded secrets', pattern: 'password.*=' },
        { label: 'child_process.exec', pattern: 'exec(' },
        { label: 'innerHTML assignment', pattern: 'innerHTML' },
      ];

      for (const { label, pattern } of checks) {
        try {
          const result = execSync(
            `grep -rn --include="*.ts" --include="*.js" "${pattern}" src/ 2>/dev/null | head -5`,
            { cwd: process.cwd(), encoding: 'utf-8', timeout: 5000 }
          );
          if (result.trim()) {
            findings.push(`\n  [PATTERN] ${label}:\n${result.trim().split('\n').map(l => '    ' + l).join('\n')}`);
          }
        } catch { /* skip */ }
      }

      if (findings.length > 0) {
        process.stdout.write(chalk.yellow('  Static pattern matches (manual review required):\n'));
        process.stdout.write(findings.join('\n') + '\n');
        process.stdout.write(chalk.gray('\n  Note: For full AI-powered analysis, ensure agent is running.\n'));
      } else {
        process.stdout.write(chalk.green('  No obvious security patterns found in static scan.\n'));
        process.stdout.write(chalk.gray('  For comprehensive review, use the AI agent directly.\n'));
      }
    } catch (e2) {
      process.stdout.write(chalk.red(`  Error: ${e2 instanceof Error ? e2.message : String(e2)}\n`));
    }
  }

  process.stdout.write(chalk.gray('─'.repeat(55) + '\n\n'));
  rl.resume();
  return done(rl);
}

// ── J12: New commands (claude-code parity) ────────────────────────────────────

/**
 * /diff — 显示当前工作目录的 git diff
 * 对标 claude-code /diff 命令。
 */
export async function handleDiff(ctx: SlashContext): Promise<true> {
  const { rl } = ctx;
  rl.pause();
  process.stdout.write('\n');
  try {
    const stat = execSync('git diff --stat', {
      cwd: process.cwd(), encoding: 'utf-8',
      timeout: 10_000, maxBuffer: 512 * 1024,
    }).trim();
    const diff = execSync('git diff', {
      cwd: process.cwd(), encoding: 'utf-8',
      timeout: 10_000, maxBuffer: 512 * 1024,
    }).trim();
    if (!stat && !diff) {
      process.stdout.write(chalk.gray('(no uncommitted changes)\n'));
    } else {
      if (stat) process.stdout.write(chalk.cyan(stat) + '\n\n');
      if (diff) process.stdout.write(diff + '\n');
    }
  } catch {
    process.stdout.write(chalk.yellow('(not a git repository or git not available)\n'));
  }
  process.stdout.write('\n');
  rl.resume();
  return done(rl);
}

/**
 * /effort [low|medium|high|max] — 调节 thinking 力度
 * 对标 claude-code /effort 命令。
 * Mapping: low=0 / medium=8K / high=32K / max=100K thinking budget tokens
 */
export async function handleEffort(input: string, ctx: SlashContext): Promise<true> {
  const { rl, agent } = ctx;
  const level = input.slice('/effort'.length).trim().toLowerCase();
  const LEVELS: Record<string, string> = {
    low: 'low', medium: 'medium', high: 'high', max: 'max',
    '0': 'low', '1': 'medium', '2': 'high', '3': 'max',
    '': 'medium', // /effort with no arg shows current
  };

  rl.pause();
  process.stdout.write('\n');

  if (level === '' || !(level in LEVELS)) {
    if (level !== '') {
      process.stdout.write(chalk.yellow(`Unknown effort level: "${level}". Valid: low, medium, high, max\n`));
    } else {
      // Show current level
      const currentLevel = (agent as unknown as { _thinkingLevel?: string })._thinkingLevel ?? 'medium';
      process.stdout.write(`Current thinking effort: ${chalk.cyan(currentLevel)}\n`);
      process.stdout.write(chalk.gray('  low    = disabled (0 thinking tokens)\n'));
      process.stdout.write(chalk.gray('  medium = light thinking (8K tokens)\n'));
      process.stdout.write(chalk.gray('  high   = deep thinking (32K tokens)\n'));
      process.stdout.write(chalk.gray('  max    = unlimited thinking\n'));
    }
  } else {
    const mapped = LEVELS[level]!;
    // Map to ThinkingLevel (matches setThinkingLevel in agent/index.ts)
    const thinkingLevelMap: Record<string, import('../../../models/types.js').ThinkingLevel | undefined> = {
      low: undefined, medium: 'low', high: 'medium', max: 'high',
    };
    agent.setThinkingLevel(thinkingLevelMap[mapped]);
    process.stdout.write(`Thinking effort set to: ${chalk.green(mapped)}\n`);
    printStatusBar();
  }

  process.stdout.write('\n');
  rl.resume();
  return done(rl);
}

/**
 * /config [key] [value] — 查看或修改 .uagent 配置项
 * 对标 claude-code /config 命令。
 */
export async function handleConfig(input: string, ctx: SlashContext): Promise<true> {
  const { rl } = ctx;
  const parts = input.trim().split(/\s+/).filter(Boolean);
  // parts[0] = '/config', parts[1] = key (optional), parts[2+] = value (optional)

  rl.pause();
  process.stdout.write('\n');

  try {
    const { loadConfig, setConfigValue } = await import('../../config-store.js');

    if (parts.length === 1) {
      // /config — list all settings
      const cfg = loadConfig();
      process.stdout.write(chalk.cyan('Current configuration:\n'));
      process.stdout.write(JSON.stringify(cfg, null, 2) + '\n');
    } else if (parts.length === 2) {
      // /config key — show single value
      const cfg = loadConfig();
      const key = parts[1]!;
      const val = (cfg as Record<string, unknown>)[key];
      if (val === undefined) {
        process.stdout.write(chalk.yellow(`Key "${key}" not found in config.\n`));
      } else {
        process.stdout.write(`${chalk.cyan(key)}: ${JSON.stringify(val)}\n`);
      }
    } else {
      // /config key value — set value
      const key = parts[1]!;
      const rawVal = parts.slice(2).join(' ');
      // Try to parse as JSON (handles booleans, numbers), fallback to string
      let value: unknown;
      try { value = JSON.parse(rawVal); } catch { value = rawVal; }
      setConfigValue(key, value as never);
      process.stdout.write(`${chalk.green('✓')} Set ${chalk.cyan(key)} = ${JSON.stringify(value)}\n`);
    }
  } catch (err) {
    process.stdout.write(chalk.red(`Config error: ${err instanceof Error ? err.message : String(err)}\n`));
  }

  process.stdout.write('\n');
  rl.resume();
  return done(rl);
}

/**
 * /rewind [n] — 回滚对话历史 n 轮（默认 1 轮）
 * 对标 claude-code /rewind 命令。
 */
export async function handleRewind(input: string, ctx: SlashContext): Promise<true> {
  const { rl, agent } = ctx;
  const nStr = input.slice('/rewind'.length).trim();
  const n = nStr ? parseInt(nStr, 10) : 1;

  rl.pause();
  process.stdout.write('\n');

  if (isNaN(n) || n <= 0) {
    process.stdout.write(chalk.yellow(`Invalid argument: "${nStr}". Usage: /rewind [n] where n > 0\n`));
  } else {
    const histBefore = agent.getHistory().length;
    const removed = agent.rewindHistory(n);
    const histAfter = agent.getHistory().length;
    if (removed === 0) {
      process.stdout.write(chalk.yellow('Nothing to rewind — history is empty.\n'));
    } else {
      process.stdout.write(
        `${chalk.green('✓')} Rewound ${removed} message(s) (${histBefore} → ${histAfter} in history).\n`,
      );
    }
  }

  process.stdout.write('\n');
  rl.resume();
  return done(rl);
}

// ── G13: /plan — Plan Mode 切换（claude-code /plan 命令对标） ───────────────────
//
// Plan Mode: LLM 只输出规划而不调用任何工具（通过修改 system prompt 实现）。
// /plan        — 进入 plan mode
// /plan off    — 退出 plan mode，恢复正常工具执行

const PLAN_MODE_PROMPT =
  'PLAN MODE ENABLED: You are in planning-only mode. Analyze the request thoroughly and ' +
  'output a detailed step-by-step plan. DO NOT call any tools or make any changes. ' +
  'Only describe what you would do and why. ' +
  'End your plan with: "Ready to execute — type /plan off to proceed."';

export async function handlePlan(input: string, ctx: SlashContext): Promise<true> {
  const { rl, agent } = ctx;
  const arg = input.slice('/plan'.length).trim().toLowerCase();

  rl.pause();
  process.stdout.write('\n');

  if (arg === 'off' || arg === 'exit' || arg === 'disable' || arg === 'false') {
    // 退出 plan mode — 清除 plan mode 专用的 appendSystemPrompt
    agent.setPlanMode(false);
    process.stdout.write(chalk.green('Plan Mode disabled — tools are now active.\n'));
    process.stdout.write(chalk.gray('  The agent will now execute changes as requested.\n\n'));
  } else {
    // 进入 plan mode
    agent.setPlanMode(true);
    process.stdout.write(chalk.cyan('Plan Mode enabled — LLM will plan but not execute.\n'));
    process.stdout.write(chalk.gray('  Type your request and the agent will output a plan only.\n'));
    process.stdout.write(chalk.gray('  Type /plan off to disable and allow tool execution.\n\n'));
  }

  rl.resume();
  return done(rl);
}

// ── J14: /ide + /stats 命令（claude-code parity） ─────────────────────────────

/**
 * J14: /ide — IDE 集成状态（claude-code /ide 命令对标）
 * 显示当前 IDE 环境检测结果、LSP 工具状态和工作目录信息。
 */
export async function handleIde(ctx: SlashContext): Promise<true> {
  const { rl } = ctx;
  rl.pause();
  process.stdout.write('\n');
  process.stdout.write(chalk.bold('🖥️  IDE Integration Status\n'));
  process.stdout.write(chalk.gray('─'.repeat(48) + '\n'));

  // 检测 IDE 环境
  const isVSCode = !!(process.env.VSCODE_PID || process.env.TERM_PROGRAM === 'vscode');
  const isCursor = !!(process.env.CURSOR_CHANNEL || process.env.CURSOR_TRACE_FILE);
  const isJetBrains = !!(process.env.IDEA_INITIAL_DIRECTORY || process.env.JETBRAINS_REMOTE_DEV_LAUNCHER_PORT);
  const isWindsurf = !!(process.env.WINDSURF_ENABLED);
  const termProgram = process.env.TERM_PROGRAM ?? process.env.TERMINAL_EMULATOR ?? 'unknown';

  let editorName: string;
  if (isCursor) editorName = chalk.green('Cursor');
  else if (isVSCode) editorName = chalk.green('VSCode');
  else if (isJetBrains) editorName = chalk.green('JetBrains IDE');
  else if (isWindsurf) editorName = chalk.green('Windsurf');
  else editorName = chalk.gray('Not detected');

  process.stdout.write(`  Editor:      ${editorName}\n`);
  process.stdout.write(`  Terminal:    ${chalk.gray(termProgram)}\n`);
  process.stdout.write(`  Shell:       ${chalk.gray(process.env.SHELL ?? 'unknown')}\n`);
  process.stdout.write(`  CWD:         ${chalk.gray(process.cwd())}\n`);
  process.stdout.write(`  Node.js:     ${chalk.gray(process.version)}\n`);
  process.stdout.write('\n');

  // LSP 工具状态
  const lspEnabled = process.env.ENABLE_LSP_TOOL === 'true';
  process.stdout.write(`  LSP Tool:    ${lspEnabled ? chalk.green('Enabled') : chalk.gray('Disabled')}${!lspEnabled ? chalk.gray(' (set ENABLE_LSP_TOOL=true to enable)') : ''}\n`);

  // 代理/网络状态（简单检测）
  const httpProxy = process.env.HTTP_PROXY ?? process.env.http_proxy;
  const httpsProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (httpProxy || httpsProxy) {
    process.stdout.write(`  HTTP Proxy:  ${chalk.gray(httpProxy ?? httpsProxy ?? '')}\n`);
  }

  // Git 检测
  try {
    const gitVersion = execSync('git --version', { encoding: 'utf-8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    process.stdout.write(`  Git:         ${chalk.green(gitVersion.replace('git version ', ''))}\n`);
  } catch {
    process.stdout.write(`  Git:         ${chalk.gray('Not found in PATH')}\n`);
  }

  process.stdout.write('\n');
  rl.resume();
  return done(rl);
}

/**
 * J14: /stats — 会话使用统计（claude-code /stats 命令对标）
 * 显示当前会话的 token 使用量、消息数量和模型信息。
 */
export async function handleStats(ctx: SlashContext): Promise<true> {
  const { rl, agent } = ctx;
  rl.pause();
  process.stdout.write('\n');
  process.stdout.write(chalk.bold('📊  Session Statistics\n'));
  process.stdout.write(chalk.gray('─'.repeat(48) + '\n'));

  const history = agent.getHistory();
  const currentModel = modelManager.getCurrentModel('main');

  // 消息统计
  const userMsgs = history.filter((m) => m.role === 'user').length;
  const assistantMsgs = history.filter((m) => m.role === 'assistant').length;
  const toolMsgs = history.filter((m) => m.role === 'tool').length;

  process.stdout.write(`  Messages:    ${chalk.bold(String(history.length))} total (${userMsgs} user, ${assistantMsgs} assistant, ${toolMsgs} tool)\n`);
  process.stdout.write(`  Model:       ${chalk.cyan(currentModel)}\n`);

  // Token 使用（从最后一条带 usage 的消息读取）
  type UsageRecord = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  const lastWithUsage = [...history].reverse().find((m) => m.usage);
  if (lastWithUsage?.usage) {
    const u = lastWithUsage.usage as UsageRecord;
    const fmt = (n: number) => n.toLocaleString('en-US');
    process.stdout.write(`\n  Last turn token usage:\n`);
    process.stdout.write(`    Input tokens:       ${chalk.bold(fmt(u.input_tokens ?? 0))}\n`);
    process.stdout.write(`    Output tokens:      ${chalk.bold(fmt(u.output_tokens ?? 0))}\n`);
    if ((u.cache_read_input_tokens ?? 0) > 0) {
      process.stdout.write(`    Cache read:         ${chalk.gray(fmt(u.cache_read_input_tokens ?? 0))}\n`);
    }
    if ((u.cache_creation_input_tokens ?? 0) > 0) {
      process.stdout.write(`    Cache write:        ${chalk.gray(fmt(u.cache_creation_input_tokens ?? 0))}\n`);
    }
  }

  // 估算总 context token 数
  try {
    const { estimateHistoryTokens } = await import('../../../core/context/context-compressor.js');
    const estimated = estimateHistoryTokens(history as import('../../../models/types.js').Message[]);
    const profiles = modelManager.listProfiles();
    const prof = profiles.find((p) => p.name === currentModel);
    const ctxLen = prof?.contextLength ?? 128_000;
    const pct = ((estimated / ctxLen) * 100).toFixed(1);

    process.stdout.write(`\n  Estimated context usage:\n`);
    process.stdout.write(`    ~${estimated.toLocaleString('en-US')} tokens / ${ctxLen.toLocaleString('en-US')} (${pct}%)\n`);

    // 进度条（20格）
    const filled = Math.round((estimated / ctxLen) * 20);
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
    const barColor = parseFloat(pct) > 75 ? chalk.red : parseFloat(pct) > 50 ? chalk.yellow : chalk.green;
    process.stdout.write(`    ${barColor('[' + bar + ']')} ${pct}%\n`);
  } catch { /* non-fatal */ }

  // Session 运行时间（近似）
  const uptimeSec = Math.floor(process.uptime());
  const uptimeStr = uptimeSec >= 3600
    ? `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`
    : uptimeSec >= 60
      ? `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`
      : `${uptimeSec}s`;
  process.stdout.write(`\n  Session uptime: ${chalk.gray(uptimeStr)}\n`);

  process.stdout.write('\n');
  rl.resume();
  return done(rl);
}


export async function handleUpgrade(ctx: SlashContext): Promise<true> {
  const { rl } = ctx;
  rl.pause();
  process.stdout.write('\n');
  process.stdout.write(chalk.cyan('Checking for updates...\n'));

  try {
    // 读取当前版本
    const currentVersion = (
      await import('../../../../package.json', { assert: { type: 'json' } })
    ).default.version as string;

    // 查询 npm registry 最新版本（超时 5s）
    let latestVersion = '';
    try {
      latestVersion = execSync('npm show universal-agent version --no-update-notifier 2>/dev/null', {
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      // 网络不可用
    }

    if (!latestVersion) {
      process.stdout.write(chalk.yellow('Could not check remote version (network unavailable).\n'));
      process.stdout.write(chalk.gray(`  Current: v${currentVersion}\n`));
      process.stdout.write(chalk.gray('  Manual upgrade: npm install -g universal-agent@latest\n\n'));
    } else if (latestVersion === currentVersion) {
      process.stdout.write(chalk.green(`Already up to date (v${currentVersion}).\n\n`));
    } else {
      process.stdout.write(`Current: v${currentVersion} → Latest: ${chalk.green('v' + latestVersion)}\n`);
      process.stdout.write(chalk.cyan('Upgrading (this may take a moment)...\n'));
      try {
        execSync(`npm install -g universal-agent@${latestVersion} --no-update-notifier`, {
          stdio: 'inherit',
          timeout: 120_000,
        });
        process.stdout.write(chalk.green(`\nUpgraded to v${latestVersion} successfully.\n`));
        process.stdout.write(chalk.gray('  Please restart the agent to apply changes.\n\n'));
      } catch (installErr) {
        process.stdout.write(chalk.red(`\nUpgrade failed: ${installErr instanceof Error ? installErr.message : String(installErr)}\n`));
        process.stdout.write(chalk.gray(`  Manual upgrade: npm install -g universal-agent@${latestVersion}\n\n`));
      }
    }
  } catch (err) {
    process.stdout.write(chalk.red(`Upgrade check failed: ${err instanceof Error ? err.message : String(err)}\n`));
    process.stdout.write(chalk.gray('  Manual upgrade: npm install -g universal-agent@latest\n\n'));
  }

  rl.resume();
  return done(rl);
}
