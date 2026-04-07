/**
 * away-summary.ts — B30: 用户离开后重连摘要服务
 *
 * 对标 claude-code src/services/awaySummary.ts
 *
 * 功能：当用户离开（超过 AWAY_THRESHOLD_MS 无输入）后再次输入时，
 * 用 Haiku 生成 1-3 句 "while you were away" 快速回顾摘要，
 * 让用户无需滚动历史就能了解 agent 做了什么。
 *
 * 特性：
 *   - AWAY_THRESHOLD_MS = 5分钟（可通过 UAGENT_AWAY_THRESHOLD_MINS 覆盖）
 *   - 静默失败（non-fatal）：任何错误不影响正常流程
 *   - 8s 超时（避免阻塞用户输入响应）
 *   - 仅对 assistant 消息生成摘要（agent 的动作，不含用户输入）
 *
 * Mirrors: claude-code awaySummary.ts generateAwaySummary()
 */

const DEFAULT_AWAY_THRESHOLD_MINS = 5;
const MAX_MESSAGES_FOR_SUMMARY = 20;   // B30: 最多取最近20条 assistant 消息
const MAX_CONTEXT_CHARS = 3000;        // B30: 单条消息最多截取字符

const SUMMARY_PROMPT = [
  'The user just returned after being away. In 1-3 short sentences,',
  'briefly summarize what happened while they were away, focusing on key',
  'actions taken and results. Be very concise. No markdown, no bullet points.',
].join(' ');

export interface AwaySummaryResult {
  summary: string;
  awayDurationMs: number;
}

// ── 活跃时间追踪 ──────────────────────────────────────────────────────────────

let _lastActivityMs = Date.now();

/** B30: 获取"离开"阈值（毫秒） */
function getAwayThresholdMs(): number {
  const mins = parseInt(process.env['UAGENT_AWAY_THRESHOLD_MINS'] ?? '', 10);
  return (isNaN(mins) ? DEFAULT_AWAY_THRESHOLD_MINS : Math.max(1, mins)) * 60_000;
}

/**
 * B30: 更新最后活跃时间。
 * 应在每次用户提交输入时调用（repl.ts 的 rl.on('line') 处理器中）。
 * Mirrors claude-code: lastActiveAt 时间戳更新。
 */
export function touchLastActivity(): void {
  _lastActivityMs = Date.now();
}

/**
 * B30: 判断是否需要生成离开摘要。
 * 若距离上次活跃时间超过阈值，返回 true。
 */
export function shouldGenerateAwaySummary(): boolean {
  return (Date.now() - _lastActivityMs) >= getAwayThresholdMs();
}

// ── 摘要生成 ──────────────────────────────────────────────────────────────────

type AnyMessage = { role: string; content: string | unknown[] };

/**
 * B30: 生成 "while you were away" 摘要。
 *
 * @param recentMessages - 近期消息历史（从 agent.getHistory() 获取）
 * @returns 摘要结果，或 null（失败时静默）
 *
 * Mirrors claude-code awaySummary.ts generateAwaySummary()
 */
export async function generateAwaySummary(
  recentMessages: AnyMessage[],
): Promise<AwaySummaryResult | null> {
  // B30: opt-out 开关
  if (process.env['UAGENT_AWAY_SUMMARY'] === 'false') return null;

  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) return null;

  // B30: 只取 assistant 消息（agent 做了什么）
  const assistantMessages = recentMessages
    .filter((m) => m.role === 'assistant')
    .slice(-MAX_MESSAGES_FOR_SUMMARY);

  if (assistantMessages.length === 0) return null;

  const awayDurationMs = Date.now() - _lastActivityMs;

  // B30: 提取文本内容（忽略 tool_use 块，只取 text）
  const contextText = assistantMessages
    .map((m) => {
      if (typeof m.content === 'string') {
        return m.content.slice(0, MAX_CONTEXT_CHARS / MAX_MESSAGES_FOR_SUMMARY);
      }
      // ContentBlock[] — 只取 text 类型
      const blocks = m.content as Array<{ type?: string; text?: string }>;
      return blocks
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text!)
        .join(' ')
        .slice(0, MAX_CONTEXT_CHARS / MAX_MESSAGES_FOR_SUMMARY);
    })
    .filter(Boolean)
    .join('\n---\n')
    .slice(0, MAX_CONTEXT_CHARS);

  if (!contextText.trim()) return null;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env['COMPACT_MODEL'] ?? 'claude-haiku-4-5',
        max_tokens: 150,
        messages: [
          {
            role: 'user',
            content: `${SUMMARY_PROMPT}\n\nRecent activity:\n${contextText}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(8000), // B30: 8s timeout — non-blocking
    });

    if (!resp.ok) return null;

    const data = await resp.json() as {
      content?: Array<{ type: string; text: string }>;
    };
    const summary = data.content?.find((c) => c.type === 'text')?.text?.trim();
    if (!summary) return null;

    return { summary, awayDurationMs };
  } catch {
    return null; // B30: silent failure — away summary is non-critical
  }
}
