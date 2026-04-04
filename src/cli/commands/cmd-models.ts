import chalk from 'chalk';
import type { Command } from 'commander';
import { modelManager } from '../../models/model-manager.js';

export function registerModelsCommands(program: Command): void {
  const modelsCmd = program.command('models').description('Manage AI model profiles');

  modelsCmd.command('list').description('List configured models').action(() => {
    console.log(chalk.yellow('\n🤖 Model Profiles:\n'));
    const profiles = modelManager.listProfiles();
    const pointers = modelManager.getPointers();
    for (const p of profiles) {
      const isActive = Object.values(pointers).includes(p.name);
      const marker = isActive ? chalk.green('●') : chalk.gray('○');
      const role = Object.entries(pointers).filter(([, v]) => v === p.name).map(([k]) => k).join('/');
      console.log(`  ${marker} ${chalk.white(p.name.padEnd(22))} ${chalk.gray(p.provider + ':' + p.modelName)} ${role ? chalk.cyan(`[${role}]`) : ''}`);
    }
    console.log(chalk.gray('\n  Pointers: main, task, compact, quick\n'));
  });

  modelsCmd.command('export')
    .description('Export model config as YAML')
    .option('-o, --output <file>', 'Output file')
    .action(async (options) => {
      const yaml = modelManager.exportYAML();
      if (options.output) {
        const { writeFileSync } = await import('fs');
        const { resolve: pathResolve } = await import('path');
        const outPath = pathResolve(process.cwd(), options.output);
        writeFileSync(outPath, yaml);
        console.log(chalk.green(`✓ Exported to ${outPath}`));
      } else {
        console.log(yaml);
      }
    });

  modelsCmd.command('set <pointer> <model>')
    .description('Set a model pointer (main|task|compact|quick)')
    .action((pointer, model) => {
      modelManager.setPointer(pointer as never, model);
      console.log(chalk.green(`✓ Set ${pointer} → ${model}`));
    });

  modelsCmd.command('add <name>')
    .description('Register a custom model profile')
    .requiredOption('--model-name <modelName>', 'Actual model name sent to the API (e.g. gpt-4o-2024-11-20)')
    .option('--provider <provider>', 'Provider: openai|anthropic|gemini|deepseek|groq|siliconflow|openrouter|ollama|custom', 'custom')
    .option('--base-url <url>', 'Custom API base URL (for openai-compat or private endpoints)')
    .option('--api-key <key>', 'API key (stored in profile; prefer env vars instead)')
    .option('--max-tokens <n>', 'Max output tokens', '8192')
    .option('--context <n>', 'Context window size', '128000')
    .option('--cost-in <usd>', 'Cost per 1k input tokens (USD)', '0')
    .option('--cost-out <usd>', 'Cost per 1k output tokens (USD)', '0')
    .option('--set-as <pointer>', 'Also set this profile as a pointer (main|task|compact|quick)')
    .action((name, options) => {
      const validProviders = ['openai', 'anthropic', 'ollama', 'gemini', 'deepseek', 'moonshot', 'qwen', 'mistral', 'groq', 'siliconflow', 'openrouter', 'custom'];
      if (!validProviders.includes(options.provider)) {
        console.error(chalk.red(`✗ Unknown provider "${options.provider}". Valid: ${validProviders.join(', ')}`));
        process.exit(1);
      }
      const profile = {
        name,
        provider: options.provider as never,
        modelName: options.modelName,
        ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        maxTokens: parseInt(options.maxTokens),
        contextLength: parseInt(options.context),
        costPer1kInput: parseFloat(options.costIn),
        costPer1kOutput: parseFloat(options.costOut),
        isActive: true,
      };
      modelManager.addProfile(profile);
      console.log(chalk.green(`✓ Added model profile: ${name}`));
      console.log(chalk.gray(`  provider: ${profile.provider}  modelName: ${profile.modelName}  context: ${profile.contextLength.toLocaleString()} tokens`));
      if (options.setAs) {
        modelManager.setPointer(options.setAs as never, name);
        console.log(chalk.green(`✓ Set ${options.setAs} → ${name}`));
      } else {
        console.log(chalk.gray(`  Tip: uagent models set main ${name}  — to use this model`));
      }
    });

  modelsCmd.command('remove <name>')
    .description('Remove a custom model profile')
    .action((name) => {
      const profiles = modelManager.listProfiles();
      const exists = profiles.some((p) => p.name === name);
      if (!exists) {
        console.error(chalk.red(`✗ Model "${name}" not found`));
        process.exit(1);
      }
      const pointers = modelManager.getPointers();
      const inUse = Object.entries(pointers).filter(([, v]) => v === name).map(([k]) => k);
      if (inUse.length > 0) {
        console.error(chalk.yellow(`⚠  Model "${name}" is currently used as pointer(s): ${inUse.join(', ')}`));
        console.error(chalk.yellow('   Update the pointer(s) first: uagent models set <pointer> <other-model>'));
        process.exit(1);
      }
      modelManager.removeProfile(name);
      console.log(chalk.green(`✓ Removed model profile: ${name}`));
    });
}
