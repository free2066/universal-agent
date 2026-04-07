/**
 * constants/system.ts — System-level constants
 *
 * Mirrors claude-code's constants/system.ts.
 * Runtime environment and system-level configuration.
 */

import { platform } from 'os';

/** Platform detection */
export const IS_WINDOWS = platform() === 'win32';
export const IS_MAC = platform() === 'darwin';
export const IS_LINUX = platform() === 'linux';

/** Default shell by platform */
export const DEFAULT_SHELL = IS_WINDOWS
  ? 'powershell.exe'
  : (process.env.SHELL ?? '/bin/bash');

/** Environment variable key for API key */
export const ANTHROPIC_API_KEY_ENV = 'ANTHROPIC_API_KEY';
export const OPENAI_API_KEY_ENV = 'OPENAI_API_KEY';
export const GEMINI_API_KEY_ENV = 'GOOGLE_API_KEY';
export const OLLAMA_BASE_URL_ENV = 'OLLAMA_BASE_URL';

/** Default Anthropic model */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5';

/** Default OpenAI model */
export const DEFAULT_OPENAI_MODEL = 'gpt-4o';

/** Default Ollama model */
export const DEFAULT_OLLAMA_MODEL = 'llama3.2';

/** Model context windows */
export const CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4-5': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-4-5': 200_000,
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-opus-20240229': 200_000,
  'gpt-4o': 128_000,
  'gpt-4-turbo': 128_000,
  'gemini-2.5-pro': 1_000_000,
  'gemini-2.5-flash': 1_000_000,
};

/** Node.js minimum version requirement */
export const MIN_NODE_VERSION = 18;

/** REPL key sequences */
export const CTRL_C = '\x03';
export const CTRL_D = '\x04';
export const CTRL_L = '\x0C';
