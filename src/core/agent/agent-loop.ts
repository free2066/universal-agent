/**
 * agent/agent-loop.ts — AgentCore 主循环逻辑
 *
 * 包含：
 *  - runStream() 主循环（LLM 调用 + 工具分发 + 确认流程）
 *  - expandMentions() @run-agent / @ask-<model> 提及扩展
 *  - _captureIterationSnapshot() 迭代快照
 */

import type { LLMClient, Message } from '../../models/types.js';
import type { ToolRegistry } from '../tool-registry.js';
import type { DomainRouter } from '../domain-router.js';
import type { MCPManager } from '../mcp-manager.js';
import type { ModelFallbackChain } from '../model-fallback.js';
import type { AgentEvents, PendingConfirmation } from './types.js';
import {
  PARALLELIZABLE_TOOLS,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_UNATTENDED_RETRIES,
  DEFAULT_UNATTENDED_RETRY_DELAY_MS,
  MAX_UNATTENDED_RETRY_DELAY_MS,
  TODO_NAG_ROUNDS,
} from './types.js';
import { modelManager } from '../../models/model-manager.js';
import { buildSystemPromptWithContext } from '../context/context-loader.js';
import { subagentSystem } from '../subagent-system.js';
import { autoCompact, reactiveCompact } from '../context/context-compressor.js';
import {
  updateSessionMemory,
  trySessionMemoryCompaction,
} from '../memory/session-memory.js';
import { getMemoryStore, triggerIncrementalIngest } from '../memory/memory-store.js';
import { createLogger } from '../logger.js';
import { triggerHook, createHookEvent } from '../hooks.js';
import { withToolRetry, withApiRateLimitRetry } from '../tool-retry.js';
import { editContextIfNeeded } from '../context/context-editor.js';
import { selectTools } from '../tool-selector.js';
import { backgroundManager } from '../background-manager.js';
import { todoManager } from '../tools/productivity/todo-tool.js';
import { getTeammateManager } from '../teammate-manager.js';
import { sessionMetrics } from '../metrics.js';
import { getPermissionManager } from './permission-manager.js';
import {
  createBudgetTracker,
  checkTokenBudget,
  buildBudgetStopMessage,
} from './token-budget.js';

const log = createLogger('agent-loop');

// ── Tombstone mechanism (claude-code parity) ──────────────────────────────────
//
// When the LLM stream is interrupted (e.g. model fallback, context overflow),
// partial streaming messages may have been pushed to the history and rendered
// in the UI. These orphaned assistant messages need to be "tombstoned" so the
// UI can remove them before the retry, preventing duplicate/garbled output.
//
// A tombstone message is a synthetic assistant message with type:'tombstone'
// that signals the UI to delete everything from the tombstone position onward.
// This mirrors claude-code's query.ts tombstone pattern.

interface TombstoneMessage {
  role: 'assistant';
  content: string;
  type: 'tombstone';
  tombstoneAt: number; // history length at time of tombstone
}

function createTombstone(historyLength: number): TombstoneMessage {
  return {
    role: 'assistant',
    content: '[tombstone]',
    type: 'tombstone',
    tombstoneAt: historyLength,
  };
}

// ── ToolUseSummary (claude-code parity) ────────────────────────────────────────
//
// When a tool result exceeds TOOL_USE_SUMMARY_THRESHOLD characters, fire a
// background Haiku-model call to generate a compressed summary. The summary
// is stored in _pendingToolSummaries and injected as a user message at the
// START of the next iteration, before the LLM call.
//
// This prevents tool results (e.g. large file reads, long grep outputs) from
// consuming excessive context. The background generation runs concurrently
// with other work, so latency impact is minimal for read-only tools.

const TOOL_USE_SUMMARY_THRESHOLD = 8_000; // chars above which we summarize
const _pendingToolSummaries: Array<{ toolName: string; summary: string }> = [];
let _summaryGenerationCount = 0; // rate-limit: max 2 concurrent summaries

async function maybeGenerateToolSummary(
  toolName: string,
  rawResult: string,
): Promise<void> {
  if (rawResult.length < TOOL_USE_SUMMARY_THRESHOLD) return;
  if (_summaryGenerationCount >= 2) return; // rate limit concurrent summaries

  _summaryGenerationCount++;
  try {
    const client = modelManager.getClient('compact');
    const response = await client.chat({
      systemPrompt: 'You are summarizing a tool result for an AI coding assistant. Be concise and preserve key findings, errors, and actionable information.',
      messages: [{
        role: 'user',
        content: `Summarize the following ${toolName} tool result in 2-4 sentences, preserving the most important information:\n\n${rawResult.slice(0, 20_000)}`,
      }],
    });
    const summary = response.content.trim();
    if (summary.length > 50 && summary.length < rawResult.length * 0.8) {
      _pendingToolSummaries.push({ toolName, summary });
    }
  } catch { /* summary failure is non-fatal */ } finally {
    _summaryGenerationCount--;
  }
}

// ── maxOutputTokens 三阶段恢复 (claude-code parity) ──────────────────────────
//
// When a response is cut off by the model's maxOutputTokens limit, claude-code
// does a three-phase recovery:
//   Phase 1: Escalate to 64k output tokens (if model supports it)
//   Phase 2: Inject meta continuation messages up to 3 times to coax the model
//            to continue where it left off (e.g. "Please continue from where you
//            left off — the response was cut off")
//   Phase 3: If still failing after 3 continuations, surface error to user
//
// Detection heuristic: finish_reason === 'max_tokens' or 'length', or the
// response ends abruptly without a natural conclusion.

const MAX_CONTINUATION_RETRIES = 3;

function isResponseTruncated(responseContent: string, finishReason?: string): boolean {
  if (finishReason === 'max_tokens' || finishReason === 'length') return true;
  // Heuristic: response ends mid-sentence (no period, ?, !, ``` or code block close)
  const trimmed = responseContent.trimEnd();
  if (trimmed.length < 50) return false;
  const lastChar = trimmed[trimmed.length - 1];
  if (['.', '?', '!', '`', '>', '}', ']', '"', "'"].includes(lastChar)) return false;
  // Ends with partial word or number (likely truncated)
  return /\w$/.test(trimmed);
}

// ─── Pending confirmation helpers ────────────────────────────────────────────

/** 处理挂起的危险命令确认（kstack article #15313）。*/
export async function handlePendingConfirmation(
  pending: PendingConfirmation,
  prompt: string,
  history: Message[],
  onChunk: (chunk: string) => void,
): Promise<boolean> {
  const { command, cwd, label, injectedAt } = pending;
  const isConfirmed = /^\s*(yes|y|confirm|ok|go|proceed|execute|run it|do it)\s*$/i.test(prompt.trim());

  if (isConfirmed) {
    if (injectedAt !== undefined && history.length > injectedAt) {
      history.splice(injectedAt);
    }
    onChunk(`\n✅ Confirmed. Executing: \`${command}\`\n\n`);
    try {
      const { execSync } = await import('child_process');
      const output = execSync(command, {
        cwd,
        encoding: 'utf-8',
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      onChunk(output.trim() || '(no output)');
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const parts: string[] = [];
      if (e.stdout?.trim()) parts.push(e.stdout.trim());
      if (e.stderr?.trim()) parts.push(e.stderr.trim());
      if (!e.stderr && e.message) parts.push(e.message);
      onChunk(`\n❌ Command failed:\n${parts.join('\n') || 'Unknown error'}`);
    }
    onChunk('\n');
  } else {
    if (injectedAt !== undefined && history.length > injectedAt) {
      history.splice(injectedAt);
    }
    onChunk(`\n🚫 Cancelled. The following command was NOT executed:\n  \`${command}\`\n  (${label})\n`);
  }
  return true; // consumed — caller should return
}

// ─── Memory recall ────────────────────────────────────────────────────────────

/** 将 MemoryStore 中相关记忆注入到 systemPrompt 中。*/
async function appendMemoriesToPrompt(prompt: string, systemPrompt: string): Promise<string> {
  try {
    const store = getMemoryStore(process.cwd());
    const memories = await store.recall(prompt);
    if (memories.length === 0) return systemPrompt;

    const iterations = memories.filter((m) => m.type === 'iteration');
    const others = memories.filter((m) => m.type !== 'iteration');

    if (others.length > 0) {
      const relativeTime = (ms: number): string => {
        const diffSec = Math.floor((Date.now() - ms) / 1000);
        if (diffSec < 60) return `${diffSec}s ago`;
        if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
        if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
        const days = Math.floor(diffSec / 86400);
        if (days === 1) return 'yesterday';
        if (days < 30) return `${days} days ago`;
        if (days < 365) return `${Math.floor(days / 30)} months ago`;
        return `${Math.floor(days / 365)} years ago`;
      };
      const memLines = others.map((m) => {
        const tag = m.type === 'pinned' ? '📌' : m.type === 'insight' ? '💡' : '📝';
        return `${tag} [${relativeTime(m.createdAt)}] ${m.content}`;
      }).join('\n');
      systemPrompt += `\n\n## Relevant Memories (from previous sessions)\n${memLines}`;
    }

    if (iterations.length > 0) {
      const iterLines = iterations.map((m) => {
        const d = new Date(m.createdAt).toISOString().slice(0, 10);
        return `### [${d}]\n${m.content}`;
      }).join('\n\n');
      systemPrompt += `\n\n## Recent Iteration History (from past sessions)\n` +
        `> These are auto-captured snapshots of what was done in previous sessions.\n` +
        `> Use them to maintain continuity and avoid repeating past mistakes.\n\n${iterLines}`;
    }
  } catch {
    // Memory recall failure is non-fatal
  }
  return systemPrompt;
}

// ─── Iteration snapshot ───────────────────────────────────────────────────────

/**
 * 在成功完成一次 session turn 后，自动捕获迭代快照。
 * Cowork Forge "迭代知识记忆" 模式。
 */
export async function captureIterationSnapshot(
  originalPrompt: string,
  history: Message[],
): Promise<void> {
  if (history.length < 4) return;

  try {
    const store = getMemoryStore(process.cwd());
    const recentTurns = history.slice(-20);
    const convText = recentTurns
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => `[${m.role.toUpperCase()}]: ${String(m.content).slice(0, 400)}`)
      .join('\n');

    const snapshotPrompt = `You are creating a brief retrospective snapshot of an AI coding session.

## Original Request
${originalPrompt.slice(0, 300)}

## Session Summary (recent turns)
${convText}

## Your Task
Write a concise retrospective in 3-5 bullet points covering:
1. What was accomplished (files created/modified, features added)
2. Key decisions made or patterns established
3. Any problems encountered and how they were resolved
4. Tech debt or follow-up items left for future sessions

Rules:
- Be specific (name actual files, functions, patterns)
- Keep each bullet to 1-2 sentences
- Start each bullet with • 
- Do NOT include meta-commentary about this being a snapshot
- Write from first-person perspective ("We refactored...", "Added support for...")`;

    const client = modelManager.getClient('compact');
    const response = await client.chat({
      systemPrompt: 'You are a retrospective assistant. Write concise, specific session summaries.',
      messages: [{ role: 'user', content: snapshotPrompt }],
    });

    const content = response.content.trim();
    if (content && content.length > 20) {
      store.add({
        type: 'iteration',
        content,
        tags: ['session', 'retrospective', 'auto-snapshot'],
        source: 'agent',
      });
    }
  } catch {
    // Snapshot failure is completely non-fatal
  }
}

// ─── @mention expansion ───────────────────────────────────────────────────────

/**
 * Expand @run-agent-<name> and @ask-<model> mentions into tool call hints.
 */
export function expandMentions(prompt: string): string {
  const hints: string[] = [];

  const agentMentions = prompt.match(/@run-agent-([\w-]+)/g) || [];
  for (const mention of agentMentions) {
    const agentName = mention.replace('@run-agent-', '');
    if (subagentSystem.getAgent(agentName)) {
      hints.push(`delegate to subagent "${agentName}" using the Task tool`);
    }
  }

  const modelMentions = prompt.match(/@ask-([\w-.:]+)/g) || [];
  for (const mention of modelMentions) {
    const modelName = mention.replace('@ask-', '');
    hints.push(`consult expert model "${modelName}" using the AskExpertModel tool`);
  }

  if (hints.length === 0) return prompt;
  return `${prompt}\n\n[Hints: ${hints.join('; ')}]`;
}

// ─── Main loop ────────────────────────────────────────────────────────────────

export interface RunStreamOptions {
  prompt: string;
  onChunk: (chunk: string) => void;
  events?: AgentEvents;
  filePath?: string;
  abortSignal?: AbortSignal;
  history: Message[];
  /** Mutable reference — loop sets this to null after consuming */
  pendingConfirmationRef: { value: PendingConfirmation | null };
  uncertainItems: string[];
  systemPromptOverride: string | null;
  appendSystemPrompt: string | null;
  thinkingLevel: import('../../models/types.js').ThinkingLevel | undefined;
  currentDomain: string;
  verbose: boolean;
  registry: ToolRegistry;
  router: DomainRouter;
  getLLM: () => LLMClient;
  fallbackChain: ModelFallbackChain | null;
  /** Permission mode: 'default' | 'autoEdit' | 'yolo' (Round 4, claude-code parity) */
  approvalMode?: import('./permission-manager.js').ApprovalMode;
}

export async function runStreamLoop(opts: RunStreamOptions): Promise<void> {
  const {
    prompt, onChunk, events, filePath,
    history, pendingConfirmationRef, uncertainItems,
    systemPromptOverride, appendSystemPrompt, thinkingLevel,
    currentDomain, verbose, registry, router, getLLM, fallbackChain,
    approvalMode = 'default',
  } = opts;

  // ── Pending confirmation check ─────────────────────────────────────────────
  if (pendingConfirmationRef.value) {
    const pending = pendingConfirmationRef.value;
    pendingConfirmationRef.value = null;
    await handlePendingConfirmation(pending, prompt, history, onChunk);
    return;
  }

  // Auto-detect domain
  const domain = currentDomain === 'auto'
    ? router.detectDomain(prompt)
    : currentDomain;

  const expandedPrompt = expandMentions(prompt);

  // ── Round 7: ultrathink keyword → max thinking budget ─────────────────────
  // If user includes "ultrathink" in the prompt, auto-escalate to maximum
  // thinking budget (32k tokens) for this turn only.
  // Reference: claude-code thinking.ts ultrathink trigger
  let _ultrathinkActive = false;
  if (/\bultrathink\b/i.test(expandedPrompt) && thinkingLevel !== undefined) {
    _ultrathinkActive = true;
    onChunk('\n🧠 ultrathink mode activated — maximum thinking budget (32k tokens)\n\n');
  }

  const baseSystemPrompt = router.getSystemPrompt(domain);
  let systemPrompt = systemPromptOverride ?? buildSystemPromptWithContext(baseSystemPrompt);
  if (appendSystemPrompt) systemPrompt += `\n\n${appendSystemPrompt}`;

  // ── Memory recall ──────────────────────────────────────────────────────────
  systemPrompt = await appendMemoriesToPrompt(expandedPrompt, systemPrompt);

  const userMessage: Message = {
    role: 'user',
    content: filePath ? `${expandedPrompt}\n\n[File context: ${filePath}]` : expandedPrompt,
  };
  history.push(userMessage);

  // ── Layer 4: Session Memory Update ─────────────────────────────────────────
  updateSessionMemory(history);
  const smCompacted = trySessionMemoryCompaction(history, onChunk);
  if (smCompacted) {
    await triggerHook(createHookEvent('agent', 'compact', { compacted: -1, layer: 4 }));
  }

  // ── Layer 5: Auto-compact ───────────────────────────────────────────────────
  const compacted = await autoCompact(history, onChunk);
  if (compacted > 0) {
    await triggerHook(createHookEvent('agent', 'compact', { compacted }));
  }

  // session:start fires only on the first turn
  if (history.length === 1) {
    await triggerHook(createHookEvent('session', 'start', {
      domain,
      model: modelManager.getCurrentModel('main'),
    }));
  }

  let iteration = 0;
  let lastLLMCallAt = 0;
  const MAX_ITERATIONS = parseInt(process.env.AGENT_MAX_ITERATIONS ?? String(DEFAULT_MAX_ITERATIONS), 10);

  // ── Token Budget Tracker (Round 5: claude-code tokenBudget.ts parity) ────────
  // Tracks per-turn token usage to detect diminishing returns and enforce budget.
  // Sub-agents (spawned via SpawnAgent/CoordinatorTool) bypass budget entirely.
  const _budgetTracker = createBudgetTracker();
  const _isSubAgent = !!(opts as unknown as Record<string, unknown>).isSubAgent;
  const _tokenBudget = process.env.AGENT_TOKEN_BUDGET
    ? parseInt(process.env.AGENT_TOKEN_BUDGET, 10)
    : null;

  const unattendedRetry = process.env.AGENT_UNATTENDED_RETRY === '1';
  let unattendedRetryCount = 0;
  const MAX_UNATTENDED_RETRIES = parseInt(
    process.env.AGENT_MAX_UNATTENDED_RETRIES ?? String(DEFAULT_MAX_UNATTENDED_RETRIES), 10);
  const UNATTENDED_RETRY_DELAY_MS = Math.min(
    parseInt(process.env.AGENT_UNATTENDED_RETRY_DELAY_MS ?? String(DEFAULT_UNATTENDED_RETRY_DELAY_MS), 10),
    MAX_UNATTENDED_RETRY_DELAY_MS,
  );

  let roundsWithoutTodo = 0;
  const teamMgr = getTeammateManager(process.cwd());

  // Outer unattended-retry loop
  let _unattendedDone = false;
  while (!_unattendedDone) {
    _unattendedDone = true;

    while (iteration < MAX_ITERATIONS) {
      iteration++;

      // ── ToolUseSummary: inject pending summaries (Round 3: claude-code parity) ──
      // Summaries generated in the previous iteration (for oversized tool results)
      // are injected as a system note at the start of each iteration so the LLM
      // can reference the compressed version without expanding the context.
      if (_pendingToolSummaries.length > 0) {
        const summaryLines = _pendingToolSummaries
          .map((s) => `[${s.toolName} result compressed] ${s.summary}`)
          .join('\n');
        history.push({ role: 'user', content: `<tool-summaries>\n${summaryLines}\n</tool-summaries>` });
        _pendingToolSummaries.length = 0;
      }

      // ── Min-round-interval throttle ──────────────────────────────────────────
      const _minInterval = parseInt(process.env.AGENT_MIN_ROUND_INTERVAL_MS ?? '500', 10);
      if (_minInterval > 0 && lastLLMCallAt > 0) {
        const _elapsed = Date.now() - lastLLMCallAt;
        if (_elapsed < _minInterval) {
          await new Promise((resolve) => setTimeout(resolve, _minInterval - _elapsed));
        }
      }

      // s08 — drain background task notifications
      const bgNotifs = backgroundManager.drainNotifications();
      if (bgNotifs.length > 0) {
        const notifText = bgNotifs
          .map((n) => `[bg:${n.taskId}] ${n.status}: ${n.result}`)
          .join('\n');
        history.push({
          role: 'user',
          content: `<background-results>\n${notifText}\n</background-results>`,
        });
      }

      // s09 — drain lead inbox
      const inboxMsgs = teamMgr.bus.readInbox('lead');
      if (inboxMsgs.length > 0) {
        history.push({
          role: 'user',
          content: `<inbox>\n${JSON.stringify(inboxMsgs)}\n</inbox>`,
        });
      }

      // Context editing
      const cleared = editContextIfNeeded(history);
      if (cleared > 0) {
        onChunk(`\n✂️  Cleared ${cleared} old tool result(s) to free context space\n`);
      }

      await triggerHook(createHookEvent('agent', 'turn', {
        iteration,
        model: modelManager.getCurrentModel('main'),
      }));

      // Fire plugin pre_prompt hooks — allow plugins to augment system prompt
      try {
        const { getPluginHooks } = await import('../domain-router.js');
        const prePromptHooks = getPluginHooks('pre_prompt');
        for (const hook of prePromptHooks) {
          if (hook.handler) {
            const result = await hook.handler({ systemPrompt, iteration }).catch(() => undefined);
            if (typeof result === 'string' && result.length > 0) {
              systemPrompt = systemPrompt + '\n\n' + result;
            }
          }
        }
      } catch { /* plugin hooks are non-fatal */ }

      const currentTools = registry.getToolDefinitions();
      const _lastUserRaw = [...history].reverse().find((m) => m.role === 'user')?.content ?? prompt;
      const lastUserMsg: string = typeof _lastUserRaw === 'string'
        ? _lastUserRaw
        : Array.isArray(_lastUserRaw)
          ? _lastUserRaw.map((b: import('../../models/types.js').ContentBlock) => typeof b === 'string' ? b : '').join('')
          : prompt;
      const tools = await selectTools(currentTools, lastUserMsg, history);

      let response;
      const _llmCallStart = Date.now();
      // ── StreamingToolExecutor: eagerly execute read-only tools during streaming ──
      // Mirrors claude-code's StreamingToolExecutor.  Create a new executor per
      // iteration (reset state).  The executor is fed tool call deltas via
      // onToolCallDelta callback as the LLM streams them out; read-only tools
      // (in PARALLELIZABLE_TOOLS) are submitted immediately when their JSON is
      // complete, without waiting for the full LLM stream to finish.
      let _streamingExecutor: import('./streaming-tool-executor.js').StreamingToolExecutor | null = null;
      try {
        const { StreamingToolExecutor } = await import('./streaming-tool-executor.js');
        _streamingExecutor = new StreamingToolExecutor(registry);
      } catch { /* streaming executor unavailable — fall back to sequential */ }

      const onToolCallDelta = _streamingExecutor
        ? (idx: number, name: string, delta: string, id?: string) => {
            _streamingExecutor!.onToolCallChunk(idx, name, delta, id);
          }
        : undefined;
      try {
        const chatOpts = {
          systemPrompt,
          messages: history,
          tools,
          stream: true,
          // Round 7: ultrathink keyword overrides thinkingLevel to max budget
          thinkingLevel: _ultrathinkActive ? 'max' as const : thinkingLevel,
          onToolCallDelta,
        };
        response = fallbackChain
          ? await withApiRateLimitRetry(
              () => fallbackChain!.callStream(getLLM(), chatOpts, onChunk),
              (elapsed) => onChunk(`\n⏳ Rate-limited — waiting 30s… (${Math.round(elapsed / 60000)}min elapsed)\n`),
            )
          : await withApiRateLimitRetry(
              () => getLLM().streamChat(chatOpts, onChunk),
              (elapsed) => onChunk(`\n⏳ Rate-limited — waiting 30s… (${Math.round(elapsed / 60000)}min elapsed)\n`),
            );
        lastLLMCallAt = Date.now();
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // Record failed call
        sessionMetrics.record({
          model: modelManager.getCurrentModel('main'),
          durationMs: Date.now() - _llmCallStart,
          inputTokens: 0,
          outputTokens: 0,
          success: false,
          error: errMsg.slice(0, 120),
        });
        const isContextOverflow = /413|context.{0,30}(overflow|limit|length|window)|too.{0,10}(long|large|many.{0,10}token)|maximum.{0,20}(context|length)/i.test(errMsg);
        const isPromptTooLong = /prompt_too_long|PROMPT_TOO_LONG|PromptTooLong/i.test(errMsg);

        // ── PTL Retry (Round 5: claude-code PTL retry parity) ─────────────
        // When the LLM explicitly returns a "prompt_too_long" error (as opposed
        // to a general 413), truncate the oldest message group from history and
        // retry — up to MAX_PTL_RETRIES times before giving up.
        if (isPromptTooLong) {
          const MAX_PTL_RETRIES = 3;
          const ptlKey = '__ptl_retry_count__';
          const ptlCount = ((opts as unknown as Record<string, unknown>)[ptlKey] as number | undefined) ?? 0;

          if (ptlCount < MAX_PTL_RETRIES) {
            (opts as unknown as Record<string, unknown>)[ptlKey] = ptlCount + 1;
            // Remove oldest 2 messages (one user+assistant pair)
            const removeCount = Math.min(2, Math.max(0, history.length - 3));
            if (removeCount > 0) {
              history.splice(0, removeCount);
              onChunk(`\n⚠️  Prompt too long — truncating oldest ${removeCount} message(s) and retrying (attempt ${ptlCount + 1}/${MAX_PTL_RETRIES})…\n`);
              history.push(createTombstone(history.length) as unknown as Message);
              continue;
            }
          }
          onChunk(`\n❌ Prompt too long and max PTL retries (${MAX_PTL_RETRIES}) reached.\n`);
          history.push(createTombstone(history.length) as unknown as Message);
          break;
        }

        if (isContextOverflow) {
          onChunk(`\n⚠️  Context overflow detected (${errMsg.slice(0, 80)}) — attempting reactive compact…\n`);
          // ── Tombstone: clear partial streaming messages before retry ────────
          // Inject a tombstone so the UI removes any orphaned partial assistant
          // messages that may have been rendered during the interrupted stream.
          // Mirrors claude-code's query.ts tombstone pattern.
          history.push(createTombstone(history.length) as unknown as Message);
          const recovered = await reactiveCompact(history, onChunk);
          if (recovered) {
            onChunk('  ↩️  Retrying with compacted context…\n');
            continue;
          }
        }
        // ── Tombstone on any LLM error (not just context overflow) ──────────
        // Ensures UI cleans up partial renders from failed stream attempts.
        history.push(createTombstone(history.length) as unknown as Message);
        onChunk(`\n❌ LLM error: ${errMsg}\n`);
        break;
      }

      // Track token usage + metrics; also attach usage to last assistant message
      // so countTokensFromHistory() can use precise counts without extra API calls
      {
        const rawUsage = ((response as unknown as Record<string, unknown>).usage ?? {}) as {
          input_tokens?: number; output_tokens?: number;
          prompt_tokens?: number; completion_tokens?: number;
          cache_creation_input_tokens?: number; cache_read_input_tokens?: number;
        };
        const rawId = ((response as unknown as Record<string, unknown>).id as string | undefined);
        const inputTokens = rawUsage.input_tokens ?? rawUsage.prompt_tokens ?? 0;
        const outputTokens = rawUsage.output_tokens ?? rawUsage.completion_tokens ?? 0;

        modelManager.recordUsage(inputTokens, outputTokens, modelManager.getCurrentModel('main'));
        sessionMetrics.record({
          model: modelManager.getCurrentModel('main'),
          durationMs: Date.now() - _llmCallStart,
          inputTokens,
          outputTokens,
          success: true,
        });

        // Attach usage + messageId to last assistant message in history for
        // token counting (mirrors claude-code's AssistantMessage.usage pattern)
        if (inputTokens > 0 || outputTokens > 0) {
          const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant');
          if (lastAssistant) {
            lastAssistant.usage = {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              cache_creation_input_tokens: rawUsage.cache_creation_input_tokens,
              cache_read_input_tokens: rawUsage.cache_read_input_tokens,
            };
            if (rawId) lastAssistant.messageId = rawId;
          }
        }
      }

      if (response.type === 'text') {
        const content = response.content;

        // ── maxOutputTokens 三阶段恢复 (Round 3: claude-code parity) ──────────
        // Phase 1-3: If response appears truncated (finish_reason=max_tokens or
        // heuristic), inject continuation meta-message and retry up to 3 times.
        // This avoids cut-off responses when the model hits output token limits.
        const finishReason = (response as unknown as Record<string, unknown>)['finish_reason'] as string | undefined;
        if (isResponseTruncated(content, finishReason)) {
          // Count how many continuation attempts have been made in this iteration
          const contCount = history.filter(
            (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('[SYSTEM:CONTINUE]'),
          ).length;

          if (contCount < MAX_CONTINUATION_RETRIES) {
            // Phase 1+2: Append partial content to history and inject continuation prompt
            history.push({ role: 'assistant', content });
            history.push({
              role: 'user',
              content: '[SYSTEM:CONTINUE] Your response was cut off. Please continue exactly from where you left off, without repeating any previous content.',
            });
            onChunk(`\n↩️  Response truncated — requesting continuation (attempt ${contCount + 1}/${MAX_CONTINUATION_RETRIES})…\n`);
            continue; // retry iteration
          } else {
            // Phase 3: Max retries reached — surface error
            onChunk(`\n⚠️  Response was truncated and ${MAX_CONTINUATION_RETRIES} continuation attempts failed. The response may be incomplete.\n`);
            history.push({ role: 'assistant', content });
            break;
          }
        }

        // Confidence mechanism (kstack article #15310)
        const uncertainPattern = /\[UNCERTAIN\]|⚠️\s*\[UNCERTAIN\]/gi;
        const lines = content.split('\n');
        for (const line of lines) {
          if (uncertainPattern.test(line)) {
            uncertainItems.push(line.trim().replace(/^[\-*>]+\s*/, ''));
          }
        }

        if (uncertainItems.length > 0) {
          const checklist = uncertainItems
            .map((item, i) => `  ${i + 1}. ${item}`)
            .join('\n');
          onChunk(`\n\n---\n⚠️  **Pending Confirmations** (items marked [UNCERTAIN]):  \n${checklist}\n---\n`);
          uncertainItems.length = 0;
        }

        history.push({ role: 'assistant', content });

        // ── Token Budget Check (Round 5: claude-code tokenBudget.ts parity) ──
        // After a text response is committed, check if we've used too many tokens.
        // Diminishing returns: if the model keeps adding tiny increments → stop.
        // Use turn-level token count from the last recorded usage.
        const _lastUsage = (() => {
          const last = [...history].reverse().find((m) => m.role === 'assistant' && m.usage);
          return last?.usage ?? null;
        })();
        const _turnTokens = _lastUsage
          ? (_lastUsage.input_tokens ?? 0) + (_lastUsage.output_tokens ?? 0)
          : 0;
        if (_turnTokens > 0 || _tokenBudget !== null) {
          const _budgetDecision = checkTokenBudget(
            _budgetTracker,
            _turnTokens,
            _tokenBudget,
            _isSubAgent,
          );
          if (_budgetDecision.action === 'stop' && _budgetDecision.reason !== 'sub_agent') {
            const _stopReason = _budgetDecision.reason as 'budget_exhausted' | 'diminishing_returns';
            const stopMsg = buildBudgetStopMessage(_stopReason);
            onChunk(`\n${stopMsg}\n`);
            break;
          } else if (_budgetDecision.action === 'continue') {
            const _nudge = (_budgetDecision as { action: 'continue'; nudgeMessage?: string }).nudgeMessage;
            if (_nudge) {
              history.push({ role: 'user', content: _nudge });
              continue;
            }
          }
        }

        break;
      }

      if (response.type === 'tool_calls') {
        if (verbose) {
          onChunk(`\n🔧 Tools: ${response.toolCalls.map((t) => t.name).join(', ')}\n`);
        }

        history.push({
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls,
        });

        const toolResults: Message[] = [];
        const MAX_PARALLEL_TOOLS = 5;
        const allParallelizable = response.toolCalls.every((c) => PARALLELIZABLE_TOOLS.has(c.name));
        const canParallelize = allParallelizable && response.toolCalls.length > 1;

        // ── StreamingToolExecutor: drain pre-executed results ──────────────
        // If the streaming executor already started executing some tools
        // during the LLM stream, finalize remaining tool calls and collect.
        // This means many read-only tools already have results ready.
        let preExecutedResults: Map<string, string> | null = null;
        if (_streamingExecutor && allParallelizable) {
          try {
            for (let i = 0; i < response.toolCalls.length; i++) {
              const call = response.toolCalls[i];
              _streamingExecutor.finalizeToolCall(
                i, call.name,
                JSON.stringify(call.arguments),
                call.id,
              );
            }
            const drainResults = await _streamingExecutor.drainAndCollect();
            preExecutedResults = new Map(drainResults.map((r) => [r.toolCallId, r.content]));
          } catch { /* drain failure is non-fatal — fall back to normal execution */ }
        }

        const runCall = async (call: (typeof response.toolCalls)[0]) => {
          // ── StreamingToolExecutor: use pre-executed result if available ──
          // If this tool was already executed during LLM streaming, return
          // the cached result immediately without re-executing.
          if (preExecutedResults?.has(call.id)) {
            const preResult = preExecutedResults.get(call.id)!;
            events?.onToolEnd?.(call.name, true, 0);
            return { role: 'tool' as const, toolCallId: call.id, content: preResult };
          }

          events?.onToolStart?.(call.name, call.arguments as Record<string, unknown>);
          const callId = `${call.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          const toolStartMs = Date.now();
          await triggerHook(createHookEvent('tool', 'before', { callId, toolName: call.name, args: call.arguments }));

          // ── ApprovalMode enforcement (Round 4: claude-code parity) ──────────
          // Check permission rules before hooks. In yolo mode, bypass entirely.
          // In autoEdit mode, write tools that are not in alwaysAllow still prompt.
          const permMgr = getPermissionManager(process.cwd());
          const permDecision = permMgr.decide(call.name, call.arguments as Record<string, unknown>, approvalMode);
          if (permDecision === 'deny') {
            await triggerHook(createHookEvent('tool', 'error', { callId, toolName: call.name, error: 'Denied by permission rule', success: false }));
            events?.onToolEnd?.(call.name, false, Date.now() - toolStartMs);
            return { role: 'tool' as const, toolCallId: call.id, content: `[Permission denied] Tool "${call.name}" is blocked by an alwaysDeny rule.` };
          }

          // ── PreToolUse hook: block/modify tool input (inspired by claude-code) ──
          // Hooks may: (1) block the tool by outputting JSON with proceed=false or exit 2
          //            (2) modify tool arguments via updatedInput in JSON stdout
          // This runs via the user-configurable HookRunner (on_tool_call event),
          // separate from the internal triggerHook() above.
          let effectiveArgs = call.arguments;
          try {
            const { getHookRunner } = await import('../hooks.js');
            const runner = getHookRunner(process.cwd());
            if (runner.hasHooksFor('on_tool_call')) {
              const hookResult = await runner.run({
                event: 'on_tool_call',
                toolName: call.name,
                toolArgs: call.arguments as Record<string, unknown>,
                cwd: process.cwd(),
              });
              if (!hookResult.proceed || hookResult.blocked) {
                // Hook blocked the tool call
                const reason = hookResult.blockReason ?? 'Blocked by hook';
                await triggerHook(createHookEvent('tool', 'error', { callId, toolName: call.name, error: reason, success: false }));
                events?.onToolEnd?.(call.name, false, Date.now() - toolStartMs);
                return { role: 'tool' as const, toolCallId: call.id, content: `[Hook blocked] ${reason}` };
              }
              // Apply updatedInput if hook modified the tool arguments
              if (hookResult.updatedInput) {
                effectiveArgs = hookResult.updatedInput;
              }
            }
          } catch { /* Hook check failure is non-fatal — proceed with original args */ }

          // Fire plugin on_tool_call hooks (non-blocking, errors are silent)
          try {
            const { getPluginHooks } = await import('../domain-router.js');
            const toolHooks = getPluginHooks('on_tool_call').filter((h) => !h.tool || h.tool === call.name);
            for (const hook of toolHooks) {
              if (hook.handler) await hook.handler({ toolName: call.name, args: effectiveArgs }).catch(() => {});
            }
          } catch { /* ignore */ }

          try {
            const result = await withToolRetry(
              () => {
                // ── Plan Mode: block write tools (Batch 2) ─────────────────
                const isPlanMode = process.env.UAGENT_PLAN_MODE === '1';
                const WRITE_TOOLS = new Set([
                  'Write', 'Edit', 'Bash', 'FileWrite', 'FileEdit',
                  'write_file', 'edit_file', 'bash',
                ]);
                if (isPlanMode && WRITE_TOOLS.has(call.name)) {
                  return Promise.resolve(
                    `[Plan Mode] Tool "${call.name}" is blocked in plan mode. ` +
                    `This action would write/modify files or execute commands. ` +
                    `Describe the plan but do NOT execute write operations. ` +
                    `Use /plan to exit plan mode.`
                  );
                }
                return registry.execute(call.name, effectiveArgs);
              },
              call.name,
            );
            const durationMs = Date.now() - toolStartMs;
            const newlyActivated = registry.evaluateConditionals(call.name, result);
            if (newlyActivated.length > 0) onChunk(`\n🔓 Unlocked tools: ${newlyActivated.join(', ')}\n`);
            await triggerHook(createHookEvent('tool', 'after', { callId, toolName: call.name, success: true }));
            events?.onToolEnd?.(call.name, true, durationMs);
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
            // ── ToolUseSummary: async compress large results (Round 3) ─────
            // Fire-and-forget background summary for oversized tool outputs.
            // Summary is injected at the start of the NEXT iteration.
            // Only triggered for read-only tools (write tools rarely produce huge output).
            if (resultStr.length >= TOOL_USE_SUMMARY_THRESHOLD && PARALLELIZABLE_TOOLS.has(call.name)) {
              maybeGenerateToolSummary(call.name, resultStr).catch(() => { /* non-fatal */ });
            }
            return { role: 'tool' as const, toolCallId: call.id, content: resultStr };
          } catch (err) {
            const durationMs = Date.now() - toolStartMs;
            await triggerHook(createHookEvent('tool', 'error', { callId, toolName: call.name, error: err instanceof Error ? err.message : String(err), success: false }));
            events?.onToolEnd?.(call.name, false, durationMs);
            return { role: 'tool' as const, toolCallId: call.id, content: `Error: ${err instanceof Error ? err.message : String(err)}` };
          }
        };

        if (canParallelize) {
          const batch = response.toolCalls.slice(0, MAX_PARALLEL_TOOLS);
          const overflow = response.toolCalls.slice(MAX_PARALLEL_TOOLS);

          if (verbose) {
            onChunk(`\n🔧 Tools (parallel): ${batch.map((t) => t.name).join(', ')}\n`);
          }

          const parallelResults = await Promise.all(batch.map(runCall));
          toolResults.push(...parallelResults);

          for (const call of overflow) {
            const r = await runCall(call);
            toolResults.push(r);
          }
        } else {
          // Sequential branch — reuse runCall() for consistent hook behavior
          for (const call of response.toolCalls) {
            if (verbose) {
              const TOOL_ARGS_PREVIEW_CHARS = 120;
              const argsStr = JSON.stringify(call.arguments).slice(0, TOOL_ARGS_PREVIEW_CHARS);
              onChunk(`  → ${call.name}(${argsStr}${argsStr.length >= 120 ? '...' : ''})\n`);
            }

            const toolResult = await runCall(call);

            if (verbose) {
              const TOOL_RESULT_PREVIEW_CHARS = 300;
              const preview = toolResult.content.slice(0, TOOL_RESULT_PREVIEW_CHARS);
              onChunk(`  ✓ ${preview}${preview.length >= TOOL_RESULT_PREVIEW_CHARS ? '...' : ''}\n`);
            }

            // ── Dry-run confirmation gate (kstack article #15313) ──────────────
            // In yolo mode (approvalMode='yolo'), skip the confirmation gate entirely.
            if (toolResult.content.startsWith('__CONFIRM_REQUIRED__:')) {
              // yolo mode: skip user confirmation — execute directly
              if (approvalMode === 'yolo') {
                // Strip the sentinel prefix and continue without prompting
                const firstNewline = toolResult.content.indexOf('\n');
                const dangerousCommand = firstNewline > -1
                  ? toolResult.content.slice(firstNewline + 1).trim()
                  : '';
                onChunk(`\n⚡ [yolo mode] Auto-approving command: \`${dangerousCommand.slice(0, 80)}\`\n`);
                toolResults.push({ ...toolResult, content: `[Auto-approved by yolo mode] ${toolResult.content.slice('__CONFIRM_REQUIRED__:'.length)}` });
                continue;
              }
              const firstNewline = toolResult.content.indexOf('\n');
              const header = toolResult.content.slice('__CONFIRM_REQUIRED__:'.length, firstNewline > -1 ? firstNewline : undefined);
              const dangerousCommand = firstNewline > -1 ? toolResult.content.slice(firstNewline + 1).trim() : '';
              const cmdCwd = (call.arguments.cwd as string | undefined)
                ? String(call.arguments.cwd)
                : process.cwd();

              pendingConfirmationRef.value = {
                command: dangerousCommand,
                cwd: cmdCwd,
                label: header,
                injectedAt: history.length + toolResults.length,
              };

              toolResults.push({
                role: 'tool',
                toolCallId: call.id,
                content: `[Paused for confirmation] Dangerous command detected: ${header}`,
              });
              history.push(...toolResults);

              history.push({
                role: 'user',
                content:
                  `[SYSTEM] The Bash tool wants to execute a potentially destructive command.\n` +
                  `Risk: ${header}\n` +
                  `Command:\n\`\`\`\n${dangerousCommand}\n\`\`\`\n\n` +
                  `Please show the user this information and ask them to reply **yes** to execute or **no** to cancel.`,
              });

              const confirmOpts = { systemPrompt, messages: history, tools: [], stream: false };
              try {
                const confirmResp = fallbackChain
                  ? await fallbackChain.call(getLLM(), confirmOpts)
                  : await getLLM().chat(confirmOpts);
                if (confirmResp.type === 'text') {
                  onChunk(confirmResp.content);
                  history.push({ role: 'assistant', content: confirmResp.content });
                }
              } catch { /* ignore — user will still see the raw prompt */ }

              return;
            }

            toolResults.push(toolResult);
          }
        }

        history.push(...toolResults);

        // s03: TodoWrite nag
        const usedTodo = response.toolCalls.some((tc) => tc.name === 'TodoWrite');
        roundsWithoutTodo = usedTodo ? 0 : roundsWithoutTodo + 1;
        if (todoManager.hasOpenItems() && roundsWithoutTodo >= TODO_NAG_ROUNDS) {
          history.push({ role: 'user', content: '<reminder>Update your TodoWrite list.</reminder>' });
          roundsWithoutTodo = 0;
        }
      }
    } // end inner while

    if (iteration >= MAX_ITERATIONS) {
      onChunk(
        `\n⚠️  Reached iteration limit (${MAX_ITERATIONS} rounds).\n` +
        `   Type /continue (or just press Enter after typing your next message)\n` +
        `   to keep going from where the agent left off.\n` +
        `   To raise the limit: AGENT_MAX_ITERATIONS=100 uagent\n`,
      );
      const last = history[history.length - 1];
      if (last?.role === 'tool') {
        history.push({ role: 'assistant', content: '[Iteration limit reached]' });
      }

      if (unattendedRetry && unattendedRetryCount < MAX_UNATTENDED_RETRIES) {
        unattendedRetryCount++;
        onChunk(
          `\n♻️  Unattended retry ${unattendedRetryCount}/${MAX_UNATTENDED_RETRIES} ` +
          `— waiting ${UNATTENDED_RETRY_DELAY_MS / 1000}s before continuing…\n`,
        );
        await new Promise((res) => setTimeout(res, UNATTENDED_RETRY_DELAY_MS));
        iteration = 0;
        _unattendedDone = false;
        history.push({
          role: 'user',
          content: `[SYSTEM] Unattended retry ${unattendedRetryCount}: please continue from where you left off. Max iterations reset.`,
        });
      }
    } else {
      // Success — capture iteration snapshot (non-blocking)
      captureIterationSnapshot(prompt, history).catch(() => { /* non-fatal */ });
      // Incremental memory ingest: fire-and-forget after each successful round
      // Inspired by claude-code's extractMemories: per-round instead of exit-time batch.
      // Only processes new messages since the last ingest (cursor-based).
      triggerIncrementalIngest(history);
    }
  } // end outer while

  log.debug('runStream completed', { iterations: iteration });
}
