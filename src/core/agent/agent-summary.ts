/**
 * agent-summary.ts — F26: 30-second sub-agent progress summaries
 *
 * Mirrors claude-code src/services/AgentSummary/agentSummary.ts:
 *   - SUMMARY_INTERVAL_MS = 30_000 (completion-triggered, not initiation-triggered)
 *   - Forked summary agent with canUseTool=deny (no tool calls, preserves prompt cache key)
 *   - skipCacheWrite: true (fork scenario, avoids polluting main cache key)
 *   - 3-5 word present-tense summary ("Implementing user auth", "Fixing database bug")
 *   - skipTranscript: true (not written to disk)
 */

import type { Message } from '../../models/types.js';
import { modelManager } from '../../models/model-manager.js';
import { createLogger } from '../logger.js';

const log = createLogger('agent-summary');

/** F26: Summary polling interval (completion-triggered) */
const SUMMARY_INTERVAL_MS = 30_000;

/** F26: AgentSummary state */
export interface AgentSummaryState {
  summary: string;
  updatedAt: number;
}

/** F26: In-memory summary store (agentId → last summary) */
const _summaries = new Map<string, AgentSummaryState>();

/**
 * F26: updateAgentSummary — store a new summary for an agent.
 */
export function updateAgentSummary(agentId: string, summary: string): void {
  _summaries.set(agentId, { summary, updatedAt: Date.now() });
}

/**
 * F26: getAgentSummary — retrieve the latest summary for an agent.
 */
export function getAgentSummary(agentId: string): AgentSummaryState | undefined {
  return _summaries.get(agentId);
}

/**
 * F26: clearAgentSummary — remove summary when agent terminates.
 */
export function clearAgentSummary(agentId: string): void {
  _summaries.delete(agentId);
}

/**
 * F26: generateProgressSummary — call compact model to generate a 3-5 word summary.
 * Mirrors claude-code agentSummary.ts runForkedAgent() + canUseTool: deny pattern.
 *
 * Uses skipCacheWrite: true so fork agent doesn't pollute the main cache key.
 */
async function generateProgressSummary(messages: Message[]): Promise<string | null> {
  if (messages.length < 2) return null;

  try {
    const client = modelManager.getClient('compact');

    // Take last 6 messages (3 turns) to understand current activity
    const lastTurns = messages
      .slice(-6)
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => {
        const content = typeof m.content === 'string' ? m.content : '[tool calls]';
        return `[${m.role}]: ${content.slice(0, 400)}`;
      })
      .join('\n');

    const response = await client.chat({
      systemPrompt:
        'Generate a 3-5 word present-tense summary of what the AI agent is currently doing. ' +
        'Examples: "Implementing user authentication", "Fixing database query bug", "Writing test cases", ' +
        '"Refactoring payment module". ' +
        'Include file names if relevant. ONLY return the summary phrase, nothing else.',
      messages: [
        {
          role: 'user',
          content: `Recent agent conversation:\n${lastTurns}\n\nCurrent activity summary (3-5 words):`,
        },
      ],
      // A25: skipCacheWrite — fork scenario, avoid polluting main conversation cache key
      // Mirrors claude-code agentSummary.ts: "forked agent doesn't change prompt cache key"
      skipCacheWrite: true,
    });

    const summary = response.content.trim().replace(/[.!?""']+$/, '').trim();
    // Validate: 2-10 words, not empty
    if (summary && summary.split(/\s+/).length >= 2 && summary.split(/\s+/).length <= 10) {
      return summary;
    }
    return null;
  } catch (err) {
    log.debug('generateProgressSummary failed (non-fatal)', { error: err });
    return null;
  }
}

/**
 * F26: startAgentSummarization — start periodic progress summary generation.
 *
 * Mirrors claude-code startAgentSummarization() in agentSummary.ts:
 *   - completion-triggered polling (not initiation-triggered, prevents overlapping calls)
 *   - 30s interval, unref'd so it doesn't block Node exit
 *   - Automatically stops when signal is aborted
 *
 * @param agentId    ID of the agent to track (used as summary key)
 * @param getMessages Function to get current agent message history
 * @param signal     AbortSignal — stops summarization when agent completes
 */
export function startAgentSummarization(
  agentId: string,
  getMessages: () => Message[],
  signal: AbortSignal,
): void {
  let _running = false; // completion-triggered: prevents overlapping summary calls

  const tick = async () => {
    if (_running || signal.aborted) return;
    _running = true;
    try {
      const messages = getMessages();
      const summary = await generateProgressSummary(messages);
      if (summary && !signal.aborted) {
        updateAgentSummary(agentId, summary);
        log.debug('agent-summary updated', { agentId, summary });
      }
    } catch { /* non-fatal */ }
    finally {
      _running = false;
    }
  };

  // Start after first interval, then every SUMMARY_INTERVAL_MS
  const interval = setInterval(tick, SUMMARY_INTERVAL_MS);
  interval.unref(); // 不阻止 Node 进程退出

  signal.addEventListener('abort', () => {
    clearInterval(interval);
    clearAgentSummary(agentId);
    log.debug('agent-summary stopped', { agentId });
  }, { once: true });
}
