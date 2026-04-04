import chalk from 'chalk';
import type { Command } from 'commander';
import ora from 'ora';

export function registerMemoryCommands(program: Command): void {
  const memCmd = program.command('memory').description('Manage long-term memory for this project');

  memCmd.command('list')
    .description('List all memories for the current project')
    .option('-t, --type <type>', 'Filter by type: pinned|insight|fact')
    .action(async (options) => {
      const { getMemoryStore } = await import('../../core/memory/memory-store.js');
      const store = getMemoryStore(process.cwd());
      const types = options.type ? [options.type] : undefined;
      const items = store.list({ types });
      if (!items.length) {
        console.log(chalk.gray('\n  No memories found.\n'));
        return;
      }
      const icon: Record<string, string> = { pinned: '📌', insight: '💡', fact: '📝' };
      console.log(chalk.yellow('\n🧠 Long-term Memories:\n'));
      for (const m of items) {
        const ttlStr = m.ttl ? chalk.gray(` [expires ${new Date(m.ttl).toLocaleDateString()}]`) : '';
        console.log(`  ${icon[m.type] ?? '•'} ${chalk.cyan(m.id)} ${chalk.white(m.content.slice(0, 100))}${ttlStr}`);
        if (m.tags.length) console.log(`     ${chalk.gray('tags: ' + m.tags.join(', '))}`);
      }
      const stats = store.stats();
      console.log(chalk.gray(`\n  Total: ${stats.total} (📌 ${stats.pinned} pinned, 💡 ${stats.insight} insight, 📝 ${stats.fact} fact)\n`));
    });

  memCmd.command('add <text>')
    .description('Add a pinned memory (permanent)')
    .option('-t, --type <type>', 'Memory type: pinned|insight|fact', 'pinned')
    .option('--tags <tags>', 'Comma-separated tags')
    .action(async (text, options) => {
      const { getMemoryStore } = await import('../../core/memory/memory-store.js');
      const store = getMemoryStore(process.cwd());
      const tags = options.tags ? options.tags.split(',').map((t: string) => t.trim()) : [];
      const id = store.add({ type: options.type, content: text, tags, source: 'user' });
      console.log(chalk.green(`✓ Memory saved [${id}]`));
    });

  memCmd.command('delete <id>')
    .description('Delete a memory by ID')
    .action(async (id) => {
      const { getMemoryStore } = await import('../../core/memory/memory-store.js');
      const store = getMemoryStore(process.cwd());
      const ok = store.delete(id);
      console.log(ok ? chalk.green(`✓ Deleted ${id}`) : chalk.red(`✗ Memory not found: ${id}`));
    });

  memCmd.command('search <query>')
    .description('Search memories by relevance')
    .option('-n, --limit <n>', 'Max results', '5')
    .action(async (query, options) => {
      const { getMemoryStore } = await import('../../core/memory/memory-store.js');
      const store = getMemoryStore(process.cwd());
      const limit = parseInt(options.limit || '5', 10);
      const results = await store.recall(query, { limit });
      if (!results.length) {
        console.log(chalk.gray('\n  No relevant memories found.\n'));
        return;
      }
      const icon: Record<string, string> = { pinned: '📌', insight: '💡', fact: '📝' };
      console.log(chalk.yellow(`\n🔍 Memory search: "${query}"\n`));
      for (const m of results) {
        console.log(`  ${icon[m.type] ?? '•'} ${chalk.cyan(m.id)} ${chalk.white(m.content)}`);
      }
      console.log();
    });

  memCmd.command('ingest')
    .description('Trigger Smart Ingest: extract memories from recent session history (requires API key)')
    .action(async () => {
      const { getMemoryStore } = await import('../../core/memory/memory-store.js');
      const { getProjectHistory } = await import('../../core/memory/session-history.js');
      const store = getMemoryStore(process.cwd());
      const history = getProjectHistory(process.cwd());
      if (!history.length) {
        console.log(chalk.gray('No session history found to ingest.'));
        return;
      }
      const spinner = ora('Running Smart Ingest (LLM extraction)...').start();
      try {
        const messages = history.slice(0, 30).reverse().map((h) => ({
          role: 'user' as const,
          content: h.prompt,
        }));
        const result = await store.ingest(messages);
        spinner.succeed(`Ingest complete: +${result.added} added, ~${result.updated} updated, ${result.skipped} skipped`);
      } catch (err) {
        spinner.fail('Ingest failed: ' + (err instanceof Error ? err.message : String(err)));
      }
    });

  memCmd.command('gc')
    .description('Garbage collect expired fact memories')
    .action(async () => {
      const { getMemoryStore } = await import('../../core/memory/memory-store.js');
      const store = getMemoryStore(process.cwd());
      const removed = store.gc();
      console.log(chalk.green(`✓ GC complete: removed ${removed} expired/excess memories`));
    });

  memCmd.command('clear')
    .description('Clear all memories for this project')
    .option('-t, --type <type>', 'Only clear specific type: pinned|insight|fact')
    .action(async (options) => {
      const { getMemoryStore } = await import('../../core/memory/memory-store.js');
      const store = getMemoryStore(process.cwd());
      const types = options.type ? [options.type] : undefined;
      store.clear(types as never);
      console.log(chalk.green(`✓ Memories cleared${options.type ? ` (type: ${options.type})` : ''}`));
    });
}
