import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse } from 'csv-parse/sync';
import type { ToolRegistration } from '../../../models/types.js';

/** Resolve path within cwd; throws on traversal attempt */
function safeResolvePath(userPath: string, baseDir: string): string {
  const resolved = resolve(baseDir, userPath);
  const base = resolve(baseDir);
  if (resolved !== base && !resolved.startsWith(base + '/')) {
    throw new Error(`Path traversal detected: "${userPath}" resolves outside the working directory.`);
  }
  return resolved;
}

export const dataCleanTool: ToolRegistration = {
  definition: {
    name: 'analyze_data_quality',
    description: 'Analyze data quality issues and suggest cleaning strategies for a dataset. Accepts a file path OR inline CSV/JSON data string.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the CSV or JSON file' },
        data: { type: 'string', description: 'Inline CSV or JSON string (alternative to file_path)' },
        format: { type: 'string', enum: ['csv', 'json'], description: 'Format of inline data (default: csv). Only used with the data parameter.' },
      },
      required: [],
    },
  },
  handler: async (args) => {
    const filePath = args.file_path as string | undefined;
    const inlineData = (args.data ?? args.inline_data) as string | undefined;
    const format = (args.format as string | undefined) ?? 'csv';

    if (!filePath && !inlineData) {
      return 'Error: Provide either file_path (path to CSV/JSON file) or data (inline CSV/JSON string).';
    }

    let content: string;
    let sourceLabel: string;

    if (inlineData) {
      content = inlineData;
      sourceLabel = '<inline data>';
    } else {
      try {
        content = readFileSync(filePath!, 'utf-8');
        sourceLabel = filePath!;
      } catch {
        return `Error: Cannot read file at ${filePath}`;
      }
    }

    let records: Record<string, unknown>[];
    const isJson = inlineData ? format === 'json' : filePath!.endsWith('.json');
    if (isJson) {
      try {
        records = JSON.parse(content);
      } catch {
        return `Error: Failed to parse JSON. Check your data format.`;
      }
    } else {
      try {
        records = parse(content, { columns: true, skip_empty_lines: true, trim: true });
      } catch {
        return `Error: Failed to parse CSV. Check your data format.`;
      }
    }

    const columns = Object.keys(records[0] || {});
    const issues: string[] = [];
    const suggestions: string[] = [];

    for (const col of columns) {
      const values = records.map((r) => r[col]);
      const nullCount = values.filter(
        (v) => v === null || v === undefined || v === '' || String(v).toLowerCase() === 'null' || String(v).toLowerCase() === 'nan'
      ).length;

      if (nullCount > 0) {
        const pct = ((nullCount / records.length) * 100).toFixed(1);
        issues.push(`Column "${col}": ${nullCount} null/empty values (${pct}%)`);

        const nonNull = values.filter((v) => v !== null && v !== undefined && v !== '');
        const nums = nonNull.map((v) => Number(v)).filter((n) => !isNaN(n));
        const isNumeric = nums.length > nonNull.length * 0.7;

        if (parseFloat(pct) < 5) {
          suggestions.push(`"${col}": Low null rate (${pct}%) → Consider dropping null rows`);
        } else if (isNumeric) {
          suggestions.push(`"${col}": Numeric column → Fill with mean/median/mode`);
        } else {
          suggestions.push(`"${col}": Categorical column → Fill with mode or 'Unknown'`);
        }
      }

      // Check for duplicates
      const strVals = values.map(String);
      const unique = new Set(strVals).size;
      if (unique < values.length * 0.1 && values.length > 100) {
        issues.push(`Column "${col}": Very low cardinality (${unique} unique values) — may need encoding`);
      }

      // Check for potential date columns
      if (!col.toLowerCase().includes('id')) {
        const datePatterns = strVals.filter((v) => /^\d{4}[-/]\d{2}[-/]\d{2}/.test(v));
        if (datePatterns.length > values.length * 0.5) {
          suggestions.push(`"${col}": Looks like a date column → Parse as datetime for time-series analysis`);
        }
      }
    }

    // Check for duplicates rows
    const rowStrings = records.map((r) => JSON.stringify(r));
    const uniqueRows = new Set(rowStrings).size;
    if (uniqueRows < records.length) {
      const dupCount = records.length - uniqueRows;
      issues.push(`Dataset: ${dupCount} duplicate rows detected`);
      suggestions.push(`Remove ${dupCount} duplicate rows with df.drop_duplicates()`);
    }

    let output = `🧹 Data Quality Report: ${sourceLabel}\n`;
    output += `${'─'.repeat(50)}\n`;
    output += `Total rows: ${records.length} | Columns: ${columns.length}\n\n`;

    if (issues.length === 0) {
      output += '✅ No major data quality issues detected!\n';
    } else {
      output += `⚠️  Issues Found (${issues.length}):\n`;
      issues.forEach((issue, i) => (output += `  ${i + 1}. ${issue}\n`));
    }

    if (suggestions.length > 0) {
      output += `\n💡 Cleaning Suggestions:\n`;
      suggestions.forEach((s, i) => (output += `  ${i + 1}. ${s}\n`));
    }

    return output;
  },
};
