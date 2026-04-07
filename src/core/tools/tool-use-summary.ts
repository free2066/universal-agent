/**
 * tool-use-summary.ts — D29: ToolUseSummary Haiku 摘要生成
 *
 * 对标 claude-code src/services/toolUseSummary/toolUseSummaryGenerator.ts L15-96
 *
 * 功能：在 tool batch 完成后，用 claude-haiku 生成 ≤30 字的 git-commit-style 摘要，
 * 供 SDK/移动端展示使用。
 *
 * 特性：
 *   - 静默失败（non-fatal）：任何错误均返回 null
 *   - 可选开关：仅当 ENABLE_TOOL_SUMMARY=true 时生效
 *   - 8s 超时（避免阻塞主流程）
 *   - 摘要截断至 ≤30 字符
 *
 * Mirrors: claude-code toolUseSummaryGenerator.ts generateToolUseSummary()
 */

const SUMMARY_PROMPT = [
  'Generate a VERY short title (30 characters or fewer, git commit style) that describes',
  'what was accomplished in the tool calls shown below. Examples:',
  '  "Updated config.json"',
  '  "Fixed login bug in auth.ts"',
  '  "Created 3 new test files"',
  'Respond with ONLY the title text, no quotes, no explanation, no markdown.',
].join('\n');

export interface ToolUseSummaryParams {
  /** Tool results from the completed batch */
  toolResults: Array<{ toolName: string; result: string }>;
  /** Optional: last assistant text before the tool calls (context prefix) */
  lastAssistantText?: string;
}

/**
 * D29: Generate a ≤30-char git-commit-style summary for a completed tool batch.
 * Uses claude-haiku (cheap + fast) to generate the label.
 *
 * Returns null if:
 *   - ENABLE_TOOL_SUMMARY is not 'true'
 *   - ANTHROPIC_API_KEY is not set
 *   - Any network/API error
 *
 * Mirrors claude-code toolUseSummaryGenerator.ts L15-96 generateToolUseSummary()
 */
export async function generateToolUseSummary(
  params: ToolUseSummaryParams,
): Promise<string | null> {
  // D29: opt-in feature flag — avoid unexpected API calls
  if (process.env['ENABLE_TOOL_SUMMARY'] !== 'true') return null;

  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) return null;
  if (!params.toolResults.length) return null;

  try {
    // D29: format tool results for context — mirrors L35-37 GenerateToolUseSummaryParams
    const toolResultsText = params.toolResults
      .map((r) => `[${r.toolName}]: ${r.result.slice(0, 200)}`)
      .join('\n');

    // D29: include lastAssistantText as context prefix — mirrors L63-72
    const userContent = params.lastAssistantText
      ? `Context: ${params.lastAssistantText.slice(0, 500)}\n\nTool calls:\n${toolResultsText}`
      : `Tool calls:\n${toolResultsText}`;

    const body = {
      model: process.env['COMPACT_MODEL'] ?? 'claude-haiku-4-5',
      max_tokens: 64,
      messages: [
        { role: 'user', content: `${SUMMARY_PROMPT}\n\n${userContent}` },
      ],
    };

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000), // D29: 8s timeout — non-blocking
    });

    if (!resp.ok) return null; // D29: silent failure on API error

    const data = await resp.json() as {
      content?: Array<{ type: string; text: string }>;
    };
    const text = data.content?.find((c) => c.type === 'text')?.text?.trim();

    // D29: truncate to ≤30 chars — mirrors L24 toolUseSummaryGenerator prompt constraint
    return text ? text.slice(0, 30) : null;
  } catch {
    // D29: silent failure — summary is non-critical
    return null;
  }
}
