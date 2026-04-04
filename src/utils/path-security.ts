/**
 * Path Security Utilities — CWE-22 Path Traversal Prevention
 *
 * Context:
 *   universal-agent is a developer-facing AI agent CLI. Many of its tools
 *   (Read, Write, Edit, Bash, LS, Grep) are *intentionally* designed to
 *   access arbitrary file-system paths — that is the core value proposition.
 *
 *   However, some internal subsystems build paths from user-supplied names/IDs
 *   that are expected to stay within a specific base directory (e.g. the
 *   .uagent/context/, .uagent/worktrees/, .uagent/tasks/ trees).  Passing a
 *   name like "../../etc/passwd" to those subsystems would escape the intended
 *   directory — a real path-traversal vulnerability.
 *
 * Strategy:
 *   1. safeResolve()  — for INTERNAL subsystems that must stay within a base dir
 *      (config files, context files, task JSON files, worktree index).
 *      Throws if the resolved path escapes the base.
 *
 *   2. sanitizeName() — validate that a user-supplied short name/ID (e.g. a
 *      context ID, worktree name, task slug) contains only safe characters
 *      before it is concatenated into a path.
 *
 *   3. isPathWithinBase() — predicate form for conditional checks.
 *
 * What is NOT in scope:
 *   The agent's first-class file tools (Read, Write, Edit, Bash, LS, Grep) are
 *   intentionally unrestricted — they operate on whatever paths the developer
 *   instructs. Restricting them would break the agent's core functionality.
 *   Those tools already include secret-scanning on write (see fs-tools.ts).
 */

import { resolve, normalize } from 'path';

// ── Core guard ────────────────────────────────────────────────────────────────

/**
 * Resolve `userPath` relative to `baseDir` and assert the result is still
 * inside `baseDir`.  Throws a descriptive error if path traversal is detected.
 *
 * @param userPath  - path (absolute or relative) supplied by user / external data
 * @param baseDir   - the directory that must contain the resolved path
 * @returns the resolved, safe absolute path
 *
 * @example
 *   const safe = safeResolve(contextId, join(cwd, '.uagent', 'context'));
 *   // contextId = '../../etc/passwd' → throws
 *   // contextId = 'my-notes'         → ok
 */
export function safeResolve(userPath: string, baseDir: string): string {
  const base = resolve(baseDir);
  // normalize() collapses ../ sequences before we resolve
  const candidate = resolve(base, normalize(userPath));

  // Ensure candidate is inside base (add trailing sep to prevent prefix match)
  if (!candidate.startsWith(base + '/') && candidate !== base) {
    throw new Error(
      `Path traversal detected: "${userPath}" escapes allowed base directory "${baseDir}"`,
    );
  }
  return candidate;
}

// ── Predicate form ────────────────────────────────────────────────────────────

/**
 * Returns true if `candidatePath` is equal to or nested inside `baseDir`.
 * Does NOT throw — use when you want to check without throwing.
 */
export function isPathWithinBase(candidatePath: string, baseDir: string): boolean {
  const base = resolve(baseDir);
  const candidate = resolve(candidatePath);
  return candidate === base || candidate.startsWith(base + '/');
}

// ── Name sanitiser ────────────────────────────────────────────────────────────

/**
 * Validate that a short user-supplied name/ID (e.g. a context file stem,
 * worktree name, task slug) is safe to concatenate into a file path.
 *
 * Allows: letters, digits, dash, underscore, dot (no slash, no space, no ..).
 * Length: 1–128 characters.
 *
 * @throws if the name is empty, too long, or contains unsafe characters
 */
export function sanitizeName(name: string, label = 'name'): string {
  if (!name || typeof name !== 'string') {
    throw new Error(`Invalid ${label}: must be a non-empty string`);
  }
  if (name.length > 128) {
    throw new Error(`Invalid ${label}: exceeds 128-character limit`);
  }
  // Reject traversal sequences regardless of further characters
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new Error(
      `Invalid ${label}: "${name}" contains path-traversal characters (..  /  \\)`,
    );
  }
  // Allow only URL/filename-safe characters
  if (!/^[A-Za-z0-9._\-]+$/.test(name)) {
    throw new Error(
      `Invalid ${label}: "${name}" contains illegal characters. ` +
        'Only letters, digits, dash, underscore, and dot are allowed.',
    );
  }
  return name;
}
