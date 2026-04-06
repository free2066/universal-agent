/**
 * handlers/auth-handlers.ts
 * F13: /login 命令 — API Key 登录（claude-code /login 命令对标）
 *
 * claude-code 有完整的 OAuth 2.0 PKCE 流程；
 * 我们实现简化版：引导用户输入 Anthropic API Key 并写入 global config。
 */

import chalk from 'chalk';
import type { SlashContext } from './shared.js';
import { done } from './shared.js';

/**
 * F13: /login — 引导用户配置 Anthropic API Key
 * 对标 claude-code /login 命令（简化版，无完整 OAuth，但功能等价）
 */
export async function handleLogin(ctx: SlashContext): Promise<true> {
  const { rl } = ctx;
  rl.pause();
  process.stdout.write('\n');

  // 检查当前登录状态
  const currentKey = process.env.ANTHROPIC_API_KEY;
  if (currentKey) {
    const maskedKey = currentKey.slice(0, 12) + '...' + currentKey.slice(-4);
    process.stdout.write(chalk.yellow(`Already authenticated.\n`));
    process.stdout.write(chalk.gray(`  API key: ${maskedKey}\n`));
    process.stdout.write(chalk.gray('  To switch accounts, use /logout first, then /login again.\n\n'));
    rl.resume();
    return done(rl);
  }

  // 检查 config 中是否有 API key
  try {
    const { loadConfig } = await import('../../config-store.js');
    const cfg = loadConfig();
    if ((cfg as Record<string, unknown>)['anthropicApiKey']) {
      process.stdout.write(chalk.yellow('API key already set in config.\n'));
      process.stdout.write(chalk.gray('  Use /logout to clear it, then /login to set a new one.\n\n'));
      rl.resume();
      return done(rl);
    }
  } catch { /* ignore */ }

  process.stdout.write(chalk.cyan('Login to Anthropic\n'));
  process.stdout.write(chalk.gray('─'.repeat(50) + '\n'));
  process.stdout.write('Get your API key at: ');
  process.stdout.write(chalk.underline('https://console.anthropic.com/settings/keys\n\n'));

  // 使用 readline 读取 API key（显示为正常输入，readline 不支持 password masking）
  rl.resume();
  rl.question(chalk.cyan('Enter your Anthropic API Key (sk-ant-...): '), async (apiKey: string) => {
    rl.pause();
    const trimmed = apiKey.trim();

    if (!trimmed) {
      process.stdout.write(chalk.yellow('\nNo key entered. Login cancelled.\n\n'));
      rl.resume();
      return;
    }

    if (!trimmed.startsWith('sk-')) {
      process.stdout.write(chalk.red('\nInvalid API key format (should start with "sk-").\n'));
      process.stdout.write(chalk.gray('  Please check your key at https://console.anthropic.com/\n\n'));
      rl.resume();
      return;
    }

    try {
      const { setConfigValue } = await import('../../config-store.js');
      // 保存到 global config（隐私字段）
      setConfigValue('anthropicApiKey', trimmed, true /* global */);
      // 本次 session 立即生效
      process.env.ANTHROPIC_API_KEY = trimmed;

      const maskedKey = trimmed.slice(0, 12) + '...' + trimmed.slice(-4);
      process.stdout.write(chalk.green(`\nAuthenticated successfully.\n`));
      process.stdout.write(chalk.gray(`  API key: ${maskedKey}\n`));
      process.stdout.write(chalk.gray('  Saved to global config (~/.codeflicker/config.json).\n'));
      process.stdout.write(chalk.gray('  For permanent use, set ANTHROPIC_API_KEY in your shell.\n\n'));
    } catch (err) {
      process.stdout.write(chalk.red(`\nFailed to save API key: ${err instanceof Error ? err.message : String(err)}\n\n`));
    }

    rl.resume();
  });

  return true as const;
}
