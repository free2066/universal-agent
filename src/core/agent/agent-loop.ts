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
import { getMemoryStore } from '../memory/memory-store.js';
import { createLogger } from '../logger.js';
import { triggerHook, createHookEvent } from '../hooks.js';
import { withToolRetry, withApiRateLimitRetry } from '../tool-retry.js';
import { editContextIfNeeded } from '../context/context-editor.js';
import { selectTools } from '../tool-selector.js';
import { backgroundManager } from '../background-manager.js';
import { todoManager } from '../tools/productivity/todo-tool.js';
import { getTeammateManager } from '../teammate-manager.js';
import { sessionMetrics } from '../metrics.js';

const log = createLogger('agent-loop');

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
}

export async function runStreamLoop(opts: RunStreamOptions): Promise<void> {
  const {
    prompt, onChunk, events, filePath,
    history, pendingConfirmationRef, uncertainItems,
    systemPromptOverride, appendSystemPrompt, thinkingLevel,
    currentDomain, verbose, registry, router, getLLM, fallbackChain,
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
      try {
        const chatOpts = {
          systemPrompt,
          messages: history,
          tools,
          stream: true,
          thinkingLevel,
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
        if (isContextOverflow) {
          onChunk(`\n⚠️  Context overflow detected (${errMsg.slice(0, 80)}) — attempting reactive compact…\n`);
          const recovered = await reactiveCompact(history, onChunk);
          if (recovered) {
            onChunk('  ↩️  Retrying with compacted context…\n');
            continue;
          }
        }
        onChunk(`\n❌ LLM error: ${errMsg}\n`);
        break;
      }

      // Track token usage + metrics
      {
        const usage = ((response as unknown as Record<string, unknown>).usage ?? {}) as {
          input_tokens?: number; output_tokens?: number;
          prompt_tokens?: number; completion_tokens?: number;
        };
        const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
        const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
        modelManager.recordUsage(inputTokens, outputTokens, modelManager.getCurrentModel('main'));
        sessionMetrics.record({
          model: modelManager.getCurrentModel('main'),
          durationMs: Date.now() - _llmCallStart,
          inputTokens,
          outputTokens,
          success: true,
        });
      }

      if (response.type === 'text') {
        const content = response.content;

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

        const runCall = async (call: (typeof response.toolCalls)[0]) => {
          events?.onToolStart?.(call.name, call.arguments as Record<string, unknown>);
          const callId = `${call.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          const toolStartMs = Date.now();
          await triggerHook(createHookEvent('tool', 'before', { callId, toolName: call.name, args: call.arguments }));

          // Fire plugin on_tool_call hooks (non-blocking, errors are silent)
          try {
            const { getPluginHooks } = await import('../domain-router.js');
            const toolHooks = getPluginHooks('on_tool_call').filter((h) => !h.tool || h.tool === call.name);
            for (const hook of toolHooks) {
              if (hook.handler) await hook.handler({ toolName: call.name, args: call.arguments }).catch(() => {});
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
                return registry.execute(call.name, call.arguments);
              },
              call.name,
            );
            const durationMs = Date.now() - toolStartMs;
            const newlyActivated = registry.evaluateConditionals(call.name, result);
            if (newlyActivated.length > 0) onChunk(`\n🔓 Unlocked tools: ${newlyActivated.join(', ')}\n`);
            await triggerHook(createHookEvent('tool', 'after', { callId, toolName: call.name, success: true }));
            events?.onToolEnd?.(call.name, true, durationMs);
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
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
          // Sequential branch
          for (const call of response.toolCalls) {
            if (verbose) {
              const TOOL_ARGS_PREVIEW_CHARS = 120;
              const argsStr = JSON.stringify(call.arguments).slice(0, TOOL_ARGS_PREVIEW_CHARS);
              onChunk(`  → ${call.name}(${argsStr}${argsStr.length >= 120 ? '...' : ''})\n`);
            }

            events?.onToolStart?.(call.name, call.arguments as Record<string, unknown>);
            const callId = `${call.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const toolStartMs = Date.now();
            await triggerHook(createHookEvent('tool', 'before', { callId, toolName: call.name, args: call.arguments }));

            try {
              const result = await withToolRetry(
                () => registry.execute(call.name, call.arguments),
                call.name,
              );
              const toolDurationMs = Date.now() - toolStartMs;
              const newlyActivated = registry.evaluateConditionals(call.name, result);
              if (newlyActivated.length > 0) {
                onChunk(`\n🔓 Unlocked tools: ${newlyActivated.join(', ')}\n`);
              }
              await triggerHook(createHookEvent('tool', 'after', { callId, toolName: call.name, success: true }));
              events?.onToolEnd?.(call.name, true, toolDurationMs);

              if (verbose) {
                const TOOL_RESULT_PREVIEW_CHARS = 300;
                const preview = JSON.stringify(result).slice(0, TOOL_RESULT_PREVIEW_CHARS);
                onChunk(`  ✓ ${preview}${preview.length === 300 ? '...' : ''}\n`);
              }

              const resultStr = typeof result === 'string' ? result : JSON.stringify(result);

              // ── Dry-run confirmation gate (kstack article #15313) ──────────────
              if (resultStr.startsWith('__CONFIRM_REQUIRED__:')) {
                const firstNewline = resultStr.indexOf('\n');
                const header = resultStr.slice('__CONFIRM_REQUIRED__:'.length, firstNewline > -1 ? firstNewline : undefined);
                const dangerousCommand = firstNewline > -1 ? resultStr.slice(firstNewline + 1).trim() : '';
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

              toolResults.push({
                role: 'tool',
                toolCallId: call.id,
                content: resultStr,
              });
            } catch (err) {
              const toolDurationMsErr = Date.now() - toolStartMs;
              await triggerHook(createHookEvent('tool', 'error', {
                callId,
                toolName: call.name,
                error: err instanceof Error ? err.message : String(err),
                success: false,
              }));
              events?.onToolEnd?.(call.name, false, toolDurationMsErr);
              toolResults.push({
                role: 'tool',
                toolCallId: call.id,
                content: `Error: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
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
    }
  } // end outer while

  log.debug('runStream completed', { iterations: iteration });
}
