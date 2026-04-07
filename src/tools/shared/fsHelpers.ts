/**
 * tools/shared/fsHelpers.ts — Shared helpers for file system tools
 *
 * Contains shared utilities used across FileReadTool, FileWriteTool,
 * FileEditTool, BashTool, LSTool, and GrepTool.
 */

import { execSync } from 'child_process';
import { resolve } from 'path';

// ─── Output truncation ───────────────────────────────────────────────────────
/** Lines / bytes beyond which tool output is considered "large" */
export const TRUNCATE_MAX_LINES = 200;
export const TRUNCATE_MAX_BYTES = 20 * 1024; // 20 KB

/**
 * Truncate a string to at most TRUNCATE_MAX_LINES / TRUNCATE_MAX_BYTES.
 */
export function truncateOutput(
  text: string,
  maxLines = TRUNCATE_MAX_LINES,
  maxBytes = TRUNCATE_MAX_BYTES,
): { content: string; truncated: boolean; removedLines: number } {
  const lines = text.split('\n');
  if (lines.length <= maxLines && Buffer.byteLength(text, 'utf-8') <= maxBytes) {
    return { content: text, truncated: false, removedLines: 0 };
  }
  let kept = Math.min(lines.length, maxLines);
  let preview = lines.slice(0, kept).join('\n');
  while (kept > 1 && Buffer.byteLength(preview, 'utf-8') > maxBytes) {
    kept = Math.floor(kept * 0.9);
    preview = lines.slice(0, kept).join('\n');
  }
  const removedLines = lines.length - kept;
  const hint =
    `\n\n(Output truncated: showing ${kept} of ${lines.length} lines, ${Math.round(Buffer.byteLength(preview, 'utf-8') / 1024)}KB. ` +
    `To see more: pipe with | head -N or | tail -N, use Grep to search, or Read with offset/limit for files.)`;
  return { content: preview + hint, truncated: true, removedLines };
}

// ─── Path Safety Helper ──────────────────────────────────────────────────────
/**
 * Resolve `userPath` relative to `baseDir` and assert the result stays inside
 * `baseDir` (prevents path-traversal).
 */
export function safeResolvePath(userPath: string, baseDir: string): string {
  const resolved = resolve(baseDir, userPath);
  const base = resolve(baseDir);
  if (resolved !== base && !resolved.startsWith(base + '/')) {
    throw new Error(
      `Path traversal detected: "${userPath}" resolves to "${resolved}" ` +
      `which is outside the working directory "${base}".`,
    );
  }
  return resolved;
}

// ─── Quick Compile Check ─────────────────────────────────────────────────────
/**
 * E34: _quickCompileCheck — lightweight compile check (sync, 10s timeout)
 */
export function quickCompileCheck(filePath: string, ext: string): string | null {
  const TIMEOUT_MS = 10_000;
  try {
    if (ext === '.java') {
      execSync(`javac -nowarn -proc:none "${filePath}" 2>&1`, {
        timeout: TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return null;
    }
    if (ext === '.ts' || ext === '.tsx') {
      const output = execSync(
        `npx tsc --noEmit --strict false --skipLibCheck --allowJs --isolatedModules "${filePath}" 2>&1 || true`,
        { timeout: TIMEOUT_MS, cwd: process.cwd(), encoding: 'utf-8' },
      );
      if (!output.trim()) return null;
      const lines = output.trim().split('\n').slice(0, 3);
      return `⚠️  TypeScript: ${lines.join(' | ')}`;
    }
  } catch (e) {
    const errOutput = (e as { stdout?: string; stderr?: string; message?: string }).stdout
      ?? (e as { stderr?: string }).stderr
      ?? (e as Error).message ?? '';
    if (!errOutput.trim()) return null;
    const lines = errOutput.trim().split('\n').slice(0, 3);
    if (ext === '.java') return `⚠️  Java compile: ${lines.join(' | ')}`;
    return `⚠️  TS check: ${lines.join(' | ')}`;
  }
  return null;
}
