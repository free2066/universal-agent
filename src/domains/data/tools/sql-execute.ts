/**
 * SQL Execute Tool
 *
 * Executes SQL queries against local or remote databases.
 * Supported drivers (zero new dependencies unless present):
 *   - SQLite  — via built-in better-sqlite3 (if installed) or sqlite3
 *   - MySQL   — via mysql2 (if installed)
 *   - PostgreSQL — via pg (if installed)
 *
 * Safety rules (always enforced):
 *   1. SELECT queries without LIMIT → auto-inject LIMIT 200
 *   2. UPDATE / DELETE / DROP / TRUNCATE → require __CONFIRM_REQUIRED__ pattern
 *   3. Connection strings read from env vars only (never from user input directly)
 *   4. Results truncated at MAX_ROWS to prevent memory issues
 *
 * Configuration (via env vars):
 *   DATABASE_URL   — postgres://user:pass@host/db  OR  mysql://...  OR  sqlite:./data.db
 *   SQLITE_FILE    — path to SQLite file (alternative to DATABASE_URL for SQLite)
 *   SQL_MAX_ROWS   — override max rows (default: 200)
 *
 * Usage:
 *   uagent run "show me top 10 users by revenue" -d data
 *   In REPL: ask agent to query your database
 */

import { existsSync } from 'fs';
import { resolve } from 'path';
import type { ToolRegistration } from '../../../models/types.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_ROWS = parseInt(process.env.SQL_MAX_ROWS ?? '200', 10);
const AUTO_LIMIT = 200;

// ─── DML Safety ──────────────────────────────────────────────────────────────

const MUTATING_PATTERN = /^\s*(UPDATE|DELETE|DROP|TRUNCATE|INSERT|ALTER|CREATE\s+OR\s+REPLACE)\b/i;
const DANGEROUS_PATTERN = /^\s*(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE)\b/i;

function requiresConfirmation(sql: string): boolean {
  return MUTATING_PATTERN.test(sql.trim());
}

function isDangerous(sql: string): boolean {
  return DANGEROUS_PATTERN.test(sql.trim());
}

/**
 * Auto-inject LIMIT if a SELECT query doesn't have one.
 */
function injectLimit(sql: string, limit: number): string {
  const trimmed = sql.trim();
  if (!/^\s*SELECT\b/i.test(trimmed)) return sql;
  if (/\bLIMIT\s+\d+/i.test(trimmed)) return sql;
  // Remove trailing semicolon before adding LIMIT
  const withoutSemi = trimmed.replace(/;\s*$/, '');
  return `${withoutSemi}\nLIMIT ${limit};`;
}

// ─── Connection Parsing ───────────────────────────────────────────────────────

type DBType = 'sqlite' | 'mysql' | 'postgresql' | 'unknown';

function parseDBType(url: string): DBType {
  if (url.startsWith('sqlite:') || url.endsWith('.db') || url.endsWith('.sqlite')) return 'sqlite';
  if (url.startsWith('mysql://') || url.startsWith('mysql2://')) return 'mysql';
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return 'postgresql';
  return 'unknown';
}

function getSQLiteFile(url: string): string {
  return url.replace(/^sqlite:/, '');
}

// ─── Drivers ──────────────────────────────────────────────────────────────────

interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
}

async function executeSQLite(sql: string, filePath: string): Promise<QueryResult> {
  const start = Date.now();
  const absPath = resolve(filePath);

  if (!existsSync(absPath)) {
    throw new Error(`SQLite file not found: ${absPath}`);
  }

  // Try better-sqlite3 first (sync), fall back to error with guidance
  let Database: new (path: string) => {
    prepare: (sql: string) => { all: (...args: unknown[]) => Record<string, unknown>[] };
  };
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error — better-sqlite3 is an optional peer dependency not in devDependencies
    const mod = await import('better-sqlite3');
    Database = mod.default as typeof Database;
  } catch {
    throw new Error(
      'better-sqlite3 is not installed. Run: npm install better-sqlite3\n' +
      'Or set DATABASE_URL to a MySQL/PostgreSQL connection string.',
    );
  }

  const db = new Database(absPath);
  const stmt = db.prepare(sql);
  const raw = stmt.all() as Record<string, unknown>[];

  const truncated = raw.length > MAX_ROWS;
  const rows = raw.slice(0, MAX_ROWS);
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

  return {
    columns,
    rows: rows.map((r) => columns.map((c) => r[c])),
    rowCount: raw.length,
    truncated,
    durationMs: Date.now() - start,
  };
}

async function executeMySQL(sql: string, url: string): Promise<QueryResult> {
  const start = Date.now();
  let createConnection: (config: string) => {
    execute: (sql: string) => Promise<[unknown[], { name: string }[]]>;
    end: () => Promise<void>;
  };

  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error — mysql2 is an optional peer dependency not in devDependencies
    const mod = await import('mysql2/promise');
    createConnection = (mod as unknown as {
      createConnection: typeof createConnection;
    }).createConnection;
  } catch {
    throw new Error(
      'mysql2 is not installed. Run: npm install mysql2',
    );
  }

  const conn = await createConnection(url);
  try {
    const [rawRows, fields] = await conn.execute(sql);
    const columns = fields.map((f) => f.name);
    const rows = rawRows as unknown[][];
    const truncated = rows.length >= MAX_ROWS;
    return {
      columns,
      rows: rows.slice(0, MAX_ROWS).map((r) => columns.map((_, i) => (r as unknown[])[i])),
      rowCount: rows.length,
      truncated,
      durationMs: Date.now() - start,
    };
  } finally {
    await conn.end();
  }
}

async function executePostgreSQL(sql: string, url: string): Promise<QueryResult> {
  const start = Date.now();
  let Client: new (config: { connectionString: string }) => {
    connect: () => Promise<void>;
    query: (sql: string) => Promise<{ rows: Record<string, unknown>[]; fields: { name: string }[] }>;
    end: () => Promise<void>;
  };

  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error — pg is an optional peer dependency not in devDependencies
    const mod = await import('pg');
    Client = (mod as unknown as { Client: typeof Client }).Client;
  } catch {
    throw new Error('pg is not installed. Run: npm install pg');
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query(sql);
    const columns = result.fields.map((f) => f.name);
    const truncated = result.rows.length >= MAX_ROWS;
    return {
      columns,
      rows: result.rows.slice(0, MAX_ROWS).map((r) => columns.map((c) => r[c])),
      rowCount: result.rows.length,
      truncated,
      durationMs: Date.now() - start,
    };
  } finally {
    await client.end();
  }
}

// ─── Formatter ────────────────────────────────────────────────────────────────

function formatTable(result: QueryResult): string {
  if (result.rows.length === 0) return '(no rows returned)';

  const colWidths = result.columns.map((c, i) => {
    const maxVal = result.rows.reduce((max, row) => {
      const cell = String(row[i] ?? 'NULL');
      return Math.max(max, cell.length);
    }, 0);
    return Math.min(Math.max(c.length, maxVal), 50);
  });

  const header = result.columns.map((c, i) => c.padEnd(colWidths[i])).join(' │ ');
  const divider = colWidths.map((w) => '─'.repeat(w)).join('─┼─');
  const rows = result.rows.map((row) =>
    row.map((cell, i) => String(cell ?? 'NULL').slice(0, 50).padEnd(colWidths[i])).join(' │ '),
  );

  const lines = [header, divider, ...rows];
  if (result.truncated) {
    lines.push(`... (showing ${MAX_ROWS} of ${result.rowCount} rows — set SQL_MAX_ROWS env var to increase)`);
  }

  return lines.join('\n');
}

// ─── Tool ─────────────────────────────────────────────────────────────────────

export const sqlExecuteTool: ToolRegistration = {
  definition: {
    name: 'execute_sql',
    description: [
      'Execute a SQL query against a configured database.',
      'Supports SQLite (local file), MySQL, and PostgreSQL.',
      'Configure via DATABASE_URL or SQLITE_FILE environment variables.',
      'SELECT without LIMIT auto-gets LIMIT 200. UPDATE/DELETE requires confirmation.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: 'The SQL query to execute',
        },
        confirm: {
          type: 'boolean',
          description: 'Set to true to confirm execution of mutating queries (UPDATE/DELETE/DROP)',
        },
        format: {
          type: 'string',
          description: 'Output format: table | json | csv',
          enum: ['table', 'json', 'csv'],
        },
      },
      required: ['sql'],
    },
  },

  handler: async (args) => {
    let sql = (args.sql as string).trim();
    const confirmed = args.confirm === true;
    const format = (args.format as string) || 'table';

    // ── Safety checks ──
    if (isDangerous(sql)) {
      if (!confirmed) {
        return `__CONFIRM_REQUIRED__:dangerous SQL operation\n${sql}`;
      }
    } else if (requiresConfirmation(sql)) {
      if (!confirmed) {
        return `__CONFIRM_REQUIRED__:mutating SQL (UPDATE/DELETE/INSERT)\n${sql}`;
      }
    }

    // ── Auto-inject LIMIT for SELECT ──
    if (/^\s*SELECT\b/i.test(sql)) {
      sql = injectLimit(sql, AUTO_LIMIT);
    }

    // ── Resolve connection ──
    const dbUrl = process.env.DATABASE_URL ?? '';
    const sqliteFile = process.env.SQLITE_FILE ?? '';

    if (!dbUrl && !sqliteFile) {
      return [
        '❌ No database configured.',
        '',
        'Set one of these environment variables:',
        '  DATABASE_URL=sqlite:./my-database.db',
        '  DATABASE_URL=mysql://user:pass@localhost/dbname',
        '  DATABASE_URL=postgres://user:pass@localhost/dbname',
        '  SQLITE_FILE=./my-database.db',
        '',
        'Add to .env in your project root, then restart.',
      ].join('\n');
    }

    const url = dbUrl || `sqlite:${sqliteFile}`;
    const dbType = parseDBType(url);

    // ── Execute ──
    let result: QueryResult;
    try {
      if (dbType === 'sqlite') {
        result = await executeSQLite(sql, getSQLiteFile(url));
      } else if (dbType === 'mysql') {
        result = await executeMySQL(sql, url);
      } else if (dbType === 'postgresql') {
        result = await executePostgreSQL(sql, url);
      } else {
        return `❌ Unsupported database URL format: ${url.slice(0, 30)}...\nSupported: sqlite:, mysql://, postgres://`;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `❌ Query failed: ${msg}`;
    }

    // ── Format output ──
    const header = `✅ Query executed in ${result.durationMs}ms — ${result.rowCount} row(s)\n\n`;

    if (format === 'json') {
      const data = result.rows.map((row) =>
        Object.fromEntries(result.columns.map((c, i) => [c, row[i]])),
      );
      return header + JSON.stringify(data, null, 2);
    }

    if (format === 'csv') {
      const csvRows = [
        result.columns.join(','),
        ...result.rows.map((row) =>
          row.map((cell) => {
            const s = String(cell ?? '');
            return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
          }).join(','),
        ),
      ];
      return header + csvRows.join('\n');
    }

    return header + formatTable(result);
  },
};
