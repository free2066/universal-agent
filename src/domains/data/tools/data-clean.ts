import { readFileSync } from 'fs';
import { parse } from 'csv-parse/sync';
import type { ToolRegistration } from '../../../models/types.js';

export const dataCleanTool: ToolRegistration = {
  definition: {
    name: 'analyze_data_quality',
    description: 'Analyze data quality issues and suggest cleaning strategies for a dataset',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the CSV or JSON file' },
      },
      required: ['file_path'],
    },
  },
  handler: async (args) => {
    const filePath = args.file_path as string;

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      return `Error: Cannot read file at ${filePath}`;
    }

    let records: Record<string, unknown>[];
    if (filePath.endsWith('.json')) {
      records = JSON.parse(content);
    } else {
      records = parse(content, { columns: true, skip_empty_lines: true, trim: true });
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

    let output = `🧹 Data Quality Report: ${filePath}\n`;
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
