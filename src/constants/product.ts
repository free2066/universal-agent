/**
 * constants/product.ts — Product information constants
 *
 * Mirrors claude-code's constants/product.ts.
 */

export const PRODUCT_NAME = 'Universal Agent';
export const PRODUCT_SHORT_NAME = 'uagent';
export const VERSION = '0.5.21';
export const HOMEPAGE = 'https://github.com/free2066/universal-agent';
export const SUPPORT_EMAIL = 'support@universal-agent.dev';

/** The name displayed in usage/help text */
export const CLI_DISPLAY_NAME = 'uagent';

/** Config directory (in home and project root) */
export const CONFIG_DIRNAME = '.codeflicker';

/** Legacy config directory (for migration) */
export const LEGACY_CONFIG_DIRNAME = '.uagent';

/** Claude/Anthropic system prompt marker file */
export const CLAUDE_MD_FILENAME = 'CLAUDE.md';

/** Universal-agent system prompt marker file */
export const AGENTS_MD_FILENAME = 'AGENTS.md';
