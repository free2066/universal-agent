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
 *   4. isDangerousRemovalPath() — B17: detect dangerous top-level paths that
 *      should never be deleted (/, /usr, ~, etc.).
 *
 *   5. validatePathForOperation() — B17: complete 7-step validation chain
 *      (UNC paths, tilde variants, shell expansion syntax, glob writes,
 *       dangerous removal paths, config directory writes, allowlist checks).
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

// ── B17: 完整路径安全验证链 ────────────────────────────────────────────────────
//
// 对标 claude-code src/utils/permissions/pathValidation.ts 的 7 步检查链。
// 用于 agent 工具（fs-tools.ts）在执行写操作/删除操作时的额外安全验证。
//
// 注意：这些检查属于"可选安全增强层"，不阻止 agent 的正常文件操作。
// 对于普通读写操作，agent 工具仍然完全自由。
// 这些检查主要用于：
//   1. 删除操作的危险路径检测
//   2. 内部子系统（非用户指令）路径验证
//   3. 配置目录写保护

export type PathOperationType = 'read' | 'write' | 'delete' | 'execute';

export interface PathValidationResult {
  /** Whether the operation is allowed */
  allowed: boolean;
  /** Human-readable reason if not allowed */
  reason?: string;
}

/**
 * B17: isDangerousRemovalPath — 拦截危险的删除目标路径。
 *
 * 对标 claude-code pathValidation.ts isDangerousRemovalPath()。
 * 防止误删 /, ~, /usr, /etc 等系统根目录（CWE-73）。
 *
 * @param filePath - path to check (absolute or relative)
 * @returns true if the path is too dangerous to delete
 */
export function isDangerousRemovalPath(filePath: string): boolean {
  const homedir = process.env.HOME ?? '/root';
  const abs = resolve(filePath.replace(/^~(?=\/|$)/, homedir));

  // Exact match against known dangerous paths
  const DANGEROUS_EXACT = new Set<string>([
    '/',
    homedir,
    resolve(homedir),
    '/usr',
    '/bin',
    '/sbin',
    '/etc',
    '/var',
    '/tmp',
    '/home',
    '/root',
    '/boot',
    '/dev',
    '/proc',
    '/sys',
    '/opt',
    '/lib',
    '/lib64',
    '/run',
    '/snap',
    '/Applications',   // macOS
    '/System',          // macOS
    '/Library',         // macOS
    '/Users',           // macOS
    'C:\\',             // Windows
    'C:\\Windows',      // Windows
  ]);

  if (DANGEROUS_EXACT.has(abs)) return true;

  // Depth check: paths with 0 or 1 segments after root are dangerous
  const parts = abs.split('/').filter(Boolean);
  if (parts.length <= 1 && abs.startsWith('/')) return true;

  return false;
}

/**
 * B17: validatePathForOperation — 完整 7 步路径安全验证链。
 *
 * 对标 claude-code pathValidation.ts 的 isPathAllowed() + validatePath()。
 *
 * 7 步检查顺序：
 *   1. UNC 路径拦截（Windows \\server\share，防 NTLM credential 泄露）
 *   2. tilde 变体拒绝（~user, ~+, ~-，TOCTOU 漏洞）
 *   3. shell 展开语法拦截（$VAR, ${VAR}, $(cmd), %VAR%, =cmd）
 *   4. glob 写操作阻止（* ? [ 在写路径中不允许）
 *   5. isDangerousRemovalPath（删除操作检查危险根目录）
 *   6. agent 配置目录写保护（.uagent/ 仅允许特定子目录写入）
 *   7. agent 可写目录白名单（.uagent/context/, .uagent/output/ 等）
 *
 * @param filePath - path to validate
 * @param operationType - type of operation being attempted
 * @returns validation result with allowed flag and reason
 */
export function validatePathForOperation(
  filePath: string,
  operationType: PathOperationType = 'read',
): PathValidationResult {
  if (!filePath || typeof filePath !== 'string') {
    return { allowed: false, reason: 'Empty or invalid path' };
  }

  // Step 1: UNC paths (\\server\share or //server/share)
  // Prevents NTLM credential leakage on Windows networks
  if (/^\\\\/.test(filePath) || /^\/\/[^/]/.test(filePath)) {
    return {
      allowed: false,
      reason: 'UNC paths (\\\\server\\share) are not allowed — prevents NTLM credential leakage',
    };
  }

  // Step 2: Tilde variants — only ~/ (home dir) is allowed; ~user, ~+, ~- are not
  // These create TOCTOU vulnerabilities and are almost never intentional
  if (/^~[^/\s]/.test(filePath)) {
    return {
      allowed: false,
      reason: `Non-home tilde variants (${JSON.stringify(filePath.slice(0, 6))}) are not allowed — use absolute paths instead`,
    };
  }

  // Step 3: Shell expansion syntax in paths
  // $VAR, ${VAR}, $(cmd), %VAR% (Windows), =cmd (zsh)
  // These can be exploited to execute commands or leak env vars
  if (/\$\{|\$\(/.test(filePath) || /%[A-Za-z_][A-Za-z0-9_]*%/.test(filePath)) {
    return {
      allowed: false,
      reason: 'Shell expansion syntax in file paths is not allowed — use literal paths',
    };
  }

  // Step 4: Glob characters in write/delete operations
  // Prevents * ? [ from being used to match multiple files in destructive ops
  if ((operationType === 'write' || operationType === 'delete') && /[*?[]/.test(filePath)) {
    return {
      allowed: false,
      reason: `Glob patterns are not allowed in ${operationType} operations — specify exact path`,
    };
  }

  // Step 5: Dangerous removal path check (delete operations only)
  if (operationType === 'delete' && isDangerousRemovalPath(filePath)) {
    return {
      allowed: false,
      reason: `Refusing to delete dangerous system path: ${filePath}`,
    };
  }

  // Step 6: Protect agent config directory from unauthorized writes
  // .uagent/ directory: only specific well-known subdirs are writable
  const normalizedPath = filePath.replace(/\\/g, '/');
  const isAgentConfigWrite =
    operationType === 'write' &&
    /(?:^|\/)\.(uagent|claude|anthropic)\//.test(normalizedPath);

  if (isAgentConfigWrite) {
    // Allow writes to known agent working directories
    const AGENT_WRITABLE_PATTERNS = [
      /\/\.uagent\/(context|scratchpad|memory|output|tasks|worktrees|sessions)\//,
      /\/\.uagent\/hooks\.json$/,
      /\/\.uagent\/settings(?:\.local)?\.json$/,
    ];
    const isAllowedAgentPath = AGENT_WRITABLE_PATTERNS.some((p) => p.test(normalizedPath));
    if (!isAllowedAgentPath) {
      return {
        allowed: false,
        reason: `Writing to agent config directory (${filePath}) requires explicit permission`,
      };
    }
  }

  // Step 7: All checks passed — allow
  return { allowed: true };
}
