/**
 * User-Agent string helpers.
 *
 * Kept dependency-free so SDK-bundled code (bridge, cli/transports) can
 * import without pulling in auth.ts and its transitive dependency tree.
 */

/** Constant user agent - version is baked in at build time */
const CACHED_CLAUDE_CODE_USER_AGENT = `claude-code/${MACRO.VERSION}`

export function getClaudeCodeUserAgent(): string {
  return CACHED_CLAUDE_CODE_USER_AGENT
}
