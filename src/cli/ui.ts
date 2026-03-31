import chalk from 'chalk';

export function printBanner() {
  console.log(chalk.cyan(`
╔═══════════════════════════════════════════╗
║   🤖  Universal Agent CLI  v0.1.0         ║
║   Multi-domain AI powered assistant       ║
╚═══════════════════════════════════════════╝`));
  console.log(chalk.gray('  Domains: data | dev | service | auto\n'));
}

export function printHelp() {
  console.log(chalk.yellow('\n📚 Available Commands:'));
  console.log(chalk.white('  /help          ') + chalk.gray('Show this help message'));
  console.log(chalk.white('  /domain <name> ') + chalk.gray('Switch domain (data|dev|service|auto)'));
  console.log(chalk.white('  /clear         ') + chalk.gray('Clear conversation history'));
  console.log(chalk.white('  /exit          ') + chalk.gray('Exit the agent\n'));

  console.log(chalk.yellow('💡 Example Prompts:'));
  console.log(chalk.gray('  [data]    ') + '"Analyze this CSV file for user retention"');
  console.log(chalk.gray('  [data]    ') + '"Generate EDA report for sales.csv"');
  console.log(chalk.gray('  [data]    ') + '"Optimize this SQL query: SELECT * FROM..."');
  console.log(chalk.gray('  [dev]     ') + '"Review this Python function for bugs"');
  console.log(chalk.gray('  [dev]     ') + '"Write unit tests for my code"');
  console.log(chalk.gray('  [service] ') + '"Classify this customer complaint"');
  console.log(chalk.gray('  [auto]    ') + '"Help me with anything"\n');
}
