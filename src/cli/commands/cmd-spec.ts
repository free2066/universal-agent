import chalk from 'chalk';
import type { Command } from 'commander';
import ora from 'ora';

export function registerSpecCommands(program: Command): void {
  const specCmd = program.command('spec').description('Generate a technical specification from a requirement description (PRD → Spec)');

  specCmd.command('new <description>')
    .description('Generate a new technical spec from a requirement description')
    .action(async (description) => {
      const spinner = ora('Generating technical spec...').start();
      try {
        const { generateSpec } = await import('../../core/tools/code/spec-generator.js');
        const result = await generateSpec(description, process.cwd());
        spinner.succeed(`Spec saved to ${result.path}`);
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
          console.log(chalk.yellow('\n📋 Extracted tasks:'));
          result.tasks.forEach((t: string, i: number) => console.log(`  ${chalk.gray(String(i + 1) + '.')} ${t}`));
        }
      } catch (err) {
        spinner.fail('Spec generation failed: ' + (err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  specCmd.command('list')
    .description('List all specs for the current project')
    .action(async () => {
      const { listSpecs } = await import('../../core/tools/code/spec-generator.js');
      const specs = listSpecs(process.cwd());
      if (!specs.length) {
        console.log(chalk.gray('\n  No specs found. Run: uagent spec new "<description>"\n'));
        return;
      }
      console.log(chalk.yellow('\n📄 Technical Specs:\n'));
      specs.forEach((s: { date: string; name: string }, i: number) => {
        console.log(`  ${chalk.gray(String(i + 1) + '.')} ${chalk.cyan(s.date)}  ${chalk.white(s.name)}`);
      });
      console.log();
    });

  specCmd.command('show [index]')
    .description('Show a spec (default: most recent)')
    .action(async (index) => {
      const { readSpec } = await import('../../core/tools/code/spec-generator.js');
      const n = index !== undefined ? parseInt(index, 10) : 0;
      const content = readSpec(isNaN(n) ? index : n, process.cwd());
      if (!content) {
        console.log(chalk.red('Spec not found'));
        return;
      }
      console.log('\n' + content);
    });
}
