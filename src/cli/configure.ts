import { createInterface } from 'readline';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { resolve } from 'path';
import chalk from 'chalk';

const CONFIG_DIR = resolve(process.env.HOME || '~', '.uagent');
const CONFIG_FILE = resolve(CONFIG_DIR, '.env');

export async function configureAgent() {
  console.log(chalk.cyan('\n🔧 Universal Agent Configuration\n'));

  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });

  let existing: Record<string, string> = {};
  if (existsSync(CONFIG_FILE)) {
    const lines = readFileSync(CONFIG_FILE, 'utf-8').split('\n');
    for (const line of lines) {
      const [k, v] = line.split('=');
      if (k && v) existing[k.trim()] = v.trim();
    }
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const question = (q: string) => new Promise<string>((res) => rl.question(q, res));

  console.log(chalk.gray('Press Enter to keep existing values\n'));

  const openaiKey = await question(
    chalk.white('OpenAI API Key') +
    chalk.gray(existing.OPENAI_API_KEY ? ` [${existing.OPENAI_API_KEY.slice(0, 8)}...]` : ' [not set]') +
    ': '
  );

  const anthropicKey = await question(
    chalk.white('Anthropic API Key') +
    chalk.gray(existing.ANTHROPIC_API_KEY ? ` [${existing.ANTHROPIC_API_KEY.slice(0, 8)}...]` : ' [not set]') +
    ': '
  );

  const openaiBase = await question(
    chalk.white('OpenAI Base URL') +
    chalk.gray(` [${existing.OPENAI_BASE_URL || 'https://api.openai.com/v1'}]`) +
    ': '
  );

  const ollamaBase = await question(
    chalk.white('Ollama Base URL') +
    chalk.gray(` [${existing.OLLAMA_BASE_URL || 'http://localhost:11434'}]`) +
    ': '
  );

  rl.close();

  const config: Record<string, string> = {
    OPENAI_API_KEY: openaiKey || existing.OPENAI_API_KEY || '',
    ANTHROPIC_API_KEY: anthropicKey || existing.ANTHROPIC_API_KEY || '',
    OPENAI_BASE_URL: openaiBase || existing.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    OLLAMA_BASE_URL: ollamaBase || existing.OLLAMA_BASE_URL || 'http://localhost:11434',
  };

  const content = Object.entries(config)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  writeFileSync(CONFIG_FILE, content, { mode: 0o600 });
  console.log(chalk.green(`\n✓ Configuration saved to ${CONFIG_FILE}\n`));
  console.log(chalk.gray('Run ' + chalk.white('uagent chat') + ' to start!\n'));
}
