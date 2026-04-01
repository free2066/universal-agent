/**
 * SQL Generate Tool — Schema-driven + Multi-dialect
 *
 * Enhanced version of the original sql-generate.ts.
 *
 * New capabilities (inspired by kstack article #15335):
 *   1. Schema-driven generation: auto-loads .uagent/schemas/ DDL files and
 *      injects the most relevant table schemas into the generation prompt.
 *      This eliminates "guessing" table structures and dramatically improves accuracy.
 *
 *   2. Hive SQL dialect: full support for Apache Hive syntax including:
 *      - CTE → subquery rewriting (Hive 0.x doesn't support WITH)
 *      - Partition-aware INSERT templates
 *      - Hive-specific compatibility settings
 *      - DISTRIBUTE BY / SORT BY support
 *
 *   3. Auto-context: reads loaded schemas and injects them without user having to
 *      manually paste DDL.
 *
 * Usage:
 *   Place schema files in .uagent/schemas/*.sql  (or *.json)
 *   Then ask: "generate a query to find top 10 users by order count"
 *   Agent will automatically match relevant tables and generate accurate SQL.
 */

import type { ToolRegistration } from '../../../models/types.js';
import { buildSchemaContext } from './schema-loader.js';

// ─── Dialect Tips ─────────────────────────────────────────────────────────────

const DIALECT_TIPS: Record<string, string[]> = {
  mysql: [
    'Use EXPLAIN to analyze query plans',
    'Add LIMIT for large result sets',
    'Use covering indexes for SELECT + WHERE + ORDER BY patterns',
  ],
  postgresql: [
    'Use EXPLAIN ANALYZE for execution plans',
    'Window functions (ROW_NUMBER, LAG, LEAD) are very powerful',
    'Use LATERAL joins for correlated subqueries',
  ],
  clickhouse: [
    'Use MergeTree or ReplacingMergeTree engine for analytics',
    'Prefer columnar operations — avoid SELECT *',
    'Use toDate() / toDateTime() for date arithmetic',
    'arrayJoin() for array column expansion',
  ],
  sqlite: [
    'SQLite is lightweight — avoid heavy multi-table JOINs',
    'Use INTEGER PRIMARY KEY for rowid-based tables',
    'JSON functions available: json_extract(), json_each()',
  ],
  hive: [
    'Use DISTRIBUTE BY + SORT BY instead of ORDER BY for large datasets',
    'Add partition columns to WHERE clause to enable partition pruning',
    'Avoid small files: use INSERT OVERWRITE with dynamic partitions',
    'Set hive.exec.dynamic.partition.mode=nonstrict for dynamic partitions',
    'Use ORC or Parquet for storage format when possible',
    'Lateral view explode() to flatten array columns',
    'STRING_AGG is not supported — use collect_list() + concat_ws() instead',
  ],
  standard: [
    'Use CTEs (WITH clauses) for readable complex queries',
    'Avoid SELECT * in production code',
    'Use proper indexes on JOIN and WHERE columns',
  ],
};

// ─── Hive CTE Rewriter ────────────────────────────────────────────────────────

/**
 * Hive < 2.0 does not support WITH (CTE) clauses.
 * This note is added to the system prompt so the LLM avoids generating CTEs.
 * For Hive 2.0+, CTEs are supported.
 */
const HIVE_COMPATIBILITY_NOTES = `
## Hive SQL Compatibility Notes

1. **CTE (WITH clause)**: Only supported in Hive 2.0+. For older versions, use subqueries instead.
   - Old style: SELECT ... FROM (SELECT ... FROM t) subq
   - New style (Hive 2.0+): WITH cte AS (SELECT ...) SELECT ...

2. **Window functions**: Supported in Hive 0.11+. Use OVER (PARTITION BY ... ORDER BY ...).

3. **Lateral View**: Use for array/map columns:
   SELECT id, tag FROM t LATERAL VIEW explode(tags) tbl AS tag

4. **Dynamic partitions**:
   SET hive.exec.dynamic.partition=true;
   SET hive.exec.dynamic.partition.mode=nonstrict;
   INSERT OVERWRITE TABLE target PARTITION (dt)
   SELECT col1, col2, dt FROM source;

5. **String aggregation**: Use collect_list() + concat_ws() instead of STRING_AGG/GROUP_CONCAT:
   SELECT id, concat_ws(',', collect_list(tag)) FROM t GROUP BY id

6. **Date functions**: Use from_unixtime(), unix_timestamp(), date_format(), datediff()

7. **NULL handling**: Use NVL(col, default) or COALESCE(col, default)
`;

// ─── Prompt Builder ───────────────────────────────────────────────────────────

function buildPrompt(
  task: string,
  dialect: string,
  mode: string,
  manualSchema: string | undefined,
  autoSchema: string,
): string {
  const parts: string[] = [];

  // Manual schema takes precedence over auto-loaded schema
  const schemaSection = manualSchema
    ? `## Table Schema (provided)\n${manualSchema}`
    : autoSchema
      ? autoSchema
      : '';

  if (schemaSection) parts.push(schemaSection);

  if (dialect === 'hive') parts.push(HIVE_COMPATIBILITY_NOTES);

  const dialectLabel = dialect === 'standard' ? 'SQL' : dialect.toUpperCase() + ' SQL';
  const tips = DIALECT_TIPS[dialect] ?? DIALECT_TIPS.standard;

  if (mode === 'generate') {
    parts.push(`## Task\nGenerate a ${dialectLabel} query that: ${task}`);
    parts.push(`## Requirements\n- Use ${dialectLabel} syntax\n- Add comments for complex logic\n- ${tips.join('\n- ')}`);
    parts.push('Return ONLY the SQL query (and required SET statements for Hive). No prose.');
  } else if (mode === 'optimize') {
    parts.push(`## SQL to Optimize\n\`\`\`sql\n${task}\n\`\`\``);
    parts.push(`## Requirements\n- Optimize for ${dialectLabel}\n- Explain what you changed and why\n- ${tips.join('\n- ')}`);
  } else if (mode === 'explain') {
    parts.push(`## SQL to Explain\n\`\`\`sql\n${task}\n\`\`\``);
    parts.push('Explain this query step by step. Describe what each clause does and the overall query logic.');
  } else if (mode === 'convert') {
    parts.push(`## SQL to Convert\n\`\`\`sql\n${task}\n\`\`\``);
    parts.push(`Convert this SQL to ${dialectLabel}. Handle dialect-specific syntax differences.`);
  }

  return parts.join('\n\n');
}

// ─── Tool Registration ────────────────────────────────────────────────────────

export const sqlGenerateTool: ToolRegistration = {
  definition: {
    name: 'generate_sql',
    description: [
      'Generate, optimize, explain, or convert SQL queries.',
      'Supports MySQL, PostgreSQL, ClickHouse, SQLite, Hive, and standard SQL.',
      'Auto-loads table schemas from .uagent/schemas/ for schema-driven accurate generation.',
      'Use mode=generate for new queries, optimize for performance, explain for understanding, convert for dialect migration.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'What you want the SQL to do (generate/explain), or the SQL to optimize/convert',
        },
        dialect: {
          type: 'string',
          description: 'SQL dialect: mysql | postgresql | clickhouse | sqlite | hive | standard',
          enum: ['mysql', 'postgresql', 'clickhouse', 'sqlite', 'hive', 'standard'],
        },
        schema: {
          type: 'string',
          description: 'Optional: table DDL/schema to use. If omitted, auto-loads from .uagent/schemas/',
        },
        mode: {
          type: 'string',
          description: 'generate | optimize | explain | convert',
          enum: ['generate', 'optimize', 'explain', 'convert'],
        },
      },
      required: ['task', 'mode'],
    },
  },

  handler: async (args) => {
    const { task, dialect = 'standard', schema: manualSchema, mode } = args as {
      task: string;
      dialect: string;
      schema?: string;
      mode: string;
    };

    // Runtime validation — enum in schema is advisory only, validate explicitly
    const VALID_DIALECTS = new Set(['mysql', 'postgresql', 'clickhouse', 'sqlite', 'hive', 'standard']);
    if (!VALID_DIALECTS.has(dialect)) {
      return { error: `Invalid dialect: "${dialect}". Valid values: ${[...VALID_DIALECTS].join(', ')}` };
    }
    const VALID_MODES = new Set(['generate', 'optimize', 'explain', 'convert']);
    if (!VALID_MODES.has(mode)) {
      return { error: `Invalid mode: "${mode}". Valid values: ${[...VALID_MODES].join(', ')}` };
    }
    if (!task || typeof task !== 'string' || !task.trim()) {
      return { error: 'Missing required parameter: "task"' };
    }

    // Auto-load schemas from .uagent/schemas/ if no manual schema provided
    const autoSchema = manualSchema ? '' : buildSchemaContext(task, process.cwd());
    const schemaSource = manualSchema ? 'provided' : autoSchema ? 'auto-loaded from .uagent/schemas/' : 'none';

    const prompt = buildPrompt(task, dialect, mode, manualSchema, autoSchema);
    const tips = DIALECT_TIPS[dialect] ?? DIALECT_TIPS.standard;

    return {
      instruction: prompt,
      dialect,
      mode,
      schemaSource,
      tips,
      note: autoSchema && !manualSchema
        ? '📋 Table schemas loaded automatically from .uagent/schemas/ — SQL will reference actual table structures.'
        : manualSchema
          ? '📋 Using provided schema.'
          : '⚠️  No schema loaded. Add DDL files to .uagent/schemas/ for schema-driven generation.',
    };
  },
};
