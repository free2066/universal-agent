import chalk from 'chalk';
import type { Command } from 'commander';
import { MCPManager } from '../../core/mcp-manager.js';

export function registerMcpCommands(program: Command): void {
  const mcpCmd = program.command('mcp').description('Manage MCP servers (Model Context Protocol)');

  mcpCmd.command('list').description('List all configured MCP servers').action(() => {
    const mgr = new MCPManager();
    const servers = mgr.listServers();
    if (!servers.length) {
      console.log(chalk.gray('No MCP servers configured.'));
      console.log(chalk.gray('  Run: uagent mcp init          — create .mcp.json'));
      console.log(chalk.gray('  Run: uagent mcp add --help    — add a server'));
      console.log(chalk.gray('  Run: uagent mcp templates     — browse built-in templates'));
      return;
    }
    console.log(chalk.yellow('\n🔌 MCP Servers:\n'));
    for (const s of servers) {
      const status = s.enabled ? chalk.green('✓ enabled ') : chalk.red('✗ disabled');
      const addr = s.type === 'stdio' ? `${s.command} ${(s.args ?? []).join(' ')}`.slice(0, 60) : (s.url ?? '');
      const desc = s.description ? chalk.gray(`  — ${s.description}`) : '';
      console.log(`  ${status}  ${chalk.white(s.name.padEnd(16))} [${s.type}] ${addr}${desc}`);
    }
    console.log();
    console.log(chalk.gray('  uagent mcp test <name>     — test a server connection'));
    console.log(chalk.gray('  uagent mcp enable <name>   — enable a server'));
    console.log(chalk.gray('  uagent mcp disable <name>  — disable a server'));
    console.log();
  });

  mcpCmd.command('init')
    .description('Initialize .mcp.json in the current directory')
    .option('--templates', 'Include all built-in template servers (as disabled examples)')
    .action((options) => {
      const result = MCPManager.initConfig(process.cwd(), options.templates);
      console.log(chalk.green(result));
      console.log(chalk.gray('  Edit .mcp.json to configure your MCP servers.'));
      console.log(chalk.gray('  Run: uagent mcp templates  — to see available built-in templates'));
    });

  mcpCmd.command('templates').description('Show built-in MCP server templates').action(() => {
    console.log(chalk.yellow('\n📦 Built-in MCP Templates:\n'));
    for (const [name, tmpl] of Object.entries(MCPManager.TEMPLATES)) {
      console.log(`  ${chalk.cyan(name.padEnd(14))} ${tmpl.description}`);
      console.log(`  ${''.padEnd(14)} ${chalk.gray('Setup: ' + tmpl.setupHint)}`);
      console.log();
    }
    console.log(chalk.gray('  Add a template:  uagent mcp add --template <name>'));
    console.log(chalk.gray('  Or init all:     uagent mcp init --templates\n'));
  });

  mcpCmd.command('add')
    .description('Add an MCP server to .mcp.json')
    .option('--name <name>', 'Server name')
    .option('--template <template>', 'Use a built-in template (run: uagent mcp templates to see list)')
    .option('--type <type>', 'Server type: stdio | sse | http', 'stdio')
    .option('--command <cmd>', 'Command to run (for stdio servers)')
    .option('--args <args>', 'Comma-separated arguments')
    .option('--url <url>', 'Server URL (for sse/http servers)')
    .option('--env <env>', 'Comma-separated ENV=VALUE pairs')
    .option('--disabled', 'Add as disabled (enabled by default)')
    .action((options) => {
      const mgr = new MCPManager();

      if (options.template) {
        const tmpl = MCPManager.TEMPLATES[options.template];
        if (!tmpl) {
          console.error(chalk.red(`Template "${options.template}" not found. Run: uagent mcp templates`));
          process.exit(1);
        }
        const name = options.name ?? options.template;
        const { setupHint, description, ...serverConfig } = tmpl;
        mgr.addServer(name, { ...serverConfig, enabled: !options.disabled, description });
        console.log(chalk.green(`✓ Added "${name}" from template.`));
        console.log(chalk.yellow(`  Setup: ${setupHint}`));
        if (serverConfig.env) {
          console.log(chalk.gray(`  Edit .mcp.json and replace placeholder values in "env":`));
          for (const [k, v] of Object.entries(serverConfig.env)) {
            console.log(chalk.gray(`    ${k}=${v}`));
          }
        }
        return;
      }

      const name = options.name;
      if (!name) {
        console.error(chalk.red('--name is required (or use --template)'));
        process.exit(1);
      }

      const envPairs: Record<string, string> = {};
      if (options.env) {
        for (const pair of String(options.env).split(',')) {
          const [k, ...rest] = pair.split('=');
          if (k) envPairs[k.trim()] = rest.join('=').trim();
        }
      }

      const type = options.type as 'stdio' | 'sse' | 'http';
      if (type === 'stdio' && !options.command) {
        console.error(chalk.red('--command is required for stdio servers'));
        process.exit(1);
      }
      if ((type === 'sse' || type === 'http') && !options.url) {
        console.error(chalk.red('--url is required for sse/http servers'));
        process.exit(1);
      }

      mgr.addServer(name, {
        type,
        command: options.command,
        args: options.args ? String(options.args).split(',').map((a: string) => a.trim()) : undefined,
        url: options.url,
        env: Object.keys(envPairs).length > 0 ? envPairs : undefined,
        enabled: !options.disabled,
      });
      console.log(chalk.green(`✓ Server "${name}" added to ${process.cwd()}/.mcp.json`));
      console.log(chalk.gray('  Run: uagent mcp test ' + name + '  — to verify the connection'));
    });

  mcpCmd.command('remove <name>').description('Remove an MCP server from .mcp.json').action((name) => {
    const mgr = new MCPManager();
    const removed = mgr.removeServer(name);
    if (removed) {
      console.log(chalk.green(`✓ Server "${name}" removed.`));
    } else {
      console.error(chalk.red(`Server "${name}" not found.`));
    }
  });

  mcpCmd.command('enable <name>').description('Enable an MCP server').action((name) => {
    const mgr = new MCPManager();
    if (mgr.enableServer(name, true)) {
      console.log(chalk.green(`✓ Server "${name}" enabled.`));
    } else {
      console.error(chalk.red(`Server "${name}" not found.`));
    }
  });

  mcpCmd.command('disable <name>').description('Disable an MCP server (keeps config, stops loading)').action((name) => {
    const mgr = new MCPManager();
    if (mgr.enableServer(name, false)) {
      console.log(chalk.green(`✓ Server "${name}" disabled.`));
    } else {
      console.error(chalk.red(`Server "${name}" not found.`));
    }
  });

  mcpCmd.command('get <name>').description('Show detailed config for a specific MCP server').action((name) => {
    const mgr = new MCPManager();
    const servers = mgr.listServers();
    const s = servers.find((sv) => sv.name === name);
    if (!s) {
      console.error(chalk.red(`\n✗ Server "${name}" not found.`));
      console.log(chalk.gray('  Run: uagent mcp list  — to see configured servers'));
      process.exit(1);
    }
    console.log(chalk.yellow(`\n🔌 MCP Server: ${s.name}\n`));
    console.log(`  Status:  ${s.enabled ? chalk.green('enabled') : chalk.red('disabled')}`);
    console.log(`  Type:    ${chalk.cyan(s.type)}`);
    if (s.command) console.log(`  Command: ${chalk.white(s.command)}`);
    if (s.args?.length) console.log(`  Args:    ${s.args.join(' ')}`);
    if (s.url) console.log(`  URL:     ${chalk.white(s.url)}`);
    if (s.description) console.log(`  Desc:    ${chalk.gray(s.description)}`);
    if (s.env && Object.keys(s.env).length > 0) {
      console.log(`  Env:`);
      for (const [k, v] of Object.entries(s.env)) {
        const masked = /key|token|secret|pass/i.test(k) ? v.slice(0, 4) + '****' : v;
        console.log(`    ${chalk.gray(k + '=')}${masked}`);
      }
    }
    console.log();
    console.log(chalk.gray('  uagent mcp test ' + name + '  — test connection'));
    console.log(chalk.gray('  uagent mcp enable ' + name + ' / disable ' + name + '  — toggle'));
    console.log();
  });

  mcpCmd.command('test [name]')
    .description('Test MCP server connection(s). Omit name to test all enabled servers.')
    .action(async (name?: string) => {
      const mgr = new MCPManager();
      const servers = name
        ? mgr.listServers().filter((s) => s.name === name)
        : mgr.listServers().filter((s) => s.enabled);

      if (servers.length === 0) {
        console.log(chalk.gray(name ? `Server "${name}" not found.` : 'No enabled servers to test.'));
        return;
      }

      console.log(chalk.yellow(`\n🔌 Testing ${servers.length} MCP server(s)...\n`));
      for (const s of servers) {
        process.stdout.write(`  ${s.name}... `);
        const result = await mgr.testServer(s.name);
        console.log(result);
      }
      console.log();
    });
}
