import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse } from 'csv-parse/sync';
import { table } from 'table';
import type { ToolRegistration } from '../../../models/types.js';

export const csvAnalyzeTool: ToolRegistration = {
  definition: {
    name: 'analyze_csv',
    description: 'Analyze a CSV or JSON file: show structure, statistics, sample rows, and data quality metrics',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the CSV or JSON file' },
        sample_rows: { type: 'number', description: 'Number of sample rows to show (default 5)' },
      },
      required: ['file_path'],
    },
  },
  handler: async (args) => {
    const rawPath = args.file_path as string;
    const sampleRows = (args.sample_rows as number) || 5;
    let filePath: string;
    try {
      const resolved = resolve(process.cwd(), rawPath);
      const base = resolve(process.cwd());
      if (resolved !== base && !resolved.startsWith(base + '/')) {
        return `Error: Path traversal detected: "${rawPath}" resolves outside the working directory.`;
      }
      filePath = resolved;
    } catch {
      filePath = rawPath;
    }

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      return `Error: Cannot read file at ${filePath}`;
    }

    let records: Record<string, unknown>[];

    if (filePath.endsWith('.json')) {
      records = JSON.parse(content);
      if (!Array.isArray(records)) records = [records];
    } else {
      records = parse(content, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      }) as Record<string, unknown>[];
    }

    if (!records.length) return 'File is empty or has no records.';

    const columns = Object.keys(records[0]);
    const numRows = records.length;
    const numCols = columns.length;

    // Statistics per column
    const stats: Record<string, Record<string, unknown>> = {};
    for (const col of columns) {
      const values = records.map((r) => r[col]);
      const nullCount = values.filter((v) => v === null || v === undefined || v === '' || v === 'null').length;
      const nonNull = values.filter((v) => v !== null && v !== undefined && v !== '' && v !== 'null');
      const numeric = nonNull.map((v) => Number(v)).filter((n) => !isNaN(n));

      stats[col] = {
        type: numeric.length > nonNull.length * 0.8 ? 'numeric' : 'string',
        null_count: nullCount,
        null_pct: ((nullCount / numRows) * 100).toFixed(1) + '%',
        unique: new Set(values.map(String)).size,
      };

      if (numeric.length > 0) {
        const sorted = [...numeric].sort((a, b) => a - b);
        const sum = numeric.reduce((a, b) => a + b, 0);
        stats[col].min = sorted[0];
        stats[col].max = sorted[sorted.length - 1];
        stats[col].mean = (sum / numeric.length).toFixed(2);
        stats[col].median = sorted[Math.floor(sorted.length / 2)];
      }
    }

    // Sample rows table
    const sample = records.slice(0, sampleRows);
    const tableData = [
      columns,
      ...sample.map((r) => columns.map((c) => String(r[c] ?? '')?.slice(0, 30))),
    ];

    let output = `📊 File Analysis: ${filePath}\n`;
    output += `${'─'.repeat(50)}\n`;
    output += `Rows: ${numRows} | Columns: ${numCols}\n\n`;
    output += `📋 Sample Data (first ${sampleRows} rows):\n`;
    output += table(tableData) + '\n';
    output += `📈 Column Statistics:\n`;

    for (const [col, s] of Object.entries(stats)) {
      output += `\n  ${col} [${s.type}]\n`;
      output += `    Nulls: ${s.null_count} (${s.null_pct}) | Unique: ${s.unique}\n`;
      if (s.type === 'numeric') {
        output += `    Min: ${s.min} | Max: ${s.max} | Mean: ${s.mean} | Median: ${s.median}\n`;
      }
    }

    return output;
  },
};
