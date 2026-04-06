/**
 * tool-result-storage.ts -- C24: Large tool result disk persistence
 *
 * C24: Mirrors claude-code src/utils/toolResultStorage.ts L55+L205
 *
 * Instead of truncating large tool results (which loses information),
 * this module persists them to disk and replaces the content in the LLM
 * context with a <persisted-output> reference. The model can then use
 * the Read tool to access the full content when needed.
 *
 * Storage: ~/.uagent/tool-results/<toolId>.txt
 * Threshold: 50,000 characters (claude-code aligned)
 *
 * Design goals:
 *   - Zero information loss (vs current truncation approach)
 *   - Transparent to LLM (it can see the preview + knows the file path)
 *   - TTL-based cleanup (older results auto-deleted to prevent disk bloat)
 */

import {
  existsSync, mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync,
} from 'fs';
import { join, resolve } from 'path';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * C24: PERSIST_THRESHOLD_CHARS -- tool results larger than this are persisted to disk.
 * Mirrors claude-code toolResultStorage.ts getPersistenceThreshold() default (50k chars).
 * Matches the truncation threshold from agent-loop.ts G12 (40% of context window).
 */
export const PERSIST_THRESHOLD_CHARS = 50_000;

/**
 * Preview characters shown inline in the LLM context.
 * Large enough to give the model orientation without wasting tokens.
 */
const PREVIEW_CHARS = 500;

/**
 * TTL for persisted tool results: 24 hours.
 * Older files are cleaned up on next startup.
 */
const RESULT_TTL_MS = 24 * 3600_000;

const TOOL_RESULTS_DIR = resolve(process.env.HOME ?? '~', '.uagent', 'tool-results');

// ── Storage helpers ───────────────────────────────────────────────────────────

function ensureDir(): void {
  mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
}

/**
 * C24: cleanupOldResults -- remove tool result files older than TTL.
 * Called lazily on first processToolResult() call.
 */
let _cleanupDone = false;
function cleanupOldResults(): void {
  if (_cleanupDone) return;
  _cleanupDone = true;
  try {
    const now = Date.now();
    const files = readdirSync(TOOL_RESULTS_DIR).filter((f) => f.endsWith('.txt'));
    for (const file of files) {
      try {
        const filePath = join(TOOL_RESULTS_DIR, file);
        const st = statSync(filePath);
        if (now - st.mtimeMs > RESULT_TTL_MS) {
          unlinkSync(filePath);
        }
      } catch { /* skip: file may have been deleted by another process */ }
    }
  } catch { /* TOOL_RESULTS_DIR may not exist yet */ }
}

// ── Core function ─────────────────────────────────────────────────────────────

/**
 * C24: processToolResult -- persist large tool results to disk.
 *
 * If content.length <= PERSIST_THRESHOLD_CHARS: returns content unchanged.
 * If content.length > PERSIST_THRESHOLD_CHARS:
 *   1. Writes full content to ~/.uagent/tool-results/<toolId>.txt
 *   2. Returns a <persisted-output> block with preview + file path
 *
 * The LLM can use the Read tool to retrieve the full content:
 *   Read({ file_path: "<path>" })
 *
 * Mirrors claude-code toolResultStorage.ts L205 processToolResultBlock().
 *
 * @param toolId    Unique tool call ID (from LLM response)
 * @param toolName  Name of the tool (for display in the reference block)
 * @param content   Raw tool result content
 * @returns         Original content or <persisted-output> reference
 */
export async function processToolResult(
  toolId: string,
  toolName: string,
  content: string,
): Promise<string> {
  // Short results pass through unchanged
  if (content.length <= PERSIST_THRESHOLD_CHARS) return content;

  // Lazy cleanup on first large result
  ensureDir();
  cleanupOldResults();

  // Sanitize toolId for filesystem use
  const safeId = toolId.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64);
  const fileName = `${safeId}.txt`;
  const filePath = join(TOOL_RESULTS_DIR, fileName);

  try {
    writeFileSync(filePath, content, 'utf-8');
  } catch (err) {
    // Write failed (disk full, permissions): fall through with truncation
    process.stderr.write(
      `[toolResultStorage] Failed to persist ${toolName} result: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    const truncated = content.slice(0, PERSIST_THRESHOLD_CHARS);
    return (
      `${truncated}\n...[truncated: ${content.length - PERSIST_THRESHOLD_CHARS} chars omitted, ` +
      `could not persist to disk]`
    );
  }

  // Build <persisted-output> reference block
  const preview = content.slice(0, PREVIEW_CHARS);
  const lines: string[] = [
    `<persisted-output tool="${toolName}" id="${safeId}" total_chars="${content.length}" path="${filePath}">`,
    preview,
  ];
  if (content.length > PREVIEW_CHARS) {
    lines.push(`\n... [${content.length - PREVIEW_CHARS} more characters]`);
  }
  lines.push('</persisted-output>');
  lines.push(`Full output saved to: ${filePath}`);
  lines.push(`Use the Read tool with this path to access the complete content.`);

  return lines.join('\n');
}

/**
 * C24: shouldPersistResult -- check if a result should be persisted.
 * Exposed for testing and conditional logic.
 */
export function shouldPersistResult(contentLength: number): boolean {
  return contentLength > PERSIST_THRESHOLD_CHARS;
}
