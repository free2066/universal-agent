/**
 * Schema Loader — DDL-driven SQL generation context
 *
 * Loads table schemas (DDL files) from .uagent/schemas/ and provides
 * semantic matching to find the most relevant tables for a given query.
 *
 * File format supported:
 *   .sql  — CREATE TABLE / DDL statements with comments
 *   .json — structured schema: { tableName, comment, columns: [{name, type, comment}] }
 *
 * Usage:
 *   Place DDL files in <projectRoot>/.uagent/schemas/
 *   Example: .uagent/schemas/orders.sql
 *            .uagent/schemas/users.sql
 *
 * The agent will automatically pick relevant tables based on semantic matching
 * between the user's query and table/column names + comments.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, resolve, extname } from 'path';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ColumnDef {
  name: string;
  type: string;
  comment?: string;
  nullable?: boolean;
  primaryKey?: boolean;
}

export interface TableSchema {
  tableName: string;
  comment?: string;
  columns: ColumnDef[];
  /** raw DDL text for passing directly to LLM */
  rawDDL: string;
  /** source file */
  sourceFile: string;
}

export interface SchemaMatch {
  table: TableSchema;
  score: number;
  matchedTerms: string[];
}

// ─── DDL Parser ───────────────────────────────────────────────────────────────

/**
 * Parse a CREATE TABLE statement into a structured TableSchema.
 * Handles MySQL/PostgreSQL style DDL with inline COMMENT clauses.
 */
function parseDDL(ddl: string, sourceFile: string): TableSchema[] {
  const schemas: TableSchema[] = [];

  // Split into individual CREATE TABLE blocks
  const createBlocks = ddl.match(/CREATE\s+TABLE\s+[^;]+;/gsi) ?? [];

  for (const block of createBlocks) {
    // Extract table name
    const tableNameMatch = block.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)[`"']?/i);
    if (!tableNameMatch) continue;

    const tableName = tableNameMatch[1];

    // Extract table comment (COMMENT = '...' at end of CREATE TABLE)
    const tableCommentMatch = block.match(/\)\s*(?:ENGINE[^;]*)?\s*COMMENT\s*=?\s*['"]([^'"]+)['"]/i);
    const tableComment = tableCommentMatch?.[1];

    // Extract columns
    const columns: ColumnDef[] = [];
    const columnLines = block
      .replace(/CREATE\s+TABLE[^(]+\(/i, '')
      .replace(/\)\s*(?:ENGINE|COMMENT|DEFAULT)[^;]*/is, '')
      .split('\n');

    for (const line of columnLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('--') || trimmed.startsWith('/*')) continue;
      if (/^(PRIMARY|UNIQUE|INDEX|KEY|CONSTRAINT|CHECK)/i.test(trimmed)) continue;

      // Column: `name` TYPE ... COMMENT 'xxx'
      const colMatch = trimmed.match(/^[`"']?(\w+)[`"']?\s+(\w+(?:\([^)]+\))?)/i);
      if (!colMatch) continue;

      const colComment = trimmed.match(/COMMENT\s+['"]([^'"]+)['"]/i)?.[1];
      const nullable = !/NOT\s+NULL/i.test(trimmed);
      const primaryKey = /PRIMARY\s+KEY/i.test(trimmed);

      columns.push({
        name: colMatch[1],
        type: colMatch[2],
        comment: colComment,
        nullable,
        primaryKey,
      });
    }

    schemas.push({
      tableName,
      comment: tableComment,
      columns,
      rawDDL: block.trim(),
      sourceFile,
    });
  }

  return schemas;
}

/**
 * Parse a JSON schema file.
 * Format: { tableName, comment?, columns: [{name, type, comment?}] }
 * or array of the above.
 */
function parseJSONSchema(content: string, sourceFile: string): TableSchema[] {
  try {
    const data = JSON.parse(content);
    const items = Array.isArray(data) ? data : [data];
    return items.map((item) => ({
      tableName: item.tableName ?? item.table_name ?? 'unknown',
      comment: item.comment ?? item.description,
      columns: (item.columns ?? []).map((c: Record<string, unknown>) => ({
        name: String(c.name ?? ''),
        type: String(c.type ?? 'TEXT'),
        comment: c.comment ? String(c.comment) : undefined,
      })),
      rawDDL: JSON.stringify(item, null, 2),
      sourceFile,
    }));
  } catch {
    return [];
  }
}

// ─── Schema Loader ────────────────────────────────────────────────────────────

/**
 * Load all schema files from .uagent/schemas/ directory.
 * Returns empty array if directory doesn't exist.
 */
export function loadSchemas(projectRoot?: string): TableSchema[] {
  const root = resolve(projectRoot ?? process.cwd());
  const schemasDir = join(root, '.uagent', 'schemas');

  if (!existsSync(schemasDir)) return [];

  const schemas: TableSchema[] = [];

  let files: string[];
  try {
    files = readdirSync(schemasDir);
  } catch {
    return [];
  }

  for (const file of files.sort()) {
    const filePath = join(schemasDir, file);
    const ext = extname(file).toLowerCase();

    try {
      const content = readFileSync(filePath, 'utf8');
      if (ext === '.sql') {
        schemas.push(...parseDDL(content, file));
      } else if (ext === '.json') {
        schemas.push(...parseJSONSchema(content, file));
      }
    } catch {
      // Skip unreadable files
    }
  }

  return schemas;
}

// ─── Semantic Matching ────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[_\-]/g, ' ')          // snake_case → words
    .replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase → words
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * Score a table's relevance to a query.
 * Scores based on:
 *   - Table name match: 3 pts per token match
 *   - Table comment match: 2 pts per token match
 *   - Column name match: 1 pt per match
 *   - Column comment match: 1 pt per match
 */
function scoreTable(query: string, table: TableSchema): { score: number; matchedTerms: string[] } {
  const queryTokens = tokenize(query);
  const matchedTerms: string[] = [];
  let score = 0;

  for (const qt of queryTokens) {
    const tableTokens = tokenize(table.tableName);
    if (tableTokens.includes(qt)) {
      score += 3;
      matchedTerms.push(`table:${qt}`);
    }

    if (table.comment) {
      const commentTokens = tokenize(table.comment);
      if (commentTokens.includes(qt)) {
        score += 2;
        matchedTerms.push(`comment:${qt}`);
      }
    }

    for (const col of table.columns) {
      const colTokens = tokenize(col.name);
      if (colTokens.includes(qt)) {
        score += 1;
        if (!matchedTerms.includes(`col:${col.name}`)) {
          matchedTerms.push(`col:${col.name}`);
        }
      }
      if (col.comment) {
        const colCommentTokens = tokenize(col.comment);
        if (colCommentTokens.includes(qt)) {
          score += 1;
          if (!matchedTerms.includes(`col:${col.name}`)) {
            matchedTerms.push(`col:${col.name}`);
          }
        }
      }
    }
  }

  return { score, matchedTerms };
}

/**
 * Find the most relevant tables for a natural language query.
 *
 * @param query       The user's natural language SQL request
 * @param topK        Maximum tables to return (default: 5)
 * @param projectRoot Project root directory
 */
export function matchSchemas(
  query: string,
  topK = 5,
  projectRoot?: string,
): SchemaMatch[] {
  const schemas = loadSchemas(projectRoot);
  if (schemas.length === 0) return [];

  const matches = schemas
    .map((table) => {
      const { score, matchedTerms } = scoreTable(query, table);
      return { table, score, matchedTerms };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return matches;
}

/**
 * Build a schema context string to inject into SQL generation prompts.
 * Returns empty string if no relevant schemas found.
 */
export function buildSchemaContext(query: string, projectRoot?: string): string {
  const matches = matchSchemas(query, 5, projectRoot);
  if (matches.length === 0) return '';

  const parts = [
    '## Relevant Table Schemas',
    '(Use these DDL definitions to generate accurate SQL)',
    '',
  ];

  for (const { table, matchedTerms } of matches) {
    parts.push(`### ${table.tableName}${table.comment ? ` — ${table.comment}` : ''}`);
    if (matchedTerms.length > 0) {
      parts.push(`<!-- matched: ${matchedTerms.slice(0, 5).join(', ')} -->`);
    }
    parts.push('```sql');
    parts.push(table.rawDDL);
    parts.push('```');
    parts.push('');
  }

  return parts.join('\n');
}

/**
 * Get a summary of all loaded schemas (for display).
 */
export function getSchemasSummary(projectRoot?: string): string {
  const schemas = loadSchemas(projectRoot);
  if (schemas.length === 0) {
    return 'No schemas loaded. Add DDL files to .uagent/schemas/ for schema-driven SQL generation.';
  }
  return schemas
    .map((s) => `  • ${s.tableName.padEnd(30)} ${s.comment ?? ''} (${s.columns.length} cols, from ${s.sourceFile})`)
    .join('\n');
}
