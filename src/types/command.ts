/**
 * types/command.ts — Command system types
 *
 * Mirrors claude-code's types/command.ts.
 * Defines the shape of CLI commands and slash commands.
 */

/** A registered slash command (e.g. /help, /clear, /model) */
export interface SlashCommand {
  /** The command name without leading slash */
  name: string;
  /** Short description shown in /help */
  description: string;
  /** Usage hint (e.g. "/model [model-name]") */
  usage?: string;
  /** Whether this command takes an argument */
  takesArg?: boolean;
  /** Execute the command */
  handler: (arg?: string, context?: CommandContext) => Promise<string | void>;
  /** Whether the command is visible in /help */
  hidden?: boolean;
}

/** Context passed to command handlers */
export interface CommandContext {
  cwd: string;
  sessionId: string;
  model: string;
  domain?: string;
}

/** A CLI subcommand (e.g. uagent config, uagent model) */
export interface CliSubcommand {
  name: string;
  description: string;
  handler: (args: string[], opts: Record<string, string | boolean>) => Promise<void>;
}
