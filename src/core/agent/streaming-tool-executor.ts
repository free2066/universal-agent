/**
 * streaming-tool-executor.ts — 流式工具提前执行器
 *
 * Round 3 refactor: 四状态机 + Bash 错误传播 + 进度消息
 * Mirrors claude-code's StreamingToolExecutor.ts (531 lines) core design.
 *
 * State machine lifecycle:
 *   queued → executing → completed → yielded
 *
 * Key design decisions (claude-code parity):
 *  1. Four-state lifecycle: queued / executing / completed / yielded
 *     — 'queued': tool call received from LLM, waiting for concurrency gate
 *     — 'executing': tool running asynchronously
 *     — 'completed': result available, not yet returned to caller
 *     — 'yielded': result consumed by drainAndCollect()
 *
 *  2. Dynamic concurrency check via canExecuteTool():
 *     — Only concurrent-safe tools can run in parallel
 *     — Non-safe tools must wait for all executing tools to finish
 *     — Any executing non-safe tool blocks new starts (strict serial)
 *
 *  3. siblingAbortController: Bash/write tool errors abort sibling queued tools
 *     — Only Bash errors propagate (read tool failures do NOT abort siblings)
 *     — Aborted siblings return a synthetic "Cancelled" error message
 *
 *  4. pendingProgress: tools can emit progress messages during execution
 *     — Flushed immediately before result in drainAndCollect()
 *     — Used for "Still working…" style status updates
 *
 *  5. getCompletedResults() strict ordering (claude-code parity):
 *     — Iterates tools in original LLM-declaration order
 *     — Breaks on any non-safe tool that is still 'executing'
 *     — Read tools: yield as completed even if later tools still executing
 *
 * Architecture (unchanged from Round 2):
 *   LLM stream → onToolCallChunk() → complete → processQueue() → execute
 *   stream done → drainAndCollect() → await all → return ordered results
 */

import type { ToolRegistry } from '../tool-registry.js';
import { PARALLELIZABLE_TOOLS } from './types.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Four-state lifecycle for tracked tool calls (claude-code parity) */
export type ToolStatus = 'queued' | 'executing' | 'completed' | 'yielded';

interface TrackedTool {
  index: number;
  toolName: string;
  argsBuffer: string;
  argsComplete: boolean;
  toolCallId?: string;
  status: ToolStatus;
  isConcurrencySafe: boolean;
  promise?: Promise<void>;
  result?: ToolCallResult;
  /** Progress messages emitted during execution — flushed before result */
  pendingProgress: ToolCallResult[];
}

export interface ToolCallResult {
  toolCallId: string;
  toolName: string;
  content: string;
  success: boolean;
  durationMs: number;
  isProgress?: boolean;  // true for progress notifications (not final result)
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Check if a JSON string is "complete" — all braces/brackets balanced.
 * Uses brace counting (cheap O(n) scan) instead of try/catch JSON.parse
 * to avoid exception overhead on every partial chunk.
 */
export function isJsonComplete(s: string): boolean {
  const trimmed = s.trimStart();
  if (!trimmed.startsWith('{')) return false;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (const ch of trimmed) {
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return true;
    }
  }
  return false;
}

// ── StreamingToolExecutor ─────────────────────────────────────────────────────

export class StreamingToolExecutor {
  private readonly registry: ToolRegistry;

  /** All tracked tools, in LLM declaration order */
  private readonly tools: TrackedTool[] = [];
  /** Map from index → TrackedTool for fast lookup */
  private readonly byIndex = new Map<number, TrackedTool>();

  /**
   * AbortController shared among all tools in one executor instance.
   * Aborted when a Bash/write tool errors — signals sibling queued tools
   * to cancel instead of execute. Mirrors claude-code's siblingAbortController.
   */
  private readonly _siblingAbort = new AbortController();
  /** Whether any write-class tool has errored and triggered sibling abort */
  private _siblingErrored = false;

  /**
   * Resolve function for progress availability notification.
   * Set when a tool pushes to pendingProgress during execution.
   */
  private _progressResolve?: () => void;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  // ── State checks ──────────────────────────────────────────────────────────

  private get executingTools(): TrackedTool[] {
    return this.tools.filter((t) => t.status === 'executing');
  }

  private get queuedTools(): TrackedTool[] {
    return this.tools.filter((t) => t.status === 'queued' && t.argsComplete);
  }

  private get hasUnfinished(): boolean {
    return this.tools.some((t) => t.status === 'queued' || t.status === 'executing');
  }

  /**
   * Can we start executing the given tool?
   * Mirrors claude-code's canExecuteTool(isConcurrencySafe):
   *   — No executing tools → always yes
   *   — All executing tools are safe AND new tool is safe → yes (parallel)
   *   — Otherwise → no (must wait for serial execution)
   */
  private canExecuteTool(isConcurrencySafe: boolean): boolean {
    const executing = this.executingTools;
    if (executing.length === 0) return true;
    return isConcurrencySafe && executing.every((t) => t.isConcurrencySafe);
  }

  // ── Tool registration ──────────────────────────────────────────────────────

  /**
   * Called for each streaming chunk that contains tool call argument data.
   */
  onToolCallChunk(
    index: number,
    toolName: string,
    deltaArgs: string,
    toolCallId?: string,
  ): void {
    let tracked = this.byIndex.get(index);
    if (!tracked) {
      const isConcurrencySafe = PARALLELIZABLE_TOOLS.has(toolName);
      tracked = {
        index, toolName,
        argsBuffer: '', argsComplete: false,
        toolCallId,
        status: 'queued',
        isConcurrencySafe,
        pendingProgress: [],
      };
      this.tools.push(tracked);
      this.byIndex.set(index, tracked);
    }

    tracked.argsBuffer += deltaArgs;
    if (toolCallId && !tracked.toolCallId) tracked.toolCallId = toolCallId;

    if (!tracked.argsComplete && isJsonComplete(tracked.argsBuffer)) {
      tracked.argsComplete = true;
      this._processQueue();
    }
  }

  /**
   * Finalize a tool call (all chunks received). Used when LLM stream completes.
   */
  finalizeToolCall(
    index: number,
    toolName: string,
    fullArgs: string,
    toolCallId?: string,
  ): void {
    let tracked = this.byIndex.get(index);
    if (!tracked) {
      const isConcurrencySafe = PARALLELIZABLE_TOOLS.has(toolName);
      tracked = {
        index, toolName,
        argsBuffer: fullArgs, argsComplete: true,
        toolCallId,
        status: 'queued',
        isConcurrencySafe,
        pendingProgress: [],
      };
      this.tools.push(tracked);
      this.byIndex.set(index, tracked);
    } else {
      tracked.argsBuffer = fullArgs;
      tracked.argsComplete = true;
      if (toolCallId) tracked.toolCallId = toolCallId;
    }
    this._processQueue();
  }

  // ── Queue processing ──────────────────────────────────────────────────────

  /**
   * Process the tool queue: start executing any tool that can proceed now.
   * Called after each tool call registration and after each tool completes.
   */
  private _processQueue(): void {
    for (const tool of this.tools) {
      if (tool.status !== 'queued' || !tool.argsComplete) continue;

      // Check sibling abort (another write tool errored)
      if (this._siblingAbort.signal.aborted) {
        // Mark as completed with synthetic error
        const id = tool.toolCallId ?? `aborted-${tool.toolName}-${tool.index}`;
        tool.status = 'completed';
        tool.result = {
          toolCallId: id, toolName: tool.toolName,
          content: 'Cancelled: parallel tool call errored',
          success: false, durationMs: 0,
        };
        continue;
      }

      if (!this.canExecuteTool(tool.isConcurrencySafe)) continue;

      // Start executing
      tool.status = 'executing';
      tool.promise = this._executeOneTool(tool)
        .then(() => {
          // After completion, try to unblock queued tools
          this._processQueue();
          // Notify getRemainingResults() that progress is available
          this._progressResolve?.();
          this._progressResolve = undefined;
        });
    }
  }

  // ── Result collection ──────────────────────────────────────────────────────

  /**
   * Synchronously yield all completed results in strict declaration order.
   *
   * Mirrors claude-code's getCompletedResults() generator:
   *  1. Always flush pendingProgress first (real-time status updates)
   *  2. If tool is 'completed' → yield result, transition to 'yielded'
   *  3. If tool is 'executing' AND non-safe → BREAK (preserve order)
   *  4. If tool is 'executing' AND safe → skip (don't break, let parallel result through)
   */
  *getCompletedResults(): Generator<ToolCallResult, void> {
    for (const tool of this.tools) {
      // Always flush progress messages immediately
      while (tool.pendingProgress.length > 0) {
        yield tool.pendingProgress.shift()!;
      }

      if (tool.status === 'yielded') continue;

      if (tool.status === 'completed' && tool.result) {
        tool.status = 'yielded';
        yield tool.result;
      } else if (tool.status === 'executing' && !tool.isConcurrencySafe) {
        // Non-safe tool still running — must wait before yielding anything after it
        break;
      }
      // Safe executing tool: skip (don't break — later completed tools can yield)
    }
  }

  /**
   * Async generator: wait for remaining tools and yield results as they complete.
   * Mirrors claude-code's getRemainingResults() async generator.
   */
  async *getRemainingResults(): AsyncGenerator<ToolCallResult, void> {
    while (this.hasUnfinished) {
      this._processQueue();

      // Yield any already-completed results
      for (const result of this.getCompletedResults()) {
        yield result;
      }

      // If still unfinished, wait for next completion or progress
      if (this.hasUnfinished) {
        const executing = this.executingTools;
        if (executing.length > 0) {
          const progressPromise = new Promise<void>((resolve) => {
            this._progressResolve = resolve;
          });
          const executingPromises = executing
            .filter((t) => t.promise)
            .map((t) => t.promise!);
          if (executingPromises.length > 0) {
            await Promise.race([...executingPromises, progressPromise]);
          } else {
            break; // No executing tools with promises — exit
          }
        } else {
          break; // No executing tools
        }
      }
    }

    // Final flush
    for (const result of this.getCompletedResults()) {
      yield result;
    }
  }

  /**
   * Wait for all eagerly-started tools to complete, then execute remaining tools.
   * Returns all results in LLM declaration order.
   *
   * Backward-compatible entry point for code using the old API.
   */
  async drainAndCollect(): Promise<ToolCallResult[]> {
    // Finalize any queued-but-not-finalized tools
    this._processQueue();

    // Collect via async generator
    const results: ToolCallResult[] = [];
    for await (const result of this.getRemainingResults()) {
      if (!result.isProgress) {
        results.push(result);
      }
    }
    return results;
  }

  // ── Tool execution ─────────────────────────────────────────────────────────

  /**
   * Execute one tool call, updating the TrackedTool status and result.
   * Handles sibling abort propagation for Bash/write errors.
   */
  private async _executeOneTool(tracked: TrackedTool): Promise<void> {
    const start = Date.now();
    const id = tracked.toolCallId ?? `streaming-${tracked.toolName}-${tracked.index}`;

    // Emit progress after 2 seconds for long-running tools
    let progressTimer: ReturnType<typeof setTimeout> | undefined;
    if (!tracked.isConcurrencySafe) {
      progressTimer = setTimeout(() => {
        tracked.pendingProgress.push({
          toolCallId: id, toolName: tracked.toolName,
          content: `[${tracked.toolName}] Still working...`,
          success: true, durationMs: 0, isProgress: true,
        });
        this._progressResolve?.();
        this._progressResolve = undefined;
      }, 2000);
    }

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(tracked.argsBuffer);
    } catch {
      clearTimeout(progressTimer);
      tracked.status = 'completed';
      tracked.result = {
        toolCallId: id, toolName: tracked.toolName,
        content: `Error: Failed to parse tool arguments: ${tracked.argsBuffer.slice(0, 100)}`,
        success: false, durationMs: Date.now() - start,
      };
      return;
    }

    try {
      const result = await this.registry.execute(tracked.toolName, args);
      clearTimeout(progressTimer);
      const content = typeof result === 'string' ? result : JSON.stringify(result);
      tracked.status = 'completed';
      tracked.result = {
        toolCallId: id, toolName: tracked.toolName,
        content, success: true, durationMs: Date.now() - start,
      };
    } catch (err) {
      clearTimeout(progressTimer);
      const errMsg = err instanceof Error ? err.message : String(err);
      tracked.status = 'completed';
      tracked.result = {
        toolCallId: id, toolName: tracked.toolName,
        content: `Error: ${errMsg}`,
        success: false, durationMs: Date.now() - start,
      };

      // ── Sibling abort: Bash/write errors propagate to queued siblings ────
      // Mirrors claude-code: only non-safe (write-class) tool errors abort siblings.
      // Read tool failures (e.g. file not found) do NOT abort other tools.
      if (!tracked.isConcurrencySafe) {
        this._siblingErrored = true;
        this._siblingAbort.abort('sibling_error');
      }
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Reset state for reuse between iterations */
  reset(): void {
    this.tools.length = 0;
    this.byIndex.clear();
    this._progressResolve = undefined;
  }

  /** Whether sibling abort was triggered (Bash/write error occurred) */
  get siblingErrored(): boolean {
    return this._siblingErrored;
  }

  /** How many tools were eagerly executed during streaming */
  get eagerCount(): number {
    return this.tools.filter((t) => t.isConcurrencySafe && t.status !== 'queued').length;
  }
}
