import type { ToolRegistration } from '../../../models/types.js';

export const sqlGenerateTool: ToolRegistration = {
  definition: {
    name: 'generate_sql',
    description: 'Generate, optimize, or explain SQL queries. Supports SELECT, INSERT, UPDATE, DELETE, CTEs, window functions.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Description of what you want the SQL to do, or the existing SQL to optimize',
        },
        dialect: {
          type: 'string',
          description: 'SQL dialect: mysql | postgresql | clickhouse | sqlite | standard',
          enum: ['mysql', 'postgresql', 'clickhouse', 'sqlite', 'standard'],
        },
        schema: {
          type: 'string',
          description: 'Optional: table schema or DDL for better SQL generation',
        },
        mode: {
          type: 'string',
          description: 'generate | optimize | explain',
          enum: ['generate', 'optimize', 'explain'],
        },
      },
      required: ['task', 'mode'],
    },
  },
  handler: async (args) => {
    const { task, dialect = 'standard', schema, mode } = args as {
      task: string;
      dialect: string;
      schema?: string;
      mode: 'generate' | 'optimize' | 'explain';
    };

    // This tool provides context for the LLM — the LLM does the actual generation
    // Here we return a structured prompt that guides the LLM's SQL generation
    const context: Record<string, unknown> = {
      mode,
      dialect,
      task,
    };

    if (schema) context.schema = schema;

    const instructions: Record<string, string> = {
      generate: `Generate a ${dialect} SQL query that: ${task}${schema ? `\n\nSchema:\n${schema}` : ''}`,
      optimize: `Optimize this SQL query for performance and readability:\n\n${task}`,
      explain: `Explain what this SQL query does step by step:\n\n${task}`,
    };

    return {
      instruction: instructions[mode],
      dialect,
      tips: getSQLTips(dialect, mode),
    };
  },
};

function getSQLTips(dialect: string, mode: string): string[] {
  const general = [
    'Use CTEs (WITH clauses) for complex queries',
    'Avoid SELECT * in production',
    'Use proper indexes on JOIN and WHERE columns',
  ];

  const dialectTips: Record<string, string[]> = {
    mysql: ['Use EXPLAIN to analyze query plans', 'Consider using LIMIT for large datasets'],
    postgresql: ['Use EXPLAIN ANALYZE for execution plans', 'Window functions are very powerful here'],
    clickhouse: ['Use MergeTree engine for time-series data', 'Prefer columnar operations'],
    sqlite: ['SQLite is lightweight, avoid heavy JOINs', 'Use INTEGER PRIMARY KEY for rowid tables'],
  };

  return [...general, ...(dialectTips[dialect] || [])];
}
