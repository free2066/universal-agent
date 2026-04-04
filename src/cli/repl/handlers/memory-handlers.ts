/**
 * handlers/memory-handlers.ts
 * 记忆相关命令：/memory /history /init /rules /review /spec /spec:brainstorm /spec:write-plan /spec:execute-plan
 */
import chalk from 'chalk';
import type { SlashContext } from './shared.js';
import { done, streamWithPause } from './shared.js';
import { getRecentHistory } from '../../../core/memory/session-history.js';
import { initAgentsMd, loadRules } from '../../../core/context/context-loader.js';

export async function handleMemory(input: string, ctx: SlashContext): Promise<true> {
  const { agent, rl } = ctx;
  const parts = input.split(/\s+/);
  const sub = parts[1];
  const { getMemoryStore } = await import('../../../core/memory/memory-store.js');
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
    const { default: ora } = await import('ora');
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
  return done(rl);
}

export async function handleHistory(input: string, ctx: SlashContext): Promise<true> {
  const { rl } = ctx;
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
  return done(rl);
}

export async function handleInit(ctx: SlashContext): Promise<true> {
  const { rl } = ctx;
  console.log(chalk.green(initAgentsMd(process.cwd())));
  return done(rl);
}

export async function handleRules(ctx: SlashContext): Promise<true> {
  const { rl } = ctx;
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
  return done(rl);
}

export async function handleReview(ctx: SlashContext): Promise<true> {
  const { rl } = ctx;
  rl.pause();
  process.stdout.write('\n');
  const { default: ora } = await import('ora');
  const spinnerR = ora('Running AI Code Review...').start();
  try {
    const { reviewCode } = await import('../../../core/tools/code/ai-reviewer.js');
    const report = await reviewCode({ projectRoot: process.cwd() });
    spinnerR.stop();
    console.log('\n' + report.markdown);
    console.log(chalk.gray(`  P1=${report.summary.P1}  P2=${report.summary.P2}  P3=${report.summary.P3}\n`));
  } catch (eR) {
    spinnerR.fail('Review failed: ' + (eR instanceof Error ? eR.message : String(eR)));
  }
  rl.resume();
  return done(rl);
}

export async function handleSpec(input: string, ctx: SlashContext): Promise<true> {
  const { agent, rl } = ctx;
  const desc = input.replace('/spec', '').trim();
  if (!desc) {
    const { listSpecs } = await import('../../../core/tools/code/spec-generator.js');
    const specs = listSpecs(process.cwd());
    if (!specs.length) {
      console.log(chalk.gray('\n  No specs yet. Usage: /spec <requirement description>\n'));
    } else {
      console.log(chalk.yellow('\n📄 Specs:\n'));
      specs.forEach((s, i) => console.log(`  ${chalk.gray(String(i + 1) + '.')} ${chalk.cyan(s.date)}  ${s.name}`));
      console.log();
    }
    return done(rl);
  }
  rl.pause();
  process.stdout.write('\n');
  const { default: ora } = await import('ora');
  const spinnerS = ora('Generating technical spec...').start();
  try {
    const { generateSpec } = await import('../../../core/tools/code/spec-generator.js');
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
  return done(rl);
}

export async function handleSpecBrainstorm(input: string, ctx: SlashContext): Promise<true> {
  const { agent, rl } = ctx;
  const topic = input.replace('/spec:brainstorm', '').trim();
  if (!topic) {
    console.log(chalk.gray('\n  Usage: /spec:brainstorm <topic or feature description>\n'));
    return done(rl);
  }
  await streamWithPause(rl, async () => {
    const { default: ora } = await import('ora');
    const spinnerB = ora('Brainstorming ideas...').start();
    try {
      const prompt = `# Brainstorm: ${topic}

Please brainstorm design approaches and ideas for the following topic. Be creative and explore multiple angles:

**Topic:** ${topic}

Provide:
1. 3-5 distinct design approaches
2. Pros and cons of each
3. Key technical challenges to consider
4. A recommended starting point`;
      spinnerB.stop();
      await agent.runStream(prompt, (chunk) => process.stdout.write(chunk));
      process.stdout.write('\n');
    } catch (err) {
      spinnerB.fail('Brainstorm failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  });
  return done(rl);
}

export async function handleSpecWritePlan(input: string, ctx: SlashContext): Promise<true> {
  const { agent, rl } = ctx;
  const topic = input.replace('/spec:write-plan', '').trim();
  const history = agent.getHistory();
  const recentContext = history.slice(-6).map((m) => {
    const gct = (c: unknown): string => typeof c === 'string' ? c : '[content]';
    return `${m.role}: ${gct(m.content).slice(0, 200)}`;
  }).join('\n');

  await streamWithPause(rl, async () => {
    const planPrompt = topic
      ? `Generate a detailed implementation plan for: ${topic}`
      : `Based on our recent conversation:\n\n${recentContext}\n\nGenerate a detailed, step-by-step implementation plan with:\n1. Clear phases and milestones\n2. Specific tasks for each phase\n3. Dependencies between tasks\n4. Estimated complexity\n5. Potential risks and mitigations`;
    try {
      await agent.runStream(planPrompt, (chunk) => process.stdout.write(chunk));
      process.stdout.write('\n');
    } catch (err) {
      console.error(chalk.red('Plan generation failed: ') + (err instanceof Error ? err.message : String(err)));
    }
  });
  return done(rl);
}

export async function handleSpecExecutePlan(ctx: SlashContext): Promise<true> {
  const { agent, rl } = ctx;
  const history = agent.getHistory();
  const lastPlan = [...history].reverse().find((m) =>
    m.role === 'assistant' && ((): boolean => {
      const t = typeof m.content === 'string' ? m.content : '';
      return t.includes('Phase') || t.includes('Step') || t.includes('Task');
    })()
  );
  if (!lastPlan) {
    console.log(chalk.gray('\n  No plan found in context. Run /spec:write-plan first.\n'));
    return done(rl);
  }
  await streamWithPause(rl, async () => {
    const execPrompt = `Execute the implementation plan step by step. Start with Phase 1 / Step 1. 
For each step:
1. Explain what you're doing
2. Implement it
3. Verify it works
4. Move to the next step

Begin execution now.`;
    try {
      await agent.runStream(execPrompt, (chunk) => process.stdout.write(chunk));
      process.stdout.write('\n');
    } catch (err) {
      console.error(chalk.red('Plan execution failed: ') + (err instanceof Error ? err.message : String(err)));
    }
  });
  return done(rl);
}
