import { readFileSync } from 'fs';
import { parse } from 'csv-parse/sync';
import type { ToolRegistration } from '../../../models/types.js';

export const edaReportTool: ToolRegistration = {
  definition: {
    name: 'generate_eda_report',
    description: 'Generate a comprehensive Exploratory Data Analysis (EDA) report for a CSV or JSON dataset',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the dataset file (CSV or JSON)' },
        target_column: {
          type: 'string',
          description: 'Optional: the target/label column for supervised analysis',
        },
      },
      required: ['file_path'],
    },
  },
  handler: async (args) => {
    const filePath = args.file_path as string;
    const targetCol = args.target_column as string | undefined;

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
    const numericCols: string[] = [];
    const categoricalCols: string[] = [];
    const report: string[] = [];

    report.push(`# EDA Report: ${filePath}`);
    report.push(`\n## Overview`);
    report.push(`- Total rows: ${records.length}`);
    report.push(`- Total columns: ${columns.length}`);
    if (targetCol) report.push(`- Target column: ${targetCol}`);

    // Classify columns
    for (const col of columns) {
      const vals = records.map((r) => r[col]).filter((v) => v !== null && v !== undefined && v !== '');
      const nums = vals.map((v) => Number(v)).filter((n) => !isNaN(n));
      if (nums.length > vals.length * 0.7) {
        numericCols.push(col);
      } else {
        categoricalCols.push(col);
      }
    }

    report.push(`\n## Column Types`);
    report.push(`- Numeric (${numericCols.length}): ${numericCols.join(', ')}`);
    report.push(`- Categorical (${categoricalCols.length}): ${categoricalCols.join(', ')}`);

    // Data quality
    report.push(`\n## Data Quality`);
    let hasIssues = false;
    for (const col of columns) {
      const nullCount = records.filter(
        (r) => r[col] === null || r[col] === undefined || r[col] === '' || String(r[col]).toLowerCase() === 'null'
      ).length;
      if (nullCount > 0) {
        const pct = ((nullCount / records.length) * 100).toFixed(1);
        report.push(`- **${col}**: ${nullCount} missing values (${pct}%)`);
        hasIssues = true;
      }
    }
    if (!hasIssues) report.push('- ✅ No missing values detected');

    // Numeric statistics
    if (numericCols.length > 0) {
      report.push(`\n## Numeric Column Statistics`);
      for (const col of numericCols) {
        const vals = records
          .map((r) => Number(r[col]))
          .filter((n) => !isNaN(n))
          .sort((a, b) => a - b);
        if (!vals.length) continue;
        const sum = vals.reduce((a, b) => a + b, 0);
        const mean = sum / vals.length;
        const median = vals[Math.floor(vals.length / 2)];
        const std = Math.sqrt(vals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / vals.length);
        const q1 = vals[Math.floor(vals.length * 0.25)];
        const q3 = vals[Math.floor(vals.length * 0.75)];

        report.push(`\n### ${col}`);
        report.push(`| Stat | Value |`);
        report.push(`|------|-------|`);
        report.push(`| Min  | ${vals[0].toFixed(2)} |`);
        report.push(`| Q1   | ${q1.toFixed(2)} |`);
        report.push(`| Median | ${median.toFixed(2)} |`);
        report.push(`| Mean | ${mean.toFixed(2)} |`);
        report.push(`| Q3   | ${q3.toFixed(2)} |`);
        report.push(`| Max  | ${vals[vals.length - 1].toFixed(2)} |`);
        report.push(`| Std  | ${std.toFixed(2)} |`);
      }
    }

    // Categorical analysis
    if (categoricalCols.length > 0) {
      report.push(`\n## Categorical Column Analysis`);
      for (const col of categoricalCols.slice(0, 5)) {
        const freq: Record<string, number> = {};
        for (const r of records) {
          const v = String(r[col] ?? 'null');
          freq[v] = (freq[v] || 0) + 1;
        }
        const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 10);
        report.push(`\n### ${col} (${Object.keys(freq).length} unique values)`);
        report.push(`| Value | Count | % |`);
        report.push(`|-------|-------|---|`);
        for (const [val, cnt] of sorted) {
          report.push(`| ${val.slice(0, 30)} | ${cnt} | ${((cnt / records.length) * 100).toFixed(1)}% |`);
        }
      }
    }

    report.push(`\n## Recommendations`);
    if (hasIssues) {
      report.push('- 🔧 Handle missing values (imputation or removal)');
    }
    if (numericCols.length > 1) {
      report.push('- 📊 Consider correlation analysis between numeric columns');
    }
    if (records.length > 10000) {
      report.push('- ⚡ Large dataset detected - consider sampling for visualization');
    }
    report.push('- 📈 Visualize distributions with histograms and box plots');
    report.push('- 🔍 Check for outliers using IQR or Z-score methods');

    return report.join('\n');
  },
};
