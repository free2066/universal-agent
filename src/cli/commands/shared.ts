/**
 * Shared helpers used across CLI command modules.
 * Extracted from src/cli/index.ts to avoid circular deps.
 */

import chalk from 'chalk';
import { modelManager } from '../../models/model-manager.js';

export const VALID_DOMAINS = ['auto', 'data', 'dev', 'service'];

export function validateDomain(domain: string): void {
  if (!VALID_DOMAINS.includes(domain)) {
    console.error(chalk.red(`\n✗ Invalid domain: "${domain}"`));
    console.error(chalk.yellow(`  Valid domains: ${VALID_DOMAINS.join(', ')}`));
    process.exit(1);
  }
}

export function validateModel(model: string): void {
  const knownPrefixes = [
    // OpenAI
    'gpt-', 'o1', 'o3', 'o4',
    // Anthropic
    'claude-',
    // Google
    'gemini-',
    // DeepSeek / Moonshot / Qwen
    'deepseek', 'moonshot', 'kimi', 'qwen', 'qwq',
    // Mistral
    'mistral', 'mixtral',
    // Prefixed providers
    'ollama:', 'groq:', 'siliconflow:', 'openrouter:',
    // 万擎 (Kuaishou internal) — format: "wanqing/<model-id>"
    'wanqing/',
  ];
  const isKnown = knownPrefixes.some((p) => model.startsWith(p));
  if (!isKnown) {
    const profiles = modelManager.listProfiles();
    const isRegistered = profiles.some((p) => p.name === model || p.modelName === model);
    if (!isRegistered) {
      console.error(chalk.red(`\n✗ Unknown model: "${model}"`));
      console.error(chalk.yellow(`  Run: uagent models list  — to see available models`));
      console.error(chalk.gray(`  Or use a known prefix: gpt-*, claude-*, gemini-*, deepseek*, wanqing/*, ollama:<name>`));
      process.exit(1);
    }
  }
  if (model.includes('_') && !model.startsWith('ollama:')) {
    console.error(chalk.red(`\n✗ Suspicious model name: "${model}" (contains underscore)`));
    console.error(chalk.yellow(`  Real model IDs use hyphens, not underscores (e.g. gpt-4o, claude-3-5-sonnet-20241022)`));
    console.error(chalk.gray(`  Run: uagent models list  — to see available models`));
    process.exit(1);
  }
}

/**
 * Infer which env var name is likely missing based on an error message.
 * Used to jump directly to the right key prompt in configureAgent().
 */
export function inferProviderEnvKey(errMsg: string): string | undefined {
  if (errMsg.includes('gemini')      || errMsg.includes('GEMINI'))      return 'GEMINI_API_KEY';
  if (errMsg.includes('groq')        || errMsg.includes('GROQ'))        return 'GROQ_API_KEY';
  if (errMsg.includes('openrouter')  || errMsg.includes('OPENROUTER'))  return 'OPENROUTER_API_KEY';
  if (errMsg.includes('deepseek')    || errMsg.includes('DEEPSEEK'))    return 'DEEPSEEK_API_KEY';
  if (errMsg.includes('anthropic')   || errMsg.includes('ANTHROPIC'))   return 'ANTHROPIC_API_KEY';
  if (errMsg.includes('siliconflow') || errMsg.includes('SILICONFLOW')) return 'SILICONFLOW_API_KEY';
  return undefined;
}
