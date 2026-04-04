import type { DomainPlugin } from '../../models/types.js';
import { csvAnalyzeTool } from './tools/csv-analyze.js';
import { sqlGenerateTool } from './tools/sql-generate.js';
import { edaReportTool } from './tools/eda-report.js';
import { dataCleanTool } from './tools/data-clean.js';

export const dataDomain: DomainPlugin = {
  name: 'data',
  description: 'Data analysis, SQL generation, EDA reports, CSV/Excel processing',
  keywords: [
    'csv', 'excel', 'sql', 'database', 'query', 'analyze', 'analysis',
    'eda', 'report', 'chart', 'visualization', 'clean', 'missing', 'null',
    'dataframe', 'pandas', 'parquet', 'json data', 'retention', 'trend',
    'correlation', 'distribution', '数据', '分析', '报表', '查询', '清洗',
    'mysql', 'postgresql', 'clickhouse', 'hive', 'select', 'join', 'aggregate',
  ],
  systemPrompt: `You are an expert Data Analyst and Data Engineer. You help users:
- Analyze CSV, Excel, JSON, and Parquet files
- Generate, optimize, and explain SQL queries
- Produce EDA (Exploratory Data Analysis) reports
- Clean and preprocess data
- Visualize data insights

When analyzing data:
1. Always describe the structure first (rows, columns, types)
2. Highlight key statistics (mean, median, null counts, distributions)
3. Identify potential data quality issues
4. Provide actionable insights

When generating SQL:
1. Use standard SQL syntax unless a specific dialect is requested
2. Add comments explaining complex logic
3. Optimize for readability and performance

Respond in the same language as the user's input.

Output style:
- No emoji unless the user uses them first
- Plain prose or simple markdown only
- Keep responses concise and direct`,
  tools: [csvAnalyzeTool, sqlGenerateTool, edaReportTool, dataCleanTool],
};
