/**
 * SubsystemLogger
 *
 * Inspired by openclaw's src/logging/subsystem.ts
 *
 * Structured, per-subsystem logger with:
 *  - 5 log levels: trace / debug / info / warn / error
 *  - Per-subsystem color-coded console output
 *  - Respect AGENT_LOG_LEVEL env var (default: "info")
 *  - Respect AGENT_VERBOSE=1 to show debug output
 *  - Silent in production unless AGENT_LOG env is set
 */

import chalk from 'chalk';

// ── Types ──────────────────────────────────────────────────────────────────────

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

export interface SubsystemLogger {
  subsystem: string;
  isEnabled(level: LogLevel): boolean;
  trace(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(name: string): SubsystemLogger;
}

// ── Config ────────────────────────────────────────────────────────────────────

function resolveMinLevel(): LogLevel {
  const env = process.env.AGENT_LOG_LEVEL?.toLowerCase();
  if (env && env in LEVEL_ORDER) return env as LogLevel;
  if (process.env.AGENT_VERBOSE === '1') return 'debug';
  return 'info';
}

// Live-read so tests can override between calls
function getMinLevel(): number {
  return LEVEL_ORDER[resolveMinLevel()];
}

// ── Colors ────────────────────────────────────────────────────────────────────

const SUBSYSTEM_COLORS = [
  chalk.cyan,
  chalk.green,
  chalk.yellow,
  chalk.blue,
  chalk.magenta,
] as const;

const colorCache = new Map<string, (typeof SUBSYSTEM_COLORS)[number]>();
let colorIndex = 0;

function pickColor(subsystem: string): (typeof SUBSYSTEM_COLORS)[number] {
  if (!colorCache.has(subsystem)) {
    colorCache.set(subsystem, SUBSYSTEM_COLORS[colorIndex % SUBSYSTEM_COLORS.length]);
    colorIndex++;
  }
  return colorCache.get(subsystem)!;
}

const LEVEL_LABELS: Record<LogLevel, string> = {
  trace: chalk.gray('TRACE'),
  debug: chalk.gray('DEBUG'),
  info:  chalk.blueBright('INFO '),
  warn:  chalk.yellow('WARN '),
  error: chalk.red('ERROR'),
};

/**
 * Safe JSON serialiser — handles circular references and non-serialisable
 * values (functions, Buffers, etc.) without throwing.
 * Falls back to util.inspect for any value that JSON.stringify cannot handle.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    // Circular reference or other non-serialisable value — use util.inspect
    // which handles circular refs gracefully (prints [Circular *1] etc.)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { inspect } = require('node:util') as typeof import('node:util');
    return inspect(value, { depth: 4, breakLength: Infinity });
  }
}

// ── Core ──────────────────────────────────────────────────────────────────────

function writeLog(
  level: LogLevel,
  subsystem: string,
  message: string,
  meta?: Record<string, unknown>,
): void {
  if (LEVEL_ORDER[level] < getMinLevel()) return;

  const color = pickColor(subsystem);
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const label = LEVEL_LABELS[level];
  const prefix = `${chalk.gray(ts)} ${label} ${color(`[${subsystem}]`)}`;

  const metaStr = meta && Object.keys(meta).length > 0
    ? ' ' + chalk.gray(safeStringify(meta))
    : '';

  const out = `${prefix} ${message}${metaStr}`;

  if (level === 'error' || level === 'warn') {
    process.stderr.write(out + '\n');
  } else {
    process.stdout.write(out + '\n');
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createLogger(subsystem: string): SubsystemLogger {
  const logger: SubsystemLogger = {
    subsystem,
    isEnabled(level: LogLevel): boolean {
      return LEVEL_ORDER[level] >= getMinLevel();
    },
    trace(message, meta?) { writeLog('trace', subsystem, message, meta); },
    debug(message, meta?) { writeLog('debug', subsystem, message, meta); },
    info(message, meta?)  { writeLog('info',  subsystem, message, meta); },
    warn(message, meta?)  { writeLog('warn',  subsystem, message, meta); },
    error(message, meta?) { writeLog('error', subsystem, message, meta); },
    child(name: string): SubsystemLogger {
      return createLogger(`${subsystem}/${name}`);
    },
  };
  return logger;
}

// ── Root logger ───────────────────────────────────────────────────────────────

export const rootLogger = createLogger('agent');
