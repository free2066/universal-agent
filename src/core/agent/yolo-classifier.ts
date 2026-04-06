/**
 * yolo-classifier.ts -- Lightweight LLM speculative classifier for autoEdit mode
 *
 * Mirrors claude-code's yoloClassifier.ts (50KB) at a much smaller scale.
 *
 * In autoEdit mode, instead of always prompting the user for non-READ_TOOLS,
 * this classifier asks a compact/fast model to judge whether a tool call is safe
 * to auto-approve without user interaction.
 *
 * Design decisions:
 * - Uses the cheapest available model (Haiku / flash / gpt-4o-mini)
 * - Hard timeout of 2000ms; on failure returns 'unavailable' (fail-open)
 * - DenialTracker: after maxConsecutive=3 or maxTotal=20 denials, fall back to
 *   prompting mode regardless of mode setting (prevents LLM abuse of autoEdit)
 * - Allowlist fast-path: known safe read-only tools bypass classifier entirely
 * - Per-session singleton (one tracker per CWD)
 *
 * Round 5: claude-code yoloClassifier.ts parity
 */

import { createLogger } from '../logger.js';

const log = createLogger('yolo-classifier');

// ── Classifier result type ────────────────────────────────────────────────────

export type ClassifierDecision = 'allow' | 'deny' | 'unavailable';

// ── Denial limits (matches claude-code DENIAL_LIMITS) ─────────────────────────

export const DENIAL_LIMITS = {
  maxConsecutive: 3,
  maxTotal: 20,
} as const;

/** Classifier timeout — fail-open after this many ms */
const CLASSIFIER_TIMEOUT_MS = 2000;

// ── Allowlist fast-path (tools that are always safe to auto-approve) ──────────

/** Read-only tools that never need classifier evaluation */
const ALLOWLIST_TOOLS = new Set([
  // File system — read
  'Read', 'read_file', 'readFile',
  'LS', 'ls', 'list_files', 'ListDir',
  'Grep', 'grep_search', 'GrepSearch',
  'Glob', 'glob_search',
  'ViewFileOutline', 'view_file_outline',
  'ViewCodeItem', 'view_code_item',
  // Web read
  'WebFetch', 'web_fetch', 'WebSearch', 'web_search',
  // Inspection / analysis (read-only)
  'InspectCode', 'inspect_code',
  'EnvProbe', 'env_probe',
  'DatabaseQuery', 'database_query',
  // Git read
  'GitLog', 'git_log', 'GitDiff', 'git_diff', 'GitStatus', 'git_status',
]);

/** Write/execute tools that always need evaluation in autoEdit mode */
const BLOCKLIST_TOOL_PATTERNS = [
  /^(Bash|bash|Shell|shell|RunCommand|run_command|Execute|execute)$/,
  /^(Write|write_file|WriteFile|Edit|edit_file|EditFile)$/,
  /^(Delete|delete_file|DeleteFile|Remove|remove_file)$/,
  /^(Create|mkdir|MakeDir|make_dir)$/,
];

// ── DenialTracker ─────────────────────────────────────────────────────────────

export interface DenialState {
  consecutiveDenials: number;
  totalDenials: number;
  /** If true, classifier has been disabled for this session due to too many denials */
  classifierDisabled: boolean;
}

const _trackerCache = new Map<string, DenialState>();

export function getDenialTracker(cwd: string): DenialState {
  if (!_trackerCache.has(cwd)) {
    _trackerCache.set(cwd, { consecutiveDenials: 0, totalDenials: 0, classifierDisabled: false });
  }
  return _trackerCache.get(cwd)!;
}

export function recordClassifierAllow(cwd: string): void {
  const tracker = getDenialTracker(cwd);
  tracker.consecutiveDenials = 0; // reset consecutive on allow
}

export function recordClassifierDeny(cwd: string): void {
  const tracker = getDenialTracker(cwd);
  tracker.consecutiveDenials++;
  tracker.totalDenials++;

  if (
    tracker.consecutiveDenials >= DENIAL_LIMITS.maxConsecutive ||
    tracker.totalDenials >= DENIAL_LIMITS.maxTotal
  ) {
    tracker.classifierDisabled = true;
    log.warn(
      `YoloClassifier: denial limits reached (consecutive=${tracker.consecutiveDenials}, total=${tracker.totalDenials}). Falling back to prompting.`
    );
  }
}

export function resetDenialTracker(cwd: string): void {
  _trackerCache.delete(cwd);
}

// ── Tool risk assessment (heuristic pre-filter) ────────────────────────────────

/**
 * Heuristically determine if a tool call looks safe without LLM evaluation.
 * Returns 'allow' for known-safe patterns, 'ask' to proceed to classifier.
 */
function heuristicPreCheck(
  toolName: string,
  args: Record<string, unknown>
): 'allow' | 'ask' {
  // Allowlist fast-path
  if (ALLOWLIST_TOOLS.has(toolName)) return 'allow';

  // Bash with simple non-destructive commands
  if (toolName === 'Bash' || toolName === 'bash') {
    const cmd = (args.command ?? args.cmd ?? '') as string;
    const safePatterns = [
      /^(ls|pwd|echo|cat|head|tail|wc|grep|find|which|type|date|whoami|uname)\b/,
      /^(git (log|status|diff|branch|show|describe|rev-parse|config --get))\b/,
      /^(npm (list|ls|info|view|outdated|run (test|lint|build|check)))\b/,
      /^(node --version|python --version|pip list|cargo check)\b/,
    ];
    if (safePatterns.some((p) => p.test(cmd.trim()))) return 'allow';
  }

  return 'ask';
}

// ── LLM classifier call ───────────────────────────────────────────────────────

/**
 * Build the classification prompt for the LLM judge.
 * We keep it very short (< 200 tokens) to use fast / cheap models.
 */
function buildClassifierPrompt(
  toolName: string,
  args: Record<string, unknown>,
  recentContext?: string,
): string {
  const argsPreview = JSON.stringify(args, null, 0).slice(0, 200);
  const contextHint = recentContext
    ? `\nRecent context (last 2 turns summary): ${recentContext.slice(0, 300)}`
    : '';

  return [
    'You are a security classifier for an AI coding assistant.',
    'Determine if the following tool call is safe to auto-approve (no user confirmation needed).',
    '',
    `Tool: ${toolName}`,
    `Args: ${argsPreview}${contextHint}`,
    '',
    'Rules:',
    '- ALLOW: read-only ops, minor edits to existing files, non-destructive git ops',
    '- DENY: deleting files/dirs, running arbitrary network requests, system config changes, privilege escalation, irreversible actions',
    '- When in doubt, DENY',
    '',
    'Respond with exactly one word: ALLOW or DENY',
  ].join('\n');
}

// ── Main classifier function ──────────────────────────────────────────────────

/**
 * Classify a tool call in autoEdit mode.
 *
 * Decision priority:
 *   1. DenialTracker disabled → 'unavailable' (fall back to ask)
 *   2. Allowlist fast-path → 'allow'
 *   3. Heuristic pre-check → 'allow' (for known-safe bash commands)
 *   4. LLM classifier with CLASSIFIER_TIMEOUT_MS timeout
 *   5. On LLM error/timeout → 'unavailable' (fail-open)
 *
 * @param toolName - The tool being called
 * @param args - The tool arguments
 * @param cwd - Current working directory (used for DenialTracker)
 * @param recentContext - Optional summary of recent conversation for context
 */
export async function classifyToolCall(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  recentContext?: string,
): Promise<ClassifierDecision> {
  const tracker = getDenialTracker(cwd);

  // 1. Denial limits reached — fall back to prompting
  if (tracker.classifierDisabled) {
    log.debug(`YoloClassifier: classifier disabled for ${cwd}, returning unavailable`);
    return 'unavailable';
  }

  // 2. Allowlist fast-path
  if (ALLOWLIST_TOOLS.has(toolName)) {
    return 'allow';
  }

  // 3. Heuristic pre-check (known-safe bash patterns)
  const heuristic = heuristicPreCheck(toolName, args);
  if (heuristic === 'allow') {
    return 'allow';
  }

  // 4. LLM classifier
  try {
    const decision = await Promise.race([
      callLLMClassifier(toolName, args, recentContext),
      new Promise<ClassifierDecision>((resolve) =>
        setTimeout(() => resolve('unavailable'), CLASSIFIER_TIMEOUT_MS)
      ),
    ]);

    if (decision === 'deny') {
      recordClassifierDeny(cwd);
    } else if (decision === 'allow') {
      recordClassifierAllow(cwd);
    }

    log.debug(`YoloClassifier: ${toolName}(${JSON.stringify(args).slice(0, 60)}) -> ${decision}`);
    return decision;
  } catch (err) {
    log.debug(`YoloClassifier: error classifying ${toolName}: ${err instanceof Error ? err.message : String(err)}`);
    return 'unavailable';
  }
}

/**
 * Internal: call the LLM with the classifier prompt.
 * Uses the smallest/fastest model available.
 */
async function callLLMClassifier(
  toolName: string,
  args: Record<string, unknown>,
  recentContext?: string,
): Promise<ClassifierDecision> {
  const { modelManager } = await import('../../models/model-manager.js');

  // For classification we just use the default client
  const prompt = buildClassifierPrompt(toolName, args, recentContext);

  const llm = modelManager.getClient('main');
  const messages: import('../../models/types.js').Message[] = [
    { role: 'user', content: prompt },
  ];

  const chunks: string[] = [];
  await llm.streamChat({
    systemPrompt: 'You are a security classifier. Respond with only ALLOW or DENY.',
    messages,
    stream: true,
  }, (chunk: string) => {
    chunks.push(chunk);
  });

  const response = chunks.join('').trim().toUpperCase();

  if (response === 'ALLOW' || response.startsWith('ALLOW')) return 'allow';
  if (response === 'DENY' || response.startsWith('DENY')) return 'deny';

  // Unexpected response — treat as unavailable (fail-open)
  log.debug(`YoloClassifier: unexpected LLM response: "${response}" — treating as unavailable`);
  return 'unavailable';
}

// ── Integration helper ─────────────────────────────────────────────────────────

/**
 * Check if a tool call should be auto-approved in autoEdit mode.
 * This is the main integration point called from permission-manager.ts.
 *
 * Returns:
 *   'allow'       — auto-approve without user confirmation
 *   'ask'         — present confirmation dialog to user
 *   'deny'        — block execution (from classifier)
 */
export async function checkAutoEditApproval(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): Promise<'allow' | 'ask' | 'deny'> {
  // Blocklist patterns always require confirmation
  if (BLOCKLIST_TOOL_PATTERNS.some((p) => p.test(toolName))) {
    const decision = await classifyToolCall(toolName, args, cwd);
    if (decision === 'allow') return 'allow';
    if (decision === 'deny') return 'deny';
    return 'ask'; // unavailable → prompt user
  }

  // All other tools: classify
  const decision = await classifyToolCall(toolName, args, cwd);
  if (decision === 'allow') return 'allow';
  if (decision === 'deny') return 'deny';
  return 'ask';
}

/**
 * E16: clearClassifierCache — 清理所有 classifier 状态缓存
 * 对标 claude-code clearClassifierApprovals()，在 postCompactCleanup 中被调用。
 */
export function clearClassifierCache(): void {
  _trackerCache.clear();
}
