/**
 * constants/common.ts — Common constants used throughout universal-agent
 *
 * Mirrors claude-code's constants/common.ts.
 */

/** Application name */
export const APP_NAME = 'universal-agent';

/** CLI binary name */
export const CLI_NAME = 'uagent';

/** Config directory name (in home dir and project) */
export const CONFIG_DIR = '.codeflicker';

/** Legacy config directory name (for migration) */
export const LEGACY_CONFIG_DIR = '.uagent';

/** Default history file name */
export const HISTORY_FILE = 'history.jsonl';

/** Default session file name */
export const SESSION_FILE = 'session.json';

/** Maximum number of sessions to retain */
export const MAX_SESSIONS = 100;

/** Maximum history entries per session */
export const MAX_HISTORY_ENTRIES = 10_000;

/** Default timeout for tool execution in ms */
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

/** Maximum tool output size in characters */
export const MAX_TOOL_OUTPUT_CHARS = 100_000;
