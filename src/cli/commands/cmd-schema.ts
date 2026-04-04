import chalk from 'chalk';
import type { Command } from 'commander';

export function registerSchemaCommands(program: Command): void {
  const schemaCmd = program.command('schema').description('Manage database schemas for schema-driven SQL generation');

  schemaCmd.command('list')
    .description('List all loaded schemas from .uagent/schemas/')
    .action(async () => {
      const { getSchemasSummary } = await import('../../domains/data/tools/schema-loader.js');
      console.log(chalk.yellow('\n📊 Loaded Schemas:\n'));
      console.log(getSchemasSummary(process.cwd()));
      console.log(chalk.gray('\n  Place DDL files in .uagent/schemas/*.sql or *.json\n'));
    });

  schemaCmd.command('search <query>')
    .description('Find tables matching a natural language query')
    .action(async (query) => {
      const { matchSchemas } = await import('../../domains/data/tools/schema-loader.js');
      const matches = matchSchemas(query, 5, process.cwd());
      if (!matches.length) {
        console.log(chalk.gray('\n  No matching tables found.\n'));
        return;
      }
      console.log(chalk.yellow(`\n🔍 Schema matches for: "${query}"\n`));
      for (const m of matches) {
        console.log(`  ${chalk.cyan(m.table.tableName.padEnd(30))} score=${m.score}  ${chalk.gray(m.matchedTerms.slice(0, 3).join(', '))}`);
        if (m.table.comment) console.log(`  ${chalk.gray('  ' + m.table.comment)}`);
      }
      console.log();
    });

  schemaCmd.command('init')
    .description('Create .uagent/schemas/ directory with an example DDL file')
    .action(async () => {
      const { mkdirSync, existsSync, writeFileSync } = await import('fs');
      const { join } = await import('path');
      const dir = join(process.cwd(), '.uagent', 'schemas');
      mkdirSync(dir, { recursive: true });
      const example = join(dir, 'example.sql');
      if (!existsSync(example)) {
        writeFileSync(example, [
          '-- Example schema file for schema-driven SQL generation',
          '-- Place your actual DDL files here (.sql or .json format)',
          '',
          'CREATE TABLE users (',
          "  id         INT          NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'User ID',",
          "  name       VARCHAR(100) NOT NULL COMMENT 'Full name',",
          "  email      VARCHAR(255) NOT NULL COMMENT 'Email address',",
          "  created_at DATETIME     NOT NULL COMMENT 'Account creation timestamp'",
          ") COMMENT = 'Registered users';",
          '',
          'CREATE TABLE orders (',
          "  id         INT    NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'Order ID',",
          "  user_id    INT    NOT NULL COMMENT 'Reference to users.id',",
          "  amount     DECIMAL(10,2) NOT NULL COMMENT 'Order total in USD',",
          "  status     VARCHAR(20)  NOT NULL COMMENT 'pending|paid|shipped|cancelled',",
          "  created_at DATETIME     NOT NULL COMMENT 'Order creation timestamp'",
          ") COMMENT = 'Customer orders';",
        ].join('\n'), 'utf8');
        console.log(chalk.green(`✓ Created ${example}`));
      } else {
        console.log(chalk.gray(`Already exists: ${example}`));
      }
      console.log(chalk.gray('  Replace example.sql with your real DDL files to enable schema-driven SQL generation.'));
    });
}
