/**
 * DatabaseQuery Tool — inspired by kstack #15372 "邪修 TDD"
 *
 * Article insight: "改完代码后，AI 需要自主验证数据流转对不对 —— DB 写对了吗？"
 * After calling an API, the Agent should be able to directly query the database
 * to verify that the data was written correctly, without human relay.
 *
 * This tool provides direct SQL query access to:
 *   - SQLite   (via sqlite3 CLI — no extra deps)
 *   - PostgreSQL (via psql CLI)
 *   - MySQL/MariaDB (via mysql CLI)
 *
 * All implemented via CLI binaries — no Node.js database drivers needed.
 * This means zero npm dependencies and compatibility with any environment
 * where the database CLI tools are installed.
 *
 * Features:
 *   - Execute any SELECT query and get structured results
 *   - Auto-detect format: JSON output when possible
 *   - Row limit to prevent flooding context (default: 20 rows)
 *   - Assert conditions: row count, specific field values
 *   - Support for multiple named connection profiles (stored in env vars)
 *
 * Tools:
 *   DatabaseQuery — Execute a SQL query against SQLite, PostgreSQL, or MySQL
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { resolve } from 'path';
import type { ToolRegistration } from '../../../models/types.js';

const execFileAsync = promisify(execFile);

// ── Constants ────────────────────────────────────────────────────────────────
const DB_DEFAULT_TIMEOUT_MS = 15000;
const DB_DEFAULT_LIMIT = 20;
const DB_MAX_LIMIT = 200;
const POSTGRESQL_DEFAULT_PORT = 5432;
const MYSQL_DEFAULT_PORT = 3306;
const TABLE_MAX_DISPLAY_ROWS = 30;
const CSV_MAX_DISPLAY_ROWS = 50;
const COL_MAX_WIDTH = 40;

// ── Types ─────────────────────────────────────────────────────────────────────

type DbType = 'sqlite' | 'postgresql' | 'mysql' | 'mariadb';

interface DbConfig {
  type: DbType;
  // SQLite
  file?: string;
  // PostgreSQL / MySQL
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  // TLS
  ssl?: boolean;
}

interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  columns: string[];
  truncated: boolean;
  queryMs: number;
  raw: string;
}

// ── Config detection ──────────────────────────────────────────────────────────

function detectDbType(args: Record<string, unknown>): DbType {
  if (args.type) return String(args.type).toLowerCase() as DbType;
  if (args.url) {
    const url = String(args.url);
    if (url.startsWith('postgresql://') || url.startsWith('postgres://')) return 'postgresql';
    if (url.startsWith('mysql://') || url.startsWith('mariadb://')) return 'mysql';
    if (url.endsWith('.db') || url.endsWith('.sqlite') || url.endsWith('.sqlite3')) return 'sqlite';
  }
  if (args.file) return 'sqlite';
  // Check env vars
  if (process.env.DATABASE_URL) {
    const url = process.env.DATABASE_URL;
    if (url.startsWith('postgresql://') || url.startsWith('postgres://')) return 'postgresql';
    if (url.startsWith('mysql://')) return 'mysql';
  }
  return 'sqlite';
}

function parseDbUrl(url: string): Partial<DbConfig> {
  try {
    const u = new URL(url);
    const proto = u.protocol.replace(':', '');
    const type: DbType = (proto === 'postgres' || proto === 'postgresql') ? 'postgresql'
      : (proto === 'mysql' || proto === 'mariadb') ? 'mysql'
      : 'sqlite';
    return {
      type,
      host: u.hostname || 'localhost',
      port: u.port ? parseInt(u.port) : (type === 'postgresql' ? POSTGRESQL_DEFAULT_PORT : MYSQL_DEFAULT_PORT),
      database: u.pathname.slice(1) || undefined,
      user: u.username || undefined,
      password: u.password || undefined,
    };
  } catch {
    return {};
  }
}

function buildConfig(args: Record<string, unknown>): DbConfig {
  const type = detectDbType(args);

  if (args.url) {
    const fromUrl = parseDbUrl(String(args.url));
    return { type, ...fromUrl };
  }

  // Check DATABASE_URL env var
  if (!args.host && !args.file && process.env.DATABASE_URL) {
    const fromUrl = parseDbUrl(process.env.DATABASE_URL);
    return { type, ...fromUrl };
  }

  if (type === 'sqlite') {
    const file = args.file ? resolve(String(args.file)) : ':memory:';
    return { type, file };
  }

  return {
    type,
    host: args.host ? String(args.host) : (process.env.DB_HOST ?? 'localhost'),
    port: args.port ? Number(args.port) : (type === 'postgresql' ? POSTGRESQL_DEFAULT_PORT : MYSQL_DEFAULT_PORT),
    database: args.database ? String(args.database) : (process.env.DB_NAME ?? ''),
    user: args.user ? String(args.user) : (process.env.DB_USER ?? ''),
    password: args.password ? String(args.password) : (process.env.DB_PASSWORD ?? ''),
    ssl: Boolean(args.ssl ?? false),
  };
}

// ── Query executors ───────────────────────────────────────────────────────────

async function runSqlite(config: DbConfig, sql: string, limit: number): Promise<QueryResult> {
  const file = config.file || ':memory:';

  // Check file exists (skip for :memory:)
  if (file !== ':memory:' && !existsSync(file)) {
    throw new Error(`SQLite database file not found: ${file}`);
  }

  // CWE-78 fix: pass SQL as a direct CLI argument — no shell interpolation.
  // sqlite3 supports: sqlite3 [options] <file> <sql>
  const limitedSql = /\bLIMIT\b/i.test(sql)
    ? sql.replace(/\n/g, ' ')
    : `${sql.replace(/\n/g, ' ')} LIMIT ${limit}`;

  const startMs = Date.now();
  try {
    const { stdout } = await execFileAsync('sqlite3', ['-json', file, limitedSql], {
      encoding: 'utf-8',
      timeout: DB_DEFAULT_TIMEOUT_MS,
    });
    const raw = stdout.trim();
    const queryMs = Date.now() - startMs;

    if (!raw) return { rows: [], rowCount: 0, columns: [], truncated: false, queryMs, raw: '' };

    const rows = JSON.parse(raw) as Record<string, unknown>[];
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    const truncated = rows.length >= limit;

    return { rows, rowCount: rows.length, columns, truncated, queryMs, raw };
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    const msg = (e.stderr ?? e.message ?? String(err)).trim();
    if (msg.includes('command not found')) {
      throw new Error('sqlite3 CLI not found. Install with: brew install sqlite3 / apt-get install sqlite3');
    }
    throw new Error(`SQLite error: ${msg}`);
  }
}

async function runPostgres(config: DbConfig, sql: string, limit: number): Promise<QueryResult> {
  const host = config.host ?? 'localhost';
  const port = config.port ?? POSTGRESQL_DEFAULT_PORT;
  const db = config.database ?? '';
  const user = config.user ?? '';
  const pass = config.password ?? '';

  // CWE-78 fix: pass SQL and connection info as individual CLI arguments — no shell, no interpolation.
  // Password is passed exclusively via PGPASSWORD env var (never embedded in the command string).
  const limitedSql = /\bLIMIT\b/i.test(sql) ? sql : `${sql} LIMIT ${limit}`;
  const connStr = `postgresql://${user}@${host}:${port}/${db}`;

  const startMs = Date.now();
  try {
    const { stdout } = await execFileAsync(
      'psql',
      [connStr, '--tuples-only', '--csv', '--command', limitedSql],
      {
        encoding: 'utf-8',
        timeout: DB_DEFAULT_TIMEOUT_MS,
        env: { ...process.env as Record<string, string>, PGPASSWORD: pass },
      },
    );
    const raw = stdout.trim();
    const queryMs = Date.now() - startMs;

    if (!raw) return { rows: [], rowCount: 0, columns: [], truncated: false, queryMs, raw: '' };

    // Parse CSV output
    const lines = raw.split('\n').filter(Boolean);
    const rows: Record<string, unknown>[] = [];
    // psql CSV: first line is column headers
    const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));

    for (const line of lines.slice(1)) {
      const values = line.split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
      const row: Record<string, unknown> = {};
      headers.forEach((h, i) => { row[h] = values[i] ?? null; });
      rows.push(row);
    }

    const truncated = rows.length >= limit;
    return { rows, rowCount: rows.length, columns: headers, truncated, queryMs, raw };
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string; stdout?: string };
    const stderr = (e.stderr ?? '').trim();
    if (stderr.includes('command not found') || (e.message ?? '').includes('not found')) {
      throw new Error('psql CLI not found. Install with: brew install postgresql / apt-get install postgresql-client');
    }
    throw new Error(`PostgreSQL error: ${stderr || e.message || String(err)}`);
  }
}

async function runMysql(config: DbConfig, sql: string, limit: number): Promise<QueryResult> {
  const host = config.host ?? 'localhost';
  const port = config.port ?? MYSQL_DEFAULT_PORT;
  const db = config.database ?? '';
  const user = config.user ?? '';
  const pass = config.password ?? '';

  // CWE-78 fix: pass all options as individual CLI arguments — no shell, no interpolation.
  // Password is passed via --password=<pass> option (never shell-interpolated).
  const limitedSql = /\bLIMIT\b/i.test(sql) ? sql : `${sql} LIMIT ${limit}`;
  const mysqlArgs = [
    `--host=${host}`,
    `--port=${port}`,
    `--user=${user}`,
    ...(pass ? [`--password=${pass}`] : []),
    ...(db ? [`--database=${db}`] : []),
    '--batch',
    '--skip-column-names',
    '--execute', limitedSql,
  ];

  const startMs = Date.now();
  try {
    const { stdout } = await execFileAsync('mysql', mysqlArgs, {
      encoding: 'utf-8',
      timeout: DB_DEFAULT_TIMEOUT_MS,
    });
    const raw = stdout.trim();
    const queryMs = Date.now() - startMs;

    if (!raw) return { rows: [], rowCount: 0, columns: [], truncated: false, queryMs, raw: '' };

    const lines = raw.split('\n').filter(Boolean);
    const headers = lines[0].split('\t');
    const rows: Record<string, unknown>[] = [];

    for (const line of lines.slice(1)) {
      const values = line.split('\t');
      const row: Record<string, unknown> = {};
      headers.forEach((h, i) => { row[h] = values[i] ?? null; });
      rows.push(row);
    }

    const truncated = rows.length >= limit;
    return { rows, rowCount: rows.length, columns: headers, truncated, queryMs, raw };
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    const stderr = (e.stderr ?? '').trim();
    if (stderr.includes('command not found') || (e.message ?? '').includes('not found')) {
      throw new Error('mysql CLI not found. Install with: brew install mysql-client / apt-get install mysql-client');
    }
    throw new Error(`MySQL error: ${stderr || e.message || String(err)}`);
  }
}

// ── Format output ─────────────────────────────────────────────────────────────

function formatQueryResult(result: QueryResult, config: DbConfig, sql: string, format: string): string {
  const connLabel = config.type === 'sqlite'
    ? `SQLite [${config.file ?? ':memory:'}]`
    : `${config.type} [${config.host}:${config.port}/${config.database}]`;

  const lines: string[] = [
    `🗄️  ${connLabel}`,
    `   Query:    ${sql.slice(0, 120)}${sql.length > 120 ? '...' : ''}`,
    `   Duration: ${result.queryMs}ms`,
    `   Rows:     ${result.rowCount}${result.truncated ? ' (LIMIT reached — more rows exist)' : ''}`,
    '',
  ];

  if (result.rowCount === 0) {
    lines.push('   (no rows returned)');
    return lines.join('\n');
  }

  if (format === 'json') {
    lines.push('📊 Results (JSON):');
    const json = JSON.stringify(result.rows, null, 2);
    lines.push(json.length > 4000 ? json.slice(0, 4000) + '\n... [truncated]' : json);
  } else if (format === 'table') {
    // ASCII table
    lines.push('📊 Results:');
    const colWidths: Record<string, number> = {};
    for (const col of result.columns) {
      colWidths[col] = col.length;
      for (const row of result.rows) {
        const val = String(row[col] ?? 'NULL');
        colWidths[col] = Math.min(Math.max(colWidths[col], val.length), COL_MAX_WIDTH);
      }
    }
    const separator = '+-' + result.columns.map((c) => '-'.repeat(colWidths[c])).join('-+-') + '-+';
    const header = '| ' + result.columns.map((c) => c.padEnd(colWidths[c])).join(' | ') + ' |';
    lines.push(separator, header, separator);
    for (const row of result.rows.slice(0, TABLE_MAX_DISPLAY_ROWS)) {
      const rowLine = '| ' + result.columns.map((c) => {
        const val = String(row[c] ?? 'NULL');
        return (val.length > colWidths[c] ? val.slice(0, colWidths[c] - 1) + '…' : val).padEnd(colWidths[c]);
      }).join(' | ') + ' |';
      lines.push(rowLine);
    }
    lines.push(separator);
    if (result.rows.length > TABLE_MAX_DISPLAY_ROWS) lines.push(`... and ${result.rows.length - TABLE_MAX_DISPLAY_ROWS} more rows`);
  } else {
    // CSV-like
    lines.push('📊 Results (CSV):');
    lines.push(result.columns.join(','));
    for (const row of result.rows.slice(0, CSV_MAX_DISPLAY_ROWS)) {
      lines.push(result.columns.map((c) => {
        const v = String(row[c] ?? '');
        return v.includes(',') || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
      }).join(','));
    }
  }

  return lines.join('\n');
}

// ── Tool ─────────────────────────────────────────────────────────────────────

export const databaseQueryTool: ToolRegistration = {
  definition: {
    name: 'DatabaseQuery',
    description: [
      'Execute a SQL query against SQLite, PostgreSQL, or MySQL/MariaDB.',
      'Inspired by kstack #15372 "邪修 TDD": AI verifies data was written correctly after an API call.',
      '',
      'Supported databases (via CLI tools — no Node.js drivers needed):',
      '  SQLite:     sqlite3 (brew install sqlite3)',
      '  PostgreSQL: psql    (brew install postgresql)',
      '  MySQL:      mysql   (brew install mysql-client)',
      '',
      'Connection options (in order of priority):',
      '  1. url parameter: postgresql://user:pass@host:port/db',
      '  2. type + host/port/database/user/password parameters',
      '  3. DATABASE_URL / DB_HOST / DB_USER / DB_PASSWORD / DB_NAME env vars',
      '  4. file parameter for SQLite',
      '',
      'READ-ONLY SAFETY: The tool will warn on non-SELECT queries.',
      'Use assert_row_count or assert_field to verify expected outcomes.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: 'SQL query to execute. SELECT statements recommended; INSERT/UPDATE/DELETE are supported but use with care.',
        },
        type: {
          type: 'string',
          enum: ['sqlite', 'postgresql', 'mysql', 'mariadb'],
          description: 'Database type. Auto-detected from url or file extension if omitted.',
        },
        url: {
          type: 'string',
          description: 'Database connection URL. E.g. postgresql://user:pass@localhost:5432/mydb or mysql://user:pass@localhost/mydb',
        },
        file: {
          type: 'string',
          description: 'Path to SQLite database file. E.g. "./data.db" or "/var/data/app.sqlite"',
        },
        host: { type: 'string', description: 'Database host (default: DB_HOST env or localhost).' },
        port: { type: 'number', description: 'Database port (default: 5432 for PostgreSQL, 3306 for MySQL).' },
        database: { type: 'string', description: 'Database/schema name (default: DB_NAME env).' },
        user: { type: 'string', description: 'Database username (default: DB_USER env).' },
        password: { type: 'string', description: 'Database password (default: DB_PASSWORD env).' },
        limit: {
          type: 'number',
          description: 'Maximum rows to return (default: 20, max: 200). Applied automatically if query has no LIMIT.',
        },
        format: {
          type: 'string',
          enum: ['table', 'json', 'csv'],
          description: 'Output format (default: table for ≤10 columns, json for more).',
        },
        assert_row_count: {
          type: 'number',
          description: 'If provided, flag an error if the result row count != this value.',
        },
        assert_field: {
          type: 'object',
          description: 'Assert that a specific field in the first row equals an expected value. E.g. {"field": "status", "value": "active"}',
          properties: {
            field: { type: 'string', description: 'Column name to check.' },
            value: { type: 'string', description: 'Expected value.' },
          },
        },
      },
      required: ['sql'],
    },
  },

  async handler(args: Record<string, unknown>): Promise<string> {
    const sql = String(args.sql ?? '').trim();
    if (!sql) return 'Error: sql parameter is required.';

    const limit = Math.min(Number(args.limit ?? DB_DEFAULT_LIMIT), DB_MAX_LIMIT);
    const format = String(args.format ?? 'table') as 'table' | 'json' | 'csv';
    const assertRowCount = args.assert_row_count !== undefined ? Number(args.assert_row_count) : null;
    const assertField = (args.assert_field && typeof args.assert_field === 'object')
      ? args.assert_field as { field: string; value: string }
      : null;

    // Safety warning for non-SELECT
    const isWriteQuery = /^\s*(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE)\b/i.test(sql);
    const safetyWarning = isWriteQuery
      ? `⚠️  Write query detected (${sql.match(/^\s*(\w+)/)?.[1]?.toUpperCase()}). Proceeding...\n\n`
      : '';

    const config = buildConfig(args);

    let result: QueryResult;
    try {
      switch (config.type) {
        case 'sqlite':
          result = await runSqlite(config, sql, limit);
          break;
        case 'postgresql':
          result = await runPostgres(config, sql, limit);
          break;
        case 'mysql':
        case 'mariadb':
          result = await runMysql(config, sql, limit);
          break;
        default:
          return `Error: Unknown database type "${config.type}". Use sqlite, postgresql, or mysql.`;
      }
    } catch (err) {
      return `❌ Query failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Determine format
    const autoFormat: 'table' | 'json' | 'csv' = result.columns.length > 10 ? 'json' : format;
    const output = formatQueryResult(result, config, sql, autoFormat);

    // Assertions
    const assertions: string[] = [];

    if (assertRowCount !== null) {
      if (result.rowCount === assertRowCount) {
        assertions.push(`✅ Row count assertion PASSED: ${result.rowCount} rows`);
      } else {
        assertions.push(`⚠️  Row count assertion FAILED: expected ${assertRowCount}, got ${result.rowCount}`);
      }
    }

    if (assertField && result.rows.length > 0) {
      const actualValue = String(result.rows[0][assertField.field] ?? '');
      if (actualValue === assertField.value) {
        assertions.push(`✅ Field assertion PASSED: ${assertField.field} = "${assertField.value}"`);
      } else {
        assertions.push(`⚠️  Field assertion FAILED: ${assertField.field}`);
        assertions.push(`   Expected: "${assertField.value}"`);
        assertions.push(`   Got:      "${actualValue}"`);
      }
    }

    const assertSection = assertions.length > 0 ? '\n\n' + assertions.join('\n') : '';

    return safetyWarning + output + assertSection;
  },
};
