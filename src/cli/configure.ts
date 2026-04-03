/// <reference types="node" />
import { createInterface } from 'readline';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { resolve } from 'path';
import chalk from 'chalk';

const CONFIG_DIR = resolve(process.env.HOME || '~', '.uagent');
const ENV_FILE   = resolve(CONFIG_DIR, '.env');
// Also write to project-level .env if it exists, so dotenv picks it up
const PROJECT_ENV = resolve(process.cwd(), '.env');

// ── Helpers ───────────────────────────────────────────────────────────────────

function readEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const result: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (k) result[k] = v;
  }
  return result;
}

function writeEnv(path: string, config: Record<string, string>) {
  // Merge: read existing, overwrite changed keys, keep unrelated keys
  const existing = readEnv(path);
  const merged   = { ...existing, ...config };
  const content  = Object.entries(merged)
    .filter(([, v]) => v)          // drop empty values
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n';
  writeFileSync(path, content, { mode: 0o600 });
}

/** Mask a key for display: show first 8 chars + ... */
function mask(val?: string) {
  if (!val) return chalk.gray('not set');
  return chalk.green(val.slice(0, 8) + '...');
}

// ── Provider catalog ─────────────────────────────────────────────────────────

interface ProviderInfo {
  label: string;          // Display name
  envKey: string;         // Env var name
  freeUrl: string;        // Where to get the key for free
  hint: string;           // Short hint shown to user
  isFree: boolean;        // Whether there's a free tier
}

const PROVIDERS: ProviderInfo[] = [
  {
    label: 'OpenRouter',
    envKey: 'OPENROUTER_API_KEY',
    freeUrl: 'https://openrouter.ai/keys',
    hint: '100+ free open-source models, no credit card needed',
    isFree: true,
  },
  {
    label: 'Google Gemini',
    envKey: 'GEMINI_API_KEY',
    freeUrl: 'https://aistudio.google.com/apikey',
    hint: '1500 free requests/day, 1M context window',
    isFree: true,
  },
  {
    label: 'Groq',
    envKey: 'GROQ_API_KEY',
    freeUrl: 'https://console.groq.com',
    hint: '14,400 free requests/day, ultra-fast llama3/deepseek',
    isFree: true,
  },
  {
    label: 'SiliconFlow',
    envKey: 'SILICONFLOW_API_KEY',
    freeUrl: 'https://siliconflow.cn',
    hint: '14M free tokens/month, many open-source models',
    isFree: true,
  },
  {
    label: 'DeepSeek',
    envKey: 'DEEPSEEK_API_KEY',
    freeUrl: 'https://platform.deepseek.com',
    hint: 'Free signup credits, very cheap after',
    isFree: true,
  },
  {
    label: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    freeUrl: 'https://platform.openai.com/api-keys',
    hint: 'GPT-4o, GPT-4.1 (paid, no free tier)',
    isFree: false,
  },
  {
    label: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    freeUrl: 'https://console.anthropic.com',
    hint: 'Claude 3.5/4 series (paid, no free tier)',
    isFree: false,
  },
];

// ── Main configure function ───────────────────────────────────────────────────

/**
 * Interactive API key setup wizard.
 *
 * @param triggerReason  If provided, shown as a banner explaining WHY config was triggered
 *                       (e.g. "No working API key found — let's set one up!")
 * @param focusKey       If provided, jump directly to this env var (e.g. 'OPENROUTER_API_KEY')
 */
export async function configureAgent(triggerReason?: string, focusKey?: string) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });

  // Merge existing keys from both locations
  const existing = { ...readEnv(ENV_FILE), ...readEnv(PROJECT_ENV) };

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const question = (q: string): Promise<string> =>
    new Promise((res) => rl.question(q, (ans) => res(ans.trim())));

  // ── Banner ────────────────────────────────────────────────────────────────
  console.log(chalk.cyan('\n╔══════════════════════════════════════════════════════════════╗'));
  console.log(chalk.cyan('║') + chalk.bold.white('  🔧  Universal Agent — API Key Setup') + chalk.cyan('                       ║'));
  console.log(chalk.cyan('╚══════════════════════════════════════════════════════════════╝\n'));

  if (triggerReason) {
    console.log(chalk.yellow(`⚠  ${triggerReason}\n`));
  }

  console.log(chalk.gray('  You only need ONE key to get started.'));
  console.log(chalk.gray('  Recommended: OpenRouter (free, no credit card)\n'));
  console.log(chalk.gray('  Press Enter to keep existing value. Type "-" to clear a key.\n'));

  const updates: Record<string, string> = {};

  // If focusKey provided, show that provider first with extra emphasis
  const sortedProviders = focusKey
    ? [
        ...PROVIDERS.filter((p) => p.envKey === focusKey),
        ...PROVIDERS.filter((p) => p.envKey !== focusKey),
      ]
    : PROVIDERS;

  for (const p of sortedProviders) {
    const current = existing[p.envKey];
    const badge = p.isFree ? chalk.green('[FREE]') : chalk.gray('[paid]');
    const focused = p.envKey === focusKey ? chalk.yellow(' ← recommended for your situation') : '';

    console.log(`${badge} ${chalk.white(p.label)}${focused}`);
    console.log(chalk.gray(`       ${p.hint}`));
    console.log(chalk.gray(`       Get key: ${p.freeUrl}`));

    const prompt =
      chalk.white(`  ${p.envKey}`) +
      chalk.gray(` [${mask(current)}]`) +
      ': ';

    const ans = await question(prompt);

    if (ans === '-') {
      updates[p.envKey] = '';   // user explicitly wants to clear
    } else if (ans) {
      updates[p.envKey] = ans;
      // Immediately set in current process so rest of session works
      process.env[p.envKey] = ans;
    }
    // else: keep existing, no update needed
    console.log();
  }

  // ── Ollama base URL ───────────────────────────────────────────────────────
  console.log(chalk.gray('[local] ') + chalk.white('Ollama'));
  console.log(chalk.gray('        Run models locally, completely free: https://ollama.com'));
  const ollamaAns = await question(
    chalk.white('  OLLAMA_BASE_URL') +
    chalk.gray(` [${existing.OLLAMA_BASE_URL || 'http://localhost:11434'}]`) +
    ': ',
  );
  if (ollamaAns) updates['OLLAMA_BASE_URL'] = ollamaAns;

  rl.close();

  // ── Persist ───────────────────────────────────────────────────────────────
  const toWrite: Record<string, string> = {};
  for (const [k, v] of Object.entries(updates)) {
    if (v !== '') toWrite[k] = v;  // don't write empty keys
  }

  if (Object.keys(toWrite).length === 0) {
    console.log(chalk.gray('\n  No changes made.\n'));
    return;
  }

  // Write to both locations for maximum compatibility
  writeEnv(ENV_FILE, toWrite);
  // Also update project .env if it already exists
  if (existsSync(PROJECT_ENV)) writeEnv(PROJECT_ENV, toWrite);

  console.log(chalk.green(`\n✓ Saved ${Object.keys(toWrite).length} key(s) to ${ENV_FILE}`));
  if (existsSync(PROJECT_ENV)) {
    console.log(chalk.green(`✓ Also updated ${PROJECT_ENV}`));
  }
  console.log(chalk.gray('\nRun ' + chalk.white('uagent') + ' to start!\n'));
}

// ── Quick single-key setter (called programmatically after auth failure) ──────

/**
 * Lightweight version: ask for just ONE key and save it.
 * Called automatically when a model call fails with 401/403.
 *
 * @param envKey       e.g. 'OPENROUTER_API_KEY'
 * @param providerName e.g. 'OpenRouter'
 * @param freeUrl      Link to get the key
 * @returns The key the user provided, or null if skipped
 */
export async function promptForSingleKey(
  envKey: string,
  providerName: string,
  freeUrl: string,
): Promise<string | null> {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const question = (q: string): Promise<string> =>
    new Promise((res) => rl.question(q, (ans) => res(ans.trim())));

  console.log(chalk.yellow(`\n⚠  ${providerName} API key not set or invalid.`));
  console.log(chalk.gray(`   Get a free key at: ${chalk.white(freeUrl)}\n`));

  const ans = await question(
    chalk.white(`  Paste your ${providerName} API key`) +
    chalk.gray(' (Enter to skip): '),
  );
  rl.close();

  if (!ans) {
    console.log(chalk.gray('  Skipped.\n'));
    return null;
  }

  // Save to env files
  const toWrite = { [envKey]: ans };
  writeEnv(ENV_FILE, toWrite);
  if (existsSync(PROJECT_ENV)) writeEnv(PROJECT_ENV, toWrite);
  process.env[envKey] = ans;

  console.log(chalk.green(`✓ Key saved to ${ENV_FILE}\n`));
  return ans;
}
